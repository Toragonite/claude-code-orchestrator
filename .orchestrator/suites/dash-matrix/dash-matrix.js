// Drive media/dashboard/preview.html through fixture x theme x width in a private headless
// Chrome over the DevTools protocol (no puppeteer): console errors, uncaught exceptions,
// horizontal overflow, the markup probe, missing strings, and an inventory of every element
// and attribute under #app. Screenshots land next to this file in shots/.
require('../lib/staged.js'); // refuses to run outside run.sh's staged copy and scratch HOME
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const SHOTS = path.join(__dirname, 'shots');
const PROFILE = path.join(__dirname, 'chrome-profile');
// The browser binary comes from run.sh (which looked for it, and prints SKIP when there is none).
const CHROME = process.env.CHROME;
if (!CHROME) { console.error('HARNESS ERROR no browser: CHROME is not set (run.sh sets it)'); process.exit(2); }
fs.mkdirSync(SHOTS, { recursive: true });

const FIXTURES = ['rich', 'claude-only', 'hostile', 'empty', 'all-logins-expired'];
const THEMES = ['dark', 'light', 'hc'];
const WIDTHS = [1400, 480];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the page. Returns a plain object.
const AUDIT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = document.getElementById('app');
  const ALLOWED = new Set(['div','span','p','h1','h2','h3','header','footer','section','article','main','nav','ul','ol','li','dl','dt','dd','button','input','select','option','label','svg','path','strong','aside','table','caption','thead','tbody','tr','th','td']);
  const inventory = () => {
    const tags = new Set(); const handlers = []; const odd = [];
    app.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED.has(tag)) { tags.add(tag); }
      for (const a of el.attributes) {
        if (/^on/i.test(a.name)) { handlers.push(tag + '[' + a.name + ']'); }
        if (a.name === 'autofocus' || a.name === 'href' || a.name === 'src' || a.name === 'srcdoc' || a.name === 'formaction') { odd.push(tag + '[' + a.name + ']'); }
      }
    });
    return { unexpectedTags: Array.from(tags), handlers, odd };
  };
  const overflow = () => {
    const w = window.innerWidth; const bad = [];
    // Offenders are listed only when the PAGE is wider than the window: text that is cut by
    // its own overflow-hidden cell is longer than the cell by design.
    if (document.documentElement.scrollWidth > w) app.querySelectorAll('.page *').forEach((el) => {
      if (el.closest('.vh') || el.classList.contains('vh') || el.closest('.cell-label') || el.closest('.prov-label') || el.classList.contains('seg-input')) { return; }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 0.5 && bad.length < 6) { bad.push(el.className + ' right=' + Math.round(r.right)); }
    });
    return { innerWidth: w, scrollWidth: document.documentElement.scrollWidth, offenders: bad };
  };
  const out = { title: document.title };
  out.mounted = !!app.querySelector('.page') || !!app.querySelector('.fatal') || !!app.querySelector('.skeleton');
  out.overflow = overflow();
  out.inventory = inventory();
  out.xss = !!window.__CCO_XSS__;
  out.missing = document.getElementById('pv-missing').textContent;
  out.counts = { accounts: app.querySelectorAll('.acct').length, tasks: app.querySelectorAll('.task').length, plates: app.querySelectorAll('.prov').length, taskBadges: Array.from(app.querySelectorAll('.tag-prov')).filter((n) => !n.hidden).length, providerChips: app.querySelectorAll('.filter-prov .filter-chip').length, providerRowShown: !!app.querySelector('.filter-prov') && !app.querySelector('.filter-prov').hidden, uniform: !!app.querySelector('.acct-grid.is-uniform'), legendShown: !!app.querySelector('.prov-legend') && !app.querySelector('.prov-legend').hidden, noRead: Array.from(app.querySelectorAll('.noread')).filter((n) => !n.hidden).length, meters: app.querySelectorAll('.meter').length };
  // Every card menu, opened and closed: what it lists, and whether opening made anything odd.
  const menus = []; let menuOverflow = 0;
  for (const btn of app.querySelectorAll('.acct .menu-wrap > .btn')) {
    if (btn.disabled) { continue; }
    btn.click(); await sleep(15);
    const menu = btn.parentNode.querySelector('.menu');
    if (menu) {
      menus.push(menu.children.length);
      const r = menu.getBoundingClientRect();
      if (r.left < -0.5 || r.right > window.innerWidth + 0.5) { menuOverflow += 1; }
    }
    btn.click(); await sleep(5);
  }
  out.menus = { opened: menus.length, items: menus.join(','), offscreen: menuOverflow };
  // The drawer.
  const gear = app.querySelector('.btn-settings');
  if (gear) {
    gear.click(); await sleep(260);
    const body = app.querySelector('.drawer-body');
    out.drawer = { open: !app.querySelector('.drawer-layer').hidden, bodyOverflow: body.scrollWidth - body.clientWidth, providerRows: app.querySelectorAll('.prov-table tbody tr').length, pollingChecked: (Array.from(app.querySelectorAll('.drawer .field-label')).map((l) => l.textContent)).length };
    out.afterDrawer = inventory();
    app.querySelector('.drawer-head .btn').click(); await sleep(60);
  }
  // K-SHELL: what a person reads on the gauges, on the alert of a logged-out card, under a stopped session,
  // and wherever a token count is printed
  const tokenTexts = Array.from(new Set(Array.from(app.querySelectorAll('.stat-sub, .cell-tokens')).map((n) => n.textContent.trim()).filter((x) => /\\d/.test(x) && x.indexOf('$') === -1))); // the same cells also hold costs; those are money, not tokens
  out.kshell = {
    meterLabels: Array.from(new Set(Array.from(app.querySelectorAll('.meter-label')).map((n) => n.textContent))),
    alerts: Array.from(app.querySelectorAll('.acct')).filter((n) => n.getAttribute('data-state') === 'expired').map((n) => (n.querySelector('.acct-name') || {}).textContent + ': ' + ((n.querySelector('.acct-alert-body') || {}).textContent || '')),
    stopped: Array.from(app.querySelectorAll('.sess')).filter((n) => n.getAttribute('data-status') === 'stopped').map((n) => Array.from(n.querySelectorAll('.sess-actions .btn')).filter((b) => !b.hidden).map((b) => b.textContent.trim()).join('+')),
    tokenTexts: tokenTexts.length,
    tokenSample: tokenTexts.slice(0, 8),
    // one format: exact (grouped digits) below 10,000, else at most three digits, one decimal and k / M / B / T / Q
    tokenBad: tokenTexts.filter((x) => (x.match(/\\d[\\d.,]*[A-Za-z]?/g) || []).some((n) => !/^(\\d{1,3}\\.\\d[kMBTQ]|\\d{1,3}(,\\d{3})?[a-z]?)$/.test(n) || /^\\d{1,2},?\\d{3}[kMBTQ]/.test(n))).slice(0, 8),
  };
  out.xssAfter = !!window.__CCO_XSS__;
  out.height = document.documentElement.scrollHeight;
  return out;
})()`;

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  // Port 0: the browser picks a free port and writes it to <profile>/DevToolsActivePort. A fixed port
  // could be one another browser on this machine is already listening on — and this script would
  // then drive THAT browser.
  // --use-mock-keychain: this browser runs under a redirected HOME, where macOS finds no default
  // keychain — without the flag the real Chrome asks the user's screen to create one ("A keychain
  // cannot be found to store Chrome"), once per launch.
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let version = null; let PORT = null;
  for (let i = 0; i < 80 && !version; i++) {
    await sleep(250);
    if (PORT === null) {
      try { const n = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (Number.isInteger(n) && n > 0) { PORT = n; } } catch (e) { /* not written yet */ }
    }
    if (PORT === null) { continue; }
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch (e) { /* not up yet */ }
  }
  if (!version) { chrome.kill(); throw new Error('chrome did not start'); }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0; const waiting = new Map(); let events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result); return; }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning' || msg.params.type === 'assert')) { events.push('console.' + msg.params.type + ': ' + msg.params.args.map((a) => a.value || a.description || a.type).join(' ').slice(0, 300)); }
    if (msg.method === 'Runtime.exceptionThrown') { events.push('exception: ' + JSON.stringify(msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || msg.params.exceptionDetails.text).slice(0, 400)); }
    if (msg.method === 'Log.entryAdded' && (msg.params.entry.level === 'error' || msg.params.entry.level === 'warning')) { events.push('log.' + msg.params.entry.level + ': ' + msg.params.entry.text.slice(0, 300)); }
  };
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

  const rows = []; let failures = 0;
  for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const fixture of FIXTURES) {
      for (const theme of THEMES) {
        const name = `${fixture}-${theme}-${width}`;
        if (ONLY && !ONLY.some((o) => name.includes(o))) { continue; }
        events = [];
        await send('Page.navigate', { url: `file://${ROOT}/media/dashboard/preview.html?fixture=${fixture}&theme=${theme}&bar=0` });
        await sleep(1100);
        const res = await send('Runtime.evaluate', { expression: AUDIT, awaitPromise: true, returnByValue: true });
        const a = res.result.value || { error: JSON.stringify(res.exceptionDetails || res.result).slice(0, 400) };
        await sleep(150);
        const clipHeight = Math.min(a.height || 1000, width === 1400 ? 2500 : 4200);
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: clipHeight, scale: 1 } });
        fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(shot.data, 'base64'));
        const problems = [];
        if (a.error) { problems.push('audit failed: ' + a.error); }
        if (events.length) { problems.push('console/exception: ' + events.join(' || ')); }
        if (a.overflow && (a.overflow.scrollWidth > a.overflow.innerWidth || a.overflow.offenders.length)) { problems.push('horizontal overflow: ' + JSON.stringify(a.overflow)); }
        if (a.xss || a.xssAfter) { problems.push('MARKUP PROBE FIRED'); }
        if (a.missing) { problems.push(a.missing); }
        for (const inv of [a.inventory, a.afterDrawer]) { if (inv && (inv.unexpectedTags.length || inv.handlers.length || inv.odd.length)) { problems.push('unexpected DOM: ' + JSON.stringify(inv)); } }
        if (a.kshell && a.kshell.tokenBad.length) { problems.push('token count not in the one format: ' + JSON.stringify(a.kshell.tokenBad)); }
        if (a.menus && a.menus.offscreen) { problems.push('menus off screen: ' + a.menus.offscreen); }
        if (a.drawer && a.drawer.bodyOverflow > 0) { problems.push('drawer overflows horizontally by ' + a.drawer.bodyOverflow); }
        if (problems.length) { failures += 1; }
        rows.push({ name, ok: problems.length === 0, counts: a.counts, menus: a.menus, drawer: a.drawer, problems });
        if (a.kshell && width === 1400 && theme === 'dark') { console.log('     kshell ' + fixture + ' ' + JSON.stringify(a.kshell)); }
        console.log((problems.length ? 'FAIL ' : 'ok   ') + name + ' ' + JSON.stringify(a.counts) + ' menus=' + JSON.stringify(a.menus) + ' drawer=' + JSON.stringify(a.drawer) + (problems.length ? '\n     ' + problems.join('\n     ') : ''));
      }
    }
  }
  console.log(`\n${rows.length - failures}/${rows.length} combinations clean`);
  ws.close(); chrome.kill();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
