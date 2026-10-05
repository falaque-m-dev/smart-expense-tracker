const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.env.E2E_URL || 'file://' + path.resolve(__dirname, '..', 'index.html');
const port = 9338;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-qa-'));
const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-qa-dl-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}
async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await res.json()).find(t => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('no target');
}

const seed = `
  const now = Date.now();
  const mk = (id, amount, category, date, description, paymentMethod) =>
    ({ id, amount, category, date, description, paymentMethod, createdAt: now - Number(id) });
  localStorage.setItem('iq_expenses_v2', JSON.stringify([
    mk('1', 84.32,  'Food & Dining', '2026-10-05', 'Whole Foods Market', 'Card'),
    mk('2', 42.50,  'Transport',     '2026-10-04', 'Uber ride to airport', 'UPI'),
    mk('3', 129.99, 'Shopping',      '2026-10-03', 'Running shoes', 'Card'),
    mk('4', 31.00,  'Entertainment', '2026-10-02', 'Cinema tickets', 'Cash'),
    mk('5', 96.75,  'Utilities',     '2026-10-01', 'Electricity bill', 'Net Banking'),
    mk('6', 18.40,  'Food & Dining', '2026-09-30', 'Coffee beans', 'UPI')
  ]));
  localStorage.setItem('iq_budget_v2', '2500');
  localStorage.setItem('iq_currency', 'USD');
  localStorage.setItem('iq_theme', 'light');
`;

function listFiles() { return fs.readdirSync(dl).filter(f => !f.endsWith('.crdownload')); }
function clearDownloads() {
  for (const f of fs.readdirSync(dl)) { try { fs.unlinkSync(path.join(dl, f)); } catch {} }
}
async function waitFile(pattern, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = listFiles().find(f => pattern.test(f));
    if (hit) {
      const full = path.join(dl, hit);
      let last = -1;
      for (let i = 0; i < 25; i++) {
        const s = fs.existsSync(full) ? fs.statSync(full).size : 0;
        if (s > 0 && s === last) return full;
        last = s;
        await sleep(200);
      }
      return full;
    }
    await sleep(200);
  }
  return null;
}

async function main() {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push('uncaught: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(resolve => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise(r => ws.onopen = r);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });

  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    }
    return r.result.result.value;
  }
  async function waitFor(expr, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await sleep(150);
    }
    return false;
  }
  const js = s => JSON.parse(s);
  async function setViewport(w, h) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
  }

  await send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete'`);
  await sleep(400);

  // Corrupt storage must not break the app — invalid records are dropped
  await ev(`localStorage.setItem('iq_expenses_v2', JSON.stringify([
    { id: 5, amount: 'x', category: null, date: 'nope' },
    null,
    { id: 'ok', amount: 10, category: 'Other', date: '2026-09-01' }
  ]))`);
  await send('Page.reload');
  await waitFor(`document.readyState === 'complete'`);
  await sleep(500);
  const corruptCount = await ev(`document.getElementById('txCount').textContent`);
  check('Corrupt localStorage recovers to valid records only', corruptCount === '1', 'count=' + corruptCount);

  // Cross-tab sync: storage written by another tab re-renders this one
  await ev(`localStorage.setItem('iq_expenses_v2', JSON.stringify([
    { id: 'x1', amount: 1, category: 'Other', date: '2026-09-01' }
  ]));
  window.dispatchEvent(new StorageEvent('storage', { key: 'iq_expenses_v2' }))`);
  await sleep(300);
  const syncCount = await ev(`document.getElementById('txCount').textContent`);
  check('Cross-tab storage change re-renders', syncCount === '1', 'count=' + syncCount);

  await ev(seed);
  await send('Page.reload');
  await waitFor(`document.readyState === 'complete'`);
  await sleep(700);

  // ════════════ FUNCTIONAL: CONTROLS ════════════
  console.log('\n── Controls & buttons ──');

  // Currency rates
  check('Rates fetch live (currency status)', await waitFor(`document.getElementById('currencyStatusText').textContent === 'Live rates'`, 8000), await ev(`document.getElementById('currencyStatusText').textContent`));

  check('Amount input labelled as USD', /Amount \(USD\)/.test(await ev(`document.querySelector('label[for="amount"]').textContent.replace(/\\s+/g, ' ').trim()`)), await ev(`document.querySelector('label[for="amount"]').textContent.replace(/\\s+/g, ' ').trim()`));

  // Live-site readiness
  const live = js(await ev(`JSON.stringify({
    description: document.querySelector('meta[name="description"]')?.content || '',
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
    sri: document.querySelector('script[integrity]')?.getAttribute('integrity') || '',
    icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || '',
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '',
    apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || ''
  })`));
  check('Meta description present', live.description.length > 40, live.description.slice(0, 50));
  check('CSP present with script hash', /script-src[^;]*sha256-/.test(live.csp), live.csp.slice(0, 60));
  check('CDN script pinned with SRI', /^sha384-/.test(live.sri), live.sri.slice(0, 24) + '...');
  check('Favicon + manifest + touch icon linked', !!live.icon && !!live.manifest && !!live.apple, `${live.icon} ${live.manifest} ${live.apple}`);

  if (/^https?:/.test(url)) {
    const assetStatus = await ev(`Promise.all(['manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','sw.js']
      .map(f => fetch(f).then(r => r.status))).then(list => list.join(','))`);
    check('PWA assets served (200)', assetStatus === '200,200,200,200,200', assetStatus);

    const manName = await ev(`fetch('manifest.webmanifest').then(r => r.json()).then(m => m.name)`);
    check('Manifest is valid JSON with name', /ExpenseIQ/.test(manName || ''), manName);

    const swState = await ev(`Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise(res => setTimeout(() => res('timeout'), 12000))
    ])`);
    check('Service worker registers and activates', swState === 'ready', swState);
  } else {
    console.log('SKIP  PWA asset/service-worker checks (file:// run)');
  }

  // 1. Receipt parser + clear
  await ev(`document.getElementById('receiptText').value =
    'WALMART SUPERCENTER\\nDate: 09/15/2026\\nGroceries  $12.50\\nTOTAL: $47.93\\nThank you!';
    document.getElementById('parseReceiptBtn').click();`);
  await sleep(300);
  let d = js(await ev(`JSON.stringify({
    vis: !document.getElementById('parseResult').classList.contains('hidden'),
    amount: document.getElementById('amount').value,
    date: document.getElementById('date').value,
    desc: document.getElementById('description').value
  })`));
  check('Parser button parses receipt', d.vis && d.amount === '47.93' && d.date === '2026-09-15' && d.desc === 'WALMART SUPERCENTER', JSON.stringify(d));
  await ev(`document.getElementById('clearReceiptBtn').click()`);
  await sleep(150);
  d = js(await ev(`JSON.stringify({
    text: document.getElementById('receiptText').value,
    hidden: document.getElementById('parseResult').classList.contains('hidden'),
    amountKept: document.getElementById('amount').value
  })`));
  check('Parser clear button clears text/result', d.text === '' && d.hidden, JSON.stringify(d));

  // 2. Reset form button
  await ev(`document.getElementById('description').value = 'temp';
    document.getElementById('amount').value = '9.99';
    document.getElementById('resetFormBtn').click();`);
  await sleep(150);
  d = js(await ev(`JSON.stringify({
    amount: document.getElementById('amount').value,
    desc: document.getElementById('description').value,
    date: document.getElementById('date').value,
    label: document.getElementById('resetFormBtn').textContent
  })`));
  check('Cancel/reset form button resets fields', d.amount === '' && d.desc === '' && d.date.length === 10 && d.label === 'Cancel', JSON.stringify(d));

  // 3. Submit add expense
  await ev(`document.getElementById('amount').value = '50';
    document.getElementById('category').value = 'Transport';
    document.getElementById('paymentMethod').value = 'Cash';
    document.getElementById('date').value = '2026-10-05';
    document.getElementById('description').value = 'Bus pass';
    document.getElementById('expenseForm').requestSubmit();`);
  await sleep(300);
  d = js(await ev(`JSON.stringify({
    count: document.getElementById('txCount').textContent,
    total: document.getElementById('totalSpent').textContent
  })`));
  check('Submit button adds expense', d.count === '7' && d.total === '$452.96', JSON.stringify(d));

  // 4. Table Edit button
  await ev(`document.querySelector('#expenseTableBody .btn-row-edit').click()`);
  await sleep(200);
  d = js(await ev(`JSON.stringify({
    label: document.getElementById('submitLabel').textContent,
    cancelLabel: document.getElementById('resetFormBtn').textContent,
    amount: document.getElementById('amount').value
  })`));
  check('Edit button opens row in form', d.label === 'Update Expense' && d.cancelLabel === 'Cancel edit' && d.amount !== '', JSON.stringify(d));
  await ev(`document.getElementById('amount').value = '88.88';
    document.getElementById('expenseForm').requestSubmit();`);
  await sleep(300);
  d = js(await ev(`JSON.stringify({
    label: document.getElementById('submitLabel').textContent,
    total: document.getElementById('totalSpent').textContent
  })`));
  check('Update submits and exits edit mode', d.label === 'Add Expense' && d.total === '$491.84', JSON.stringify(d));

  // 5. Delete button: cancel path (modalCancelBtn + Escape) then confirm
  let countBefore = await ev(`document.getElementById('txCount').textContent`);
  await ev(`(() => { const b = document.querySelector('#expenseTableBody .btn-row-delete'); b.focus(); b.click(); return true; })()`);
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  await sleep(150);
  check('Modal focuses cancel button on open', (await ev(`document.activeElement.id`)) === 'modalCancelBtn', await ev(`document.activeElement.id`));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
  await sleep(100);
  check('Tab is trapped inside the modal', (await ev(`document.activeElement.id`)) === 'modalConfirmBtn', await ev(`document.activeElement.id`));
  await ev(`document.getElementById('modalCancelBtn').click()`);
  await sleep(200);
  check('Focus returns to trigger after modal closes', /btn-row-delete/.test(await ev(`document.activeElement.className`)), await ev(`document.activeElement.className`));
  let countAfter = await ev(`document.getElementById('txCount').textContent`);
  check('Modal cancel button keeps data', countBefore === countAfter, `${countBefore} → ${countAfter}`);

  await ev(`document.querySelector('#expenseTableBody .btn-row-delete').click()`);
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  countAfter = await ev(`document.getElementById('txCount').textContent`);
  check('Escape key closes modal without deleting', countBefore === countAfter, `${countBefore} → ${countAfter}`);

  await ev(`document.querySelector('#expenseTableBody .btn-row-delete').click()`);
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  await ev(`document.getElementById('modalConfirmBtn').click()`);
  await sleep(250);
  countAfter = await ev(`document.getElementById('txCount').textContent`);
  check('Modal confirm deletes row', Number(countAfter) === Number(countBefore) - 1, `${countBefore} → ${countAfter}`);

  // 6. Budget edit (Enter + blur)
  await ev(`(() => {
    document.getElementById('editBudgetBtn').click();
    const b = document.getElementById('budgetInput');
    b.value = '1000';
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  check('Budget edit button + Enter commits', (await ev(`document.getElementById('budgetDisplay').textContent`)) === '$1,000.00', await ev(`document.getElementById('budgetDisplay').textContent`));
  await ev(`(() => {
    document.getElementById('editBudgetBtn').click();
    const b = document.getElementById('budgetInput');
    b.value = '2500';
    b.dispatchEvent(new Event('blur'));
    return true;
  })()`);
  await sleep(400);
  check('Budget commits on blur too', (await ev(`document.getElementById('budgetDisplay').textContent`)) === '$2,500.00', await ev(`document.getElementById('budgetDisplay').textContent`));

  // 7. Search + filters + sort
  await ev(`(() => { const s = document.getElementById('searchInput'); s.value = 'coffee'; s.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(250);
  check('Search filters rows', (await ev(`document.querySelectorAll('#expenseTableBody tr').length`)) === 1);
  await ev(`(() => { const s = document.getElementById('searchInput'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);

  await ev(`(() => { const s = document.getElementById('filterPayment'); s.value = 'UPI'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(200);
  rows = await ev(`[...document.querySelectorAll('#expenseTableBody tr')].map(r => r.textContent).join('|')`);
  check('Payment filter works', rows.length > 0 && rows.split('|').every(r => /UPI/.test(r)), rows.split('|').length + ' rows');
  await ev(`(() => { const s = document.getElementById('filterPayment'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);

  await ev(`(() => { const s = document.getElementById('filterCategory'); s.value = 'Transport'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(200);
  rows = await ev(`[...document.querySelectorAll('#expenseTableBody tr')].map(r => r.textContent).join('|')`);
  check('Category filter works', rows.length > 0 && rows.split('|').every(r => /Transport/.test(r)), rows.split('|').length + ' rows');
  await ev(`(() => { const s = document.getElementById('filterCategory'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);

  await ev(`(() => { const s = document.getElementById('sortBy'); s.value = 'amount-desc'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(200);
  check('Sort high→low works', /Running shoes/.test(await ev(`document.querySelector('#expenseTableBody tr').textContent`)));
  await ev(`(() => { const s = document.getElementById('sortBy'); s.value = 'amount-asc'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(200);
  check('Sort low→high works', /Coffee beans/.test(await ev(`document.querySelector('#expenseTableBody tr').textContent`)));
  await ev(`(() => { const s = document.getElementById('sortBy'); s.value = 'date-desc'; s.dispatchEvent(new Event('change')); return true; })()`);

  // 8. Empty state messaging when filters match nothing
  await ev(`(() => { const s = document.getElementById('filterCategory'); s.value = 'Housing'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(200);
  d = js(await ev(`JSON.stringify({
    title: document.getElementById('emptyTitle').textContent,
    body: document.getElementById('emptyBody').textContent,
    shown: !document.getElementById('emptyState').classList.contains('hidden')
  })`));
  check('Empty state reflects active filters', d.shown && d.title === 'No matching expenses', JSON.stringify(d));
  await ev(`(() => { const s = document.getElementById('filterCategory'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);

  // 9. Theme toggle twice
  const t0 = await ev(`document.documentElement.getAttribute('data-theme')`);
  await ev(`document.getElementById('themeToggleBtn').click()`);
  await sleep(150);
  const t1 = await ev(`document.documentElement.getAttribute('data-theme')`);
  await ev(`document.getElementById('themeToggleBtn').click()`);
  await sleep(150);
  const t2 = await ev(`document.documentElement.getAttribute('data-theme')`);
  check('Theme toggle button toggles both ways', t0 !== t1 && t2 === t0 && (await ev(`localStorage.getItem('iq_theme')`)) === t0, `${t0} → ${t1} → ${t2}`);

  // 10. Currency selector all options
  let currencyOk = true, currencyLog = [];
  for (const cur of ['EUR', 'GBP', 'INR', 'USD']) {
    await ev(`(() => { const s = document.getElementById('currencySelect'); s.value = '${cur}'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(200);
    const total = await ev(`document.getElementById('totalSpent').textContent`);
    const sym = { EUR: '€', GBP: '£', INR: '₹', USD: '$' }[cur];
    currencyLog.push(`${cur}:${total}`);
    if (!total.includes(sym)) currencyOk = false;
  }
  check('Currency selector converts to EUR/GBP/INR/USD', currencyOk, currencyLog.join(' '));

  // 11. Nav links scroll + active state
  check('Nav links set active section', await (async () => {
    await ev(`document.querySelector('.nav-item[data-section="section-history"]').click()`);
    return await waitFor(`document.querySelector('.nav-item[data-section="section-history"]').classList.contains('active')`, 4000)
      && (await ev(`window.scrollY`)) > 100;
  })());
  await ev(`window.scrollTo({ top: 0, behavior: 'auto' })`);
  await sleep(400);

  // ════════════ FUNCTIONAL: EXPORTS ════════════
  console.log('\n── Export & backup ──');

  clearDownloads();
  await ev(`document.getElementById('exportCsvBtn').click()`);
  let f = await waitFile(/\.csv$/i);
  check('CSV export downloads file', !!f, f ? path.basename(f) : 'none');
  if (f) {
    const lines = fs.readFileSync(f, 'utf8').split('\r\n');
    check('CSV content valid', lines.length === 7 && lines[0].includes('Payment Method'), `lines=${lines.length}`);
  }

  clearDownloads();
  await ev(`document.getElementById('backupJsonBtn').click()`);
  f = await waitFile(/\.json$/i);
  check('JSON backup downloads valid data', (() => {
    if (!f) return false;
    try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) && a.length === 6; } catch { return false; }
  })(), f ? path.basename(f) : 'none');

  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-bad-'));
  const badFile = path.join(badDir, 'bad.json');
  fs.writeFileSync(badFile, '{not json');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#restoreJsonInput' });
  await send('DOM.setFileInputFiles', { files: [badFile], nodeId: node.result.nodeId });
  await sleep(500);
  check('Restore rejects invalid JSON', /Invalid JSON/.test(await ev(`document.getElementById('toast').textContent`)), await ev(`document.getElementById('toast').textContent`));

  const restoreFile = path.join(badDir, 'good.json');
  fs.writeFileSync(restoreFile, JSON.stringify([
    { id: 'a1', amount: 20, category: 'Health', date: '2026-09-10', description: 'Restored A' },
    { id: 'a2', amount: 5, category: 'Other', date: '2026-09-11' },
  ]));
  await send('DOM.setFileInputFiles', { files: [restoreFile], nodeId: node.result.nodeId });
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  await ev(`document.getElementById('modalConfirmBtn').click()`);
  await sleep(400);
  d = js(await ev(`JSON.stringify({
    count: document.getElementById('txCount').textContent,
    stored: JSON.parse(localStorage.getItem('iq_expenses_v2')).length
  })`));
  check('Restore button/input restores backup', d.count === '2' && d.stored === 2, JSON.stringify(d));

  const libOk = await waitFor(`typeof html2pdf !== 'undefined'`, 15000);
  clearDownloads();
  await ev(`document.getElementById('exportPdfBtn').click()`);
  f = await waitFile(/\.pdf$/i, 60000);
  check('PDF export downloads valid file', !!f && fs.readFileSync(f).slice(0, 4).toString() === '%PDF', f ? path.basename(f) : 'none');
  await sleep(500);

  // ════════════ CSV HARDENING ════════════
  console.log('\n── CSV edge cases ──');
  const trickyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-tricky-'));
  const trickyFile = path.join(trickyDir, 'tricky.json');
  fs.writeFileSync(trickyFile, JSON.stringify([
    { id: 't1', amount: 12.34, category: 'Other', date: '2026-09-01', description: '=SUM(A1:A2)', paymentMethod: 'Other' },
    { id: 't2', amount: 56.78, category: 'Food & Dining', date: '2026-09-02', description: 'Comma, quote " and\nnewline ₹', paymentMethod: 'Cash' },
  ]));
  await send('DOM.setFileInputFiles', { files: [trickyFile], nodeId: node.result.nodeId });
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  await ev(`document.getElementById('modalConfirmBtn').click()`);
  await sleep(400);
  clearDownloads();
  await ev(`document.getElementById('exportCsvBtn').click()`);
  f = await waitFile(/\.csv$/i);
  check('CSV: exported tricky data', !!f, f ? path.basename(f) : 'none');
  if (f) {
    const txt = fs.readFileSync(f, 'utf8');
    check('CSV: UTF-8 BOM present', txt.charCodeAt(0) === 0xFEFF, 'code=' + txt.charCodeAt(0));
    check('CSV: formula injection guarded', txt.includes("'=SUM(A1:A2)"), (txt.split('\r\n').find(l => l.includes('SUM')) || '').slice(0, 40));
    check('CSV: commas/quotes/newlines escaped + unicode intact', txt.includes('"Comma, quote "" and\nnewline ₹"'), 'checked');
  }

  // ════════════ ALIGNMENT ACROSS WIDTHS ════════════
  console.log('\n── Alignment across viewports ──');
  const widths = [
    { w: 1920, h: 1000, desktop: true,  cols: 4 },
    { w: 1440, h: 900,  desktop: true,  cols: 4 },
    { w: 1280, h: 900,  desktop: true,  cols: 4 },
    { w: 1024, h: 800,  desktop: true,  cols: 2 },
    { w: 900,  h: 800,  desktop: true,  cols: 2 },
    { w: 769,  h: 800,  desktop: true,  cols: 2 },
    { w: 768,  h: 800,  desktop: false, cols: 2 },
    { w: 520,  h: 800,  desktop: false, cols: 2 },
    { w: 390,  h: 780,  desktop: false, cols: 2 },
  ];
  for (const { w, h, desktop, cols } of widths) {
    await setViewport(w, h);
    d = js(await ev(`(() => {
      const q = s => document.querySelector(s);
      const r = el => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) }; };
      const cw = document.documentElement.clientWidth;
      const ch = document.documentElement.clientHeight;
      const m = r(q('.main-content')), dk = r(q('.sidebar'));
      return JSON.stringify({
        vw: cw, vh: ch,
        overflow: document.documentElement.scrollWidth - cw,
        mainL: m.l, mainR: cw - m.r,
        dockL: dk.l, dockR: dk.r, dockCenter: Math.round(dk.l + dk.w / 2), dockBottomGap: ch - dk.b, dockTop: dk.t,
        dockScrollW: q('.sidebar').scrollWidth, dockClientW: q('.sidebar').clientWidth,
        topbar: getComputedStyle(q('.mobile-topbar')).display,
        cols: getComputedStyle(q('.metrics-grid')).gridTemplateColumns.trim().split(/\\s+/).length,
        btnCenterMax: Math.max(...[...document.querySelectorAll('.export-card .btn')].map(btn => {
          const c = btn.closest('.export-card').getBoundingClientRect();
          const b = btn.getBoundingClientRect();
          return Math.abs((c.left + c.width / 2) - (b.left + b.width / 2));
        })),
        btnTextMax: Math.max(...[...document.querySelectorAll('.export-card .btn')].map(btn => {
          const b = btn.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(btn);
          const t = range.getBoundingClientRect();
          return Math.abs((b.top + b.height / 2) - (t.top + t.height / 2));
        }))
      });
    })()`));
    const label = `${w}x${h}`;
    const centered = Math.abs(d.mainL - d.mainR) <= 1;
    const dockCentered = Math.abs(d.dockCenter - Math.round(d.vw / 2)) <= 1;
    const dockInView = d.dockL >= 0 && d.dockR <= d.vw;
    const expectedTopbar = desktop ? 'none' : 'flex';
    check(`Layout @${label}: no overflow, main centered`, d.overflow <= 0 && centered, `ovf=${d.overflow} L=${d.mainL} R=${d.mainR}`);
    check(`Layout @${label}: metrics ${cols} col`, d.cols === cols, `cols=${d.cols}`);
    check(`Layout @${label}: export buttons centered`, d.btnCenterMax <= 1 && d.btnTextMax <= 1, `h<=${d.btnCenterMax} v<=${d.btnTextMax}`);
    if (desktop) {
      check(`Layout @${label}: dock bottom-centered`, dockCentered && d.dockBottomGap === 24 && dockInView && d.topbar === expectedTopbar, `cx=${d.dockCenter}/${w} bottom=${d.dockBottomGap} topbar=${d.topbar}`);
      check(`Layout @${label}: dock fits without inner scroll`, d.dockScrollW <= d.dockClientW + 1, `scrollW=${d.dockScrollW} clientW=${d.dockClientW}`);
    } else {
      check(`Layout @${label}: drawer hidden + topbar shown`, d.dockL === -224 && d.topbar === expectedTopbar, `sidebarX=${d.dockL} topbar=${d.topbar}`);
    }
  }

  // Dock never covers content at page bottom (desktop)
  await setViewport(1440, 900);
  await ev(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(600);
  d = js(await ev(`(() => {
    const secs = [...document.querySelectorAll('.page-section')];
    const last = secs[secs.length - 1].getBoundingClientRect();
    const dock = document.querySelector('.sidebar').getBoundingClientRect();
    return JSON.stringify({ lastBottom: Math.round(last.bottom), dockTop: Math.round(dock.top) });
  })()`));
  check('Dock does not cover the last section at page bottom', d.lastBottom <= d.dockTop, `last=${d.lastBottom} dockTop=${d.dockTop}`);
  await ev(`window.scrollTo(0, 0)`);
  await sleep(400);

  // Modal alignment + padding
  await ev(`document.querySelector('#expenseTableBody .btn-row-delete').click()`);
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  await sleep(300);
  d = js(await ev(`(() => {
    const m = document.querySelector('.modal').getBoundingClientRect();
    const title = document.querySelector('.modal-title');
    const range = document.createRange();
    range.selectNodeContents(title);
    const tr = range.getBoundingClientRect();
    const btns = [...document.querySelectorAll('.modal-actions .btn')];
    const last = btns[btns.length - 1].getBoundingClientRect();
    return JSON.stringify({
      mx: Math.round(m.left + m.width / 2), my: Math.round(m.top + m.height / 2),
      vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
      titlePadL: Math.round(tr.left - m.left), titlePadT: Math.round(tr.top - m.top),
      actionsPadB: Math.round(m.bottom - last.bottom), actionsPadR: Math.round(m.right - last.right)
    });
  })()`));
  check('Modal is centered', Math.abs(d.mx - Math.round(d.vw / 2)) <= 1 && Math.abs(d.my - Math.round(d.vh / 2)) <= 1, `(${d.mx},${d.my}) vs (${d.vw / 2},${d.vh / 2})`);
  check('Modal has proper inner padding', d.titlePadL >= 20 && d.titlePadT >= 20 && d.actionsPadB >= 20 && d.actionsPadR >= 20, `L=${d.titlePadL} T=${d.titlePadT} B=${d.actionsPadB} R=${d.actionsPadR}`);
  await ev(`document.getElementById('modalCancelBtn').click()`);
  await sleep(200);

  // Mobile drawer interaction at 390
  await setViewport(390, 780);
  await ev(`document.getElementById('menuToggle').click()`);
  await sleep(400);
  d = js(await ev(`JSON.stringify({
    open: document.getElementById('sidebar').classList.contains('open'),
    expanded: document.getElementById('menuToggle').getAttribute('aria-expanded'),
    overlay: document.getElementById('sidebarOverlay').classList.contains('visible'),
    sidebarL: Math.round(document.getElementById('sidebar').getBoundingClientRect().left)
  })`));
  check('Mobile menu button opens drawer', d.open && d.expanded === 'true' && d.overlay && d.sidebarL === 0, JSON.stringify(d));
  await ev(`document.getElementById('sidebarOverlay').click()`);
  await sleep(400);
  d = js(await ev(`JSON.stringify({
    open: document.getElementById('sidebar').classList.contains('open'),
    overlay: document.getElementById('sidebarOverlay').classList.contains('visible'),
    sidebarL: Math.round(document.getElementById('sidebar').getBoundingClientRect().left)
  })`));
  check('Overlay tap closes drawer', !d.open && !d.overlay && d.sidebarL === -224, JSON.stringify(d));
  await send('Emulation.clearDeviceMetricsOverride');

  // ════════════ FUNCTIONAL: CLEAR ALL LAST ════════════
  console.log('\n── Clear all ──');
  await sleep(300);
  await ev(`document.getElementById('clearAllBtn').click()`);
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  d = js(await ev(`JSON.stringify({
    title: document.getElementById('modalTitle').textContent,
    label: document.getElementById('modalConfirmBtn').textContent
  })`));
  check('Clear-all modal titled correctly', d.title === 'Clear all expenses?' && d.label === 'Clear all', JSON.stringify(d));
  await ev(`document.getElementById('modalCancelBtn').click()`);
  await sleep(200);
  check('Clear-all cancel keeps data', (await ev(`document.getElementById('txCount').textContent`)) === '2');
  await ev(`document.getElementById('clearAllBtn').click()`);
  await waitFor(`!document.getElementById('modalBackdrop').classList.contains('hidden')`);
  await ev(`document.getElementById('modalConfirmBtn').click()`);
  await sleep(300);
  d = js(await ev(`JSON.stringify({
    count: document.getElementById('txCount').textContent,
    title: document.getElementById('emptyTitle').textContent,
    stored: JSON.parse(localStorage.getItem('iq_expenses_v2')).length
  })`));
  check('Clear-all button empties app', d.count === '0' && d.stored === 0 && d.title === 'No expenses yet', JSON.stringify(d));

  // ════════════ Summary ════════════
  check('No uncaught JS/console errors during entire run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');
  const fails = results.filter(r => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
  if (fails.length) {
    console.log('Failures:');
    fails.forEach(x => console.log('  - ' + x.name));
  }
  ws.close();
  chrome.kill();
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('ERROR:', e.message); chrome.kill(); process.exit(2); });
