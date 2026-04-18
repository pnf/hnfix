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
const EMBED_URL     = 'https://embed-1143541.secondstreetapp.com/embed/ede68172-c907-4b3e-8116-dbcacb7ef1bb/gallery/?group=538674';
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

// Debug: explore the ballot page and return its structure (pre- and post-login)
app.get('/debug/ballot', async (req, res) => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: LAUNCH_ARGS });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    let navError = null;
    try {
      await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      navError = e.message;
    }
    await page.waitForTimeout(5000);

    const snap = async (label) => ({
      label,
      inputs: await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).slice(0, 20).map(el => ({
          type: el.type, name: el.name, id: el.id, placeholder: el.placeholder,
          label: (document.querySelector(`label[for="${el.id}"]`) || el.closest('label'))?.textContent?.trim(),
        }))
      ).catch(() => []),
      buttons: await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 30).map(el => ({
          text: el.textContent?.trim().slice(0, 60), cls: el.className,
        }))
      ).catch(() => []),
      sampleClasses: await page.evaluate(() =>
        [...new Set(Array.from(document.querySelectorAll('*')).map(el => el.className).filter(c => typeof c === 'string' && c.trim()))].slice(0, 50)
      ).catch(() => []),
      entryEls: await page.evaluate(() =>
        Array.from(document.querySelectorAll('[class*="entry"],[class*="contestant"],[class*="nominee"],[class*="gallery-item"],[class*="card"]')).slice(0, 10).map(el => ({
          cls: el.className,
          text: el.textContent?.trim().slice(0, 120),
        }))
      ).catch(() => []),
      htmlPreview: (await page.content().catch(() => '')).substring(0, 6000),
    });

    const prelog = await snap('pre-login');
    const screenshotPre = await page.screenshot({ fullPage: false }).catch(() => null);

    // Click login-prompt-button
    let loginClicked = false;
    let loginClickError = null;
    const loginBtn = page.locator('.login-prompt-button').first();
    if (await loginBtn.count() > 0) {
      try {
        await loginBtn.click();
        loginClicked = true;
        await page.waitForTimeout(2000);
      } catch (e) {
        loginClickError = e.message;
      }
    }

    // Fill dummy voter info in the modal
    const dummyJob = { email: 'test@example.com', firstName: 'Test', lastName: 'User', zip: '98055' };
    const fillLog = [];
    await fillVoterInfoInModal(page, { ...dummyJob, log: [] }, fillLog);

    const postlog = await snap('post-login-form-filled');
    const screenshotPost = await page.screenshot({ fullPage: false }).catch(() => null);

    await browser.close();
    res.json({
      navError, loginClicked, loginClickError, fillLog,
      prelog, postlog,
      screenshotPreBase64: screenshotPre ? screenshotPre.toString('base64') : null,
      screenshotPostBase64: screenshotPost ? screenshotPost.toString('base64') : null,
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
    log(job, `Loading embed ballot: ${EMBED_URL}`);
    await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    log(job, 'Waiting for Ember SPA to render…');
    await page.waitForTimeout(5000);

    // Step 1: scroll to trigger lazy-loading of all entries
    log(job, 'Scrolling to load all ballot entries…');
    await page.evaluate(async () => {
      const step = 800;
      for (let y = 0; y < Math.min(document.body.scrollHeight, 60000); y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);

    // Log pre-vote state
    const preInfo = await page.evaluate(() => ({
      entryCount: document.querySelectorAll('[class*="individual-entry"]').length,
      voteButtons: document.querySelectorAll('.vote-button, [class*="voting-button"]').length,
      loginBtn: document.querySelectorAll('.login-prompt-button').length,
    })).catch(() => ({}));
    log(job, `Pre-vote: ${preInfo.entryCount} entries, ${preInfo.voteButtons} vote-buttons, ${preInfo.loginBtn} login-btn`);

    // Step 2: vote on gallery entries BEFORE authenticating
    const votedCount = await voteOnGalleryEntries(page, job, votePlan);
    log(job, `Voted in ${votedCount} categories via UI`);

    // Step 3: click "Already Entered?" (login-prompt-button) to authenticate
    const loginBtn = page.locator('.login-prompt-button').first();
    if (await loginBtn.count() > 0) {
      log(job, 'Clicking login-prompt-button to authenticate…');
      await loginBtn.click();
      await page.waitForTimeout(2000);

      // Step 4: fill voter info
      log(job, 'Filling voter info…');
      const fillLog = [];
      await fillVoterInfoInModal(page, job, fillLog);
      for (const msg of fillLog) log(job, msg);

      // Step 5: submit voter info
      log(job, 'Submitting voter info…');
      const formSubmitted = await submitVoterInfoModal(page, job);
      if (formSubmitted) {
        log(job, 'Voter info submitted successfully!');
        await page.waitForTimeout(4000);
        return true;
      }
      log(job, 'WARNING: could not submit voter info form');
    } else {
      log(job, 'login-prompt-button not found');
    }

    return false;
  } catch (err) {
    log(job, `UI voting error: ${err.message}`);
    return false;
  }
}

async function fillVoterInfoInModal(page, job, fillLog = []) {
  const { email, firstName, lastName, zip } = job;

  const fieldMap = [
    { selectors: ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="email" i]', 'input[placeholder*="mail" i]'], value: email },
    { selectors: ['input[name*="first" i]', 'input[id*="first" i]', 'input[placeholder*="first" i]'], value: firstName },
    { selectors: ['input[name*="last" i]', 'input[id*="last" i]', 'input[placeholder*="last" i]'], value: lastName },
    { selectors: ['input[name*="zip" i]', 'input[id*="zip" i]', 'input[placeholder*="zip" i]', 'input[placeholder*="postal" i]'], value: zip },
  ];

  for (const { selectors, value } of fieldMap) {
    if (!value) continue;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.fill(value);
          fillLog.push(`Filled "${sel}" = "${value}"`);
          break;
        }
      } catch {}
    }
  }

  // Check any unchecked checkboxes (age verification, terms, etc.)
  const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
  for (const cb of checkboxes) {
    try { await cb.check(); fillLog.push('Checked a checkbox'); } catch {}
  }
}

async function submitVoterInfoModal(page, job) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    '[class*="submit"]',
    '[class*="register"]',
    '[class*="continue"]',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        log(job, `Submitting voter form via: ${sel}`);
        await btn.click();
        return true;
      }
    } catch {}
  }
  for (const text of ['Submit', 'Continue', 'Register', 'Sign In', 'Enter', 'Login']) {
    try {
      const btn = page.getByRole('button', { name: text, exact: false });
      if (await btn.count() > 0) {
        log(job, `Submitting voter form via button text: "${text}"`);
        await btn.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function voteOnGalleryEntries(page, job, votePlan) {
  // Build plain-object lookup: lowercase entry name → category name (for logging)
  const entryLookup = {};
  for (const v of votePlan) {
    entryLookup[v.selectedEntry.name.toLowerCase().trim()] = v.matchup.name || '';
  }

  const result = await page.evaluate((lookup) => {
    const clicked = [];
    const missed = [];

    // Strategy A: find entry containers and look for a vote button inside
    const containers = Array.from(document.querySelectorAll(
      '[class*="entry"],[class*="contestant"],[class*="nominee"],[class*="gallery-item"],[class*="card"],[class*="item"]'
    ));

    for (const [name, catName] of Object.entries(lookup)) {
      let found = false;
      for (const container of containers) {
        const text = container.textContent?.trim().toLowerCase() || '';
        if (!text.includes(name)) continue;

        // Found a container matching this entry — look for a vote button inside
        const voteBtn = container.querySelector(
          'button, [role="button"], [class*="vote"], [class*="select"], [class*="choose"]'
        );
        if (voteBtn) {
          try {
            voteBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            voteBtn.click();
            clicked.push({ name, catName, btnText: voteBtn.textContent?.trim(), btnCls: voteBtn.className });
            found = true;
          } catch (e) {
            missed.push({ name, reason: e.message });
          }
          break;
        }
      }

      // Strategy B: text-node walk to find entry name, then bubble up to find a button
      if (!found) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent?.trim().toLowerCase() !== name) continue;
          let el = node.parentElement;
          for (let depth = 0; depth < 7; depth++) {
            if (!el) break;
            const btn = el.querySelector('button, [role="button"]');
            if (btn) {
              try {
                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                btn.click();
                clicked.push({ name, catName, btnText: btn.textContent?.trim(), btnCls: btn.className, strategy: 'B' });
                found = true;
              } catch (e) {
                missed.push({ name, reason: e.message });
              }
              break;
            }
            el = el.parentElement;
          }
          break;
        }
        if (!found) missed.push({ name, reason: 'no container or button found' });
      }
    }

    return { clicked, missed, containerCount: containers.length };
  }, entryLookup);

  log(job, `Gallery containers found: ${result.containerCount}`);
  log(job, `Votes clicked: ${result.clicked.length}, missed: ${result.missed.length}`);
  if (result.clicked.length > 0) {
    for (const c of result.clicked.slice(0, 5)) {
      log(job, `  ✓ "${c.name}" in "${c.catName}" (btn: "${c.btnText}" cls: "${c.btnCls}")`);
    }
  }
  if (result.missed.length > 0) {
    log(job, `  First missed: ${JSON.stringify(result.missed[0])}`);
  }

  return result.clicked.length;
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
