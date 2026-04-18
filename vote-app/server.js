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

// Debug: intercept network calls, scroll ballot, click vote buttons, capture API traffic
app.get('/debug/ballot', async (req, res) => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: LAUNCH_ARGS });
  const networkLog = [];
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    // Intercept all XHR/fetch requests
    page.on('request', req => {
      if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
        const entry = { type: 'req', method: req.method(), url: req.url(), postData: null };
        try { entry.postData = req.postData(); } catch {}
        networkLog.push(entry);
      }
    });
    page.on('response', async resp => {
      if (resp.request().resourceType() === 'xhr' || resp.request().resourceType() === 'fetch') {
        const entry = { type: 'resp', status: resp.status(), url: resp.url(), body: null };
        try { entry.body = (await resp.text()).slice(0, 1000); } catch {}
        networkLog.push(entry);
      }
    });

    let navError = null;
    try {
      await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) { navError = e.message; }
    await page.waitForTimeout(5000);

    // Scroll fully to load all categories
    await page.evaluate(async () => {
      for (let i = 0; i < 30; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 300));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Snapshot after scrolling
    const entryNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.individual-entry-view')).map(el => ({
        name: el.textContent?.trim().split('\n')[0].trim().slice(0, 60),
        hasVoteBtn: !!el.querySelector('.vote-button'),
      }))
    ).catch(() => []);

    const libertyCafeEntries = entryNames.filter(e =>
      e.name?.toLowerCase().includes('liberty')
    );

    const screenshotPre = await page.screenshot({ fullPage: false }).catch(() => null);

    // Click vote button for first Liberty Cafe entry found
    let voteClicked = false;
    let voteClickError = null;
    const lcEntry = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.individual-entry-view'));
      for (const el of all) {
        if (el.textContent?.toLowerCase().includes('liberty cafe')) {
          const btn = el.querySelector('.vote-button');
          if (btn) { btn.click(); return { found: true, name: el.textContent?.trim().split('\n')[0] }; }
          return { found: true, noBtnFound: true };
        }
      }
      return { found: false };
    }).catch(e => ({ error: e.message }));
    if (lcEntry.found && !lcEntry.noBtnFound) { voteClicked = true; await page.waitForTimeout(1000); }
    else { voteClickError = JSON.stringify(lcEntry); }

    const screenshotAfterVote = await page.screenshot({ fullPage: false }).catch(() => null);

    // Click Already Entered? button
    let loginClicked = false;
    const loginBtn = page.locator('.login-prompt-button').first();
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
      loginClicked = true;
      await page.waitForTimeout(2000);
    }

    // Fill email only (that's all the form needs)
    await page.fill('input[type="email"]', 'test@example.com').catch(() => {});
    await page.waitForTimeout(500);

    const screenshotEmailForm = await page.screenshot({ fullPage: false }).catch(() => null);

    // Click submit (DO NOT actually submit - just snapshot)
    const submitBtn = await page.$('.submit-button');
    const submitBtnFound = !!submitBtn;

    await browser.close();
    res.json({
      navError,
      totalEntries: entryNames.length,
      libertyCafeEntries,
      lcEntry,
      voteClicked,
      voteClickError,
      loginClicked,
      submitBtnFound,
      networkLog: networkLog.slice(0, 40),
      screenshotPreBase64: screenshotPre?.toString('base64') ?? null,
      screenshotAfterVoteBase64: screenshotAfterVote?.toString('base64') ?? null,
      screenshotEmailFormBase64: screenshotEmailForm?.toString('base64') ?? null,
    });
  } catch (err) {
    await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Debug: explore SPA navigation - find group links, test multi-group navigation
app.get('/debug/nav', async (req, res) => {
  const EMBED_BASE = 'https://embed-1143541.secondstreetapp.com/embed/ede68172-c907-4b3e-8116-dbcacb7ef1bb/gallery/';
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: LAUNCH_ARGS });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    await page.goto(EMBED_BASE + '?group=538674', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Scroll to load all entries
    await page.evaluate(async () => {
      for (let i = 0; i < 60; i++) { window.scrollBy(0, window.innerHeight); await new Promise(r => setTimeout(r, 200)); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);

    const group538674Count = await page.evaluate(() =>
      document.querySelectorAll('.individual-entry-view').length
    );

    // Find group navigation links
    const navLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="group="], a[href*="gallery"]'))
        .map(a => ({ text: a.textContent?.trim().slice(0,50), href: a.href, cls: a.className }));
      const breadcrumb = document.querySelector('.breadcrumb-navigation');
      const breadHtml = breadcrumb?.outerHTML?.slice(0, 2000) || '';
      return { links: links.slice(0,20), breadHtml };
    });

    // Try clicking a vote button to set state, then navigate to another group
    const voteResult = await page.evaluate(() => {
      const entries = Array.from(document.querySelectorAll('.individual-entry-view'));
      const firstBtn = entries[0]?.querySelector('.vote-button');
      if (firstBtn) { firstBtn.click(); return { clicked: entries[0]?.textContent?.trim().split('\n')[0] }; }
      return { clicked: null };
    });

    // Navigate to the ballot without group filter (test if votes persist)
    await page.goto(EMBED_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    await page.evaluate(async () => {
      for (let i = 0; i < 60; i++) { window.scrollBy(0, window.innerHeight); await new Promise(r => setTimeout(r, 200)); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);

    const afterNavInfo = await page.evaluate(() => {
      const entries = Array.from(document.querySelectorAll('.individual-entry-view'));
      // Check if any vote button looks "selected" (different class or aria)
      const selectedBtns = Array.from(document.querySelectorAll('.vote-button')).filter(b =>
        b.className.includes('selected') || b.className.includes('voted') || b.getAttribute('aria-pressed') === 'true'
      );
      return {
        entryCount: entries.length,
        selectedBtns: selectedBtns.length,
        firstNames: entries.slice(0,5).map(e => e.textContent?.trim().split('\n')[0]),
        // check group navigation links
        groupLinks: Array.from(document.querySelectorAll('a[href*="group="]')).map(a => ({
          text: a.textContent?.trim().slice(0,40), href: a.href,
        })),
      };
    });

    const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);

    await browser.close();
    res.json({
      group538674Count, navLinks, voteResult, afterNavInfo,
      screenshotBase64: screenshot?.toString('base64') ?? null,
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
//
// The 2nd Street ballot flow:
//   1. Click "Vote" on any entry → inline registration form appears
//   2. (Optionally click more vote buttons before submitting)
//   3. Fill name / email / birthdate / zip in the form
//   4. Click the green "VOTE" button → ballot submitted
//
// "Already Entered?" is only for returning participants (already registered).

async function voteViaUI(page, job, votePlan) {
  try {
    log(job, `Loading embed ballot: ${EMBED_URL}`);

    // Intercept form submission response to detect errors
    const apiResults = [];
    page.on('response', async resp => {
      if (resp.url().includes('/api/form_page_submissions') || resp.url().includes('/api/login_email')) {
        const body = await resp.text().catch(() => '');
        apiResults.push({ url: resp.url(), status: resp.status(), body: body.slice(0, 400) });
      }
    });

    await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // Scroll incrementally to trigger lazy-loading
    log(job, 'Scrolling to load all ballot entries…');
    await page.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);

    const entryCount = await page.evaluate(() =>
      document.querySelectorAll('.individual-entry-view').length
    );
    log(job, `Entries in DOM: ${entryCount}`);

    // Build a name→index map once (avoids O(n²) DOM evaluations)
    log(job, 'Scanning ballot entries…');
    const allEntries = page.locator('.individual-entry-view');
    const total = await allEntries.count();
    const entryNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.individual-entry-view')).map(el =>
        (el.textContent || '').trim().split('\n').map(l => l.trim()).find(l => l) || ''
      )
    );

    const clicked = [];
    const missed = [];
    const usedEntryIndices = new Set();

    for (const target of votePlan) {
      const name = target.selectedEntry.name;
      const catName = target.matchup.name;
      const nameLower = name.toLowerCase().trim();
      let found = false;

      for (let i = 0; i < total; i++) {
        if (usedEntryIndices.has(i)) continue;
        if (!entryNames[i].toLowerCase().includes(nameLower)) continue;

        const btn = allEntries.nth(i).locator('.vote-button');
        if (await btn.count() === 0) continue;

        try {
          await btn.first().scrollIntoViewIfNeeded();
          await btn.first().click();
          await page.waitForTimeout(200);
          usedEntryIndices.add(i);
          clicked.push({ name, catName });
          found = true;
          break;
        } catch {}
      }
      if (!found) missed.push({ name, catName });
      if ((clicked.length + missed.length) % 10 === 0) {
        log(job, `  Progress: ${clicked.length} voted, ${missed.length} skipped so far…`);
      }
    }

    log(job, `Votes clicked: ${clicked.length}, missed: ${missed.length}`);
    for (const c of clicked.filter(c => c.name.toLowerCase().includes('liberty'))) {
      log(job, `  ✓ Liberty Cafe in "${c.catName}"`);
    }
    const libertyMissed = missed.filter(m => m.name.toLowerCase().includes('liberty'));
    if (libertyMissed.length > 0) log(job, `  LIBERTY MISSED: ${JSON.stringify(libertyMissed)}`);

    if (clicked.length === 0) {
      log(job, 'No votes clicked — cannot submit ballot');
      return false;
    }

    // Wait for the registration form to appear (triggered by first vote button click)
    log(job, 'Waiting for registration form…');
    const formVisible = await page.waitForSelector('input[type="text"]', { state: 'visible', timeout: 15000 })
      .then(() => true).catch(() => false);
    log(job, `Registration form visible: ${formVisible}`);

    // Scroll back to top so the form is in view
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    log(job, 'Filling registration form…');
    await fillRegistrationForm(page, job);

    // Click the green VOTE button to submit
    log(job, 'Clicking VOTE button…');
    const submitted = await clickVoteSubmitButton(page, job);
    if (submitted) {
      await page.waitForTimeout(4000);
      // Check API response for success/error
      for (const r of apiResults) {
        if (r.status >= 400) {
          log(job, `API error ${r.status}: ${r.body.slice(0, 200)}`);
        } else if (r.status === 200 || r.status === 201) {
          log(job, `API success ${r.status} → ballot submitted!`);
          return true;
        }
      }
      if (apiResults.length === 0) log(job, 'No API response captured after VOTE click');
      // Check page for success message
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
      if (pageText.toLowerCase().includes('thank') || pageText.toLowerCase().includes('success')) {
        log(job, 'Success message detected on page');
        return true;
      }
      log(job, `Page text after submit: ${pageText.slice(0, 200)}`);
      log(job, 'Ballot submit failed — API returned error or no success signal');
      return false;
    }

    return false;
  } catch (err) {
    log(job, `UI voting error: ${err.message}`);
    return false;
  }
}

async function fillRegistrationForm(page, job) {
  const { firstName, lastName, email, zip } = job;

  // Scroll the visible form fields into view
  const form = page.locator('.ssRegistrationField').first();
  if (await form.count() > 0) await form.scrollIntoViewIfNeeded().catch(() => {});

  // The form fields in order: text[0]=First Name, text[1]=Last Name,
  // email[0]=Email, date[0]=Birthdate, text[2]=Postal Code
  const textInputs = page.locator('input[type="text"]');
  const emailInput = page.locator('input[type="email"]');
  const dateInput  = page.locator('input[type="date"]');

  const textCount = await textInputs.count();
  log(job, `Form inputs: ${textCount} text, email=${await emailInput.count()}, date=${await dateInput.count()}`);

  if (textCount >= 1) await textInputs.nth(0).fill(firstName || 'Voter').catch(() => {});
  if (textCount >= 2) await textInputs.nth(1).fill(lastName  || 'Vote').catch(() => {});
  await emailInput.first().fill(email).catch(() => {});
  await dateInput.first().fill('1990-01-15').catch(() => {});
  if (textCount >= 3) await textInputs.nth(2).fill(zip || '98055').catch(() => {});

  // Check any unchecked checkboxes (terms, marketing opt-in, etc.)
  const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
  for (const cb of checkboxes) await cb.check().catch(() => {});
}

async function clickVoteSubmitButton(page, job) {
  // The form submit button is type="submit"; ballot vote buttons are type="button"
  await page.waitForSelector('button[type="submit"]', { state: 'visible', timeout: 10000 }).catch(() => {});
  const submit = page.locator('button[type="submit"]').first();
  if (await submit.count() > 0) {
    log(job, 'Clicking button[type="submit"]');
    await submit.click();
    return true;
  }
  log(job, 'button[type="submit"] not found');
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
      // Prefer active entries (status_type_id === 1) so the name matches what the ballot UI shows
      const active = pool.filter(e => e.status_type_id === 1);
      const searchPool = active.length > 0 ? active : pool;
      const libertyCafe = searchPool.find(e => e.name && e.name.toLowerCase().includes(TARGET_NAME));
      const selectedEntry = libertyCafe || searchPool[Math.floor(Math.random() * searchPool.length)];
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
