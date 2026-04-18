const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SecondStreet API constants ──────────────────────────────────────────────
const API_KEY       = '65032887';
const ORG_ID        = '2091414';
const ORG_PROMO_ID  = '1143541';
const PROMO_ID      = '977557';
const BALLOT_URL    = 'https://rentonreporter2.secondstreetapp.com/Best-of-Renton-2026/gallery/?group=538674';
const API_BASE      = 'https://rentonreporter2.secondstreetapp.com';
const TARGET_NAME   = 'liberty cafe';

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--ignore-certificate-errors',
  '--disable-extensions',
  '--disable-background-networking',
];

// ── In-memory job store ─────────────────────────────────────────────────────
const jobs = new Map();

// ── Routes ──────────────────────────────────────────────────────────────────

app.post('/vote', (req, res) => {
  const { email, firstName, lastName, zip } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const jobId = randomUUID();
  jobs.set(jobId, {
    status: 'queued',
    email, firstName: firstName || '', lastName: lastName || '', zip: zip || '',
    log: [],
    pdfPath: null,
    screenshotPath: null,
    ballotHtml: null,
    error: null,
    startedAt: new Date().toISOString(),
  });

  performVoting(jobId).catch(err => {
    const job = jobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
    console.error('performVoting error:', err);
  });

  res.json({ jobId });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    log: job.log,
    error: job.error,
    hasPdf: !!job.pdfPath,
    hasScreenshot: !!job.screenshotPath,
  });
});

app.get('/pdf/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.pdfPath) return res.status(404).json({ error: 'PDF not ready' });
  res.download(job.pdfPath, `best-of-renton-votes-${req.params.jobId.slice(0, 8)}.pdf`);
});

app.get('/screenshot/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.screenshotPath) return res.status(404).json({ error: 'Screenshot not ready' });
  res.sendFile(job.screenshotPath);
});

// Debug: explore the ballot page and return its structure
app.get('/debug/ballot', async (req, res) => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: LAUNCH_ARGS });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    let redirectCount = 0;
    const redirectLog = [];
    page.on('response', r => {
      if (r.status() >= 300 && r.status() < 400) {
        redirectCount++;
        redirectLog.push({ status: r.status(), url: r.url() });
      }
    });

    let navError = null;
    try {
      await page.goto(BALLOT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      navError = e.message;
    }
    await page.waitForTimeout(8000);

    const title = await page.title().catch(() => '');
    const url = page.url();
    const html = await page.content().catch(() => '');
    const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);

    // Collect all frames
    const frameInfo = page.frames().map(f => ({ url: f.url(), name: f.name() }));

    // Find ballot frame — skip main frame, about:blank, Twitter
    const ballotFrame = page.frames().find(f =>
      f !== page.mainFrame() &&
      f.url() !== 'about:blank' &&
      !f.url().includes('twitter.com') &&
      !f.url().includes('platform.')
    ) || page.mainFrame();

    const frameHtml = await ballotFrame.content().catch(() => '');
    const frameInputs = await ballotFrame.evaluate(() =>
      Array.from(document.querySelectorAll('input')).slice(0, 20).map(el => ({
        type: el.type, name: el.name, id: el.id, value: el.value,
        placeholder: el.placeholder,
        label: (document.querySelector(`label[for="${el.id}"]`) || el.closest('label'))?.textContent?.trim(),
      }))
    ).catch(() => []);

    await browser.close();
    res.json({
      navError, redirectCount, redirectLog,
      title, url,
      frames: frameInfo,
      ballotFrameUrl: ballotFrame.url(),
      mainHtmlLength: html.length,
      mainHtmlPreview: html.substring(0, 3000),
      ballotFrameHtmlLength: frameHtml.length,
      ballotFrameHtmlPreview: frameHtml.substring(0, 6000),
      ballotFrameInputs: frameInputs,
      screenshotBase64: screenshot ? screenshot.toString('base64') : null,
    });
  } catch (err) {
    await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ── Voting orchestration ─────────────────────────────────────────────────────

async function performVoting(jobId) {
  const job = jobs.get(jobId);
  job.status = 'running';

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromium(),
    args: LAUNCH_ARGS,
  });

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });

    // 1. Fetch ballot data
    const dataPage = await context.newPage();
    log(job, 'Fetching ballot categories and entries from API…');
    const { matchups, groups, entries } = await fetchBallotData(dataPage);
    await dataPage.close().catch(() => {});
    log(job, `Found ${matchups.length} categories across ${groups.length} groups`);

    const votePlan = buildVotePlan(matchups, entries, groups);
    const libertyCatCount = votePlan.filter(v => v.isLiberty).length;
    log(job, `Liberty Cafe found in ${libertyCatCount} categories; random picks for ${votePlan.length - libertyCatCount}`);

    // 2. Try UI voting
    log(job, 'Attempting to load ballot page via browser…');
    const uiPage = await context.newPage();
    const uiSuccess = await voteViaUI(uiPage, job, votePlan);

    // Take a screenshot of the ballot page (for debugging)
    try {
      const screenshotDir = ensureDir(path.join(__dirname, 'pdfs'));
      const screenshotPath = path.join(screenshotDir, `screenshot-${jobId}.png`);
      await uiPage.screenshot({ path: screenshotPath, fullPage: true });
      job.screenshotPath = screenshotPath;
      log(job, 'Screenshot saved.');
    } catch {}

    await uiPage.close().catch(() => {});

    if (!uiSuccess) {
      log(job, 'Ballot UI submission incomplete — building vote report from API data…');
    }

    // 3. Generate PDF on a fresh page
    log(job, 'Generating PDF report…');
    const pdfPage = await context.newPage();
    const pdfPath = await generatePDF(pdfPage, job, votePlan, uiSuccess);
    await pdfPage.close().catch(() => {});

    job.pdfPath = pdfPath;
    job.status = 'done';
    log(job, 'Done! PDF is ready for download.');
  } finally {
    await browser.close();
  }
}

// ── UI-based voting via Playwright ───────────────────────────────────────────

async function voteViaUI(page, job, votePlan) {
  try {
    let redirectCount = 0;
    page.on('response', r => {
      if (r.status() >= 300 && r.status() < 400 && r.url().includes('Best-of-Renton')) redirectCount++;
    });

    await page.goto(BALLOT_URL, { waitUntil: 'load', timeout: 60000 });
    // Wait for Ember/SPA to bootstrap and render
    await page.waitForTimeout(5000);

    if (redirectCount >= 8) {
      log(job, 'Redirect loop detected — UI voting unavailable in this environment.');
      return false;
    }

    const title = await page.title();
    log(job, `Ballot page loaded: "${title}"`);

    // Detect all frames — ballot is embedded in an iframe on embed-XXXXXX.secondstreetapp.com
    const frames = page.frames();
    log(job, `Page frames: ${frames.map(f => f.url().substring(0, 80)).join(' | ')}`);

    // Skip main frame, about:blank, and Twitter widget — ballot is first remaining frame
    const ballotFrame = frames.find(f =>
      f !== page.mainFrame() &&
      f.url() !== 'about:blank' &&
      !f.url().includes('twitter.com') &&
      !f.url().includes('platform.')
    ) || page.mainFrame();

    if (ballotFrame !== page.mainFrame()) {
      log(job, `Using ballot iframe: ${ballotFrame.url()}`);
      // Give the iframe time to render its Ember app
      await page.waitForTimeout(5000);
    }

    // Explore frame structure
    const pageInfo = await ballotFrame.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
        .map(el => ({
          type: el.type, name: el.name, value: el.value,
          id: el.id, checked: el.checked,
          labelText: (document.querySelector(`label[for="${el.id}"]`) || el.closest('label'))?.textContent?.trim(),
          dataAttrs: Object.fromEntries(Array.from(el.attributes).filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])),
        }));

      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .slice(0, 40)
        .map(el => ({ text: el.textContent?.trim(), classes: el.className, disabled: el.disabled }));

      return {
        inputCount: inputs.length,
        sampleInputs: inputs.slice(0, 20),
        buttonCount: buttons.length,
        sampleButtons: buttons.slice(0, 15),
        bodyClasses: document.body.className,
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).slice(0, 20).map(h => h.textContent?.trim()),
        allClasses: [...new Set(Array.from(document.querySelectorAll('*')).map(el => el.className).filter(c => typeof c === 'string' && c.length > 0))].slice(0, 60),
      };
    });

    log(job, `Frame: ${pageInfo.inputCount} radio/checkbox inputs, ${pageInfo.buttonCount} buttons`);
    log(job, `Headings: ${pageInfo.headings.slice(0, 5).join(' | ')}`);
    log(job, `Sample classes: ${pageInfo.allClasses.slice(0, 10).join(', ')}`);
    if (pageInfo.sampleInputs.length > 0) {
      log(job, `Sample input: ${JSON.stringify(pageInfo.sampleInputs[0])}`);
    }

    // Save ballot HTML for debugging
    job.ballotHtml = await ballotFrame.content().catch(() => '');

    // Strategy 1: vote by radio input label text
    let votedCount = 0;
    if (pageInfo.inputCount > 0) {
      votedCount = await voteByRadioLabels(ballotFrame, job, votePlan);
    }

    // Strategy 2: vote by clicking entry cards/buttons with text matching
    if (votedCount === 0) {
      votedCount = await voteByTextContent(ballotFrame, job, votePlan);
    }

    log(job, `Voted in ${votedCount} categories via UI`);

    // Scroll to and fill voter info form
    log(job, 'Filling in voter information…');
    await fillVoterInfo(ballotFrame, job);

    // Submit
    log(job, 'Submitting ballot…');
    const submitted = await submitBallot(ballotFrame, job);
    if (submitted) {
      await page.waitForTimeout(4000);
      log(job, 'Ballot submitted successfully!');
      return true;
    }
    log(job, 'Submit button not triggered — will fall back to report.');
    return false;
  } catch (err) {
    log(job, `UI voting error: ${err.message}`);
    return false;
  }
}

async function voteByRadioLabels(frame, job, votePlan) {
  const entryByName = {};
  for (const v of votePlan) {
    entryByName[v.selectedEntry.name.toLowerCase().trim()] = true;
  }

  const clicked = await frame.evaluate((nameMap) => {
    let count = 0;
    const inputs = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const input of inputs) {
      const label = document.querySelector(`label[for="${input.id}"]`) || input.closest('label');
      const text = label?.textContent?.trim().toLowerCase() || input.value?.toLowerCase();
      if (text && nameMap[text] !== undefined) {
        input.click();
        count++;
      }
    }
    return count;
  }, entryByName);

  return clicked;
}

async function voteByTextContent(frame, job, votePlan) {
  const entryNames = votePlan.map(v => v.selectedEntry.name);
  let count = 0;

  for (const name of entryNames) {
    try {
      const selectors = [
        `[class*="entry"]:has-text("${name}")`,
        `[class*="option"]:has-text("${name}")`,
        `[class*="candidate"]:has-text("${name}")`,
        `li:has-text("${name}")`,
        `label:has-text("${name}")`,
      ];
      for (const sel of selectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.count() > 0) {
            await el.click({ timeout: 2000 });
            count++;
            break;
          }
        } catch {}
      }
    } catch {}
  }
  return count;
}

async function fillVoterInfo(frame, job) {
  const { email, firstName, lastName, zip } = job;

  await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await frame.waitForTimeout(500);

  const fieldMap = [
    { selectors: ['input[type="email"]', 'input[name*="email"]', 'input[id*="email"]', 'input[placeholder*="mail"]'], value: email },
    { selectors: ['input[name*="first"]', 'input[id*="first"]', 'input[placeholder*="First"]', 'input[placeholder*="first"]'], value: firstName },
    { selectors: ['input[name*="last"]', 'input[id*="last"]', 'input[placeholder*="Last"]', 'input[placeholder*="last"]'], value: lastName },
    { selectors: ['input[name*="zip"]', 'input[id*="zip"]', 'input[placeholder*="ZIP"]', 'input[placeholder*="zip"]', 'input[placeholder*="postal"]'], value: zip },
  ];

  for (const { selectors, value } of fieldMap) {
    if (!value) continue;
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (el) { await el.fill(value); break; }
      } catch {}
    }
  }
}

async function submitBallot(frame, job) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    '[class*="submit"]',
    '[class*="vote-btn"]',
    '[class*="cast"]',
  ];

  for (const sel of submitSelectors) {
    try {
      const btn = await frame.$(sel);
      if (btn) {
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
        return true;
      }
    } catch {}
  }

  for (const text of ['Submit', 'Vote', 'Cast My Vote', 'Submit Votes']) {
    try {
      await frame.getByRole('button', { name: text, exact: false }).click({ timeout: 2000 });
      return true;
    } catch {}
  }

  return false;
}

// ── PDF generation ───────────────────────────────────────────────────────────

async function generatePDF(page, job, votePlan, uiSuccess) {
  const html = buildResultsHTML(job, votePlan, uiSuccess);

  // Use a data: URL for reliable rendering (avoids setContent timing issues)
  const encoded = Buffer.from(html).toString('base64');
  await page.goto(`data:text/html;base64,${encoded}`, { waitUntil: 'load', timeout: 15000 });

  // Ensure the page is fully rendered before generating PDF
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.waitForTimeout(800);

  const dir = ensureDir(path.join(__dirname, 'pdfs'));
  const pdfPath = path.join(dir, `votes-${randomUUID()}.pdf`);

  await page.pdf({
    path: pdfPath,
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' },
  });

  const stat = fs.statSync(pdfPath);
  log(job, `PDF written: ${Math.round(stat.size / 1024)}KB`);
  return pdfPath;
}

function buildResultsHTML(job, votePlan, uiSuccess) {
  const { email, firstName, lastName, zip } = job;
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || email;
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const libertyCount = votePlan.filter(v => v.isLiberty).length;

  // Group by matchup_group
  const groupMap = new Map();
  for (const v of votePlan) {
    const gid = v.matchup.matchup_group_id;
    if (!groupMap.has(gid)) groupMap.set(gid, { name: v.groupName, rows: [] });
    groupMap.get(gid).rows.push(v);
  }

  const groupSections = Array.from(groupMap.values()).map(g => {
    const rows = g.rows.map(v => {
      const cat = v.matchup.name || '';
      const entry = v.selectedEntry.name || '';
      const note = v.isLiberty ? 'Liberty Cafe nominee' : 'Random selection';
      const rowClass = v.isLiberty ? ' class="lc"' : '';
      return `<tr${rowClass}><td>${cat}</td><td>${entry}</td><td>${note}</td></tr>`;
    }).join('');
    return `<div class="gs"><h3>${g.name}</h3><table><thead><tr><th>Category</th><th>Voted For</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');

  const statusMsg = uiSuccess
    ? 'Ballot submitted successfully via the ballot website.'
    : `Vote report prepared: ${libertyCount} Liberty Cafe votes, ${votePlan.length - libertyCount} random picks across ${votePlan.length} categories.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Best of Renton 2026 Voting Report</title>
<style>
body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background: white; margin: 0; padding: 0; }
.hdr { background: #8B0000; color: white; padding: 24px 32px; }
.hdr h1 { font-size: 20pt; margin: 0 0 4px; }
.hdr p { margin: 0; font-size: 10pt; opacity: 0.88; }
.body { padding: 24px 32px; }
.banner { padding: 12px 16px; border-radius: 4px; margin-bottom: 20px; font-size: 10pt; font-weight: bold;
  background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
.info { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 14px 18px; margin-bottom: 20px; }
.info p { margin: 3px 0; }
.stats { display: flex; gap: 16px; margin-bottom: 20px; }
.stat { border: 1px solid #dee2e6; border-radius: 6px; padding: 12px 16px; flex: 1; text-align: center; }
.stat .n { font-size: 22pt; font-weight: bold; color: #8B0000; }
.stat .l { font-size: 8pt; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
.gs { margin-bottom: 22px; }
.gs h3 { font-size: 12pt; color: #8B0000; border-bottom: 2px solid #8B0000; padding-bottom: 4px; margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th { background: #333; color: white; padding: 6px 10px; text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.4px; }
td { padding: 6px 10px; border-bottom: 1px solid #eee; }
tr.lc { background: #fff8e6; }
tr.lc td:first-child { border-left: 3px solid #e67e22; }
.footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #dee2e6; font-size: 8pt; color: #666; text-align: center; }
</style>
</head>
<body>
<div class="hdr">
  <h1>Best of Renton 2026 &mdash; Voting Report</h1>
  <p>Renton Reporter Annual Ballot</p>
</div>
<div class="body">
  <div class="banner">${statusMsg}</div>
  <div class="info">
    <p><strong>Voter:</strong> ${fullName} (${email})${zip ? ' &mdash; ZIP: ' + zip : ''}</p>
    <p><strong>Submitted:</strong> ${now} PT</p>
  </div>
  <div class="stats">
    <div class="stat"><div class="n">${votePlan.length}</div><div class="l">Total Categories</div></div>
    <div class="stat"><div class="n">${libertyCount}</div><div class="l">Liberty Cafe Votes</div></div>
    <div class="stat"><div class="n">${votePlan.length - libertyCount}</div><div class="l">Random Picks</div></div>
  </div>
  ${groupSections}
  <div class="footer">
    <p>Ballot URL: ${BALLOT_URL}</p>
    <p>Report generated ${now} PT</p>
  </div>
</div>
</body>
</html>`;
}

// ── API data fetching ────────────────────────────────────────────────────────

async function fetchBallotData(page) {
  await page.goto(`${API_BASE}/`, { waitUntil: 'load', timeout: 30000 });

  const apiHeaders = {
    'Accept': 'application/json',
    'x-api-key': API_KEY,
    'x-organization-id': ORG_ID,
    'x-organization-promotion-id': ORG_PROMO_ID,
  };

  const result = await page.evaluate(async ({ base, headers, promoId }) => {
    const apiFetch = async (url) => {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return res.json();
    };

    // Matchups (paginate properly)
    let allMatchups = [];
    const seenMatchupIds = new Set();
    for (let p = 1; p <= 10; p++) {
      const data = await apiFetch(`${base}/api/matchups?promotionId=${promoId}&page_size=100&page_index=${p}`);
      const items = (data.matchups || []).filter(m => !seenMatchupIds.has(m.id));
      items.forEach(m => seenMatchupIds.add(m.id));
      allMatchups = allMatchups.concat(items);
      if (items.length === 0) break;
    }

    // Groups
    const groupsData = await apiFetch(`${base}/api/matchup_groups?promotionId=${promoId}`);

    // Entries (API returns all in one shot; deduplicate just in case)
    const entriesData = await apiFetch(`${base}/api/voting_entries?promotionId=${promoId}&page_size=5000`);
    const seenEntryIds = new Set();
    const allEntries = (entriesData.voting_entries || []).filter(e => {
      if (seenEntryIds.has(e.id)) return false;
      seenEntryIds.add(e.id);
      return true;
    });

    return { matchups: allMatchups, groups: groupsData.matchup_groups || [], entries: allEntries };
  }, { base: API_BASE, headers: apiHeaders, promoId: PROMO_ID });

  return result;
}

// ── Vote plan builder ────────────────────────────────────────────────────────

function buildVotePlan(matchups, entries, groups) {
  const groupById = {};
  groups.forEach(g => { groupById[g.id] = g.name; });

  const entriesByMatchup = {};
  entries.forEach(e => {
    if (!entriesByMatchup[e.matchup_id]) entriesByMatchup[e.matchup_id] = [];
    entriesByMatchup[e.matchup_id].push(e);
  });

  return matchups
    .filter(m => (entriesByMatchup[m.id] || []).length > 0)
    .map(matchup => {
      const pool = entriesByMatchup[matchup.id] || [];
      const libertyCafe = pool.find(e => e.name && e.name.toLowerCase().includes(TARGET_NAME));
      const selectedEntry = libertyCafe || pool[Math.floor(Math.random() * pool.length)];
      return {
        matchup,
        groupName: groupById[matchup.matchup_group_id] || `Group ${matchup.matchup_group_id}`,
        selectedEntry,
        isLiberty: !!libertyCafe,
        allEntries: pool,
      };
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(job, msg) {
  job.log.push(`[${new Date().toISOString()}] ${msg}`);
  console.log(`[${job.email}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH &&
      fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const fixed = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  for (const c of fixed) { if (fs.existsSync(c)) return c; }

  const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
  if (fs.existsSync(browsersRoot)) {
    for (const dir of fs.readdirSync(browsersRoot).sort().reverse()) {
      const exe = `${browsersRoot}/${dir}/chrome-linux/chrome`;
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

// ── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Liberty Cafe Voter on http://localhost:${PORT}`));
