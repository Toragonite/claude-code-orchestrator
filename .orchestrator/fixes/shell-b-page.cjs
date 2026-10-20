// The page half of shell-b.cjs: the dashboard page (through media/dashboard/preview.html and its
// fixtures) and the Asset Manager page (the document the host generates), driven in a private
// headless Chrome over the DevTools protocol. No puppeteer: Node's own fetch and WebSocket.
//
// Called by shell-b.cjs's P1-page case:  run({ media, assetFile, scratch, check })
// The browser gets its own profile directory under `scratch` and a port of its own, loads only
// file:// pages, and is killed at the end.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p) => typeof p === 'string' && p !== '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startChrome(scratch) {
  const binary = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!binary) {
    return undefined;
  }
  const profile = path.join(scratch, 'chrome-profile');
  const port = 20000 + Math.floor(Math.random() * 20000);
  // --use-mock-keychain: this browser runs under a redirected HOME, where macOS finds no default
  // keychain — without the flag the real Chrome asks the user's screen to create one ("A keychain
  // cannot be found to store Chrome"), once per launch.
  const proc = spawn(binary, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    await sleep(250);
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      /* not up yet */
    }
  }
  if (!version) {
    proc.kill('SIGKILL');
    throw new Error('headless Chrome did not start');
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const waiting = new Map();
  const browser = { events: [], version: version.Browser };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
      else w.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning' || msg.params.type === 'assert')) {
      browser.events.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value || a.description || a.type).join(' ').slice(0, 300)}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      browser.events.push(`exception: ${JSON.stringify((msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description) || msg.params.exceptionDetails.text).slice(0, 400)}`);
    }
    if (msg.method === 'Log.entryAdded' && (msg.params.entry.level === 'error' || msg.params.entry.level === 'warning')) {
      browser.events.push(`log.${msg.params.entry.level}: ${msg.params.entry.text.slice(0, 300)}`);
    }
  };
  browser.send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  /** Evaluate an expression (it may be a promise) and return its JSON value. */
  browser.evaluate = async (expression) => {
    const res = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`page evaluation failed: ${JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text).slice(0, 500)}`);
    }
    return res.result.value;
  };
  browser.open = async (url, width, settleMs = 1000) => {
    browser.events = [];
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url });
    await sleep(settleMs);
  };
  browser.close = async () => {
    try { ws.close(); } catch { /* already closed */ }
    proc.kill('SIGKILL');
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  };
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Log.enable');
  return browser;
}

/* ---- what is read off the dashboard page ---- */

// Runs inside the page: everything a check needs, as plain data.
const DASHBOARD_AUDIT = `(() => {
  const app = document.getElementById('app');
  const ALLOWED = new Set(['div','span','p','h1','h2','h3','header','footer','section','article','main','nav','ul','ol','li','dl','dt','dd','button','input','select','option','label','svg','path','strong','aside','table','caption','thead','tbody','tr','th','td']);
  const tags = new Set(); const handlers = []; const odd = [];
  app.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED.has(tag)) tags.add(tag);
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) handlers.push(tag + '[' + a.name + ']');
      if (['autofocus', 'href', 'src', 'srcdoc', 'formaction', 'style'].includes(a.name) && !(a.name === 'style' && /^--/.test(a.value.trim()))) odd.push(tag + '[' + a.name + ']');
    }
  });
  const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  const box = app.querySelector('.sec-accounts .unsupported');
  const list = box ? box.querySelector('.unsupported-list') : null;
  const banner = app.querySelector('.banners .callout.is-error');
  const registry = Array.from(app.querySelectorAll('.banners .callout')).find((c) => Array.from(c.querySelectorAll('button')).length > 0 && c.classList.contains('is-error'));
  const w = window.innerWidth;
  const wide = [];
  if (document.documentElement.scrollWidth > w) app.querySelectorAll('.page *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > w + 0.5 && wide.length < 5 && !el.closest('.vh') && !el.classList.contains('vh')) wide.push(el.className + ' right=' + Math.round(r.right));
  });
  return {
    mounted: !!app.querySelector('.page'),
    xss: !!window.__CCO_XSS__,
    missing: document.getElementById('pv-missing').textContent,
    unexpectedTags: Array.from(tags), handlers, odd,
    images: document.querySelectorAll('#app img, #app script, #app iframe, #app object, #app embed').length,
    overflow: { innerWidth: w, scrollWidth: document.documentElement.scrollWidth, offenders: wide },
    accounts: app.querySelectorAll('.acct').length,
    onboarding: !!app.querySelector('.onboard'),
    unsupported: box ? {
      shown: visible(box),
      title: (box.querySelector('.callout-title') || {}).textContent,
      body: (box.querySelector('.callout-body') || {}).textContent,
      items: Array.from(list.children).map((li) => ({ tag: li.tagName, kids: Array.from(li.children).map((c) => c.tagName + '.' + c.className), texts: Array.from(li.children).map((c) => c.textContent) })),
      elements: list.querySelectorAll('*').length,
      buttons: box.querySelectorAll('button, a, input').length,
      width: Math.round(box.getBoundingClientRect().width),
      background: getComputedStyle(box).backgroundColor,
      color: getComputedStyle(box).color,
    } : null,
    registry: registry ? {
      shown: visible(registry),
      title: (registry.querySelector('.callout-title') || {}).textContent,
      body: (registry.querySelector('.callout-body') || {}).textContent,
      buttons: Array.from(registry.querySelectorAll('button')).map((b) => b.textContent.trim()),
      elements: registry.querySelectorAll('*').length,
      background: getComputedStyle(registry).backgroundColor,
      color: getComputedStyle(registry).color,
    } : null,
    errorBanners: banner ? app.querySelectorAll('.banners .callout.is-error:not([hidden])').length : 0,
  };
})()`;

const previewUrl = (media, query) => `file://${path.join(media, 'preview.html')}?${query}`;

async function dashboardNotices(browser, media, check) {
  const IMG = '<img src=x onerror="window.__CCO_XSS__=1">';
  const seen = {};
  for (const fixture of ['unsupported-entries', 'registry-unreadable', 'hostile', 'rich']) {
    for (const theme of ['dark', 'light']) {
      for (const width of [1400, 480]) {
        const name = `${fixture} / ${theme} / ${width}px`;
        await browser.open(previewUrl(media, `fixture=${fixture}&theme=${theme}&bar=0`), width, 900);
        const a = await browser.evaluate(DASHBOARD_AUDIT);
        seen[`${fixture}-${theme}-${width}`] = a;
        const clean = a.mounted && !a.xss && a.missing === '' && browser.events.length === 0 && a.unexpectedTags.length === 0 && a.handlers.length === 0 && a.odd.length === 0 && a.images === 0;
        check(`${name}: the page mounts with no console error, no missing string, no element outside its own set, no handler attribute, no <img>, and the markup probe did not fire`, clean, { mounted: a.mounted, xss: a.xss, missing: a.missing, events: browser.events.slice(0, 3), tags: a.unexpectedTags, handlers: a.handlers, odd: a.odd, images: a.images });
        check(`${name}: no horizontal overflow`, a.overflow.scrollWidth <= a.overflow.innerWidth && a.overflow.offenders.length === 0, a.overflow);
        if (fixture === 'unsupported-entries') {
          const u = a.unsupported;
          const texts = u ? u.items.map((i) => i.texts) : [];
          check(`${name}: the unusable entries are a notice under the accounts — three rows, each a name and a reason, and nothing else`, u && u.shown && u.items.length === 3 && u.elements === 9 && u.items.every((i) => i.tag === 'LI' && i.kids.length === 2 && i.kids.every((k) => k.startsWith('SPAN.'))), u);
          check(`${name}: …the named one by its name, the nameless one as "(unnamed entry)"`, texts[0] && texts[0][0] === 'oc' && texts[0][1] === 'unsupported provider "opencode"' && texts[1][0] === '(unnamed entry)' && texts[1][1] === 'incomplete entry', texts);
          check(`${name}: …the hostile name as TEXT — the markup is there to read, the bidi override is gone`, texts[2] && texts[2][0].includes(IMG) && texts[2][0].includes('"quoted"') && !/[‪-‮⁦-⁩]/.test(texts[2][0]) && texts[2][1] === 'duplicate name', texts[2]);
          check(`${name}: …it says this version cannot use them and where they are removed, and offers no action`, u && /cannot use/.test(u.body) && /Worker Accounts view/.test(u.body) && /3/.test(u.title) && u.buttons === 0, u && [u.title, u.body, u.buttons]);
          check(`${name}: …the accounts themselves are all still drawn, and there is no registry banner`, a.accounts >= 5 && a.registry && a.registry.shown === false, [a.accounts, a.registry && a.registry.shown]);
        }
        if (fixture === 'registry-unreadable') {
          const r = a.registry;
          check(`${name}: an unreadable registry is a page-level error with the reason and ONE action, "Open File"`, r && r.shown && /could not be read/.test(r.title) && /not valid JSON \(unexpected character at line 14, column 3\)/.test(r.body) && /not an empty registry/.test(r.body) && JSON.stringify(r.buttons) === JSON.stringify(['Open File']), r);
          check(`${name}: …no account card, and no "add your first worker" card over a registry that merely could not be read`, a.accounts === 0 && a.onboarding === false, { accounts: a.accounts, onboarding: a.onboarding });
        }
        if (fixture === 'hostile') {
          const u = a.unsupported;
          check(`${name}: hostile entries — at most 20 rows, every row a name and at most a reason, as text`, u && u.shown && u.items.length > 0 && u.items.length <= 20 && u.items.every((i) => i.tag === 'LI' && i.kids.length >= 1 && i.kids.length <= 2 && i.kids.every((k) => k.startsWith('SPAN.'))) && u.elements === u.items.reduce((n, i) => n + 1 + i.kids.length, 0) && u.items.some((i) => i.texts[0].includes('<img')), u && { rows: u.items.length, elements: u.elements, first: u.items.slice(0, 3) });
          const plain = seen[`registry-unreadable-${theme}-${width}`].registry;
          check(`${name}: a hostile registry problem is text in the banner, cut short — the banner has exactly the elements it has for a plain reason`, a.registry && a.registry.shown && a.registry.body.includes('<img src=x') && a.registry.body.length < 500 && plain && a.registry.elements === plain.elements && JSON.stringify(a.registry.buttons) === JSON.stringify(['Open File']), [a.registry, plain && plain.elements]);
        }
        if (fixture === 'rich') {
          check(`${name}: a model with no unusable entry and no registry problem shows neither notice`, a.unsupported && a.unsupported.shown === false && a.registry && a.registry.shown === false, [a.unsupported && a.unsupported.shown, a.registry && a.registry.shown]);
        }
      }
    }
  }
  const dark = seen['unsupported-entries-dark-1400'].unsupported;
  const light = seen['unsupported-entries-light-1400'].unsupported;
  check('the unusable-entries notice follows the theme: its colours differ between dark and light', dark && light && (dark.background !== light.background || dark.color !== light.color), [dark && [dark.background, dark.color], light && [light.background, light.color]]);
  const darkR = seen['registry-unreadable-dark-1400'].registry;
  const lightR = seen['registry-unreadable-light-1400'].registry;
  check('the registry banner follows the theme too', darkR && lightR && (darkR.background !== lightR.background || darkR.color !== lightR.color), [darkR && [darkR.background, darkR.color], lightR && [lightR.background, lightR.color]]);

  // A model that lacks both fields entirely (a host from before they existed).
  await browser.open(previewUrl(media, 'fixture=rich&theme=dark&bar=0'), 1400, 900);
  const stripped = await browser.evaluate(`(async () => {
    const model = window.__CCO_FIXTURES__.rich();
    delete model.unsupportedAccounts;
    delete model.health.registryProblem;
    window.postMessage({ type: 'model', model }, '*');
    await new Promise((r) => setTimeout(r, 200));
    const box = document.querySelector('.sec-accounts .unsupported');
    return { mounted: !!document.querySelector('.page'), accounts: document.querySelectorAll('.acct').length, notice: !!box && !box.hidden, banners: document.querySelectorAll('.banners .callout.is-error:not([hidden])').length };
  })()`);
  check('a model with neither field at all renders as "none": accounts drawn, no notice, no console error', stripped.mounted && stripped.accounts > 0 && !stripped.notice && browser.events.length === 0, [stripped, browser.events]);

  // "Open File": the page asks; it names no file.
  await browser.open(previewUrl(media, 'fixture=registry-unreadable&theme=dark&bar=0'), 1400, 900);
  const posted = await browser.evaluate(`(async () => {
    const before = window.__CCO_POSTED__.length;
    const button = Array.from(document.querySelectorAll('.banners .callout.is-error button')).find((b) => b.textContent.trim() === 'Open File');
    if (!button) return { error: 'no Open File button' };
    button.click();
    await new Promise((r) => setTimeout(r, 100));
    return { sent: window.__CCO_POSTED__.slice(before) };
  })()`);
  check('"Open File" posts { type: "openRegistryFile" } and nothing else — the page names no file', posted.sent && JSON.stringify(posted.sent) === JSON.stringify([{ type: 'openRegistryFile' }]), posted);
}

async function dashboardButtons(browser, media, check) {
  await browser.open(previewUrl(media, 'fixture=rich&theme=dark&bar=0&drawer=1'), 1400, 1500);
  const reset = await browser.evaluate(`(async () => {
    const button = Array.from(document.querySelectorAll('.drawer .danger-row button')).find((b) => /^Reset check-in$/.test(b.textContent.trim()));
    if (!button) return { error: 'no Reset check-in button', buttons: Array.from(document.querySelectorAll('.drawer .danger-row button')).map((b) => b.textContent.trim()) };
    const before = window.__CCO_POSTED__.length;
    button.click();
    await new Promise((r) => setTimeout(r, 120));
    return { sent: window.__CCO_POSTED__.slice(before), label: button.textContent.trim(), armed: button.classList.contains('is-armed'), hint: button.closest('.danger-row').querySelector('.field-hint').textContent };
  })()`);
  check('Reset check-in: ONE press sends the command (the host asks), and the button does not change into a second question', reset.sent && JSON.stringify(reset.sent) === JSON.stringify([{ type: 'command', id: 'resetCheckin' }]) && reset.label === 'Reset check-in' && reset.armed === false, reset);
  check('…and its hint says that it asks first, like its two neighbours', typeof reset.hint === 'string' && /Asks first\.$/.test(reset.hint), reset.hint);

  await browser.open(previewUrl(media, 'fixture=rich&theme=dark&bar=0'), 1400, 1000);
  const stop = await browser.evaluate(`(async () => {
    const button = Array.from(document.querySelectorAll('.sess .sess-actions .btn-danger')).find((b) => !b.hidden && b.getClientRects().length > 0);
    if (!button) return { error: 'no visible Stop button' };
    const before = window.__CCO_POSTED__.length;
    button.click();
    await new Promise((r) => setTimeout(r, 120));
    const sent = window.__CCO_POSTED__.slice(before);
    return { sent: sent.map((m) => ({ type: m.type, action: m.action, hasKey: typeof m.key === 'string' })), label: button.textContent.trim(), armed: button.classList.contains('is-armed') };
  })()`);
  check('Stop on a session: ONE press sends the action (the host asks before it stops anything)', stop.sent && JSON.stringify(stop.sent) === JSON.stringify([{ type: 'session', action: 'stop', hasKey: true }]) && stop.label === 'Stop' && stop.armed === false, stop);
  const cancel = await browser.evaluate(`(async () => {
    const button = Array.from(document.querySelectorAll('.task .btn-danger')).find((b) => !b.hidden && b.getClientRects().length > 0);
    if (!button) return { error: 'no visible Cancel button' };
    const before = window.__CCO_POSTED__.length;
    button.click();
    await new Promise((r) => setTimeout(r, 120));
    const first = window.__CCO_POSTED__.slice(before).length;
    const label = button.textContent.trim();
    button.click();
    await new Promise((r) => setTimeout(r, 120));
    return { first, label, second: window.__CCO_POSTED__.slice(before).map((m) => m.type) };
  })()`);
  check('Cancel on a task keeps its two steps: the host does not ask about that one', cancel.first === 0 && cancel.label === 'Cancel task?' && JSON.stringify(cancel.second) === JSON.stringify(['cancelTask']), cancel);
}

/** Press "Allow" on the frontier guard and read the control's status until `untilMs`. */
const PENDING_PROBE = (untilMs) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const field = Array.from(document.querySelectorAll('.drawer .field')).find((f) => (f.querySelector('.field-label') || {}).textContent === 'Frontier model dispatch');
  if (!field) return { error: 'no frontier guard field' };
  const status = field.querySelector('.field-status');
  const radio = (value) => field.querySelector('input[type=radio][value=' + value + ']');
  const started = Date.now();
  radio('allow').click();
  const seen = [];
  const note = () => { const t = status.textContent; if (seen.length === 0 || seen[seen.length - 1].text !== t) seen.push({ at: Date.now() - started, text: t, state: status.getAttribute('data-state') }); };
  while (Date.now() - started < ${untilMs}) { note(); await sleep(100); }
  note();
  return { seen, checked: radio('allow').checked ? 'allow' : radio('block').checked ? 'block' : 'neither', sent: window.__CCO_POSTED__.filter((m) => m.type === 'setSetting').map((m) => [m.key, m.value]) };
})()`;

async function dashboardPending(browser, media, check) {
  // The host "dialog" stays open for 31 s and is then cancelled.
  await browser.open(previewUrl(media, 'fixture=rich&theme=dark&bar=0&drawer=1&confirm=cancel&confirmMs=31000'), 1400, 1500);
  const slow = await browser.evaluate(PENDING_PROBE(33_000));
  const texts = (slow.seen ?? []).map((s) => s.text);
  const noAnswer = (slow.seen ?? []).find((s) => /did not answer/.test(s.text));
  const waiting = (slow.seen ?? []).find((s) => /Waiting for your answer in the dialog/.test(s.text));
  const last = (slow.seen ?? []).slice(-1)[0];
  check('a setting the host is asking about: the page sent it once', JSON.stringify(slow.sent) === JSON.stringify([['frontierWorkerDispatch', 'allow']]), slow);
  check('…the control says it is waiting for the answer in the dialog', waiting !== undefined && waiting.at < 2000 && waiting.state === 'saving', slow.seen);
  check('…for 30 seconds it never says "the editor did not answer"', noAnswer === undefined && waiting !== undefined && (slow.seen ?? []).filter((s) => s.at < 30_500).every((s) => s.text === '' || /Saving|Waiting for your answer/.test(s.text)), slow.seen);
  check('…and when the host answers (the dialog was cancelled, after 31 s) it shows that answer, and the control is back on the value in effect', last && last.at >= 30_500 && /^Not saved: the change was not confirmed/.test(last.text) && last.state === 'failed' && slow.checked === 'block', { texts, checked: slow.checked, last });

  // Confirmed quickly.
  await browser.open(previewUrl(media, 'fixture=rich&theme=dark&bar=0&drawer=1&confirm=accept&confirmMs=1200'), 1400, 1500);
  const quick = await browser.evaluate(PENDING_PROBE(2600));
  const quickTexts = (quick.seen ?? []).map((s) => s.text);
  check('confirmed: waiting, then "Saved", and the control shows the new value', quickTexts.some((t) => /Waiting for your answer/.test(t)) && quickTexts.includes('Saved') && !quickTexts.some((t) => /did not answer|Not saved/.test(t)) && quick.checked === 'allow', { quickTexts, checked: quick.checked });

  // A host that really goes silent is still reported — the clock only stops when the host says it is asking.
  await browser.open(previewUrl(media, 'fixture=rich&theme=dark&bar=0&drawer=1'), 1400, 1500);
  const silent = await browser.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The stand-in host answers every setSetting; take its answers away for this one.
    const real = window.postMessage.bind(window);
    window.postMessage = (m, o) => { if (m && (m.type === 'settingResult' || m.type === 'settingPending')) return; real(m, o); };
    const field = Array.from(document.querySelectorAll('.drawer .field')).find((f) => (f.querySelector('.field-label') || {}).textContent === 'Quota cooldown (minutes)');
    const input = field.querySelector('input');
    input.value = '44';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const status = field.querySelector('.field-status');
    await sleep(9000);
    const at9 = status.textContent;
    await sleep(1600);
    return { at9, at10: status.textContent };
  })()`);
  check('a host that never answers and never says it is asking: "the editor did not answer" after 10 seconds, as before', silent.at9 === 'Saving…' && /did not answer/.test(silent.at10), silent);
}

async function dashboardSource(media, check) {
  const js = fs.readFileSync(path.join(media, 'dashboard.js'), 'utf8');
  const css = fs.readFileSync(path.join(media, 'dashboard.css'), 'utf8');
  const fixtures = fs.readFileSync(path.join(media, 'fixtures.js'), 'utf8');
  check('dashboard.js and dashboard.css have no "overridden" state left', !/overridden/.test(js) && !/overridden/.test(css), [(js.match(/.*overridden.*/g) ?? []).slice(0, 2), (css.match(/.*overridden.*/g) ?? []).slice(0, 2)]);
  check('dashboard.js uses no markup-string or code-from-text API', ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write', 'eval(', 'new Function'].every((f) => !js.includes(f)), 'found one');
  check('the fixtures\' string table has neither "confirm again" label and has the new entries', !/dangerResetCheckinConfirm|sessStopConfirm/.test(fixtures) && /saveConfirming:/.test(fixtures) && /unsupportedUnnamed: "\(unnamed entry\)"/.test(fixtures) && /registryOpen:/.test(fixtures), 'string table differs');
}

/* ---- the Asset Manager page ---- */

async function assetManagerPage(browser, assetFile, check) {
  const IMG = '<img src=x onerror="window.__AM_XSS__=1">';
  const RLO = '‮';
  const LONG = 'N'.repeat(10000);
  const ODD_ROOT = '/packs/a"b\'c<d>&e|f';
  const data = {
    type: 'data',
    workspace: `/ws/${IMG}`,
    autoSync: true,
    lastReport: `sync: ${IMG}`,
    sources: [
      { entry: 'bundled', root: '/x/assets', kind: 'bundled', ok: true, name: 'bundled', assetCount: 3 },
      { entry: `/entry/${IMG}"'`, root: ODD_ROOT, kind: 'setting', ok: true, name: `${IMG}${RLO}gnp.exe`, assetCount: 1 },
      { entry: LONG, root: LONG, kind: 'setting', ok: false, name: null, assetCount: 0 },
    ],
    assets: [
      { key: `${IMG}:commands/${IMG}`, pack: IMG, type: 'command', id: '"><script>window.__AM_XSS__=1</script>', description: `${IMG} & <b>bold</b> ' "`, enabled: true, status: 'customized', conflictWith: null,
        files: [{ rel: `commands/${IMG}.md`, state: 'customized', installed: true }, { rel: 'commands/a\'b"c|d.md', state: 'writable', installed: true }] },
      { key: 'p|q:commands/x', pack: 'p|q', type: 'command', id: LONG, description: null, enabled: false, status: 'conflict', conflictWith: IMG,
        files: [{ rel: 'commands/x|y.md', state: 'in-sync', installed: true }] },
      { key: 'p:skills/y', pack: `${RLO}evil`, type: 'skill', id: 'y', description: 'ok', enabled: false, status: IMG, conflictWith: null,
        files: [{ rel: 'skills/y/SKILL.md', state: '__proto__', installed: false }] },
    ],
    orphans: [{ key: `${IMG}:hooks/h"'`, files: ['a', 'b'] }],
  };
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__posted = []; window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(JSON.parse(JSON.stringify(m))), getState: () => null, setState: () => {} });`,
  });
  await browser.open(`file://${assetFile}`, 1200, 600);
  const first = await browser.evaluate(`({ posted: window.__posted, csp: window.__csp, title: (document.querySelector('h1') || {}).textContent })`);
  check('the page\'s one script runs under its own policy (it posts "refresh"), and nothing was blocked', JSON.stringify(first.posted) === JSON.stringify([{ type: 'refresh' }]) && first.csp.length === 0 && browser.events.length === 0, [first, browser.events]);
  const blocked = await browser.evaluate(`(async () => {
    const s = document.createElement('script'); s.textContent = 'window.__AM_INJECTED__ = 1'; document.body.appendChild(s);
    const d = document.createElement('div'); d.setAttribute('onclick', 'window.__AM_INJECTED__ = 2'); document.body.appendChild(d); d.click();
    const p = document.createElement('p'); p.setAttribute('style', 'color: rgb(1, 2, 3)'); document.body.appendChild(p);
    await new Promise((r) => setTimeout(r, 100));
    const out = { injected: window.__AM_INJECTED__, styled: getComputedStyle(p).color === 'rgb(1, 2, 3)', csp: window.__csp.slice() };
    s.remove(); d.remove(); p.remove();
    return out;
  })()`);
  check('the policy holds: a script without the nonce, an inline handler and a style attribute are all refused by the browser', blocked.injected === undefined && blocked.styled === false && blocked.csp.length >= 3, blocked);
  // The browser logged those three refusals; what follows is about the page's own rendering.
  browser.events = [];

  const audit = await browser.evaluate(`(async () => {
    const data = ${JSON.stringify(data)};
    window.postMessage(data, '*');
    await new Promise((r) => setTimeout(r, 250));
    const ALLOWED = new Set(['h1','p','div','button','label','input','span','h2','table','thead','tbody','tr','th','td','b','a','details','summary','script','style']);
    const tags = new Set(); const handlers = []; const odd = [];
    document.body.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED.has(tag)) tags.add(tag);
      for (const a of el.attributes) {
        if (/^on/i.test(a.name)) handlers.push(tag + '[' + a.name + ']');
        if (['href', 'src', 'srcdoc', 'style', 'formaction', 'autofocus'].includes(a.name)) odd.push(tag + '[' + a.name + ']');
      }
    });
    const rows = Array.from(document.querySelectorAll('#assets tbody > tr'));
    const sources = Array.from(document.querySelectorAll('#sources > .file-row'));
    return {
      xss: window.__AM_XSS__, csp: window.__csp.slice(csp0), unexpectedTags: Array.from(tags), handlers, odd,
      scripts: document.querySelectorAll('script').length, images: document.querySelectorAll('img, iframe, object, embed, svg').length,
      meta: document.getElementById('meta').textContent,
      sourceRows: sources.length,
      sourceNames: sources.map((r) => r.querySelector('b').textContent),
      sourcePaths: sources.map((r) => r.querySelector('.src-path').textContent.length),
      sourceKids: sources.map((r) => Array.from(r.children).map((c) => c.tagName + '.' + c.className)),
      assetRows: rows.length,
      names: rows.map((r) => r.querySelector('.asset-name').textContent),
      nameLengths: rows.map((r) => r.querySelector('.asset-name').textContent.length),
      descs: rows.map((r) => Array.from(r.querySelectorAll('.desc')).map((d) => d.textContent)),
      packs: rows.map((r) => r.children[2].textContent),
      badges: rows.map((r) => r.querySelector('.badge').className + '|' + r.querySelector('.badge').textContent),
      fileRows: rows.map((r) => Array.from(r.querySelectorAll('details .file-row')).map((f) => ({ rel: f.querySelector('.src-path').textContent, kids: Array.from(f.children).map((c) => c.tagName + '.' + c.className + ':' + c.textContent) }))),
      cells: rows.map((r) => r.children.length),
      orphanShown: !document.getElementById('orphans-card').hidden,
      orphanKeys: Array.from(document.querySelectorAll('#orphans b')).map((b) => b.textContent),
      bodyElements: document.body.querySelectorAll('*').length,
    };
  })()`.replace('window.__csp.slice(csp0)', `window.__csp.slice(${blocked.csp.length})`));
  const expectElements = audit.bodyElements;
  check('hostile pack names, asset ids, paths and statuses: the markup probe did not fire and nothing was blocked or logged', audit.xss === undefined && audit.csp.length === 0 && browser.events.length === 0, [audit.xss, audit.csp, browser.events.slice(0, 3)]);
  check('…no element outside the page\'s own set, one script, no <img>, no handler, href, src or style attribute anywhere', audit.unexpectedTags.length === 0 && audit.scripts === 1 && audit.images === 0 && audit.handlers.length === 0 && audit.odd.length === 0, { tags: audit.unexpectedTags, scripts: audit.scripts, images: audit.images, handlers: audit.handlers, odd: audit.odd });
  check('…three pack rows and three asset rows of six cells, each built of the expected pieces only', audit.sourceRows === 3 && audit.assetRows === 3 && audit.cells.every((n) => n === 6) && JSON.stringify(audit.sourceKids[1]) === JSON.stringify(['B.', 'SPAN.src-path muted', 'SPAN.badge synced', 'A.action', 'A.action']) && JSON.stringify(audit.sourceKids[2]) === JSON.stringify(['B.', 'SPAN.src-path muted', 'SPAN.badge orphan', 'A.action']), [audit.sourceKids, audit.cells]);
  check('…the names are shown literally: the markup as text, quotes and ampersands as they are, the RTL override character kept as a character', audit.sourceNames[1] === `${IMG}${RLO}gnp.exe` && audit.names[0] === '"><script>window.__AM_XSS__=1</script>' && audit.descs[0][0] === `${IMG} & <b>bold</b> ' "` && audit.packs[0] === IMG && audit.packs[2] === `${RLO}evil` && audit.meta.includes(IMG), [audit.sourceNames, audit.names[0], audit.descs[0], audit.packs]);
  check('…a 10,000-character name is all there, as one text', audit.nameLengths[1] === 10000 && audit.sourceNames[2].length === 10000 && audit.sourcePaths[2] === 10000, [audit.nameLengths, audit.sourcePaths]);
  check('…an unknown status is text in a plain badge, an unknown file state shows no label, and the conflict note names the other asset as text', audit.badges[2] === `badge off|${IMG}` && audit.fileRows[2][0].kids.length === 2 && audit.descs[1].some((d) => d.includes(IMG)) && audit.badges[1].startsWith('badge orphan|'), [audit.badges, audit.fileRows[2], audit.descs[1]]);
  check('…the orphan is listed by its key, as text', audit.orphanShown === true && JSON.stringify(audit.orphanKeys) === JSON.stringify([`${IMG}:hooks/h"'`]), audit.orphanKeys);

  // What the page sends back is exactly what it was given — quotes, bars and markup included.
  const sent = await browser.evaluate(`(async () => {
    const click = async (el) => { const before = window.__posted.length; el.click(); await new Promise((r) => setTimeout(r, 30)); return window.__posted.slice(before); };
    const action = (root, label) => Array.from(root.querySelectorAll('a.action')).find((a) => a.textContent === label);
    const sources = Array.from(document.querySelectorAll('#sources > .file-row'));
    const rows = Array.from(document.querySelectorAll('#assets tbody > tr'));
    const out = {};
    out.reveal = await click(action(sources[1], 'reveal'));
    out.remove = await click(action(sources[1], 'remove'));
    const files0 = Array.from(rows[0].querySelectorAll('details .file-row'));
    out.open = await click(action(files0[0], 'open'));
    out.diff = await click(action(files0[1], 'diff'));
    out.packVersion = await click(action(files0[1], 'pack version'));
    out.resetFile = await click(action(files0[0], 'reset'));
    out.reset = await click(action(rows[0], 'reset to pack'));
    const files1 = Array.from(rows[1].querySelectorAll('details .file-row'));
    out.barKey = await click(action(files1[0], 'pack version'));
    const box = rows[1].querySelector('input[type=checkbox]');
    out.toggle = await click(box);
    out.orphan = await click(action(document.getElementById('orphans'), 'disable & clean'));
    out.autosync = await click(document.getElementById('autosync'));
    out.sync = await click(document.querySelector('button[data-act=syncNow]'));
    out.elementsAfter = document.body.querySelectorAll('*').length;
    return out;
  })()`);
  const one = (list, expected) => JSON.stringify(list) === JSON.stringify([expected]);
  check('reveal / remove send the pack directory and the settings entry exactly as given', one(sent.reveal, { type: 'revealPack', root: ODD_ROOT }) && one(sent.remove, { type: 'removePack', entry: `/entry/${IMG}"'` }), [sent.reveal, sent.remove]);
  check('the file actions send the asset key and the file path exactly as given', one(sent.open, { type: 'openInstalled', rel: `commands/${IMG}.md` }) && one(sent.diff, { type: 'diff', key: `${IMG}:commands/${IMG}`, rel: 'commands/a\'b"c|d.md' }) && one(sent.packVersion, { type: 'openSource', key: `${IMG}:commands/${IMG}`, rel: 'commands/a\'b"c|d.md' }) && one(sent.resetFile, { type: 'resetFile', key: `${IMG}:commands/${IMG}`, rel: `commands/${IMG}.md` }) && one(sent.reset, { type: 'reset', key: `${IMG}:commands/${IMG}` }), sent);
  check('a pack name with a "|" in it does not split the key from the path', one(sent.barKey, { type: 'openSource', key: 'p|q:commands/x', rel: 'commands/x|y.md' }), sent.barKey);
  check('the toggle, the orphan action, auto-sync and the toolbar send typed values', one(sent.toggle, { type: 'toggle', key: 'p|q:commands/x', enabled: true }) && one(sent.orphan, { type: 'disableOrphan', key: `${IMG}:hooks/h"'` }) && one(sent.autosync, { type: 'setAutoSync', value: false }) && one(sent.sync, { type: 'syncNow' }), [sent.toggle, sent.orphan, sent.autosync, sent.sync]);
  check('all of that added no element to the page', sent.elementsAfter === expectElements, [expectElements, sent.elementsAfter]);

  // A second, different state replaces the first: rows are rebuilt, not accumulated.
  const second = await browser.evaluate(`(async () => {
    window.postMessage({ type: 'data', workspace: null, autoSync: false, lastReport: null, sources: [], assets: [], orphans: [] }, '*');
    await new Promise((r) => setTimeout(r, 150));
    return { sources: document.querySelectorAll('#sources > *').length, rows: document.querySelectorAll('#assets tbody > tr').length, empty: (document.querySelector('#assets tbody .empty') || {}).textContent, orphanHidden: document.getElementById('orphans-card').hidden, summary: document.getElementById('summary').textContent };
  })()`);
  check('an empty state replaces the rows: one "open a workspace folder first" row, the orphan card hidden', second.sources === 0 && second.rows === 1 && second.empty === 'open a workspace folder first' && second.orphanHidden === true && second.summary === '', second);
  // Messages that are not the host's data are ignored.
  const junk = await browser.evaluate(`(async () => {
    for (const m of [null, 42, 'data', [], { type: 'nope' }, { type: 'data' }, { type: 'data', sources: 'x', assets: 7, orphans: {} }]) window.postMessage(m, '*');
    await new Promise((r) => setTimeout(r, 150));
    return { rows: document.querySelectorAll('#assets tbody > tr').length };
  })()`);
  check('junk messages (null, a number, data of the wrong shape) do not break the page', junk.rows === 1 && browser.events.length === 0, [junk, browser.events.slice(0, 3)]);
}

async function run({ media, assetFile, scratch, check }) {
  dashboardSource(media, check);
  let browser;
  try {
    browser = await startChrome(scratch);
  } catch (e) {
    check('a headless browser engine is available', false, String(e && e.message));
    return;
  }
  if (!browser) {
    check('a headless browser engine is available', false, `no Chrome or Chromium found (looked at CHROME_BIN and ${CHROME_CANDIDATES.length} usual places) — the page checks did not run`);
    return;
  }
  try {
    check('a headless browser engine is available', true, browser.version);
    await dashboardNotices(browser, media, check);
    await dashboardButtons(browser, media, check);
    await dashboardPending(browser, media, check);
    await assetManagerPage(browser, assetFile, check);
  } finally {
    await browser.close();
  }
}

module.exports = { run, startChrome };
