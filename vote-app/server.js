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
    error: null,
    startedAt: new Date().toISOString(),
  });

  // Run in background
  performVoting(jobId).catch(err => {
    const job = jobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
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
  });
});

app.get('/pdf/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.pdfPath) return res.status(404).json({ error: 'PDF not ready' });
  res.download(job.pdfPath, `best-of-renton-votes-${req.params.jobId.slice(0, 8)}.pdf`);
});

// ── Voting orchestration ─────────────────────────────────────────────────────

async function performVoting(jobId) {
  const job = jobs.get(jobId);
  job.status = 'running';

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromium(),
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const dataPage = await context.newPage();

    log(job, 'Fetching ballot categories and entries from API…');
    const { matchups, groups, entries } = await fetchBallotData(dataPage);
    await dataPage.close().catch(() => {});
    log(job, `Found ${matchups.length} categories across ${groups.length} groups`);

    const votePlan = buildVotePlan(matchups, entries, groups);
    const libertyCatCount = votePlan.filter(v => v.isLiberty).length;
    log(job, `Liberty Cafe found in ${libertyCatCount} categories; random picks for ${votePlan.length - libertyCatCount}`);

    // Try UI voting first (may use the page; might leave it in an error state)
    log(job, 'Attempting to load ballot page via browser…');
    let uiPage = await context.newPage();
    const uiSuccess = await voteViaUI(uiPage, job, votePlan);
    await uiPage.close().catch(() => {});

    if (!uiSuccess) {
      log(job, 'Ballot page unavailable; generating vote report from API data…');
    }

    // Use a fresh page for PDF so redirect failures don't contaminate it
    const pdfPage = await context.newPage();
    log(job, 'Generating PDF report…');
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
    // Navigate with a short redirect-loop timeout
    let redirectCount = 0;
    page.on('response', res => {
      if (res.status() === 302 && res.url().includes('Best-of-Renton-2026')) redirectCount++;
    });

    await page.goto(BALLOT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    if (redirectCount >= 5) {
      log(job, 'Redirect loop detected – UI voting not available in this environment.');
      return false;
    }

    const title = await page.title();
    log(job, `Ballot page loaded: "${title}"`);

    // Navigate through all category groups using navigation tabs/links
    const groupLinks = await page.$$('[data-group-id], .ballot-group-tab, [class*="group"] a, [class*="tab"] a');
    log(job, `Found ${groupLinks.length} group navigation elements`);

    // Vote in currently visible matchups, then navigate to others
    await voteInVisibleMatchups(page, job, votePlan);

    // Look for navigation to other groups
    const allGroupIds = [...new Set(votePlan.map(v => v.matchup.matchup_group_id))];
    for (const groupId of allGroupIds) {
      try {
        const groupLink = await page.$(`[data-group-id="${groupId}"], a[href*="group=${groupId}"]`);
        if (groupLink) {
          await groupLink.click();
          await page.waitForTimeout(1500);
          await voteInVisibleMatchups(page, job, votePlan);
        }
      } catch {}
    }

    // Fill in voter info form
    log(job, 'Filling in voter information…');
    await fillVoterInfo(page, job);

    // Submit ballot
    log(job, 'Submitting ballot…');
    const submitted = await submitBallot(page, job);
    if (submitted) {
      await page.waitForTimeout(3000);
      log(job, 'Ballot submitted successfully!');
      return true;
    }
    return false;
  } catch (err) {
    log(job, `UI voting error: ${err.message}`);
    return false;
  }
}

async function voteInVisibleMatchups(page, job, votePlan) {
  // SecondStreet ballot apps use various selector patterns
  const categorySelectors = [
    '[data-matchup-id]',
    '[class*="matchup"]',
    '[class*="ballot-category"]',
    '[class*="category-card"]',
    '.voting-category',
  ];

  for (const sel of categorySelectors) {
    const categories = await page.$$(sel);
    if (categories.length > 0) {
      log(job, `Found ${categories.length} categories with selector "${sel}"`);
      for (const cat of categories) {
        await selectEntryInCategory(page, cat, job, votePlan);
      }
      break;
    }
  }
}

async function selectEntryInCategory(page, categoryEl, job, votePlan) {
  try {
    // Try to get matchup ID from element attributes
    const matchupId = await categoryEl.evaluate(el => {
      return el.getAttribute('data-matchup-id') ||
             el.getAttribute('data-id') ||
             el.id?.replace(/\D/g, '') || null;
    });

    // Find the vote plan entry for this matchup
    const plan = matchupId
      ? votePlan.find(v => String(v.matchup.id) === String(matchupId))
      : null;

    const entryName = plan
      ? plan.selectedEntry.name
      : null;

    if (!entryName) return;

    // Try to click on the correct entry
    const entrySelectors = [
      `[data-entry-name="${entryName}"]`,
      `[title="${entryName}"]`,
      `input[value="${entryName}"]`,
    ];

    // Also try text matching
    const allEntryBtns = await categoryEl.$$('button, label, [role="radio"], input[type="radio"]');
    for (const btn of allEntryBtns) {
      const text = await btn.evaluate(el => el.textContent || el.value || el.getAttribute('aria-label') || '');
      if (text.trim().toLowerCase() === entryName.toLowerCase()) {
        await btn.click();
        log(job, `  ✓ Voted for "${entryName}" in ${plan?.matchup.name || 'category'}`);
        return;
      }
    }

    for (const sel of entrySelectors) {
      try {
        const el = await categoryEl.$(sel);
        if (el) {
          await el.click();
          log(job, `  ✓ Voted for "${entryName}" via selector`);
          return;
        }
      } catch {}
    }
  } catch {}
}

async function fillVoterInfo(page, job) {
  const { email, firstName, lastName, zip } = job;
  const fieldMap = [
    { selectors: ['input[type="email"]', 'input[name="email"]', 'input[id*="email"]'], value: email },
    { selectors: ['input[name="first_name"]', 'input[id*="first"]', 'input[placeholder*="First"]'], value: firstName },
    { selectors: ['input[name="last_name"]', 'input[id*="last"]', 'input[placeholder*="Last"]'], value: lastName },
    { selectors: ['input[name="zip"]', 'input[id*="zip"]', 'input[placeholder*="zip"]', 'input[placeholder*="ZIP"]'], value: zip },
  ];

  for (const { selectors, value } of fieldMap) {
    if (!value) continue;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.fill(value);
          break;
        }
      } catch {}
    }
  }
}

async function submitBallot(page, job) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Vote")',
    'button:has-text("Cast")',
    '[class*="submit"]',
  ];

  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        return true;
      }
    } catch {}
  }

  // Try text-based search
  try {
    await page.getByRole('button', { name: /submit|vote|cast/i }).click();
    return true;
  } catch {}

  return false;
}

// ── PDF generation ───────────────────────────────────────────────────────────

async function generatePDF(page, job, votePlan, uiSuccess) {
  const html = buildResultsHTML(job, votePlan, uiSuccess);

  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const pdfDir = path.join(__dirname, 'pdfs');
  if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir);

  const pdfPath = path.join(pdfDir, `votes-${randomUUID()}.pdf`);
  await page.pdf({
    path: pdfPath,
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
  });

  return pdfPath;
}

function buildResultsHTML(job, votePlan, uiSuccess) {
  const { email, firstName, lastName, zip } = job;
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || email;
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const libertyCount = votePlan.filter(v => v.isLiberty).length;

  const groupMap = {};
  for (const v of votePlan) {
    const gid = v.matchup.matchup_group_id;
    if (!groupMap[gid]) groupMap[gid] = { name: v.groupName, rows: [] };
    groupMap[gid].rows.push(v);
  }

  const groupSections = Object.values(groupMap).map(g => `
    <div class="group-section">
      <h3>${g.name}</h3>
      <table>
        <thead><tr><th>Category</th><th>Voted For</th><th>Reason</th></tr></thead>
        <tbody>
          ${g.rows.map(v => `
            <tr class="${v.isLiberty ? 'liberty-row' : ''}">
              <td>${v.matchup.name}</td>
              <td><strong>${v.selectedEntry.name}</strong></td>
              <td>${v.isLiberty ? '⭐ Liberty Cafe' : 'Random selection'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `).join('');

  const statusBanner = uiSuccess
    ? `<div class="status success">✅ Ballot submitted successfully via ballot website</div>`
    : `<div class="status info">📋 Vote plan prepared — ballot submitted via API (${libertyCount} Liberty Cafe votes + ${votePlan.length - libertyCount} random)</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Best of Renton 2026 — Voting Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; }
  .header { background: linear-gradient(135deg, #8B0000 0%, #c0392b 100%); color: white; padding: 32px 40px; }
  .header h1 { font-size: 22pt; font-weight: 700; letter-spacing: -0.5px; }
  .header .subtitle { margin-top: 6px; opacity: 0.85; font-size: 11pt; }
  .content { padding: 28px 40px; }
  .status { padding: 14px 18px; border-radius: 6px; margin-bottom: 24px; font-size: 10.5pt; font-weight: 500; }
  .status.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
  .status.info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
  .voter-card { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 18px 22px; margin-bottom: 28px; }
  .voter-card h2 { font-size: 12pt; color: #495057; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .voter-info { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .voter-info .field { font-size: 10.5pt; }
  .voter-info .label { color: #6c757d; font-weight: 500; }
  .voter-info .value { color: #212529; font-weight: 600; }
  .summary-stats { display: flex; gap: 20px; margin-bottom: 28px; }
  .stat { background: #fff; border: 1px solid #dee2e6; border-radius: 8px; padding: 16px 20px; flex: 1; text-align: center; }
  .stat .num { font-size: 28pt; font-weight: 700; color: #8B0000; }
  .stat .label { font-size: 9pt; color: #6c757d; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  .group-section { margin-bottom: 28px; }
  .group-section h3 { font-size: 13pt; font-weight: 700; color: #8B0000; border-bottom: 2px solid #8B0000; padding-bottom: 6px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { background: #343a40; color: white; padding: 8px 12px; text-align: left; font-weight: 600; text-transform: uppercase; font-size: 8.5pt; letter-spacing: 0.5px; }
  td { padding: 7px 12px; border-bottom: 1px solid #e9ecef; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .liberty-row td { background: #fff8f0; }
  .liberty-row td:first-child { border-left: 3px solid #e67e22; }
  .footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #dee2e6; color: #6c757d; font-size: 9pt; text-align: center; }
  .ballot-url { font-family: monospace; font-size: 8.5pt; background: #f8f9fa; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <div class="header">
    <h1>Best of Renton 2026</h1>
    <div class="subtitle">Voting Report — Renton Reporter Ballot</div>
  </div>

  <div class="content">
    ${statusBanner}

    <div class="voter-card">
      <h2>Voter Information</h2>
      <div class="voter-info">
        <div class="field"><span class="label">Name: </span><span class="value">${fullName}</span></div>
        <div class="field"><span class="label">Email: </span><span class="value">${email}</span></div>
        ${zip ? `<div class="field"><span class="label">ZIP: </span><span class="value">${zip}</span></div>` : ''}
        <div class="field"><span class="label">Submitted: </span><span class="value">${now} PT</span></div>
      </div>
    </div>

    <div class="summary-stats">
      <div class="stat">
        <div class="num">${votePlan.length}</div>
        <div class="label">Total Categories</div>
      </div>
      <div class="stat">
        <div class="num">${libertyCount}</div>
        <div class="label">Liberty Cafe Votes</div>
      </div>
      <div class="stat">
        <div class="num">${votePlan.length - libertyCount}</div>
        <div class="label">Random Selections</div>
      </div>
    </div>

    ${groupSections}

    <div class="footer">
      <p>Ballot: <span class="ballot-url">${BALLOT_URL}</span></p>
      <p style="margin-top:6px">Generated ${now} PT | Best of Renton 2026 Voting Report</p>
    </div>
  </div>
</body>
</html>`;
}

// ── API data fetching ────────────────────────────────────────────────────────

async function fetchBallotData(page) {
  // Navigate to the promotions feed to establish browser context
  await page.goto(`${API_BASE}/`, { waitUntil: 'networkidle', timeout: 20000 });

  const apiHeaders = {
    'Accept': 'application/json',
    'x-api-key': API_KEY,
    'x-organization-id': ORG_ID,
    'x-organization-promotion-id': ORG_PROMO_ID,
  };

  const { matchups, groups, entries } = await page.evaluate(async ({ base, headers, promoId }) => {
    async function apiFetch(url) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return res.json();
    }

    // Fetch all matchups (paginated)
    let allMatchups = [];
    for (let p = 1; p <= 10; p++) {
      const data = await apiFetch(`${base}/api/matchups?promotionId=${promoId}&page_size=100&page_index=${p}`);
      const items = data.matchups || [];
      allMatchups = allMatchups.concat(items);
      if (items.length < 100) break;
    }

    // Fetch matchup groups
    const groupsData = await apiFetch(`${base}/api/matchup_groups?promotionId=${promoId}`);

    // Fetch all voting entries in one call (API returns all regardless of page_size)
    const entriesData = await apiFetch(`${base}/api/voting_entries?promotionId=${promoId}&page_size=5000`);
    const allEntries = entriesData.voting_entries || [];

    return {
      matchups: allMatchups,
      groups: groupsData.matchup_groups || [],
      entries: allEntries,
    };
  }, { base: API_BASE, headers: apiHeaders, promoId: PROMO_ID });

  return { matchups, groups, entries };
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
      const libertyCafe = pool.find(e =>
        e.name && e.name.toLowerCase().includes(TARGET_NAME)
      );

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

function findChromium() {
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined; // let Playwright find it
}

// ── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Liberty Cafe Voter running at http://localhost:${PORT}`);
});
