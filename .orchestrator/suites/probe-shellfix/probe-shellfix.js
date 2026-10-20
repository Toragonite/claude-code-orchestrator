// probe-shellfix — see the banner below. The harness is ../lib/host-harness.js.
'use strict';
const H = require('../lib/host-harness.js');
const {
  Module, fs, os, path, execFileSync, OUT, REPO, SANDBOX,
  HOME, BIN, WS, FAKE_LOG, REAL_HOME, FAKE_CLAUDE, FAKE_MODE, cp,
  realSpawnSync, realSpawn, PARTIAL, blockedSpawns, mayRun, fakeCalls, rec, answers,
  settingsBySection, settings, commands, configListeners, fireConfigChange, EventEmitter, TreeItem, ThemeIcon,
  ThemeColor, escapeMd, MarkdownString, vscode, team, teamStub, dashboardCalls, dashboardLogSinks,
  dashboardSettingsSyncs, stubByFile, timers, realSetTimeout, realSetInterval, captureTimers, realClearTimeout, realClearInterval,
  watched, registry, usage, keepalive, reaper, pool, litter, uiModel,
  platform, teamAgent, spawnGuards, providerRefresh, ledgerCalls, litterScript, accounts, outputs,
  realResolveAccount, ext, views, teamView, check, reset, run, readReg,
  memento, hovered, readWorkers, skip, NO_BASE_BUILD, shown, Uri, EXTENSION_ID,
} = H;
/* ======================================================================================
 * SHELL-FIX (wave 3) probe body. The harness above this line is ext-probe2.js's own, verbatim
 * (sandbox HOME, fake `claude`, spawn allowlist, stub `vscode`, module stand-ins) — see
 * make-probe-shellfix.py. What follows probes only what this task changed:
 *
 *   T  terminals of non-Claude accounts (decision D1) and that Claude Code terminals did not change
 *   K  the Codex "where to keep the login" step of Add Worker
 *   L  "used by Claude Code before" — the wording that no longer claims a login
 *   X  decision D2 on the host side: prune list, re-login / open-session, Workers tree, stop
 *
 * Usage: node probe-shellfix.js <compiled out dir> <repo root> [<compiled out dir of the tree BEFORE the fix>]
 * ====================================================================================== */
(async () => {
  const BASE_OUT = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      check(`${name} — section crashed`, false, e && e.stack);
    }
  };
  const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

  /* ------------------------------------------------------------------ activation */
  const EXT_DIR = path.join(SANDBOX, 'ext');
  const BUNDLE = path.join(EXT_DIR, 'out', 'mcp');
  fs.mkdirSync(BUNDLE, { recursive: true });
  for (const f of ['server.js', 'run-task.js', 'provider-cli.js']) fs.writeFileSync(path.join(BUNDLE, f), '// stand-in\n');
  const context = {
    subscriptions: [], globalState: memento(), workspaceState: memento(),
    extension: { id: EXTENSION_ID, packageJSON: { version: '2.0.0' } },
    asAbsolutePath: (p) => path.join(EXT_DIR, p),
  };
  // The extension host holds Anthropic credentials, as a real one can (the harness already set four
  // session-identity variables); the rest of the identity list is added so all thirteen are present.
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'sk-ant-HOST-KEY', ANTHROPIC_AUTH_TOKEN: 'HOST-AUTH-TOKEN', CLAUDE_CODE_OAUTH_TOKEN: 'HOST-OAUTH-TOKEN',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/host.sock', CLAUDE_CODE_EXECPATH: '/opt/claude',
    CLAUDE_CODE_SSE_PORT: '4711', CLAUDE_PID: '4242', CLAUDE_PROJECT_DIR: '/work/p', CLAUDE_AGENT_SDK_VERSION: '0.9.9', CLAUDE_EFFORT: 'high',
  });
  captureTimers(true);
  let activateError;
  try { ext.activate(context); } catch (e) { activateError = e; }
  captureTimers(false);
  await new Promise((r) => realSetTimeout(r, 50));
  check('S0 activate() returns without throwing', activateError === undefined, activateError && activateError.stack);

  const providersMod = require(path.join(OUT, 'providers.js'));
  const wmMod = require(path.join(OUT, 'workerManager.js'));
  const baseWm = BASE_OUT ? require(path.join(BASE_OUT, 'workerManager.js')) : undefined;
  const direct = new wmMod.WorkerManager();
  // Written out, then compared with platform.ts: a list that drifts is a failure, not a silent pass.
  const IDENTITY = [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID',
    'CLAUDE_PROJECT_DIR', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_EFFORT',
  ];
  const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CONFIG_DIR'];
  // K-SHELL: "ALL17" keeps its name; it is now every variable such a terminal removes — the 13 identity ones,
  // the 8 named ones, and every other ANTHROPIC_* / CLAUDE_* variable this process holds.
  const ALL17 = [...new Set([...IDENTITY, ...CREDENTIALS, ...Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_)/.test(k) || k === 'CLAUDECODE')])];
  const allNulled = (env) => ALL17.every((k) => env[k] === null);
  const keysAre = (env, extra) => JSON.stringify(Object.keys(env).sort()) === JSON.stringify([...ALL17, ...extra].sort());
  const CODEX_DEFAULT = providersMod.defaultProviderHome('codex');
  const CURSOR_DEFAULT = providersMod.defaultProviderHome('cursor');
  const AGY_DEFAULT = providersMod.defaultProviderHome('gemini');
  const mainDir = platform.hostConfigDir();
  const W1 = path.join(HOME, '.claude-w1');
  fs.mkdirSync(W1, { recursive: true });
  const entryOf = (name) => readWorkers().find((w) => w.name === name);
  const pickLabel = (label) => (items) => items.find((i) => i.label === label);
  const pickLogin = (login) => (items) => items.find((i) => i.login === login);
  const pickStore = (store) => (items) => items.find((i) => i.store === store);
  check('S1 the sandbox is where every account home resolves', CODEX_DEFAULT === path.join(HOME, '.codex') && CURSOR_DEFAULT === path.join(HOME, '.cursor') && AGY_DEFAULT === path.join(HOME, '.agy') && mainDir === path.join(HOME, '.claude'),
    [CODEX_DEFAULT, mainDir].join(' ; '));

  /* ================================================================ T. terminals (D1) */
  await section('T', async () => {
    const CXOWN = path.join(HOME, '.codex-own');
    const AGOWN = path.join(HOME, '.agy-own');
    check('T0 the variable lists probed here are platform.ts\'s (13 session-identity, 4 Anthropic), and the host process holds the credentials and the identity',
      JSON.stringify([...platform.SESSION_IDENTITY_ENV].sort()) === JSON.stringify([...IDENTITY].sort())
      && JSON.stringify([...(platform.ANTHROPIC_CREDENTIAL_ENV || [])].sort()) === JSON.stringify([...CREDENTIALS].sort())
      && ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', ...IDENTITY].every((k) => typeof process.env[k] === 'string' && process.env[k] !== ''),
      `${platform.SESSION_IDENTITY_ENV.length} + ${(platform.ANTHROPIC_CREDENTIAL_ENV || []).length}`);
    const vendorEnvs = [];

    reset();
    wmMod.openReloginTerminal('cx-own', CXOWN, 'codex');
    const t1 = rec.terminals[0];
    vendorEnvs.push(...rec.terminals.map((t) => ({ env: t.opts.env, home: CXOWN })));
    check('T1 Codex LOGIN terminal, separate home: CODEX_HOME=<dir> verbatim, plus null for each of the 4 Anthropic variables and each of the 13 session-identity variables, and no other key; runs `codex login`',
      rec.terminals.length === 1 && t1.opts.env.CODEX_HOME === CXOWN && allNulled(t1.opts.env) && keysAre(t1.opts.env, ['CODEX_HOME']) && t1.sent.join('|') === 'codex login' && t1.opts.name === 'login: cx-own',
      t1 && JSON.stringify({ CODEX_HOME: t1.opts.env.CODEX_HOME, nulls: ALL17.filter((k) => t1.opts.env[k] === null).length, keys: Object.keys(t1.opts.env).length, sent: t1.sent }));
    check('T1b spelled out: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CONFIG_DIR are each null (removed) in it',
      t1 && CREDENTIALS.every((k) => k in t1.opts.env && t1.opts.env[k] === null), t1 && CREDENTIALS.map((k) => `${k}=${t1.opts.env[k]}`).join(' '));

    reset();
    wmMod.openReloginTerminal('cx-amb', CODEX_DEFAULT, 'codex');
    wmMod.openReloginTerminal('cx-amb2', CODEX_DEFAULT + path.sep, 'codex');
    vendorEnvs.push(...rec.terminals.map((t) => ({ env: t.opts.env, home: undefined })));
    check('T2 Codex login terminal, DEFAULT home (also spelled with a trailing separator): NO CODEX_HOME — exactly the 17 nulls and nothing else',
      rec.terminals.length === 2 && rec.terminals.every((t) => !('CODEX_HOME' in t.opts.env) && allNulled(t.opts.env) && keysAre(t.opts.env, []) && t.sent.join('|') === 'codex login'),
      rec.terminals.map((t) => Object.keys(t.opts.env).filter((k) => !ALL17.includes(k)).join(',') || 'no extra key').join(' ; '));

    reset();
    wmMod.openReloginTerminal('cur', CURSOR_DEFAULT, 'cursor');
    wmMod.openReloginTerminal('cur-odd', path.join(HOME, '.cursor-elsewhere'), 'cursor');
    vendorEnvs.push(...rec.terminals.map((t) => ({ env: t.opts.env, home: undefined })));
    check('T3 Cursor terminal: NO home variable at all — not even for a directory that is not its default (it has no isolation); the 17 nulls; runs `cursor-agent login`',
      rec.terminals.length === 2 && rec.terminals.every((t) => !('CODEX_HOME' in t.opts.env) && !('AGY_HOME' in t.opts.env) && allNulled(t.opts.env) && keysAre(t.opts.env, []) && t.sent.join('|') === 'cursor-agent login'),
      rec.terminals.map((t) => Object.keys(t.opts.env).filter((k) => !ALL17.includes(k)).join(',') || 'no extra key').join(' ; '));

    reset();
    direct.openTerminal({ name: 'cx-own', configDir: CXOWN, provider: 'codex' }, 'a prompt that must not be typed');
    direct.openTerminal({ name: 'ag-own', configDir: AGOWN, provider: 'gemini' });
    direct.openTerminal({ name: 'ag-amb', configDir: AGY_DEFAULT, provider: 'gemini' });
    const [o1, o2, o3] = rec.terminals;
    vendorEnvs.push({ env: o1.opts.env, home: CXOWN }, { env: o2.opts.env, home: AGOWN }, { env: o3.opts.env, home: undefined });
    check('T4 OPEN-SESSION terminals follow the same rule: Codex own home → CODEX_HOME; Antigravity own home → AGY_HOME; Antigravity default → none; the 17 nulls in each; the CLI is opened with no argument',
      rec.terminals.length === 3 && o1.opts.env.CODEX_HOME === CXOWN && keysAre(o1.opts.env, ['CODEX_HOME']) && o1.sent.join('|') === 'codex'
      && o2.opts.env.AGY_HOME === AGOWN && keysAre(o2.opts.env, ['AGY_HOME']) && o2.sent.join('|') === 'agy' && keysAre(o3.opts.env, []) && [o1, o2, o3].every((t) => allNulled(t.opts.env)),
      rec.terminals.map((t) => `${t.opts.name}: ${t.sent.join('|')}`).join(' ; '));
    const stray = vendorEnvs.flatMap(({ env, home }) => Object.entries(env).filter(([, v]) => v !== null && v !== home).map(([k, v]) => `${k}=${v}`));
    check(`T5 across all ${vendorEnvs.length} non-Claude terminals the only non-null value is the account's own home directory — no credential value rides along under any name`, stray.length === 0, stray.join(',') || 'none');

    // ---- Claude Code: unchanged
    const DEFAULT = platform.defaultConfigDir();
    const cases = [];
    const snapshot = (label) => {
      for (const d of [DEFAULT, W1, W1 + path.sep, path.join(HOME, '.claude-other')]) {
        cases.push({ label, d, now: wmMod.accountTerminalEnv('claude', d), ref: platform.claudeTerminalEnv(d), base: baseWm ? baseWm.accountTerminalEnv('claude', d) : undefined });
      }
    };
    snapshot('host has no CLAUDE_CONFIG_DIR');
    process.env.CLAUDE_CONFIG_DIR = W1;
    snapshot('host runs under CLAUDE_CONFIG_DIR=<w1>');
    delete process.env.CLAUDE_CONFIG_DIR;
    const savedTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    snapshot('host has no OAuth token');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = savedTok;
    check(`T6 a Claude Code terminal still goes through claudeTerminalEnv: accountTerminalEnv('claude', dir) equals it for ${cases.length} cases (4 directories × 3 host environments)`,
      cases.every((c) => same(c.now, c.ref)), cases.filter((c) => !same(c.now, c.ref)).map((c) => `${c.label}:${c.d}`).join(' ; ') || 'all equal');
    if (baseWm === undefined) skip('T6b and it is identical to what the tree BEFORE this change produced for the same cases', NO_BASE_BUILD);
    else check('T6b and it is identical to what the tree BEFORE this change produced for the same cases',
      cases.every((c) => same(c.now, c.base)), cases.filter((c) => !same(c.now, c.base)).map((c) => `${c.label}:${c.d}`).join(' ; ') || 'all equal');
    check('T6c a Claude Code terminal does NOT remove ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (they select a key for Claude sessions; that rule is untouched), and sets or removes CLAUDE_CONFIG_DIR per the binding',
      cases.every((c) => !('ANTHROPIC_API_KEY' in c.now) && !('ANTHROPIC_AUTH_TOKEN' in c.now) && 'CLAUDE_CONFIG_DIR' in c.now)
      && cases[0].now.CLAUDE_CONFIG_DIR === null && cases[1].now.CLAUDE_CONFIG_DIR === W1 && cases[1].now.CLAUDE_CODE_OAUTH_TOKEN === null,
      JSON.stringify([cases[0].now.CLAUDE_CONFIG_DIR, cases[1].now.CLAUDE_CONFIG_DIR]));

    const claudeTerminals = (wm) => {
      reset();
      wm.openReloginTerminal('main', DEFAULT);
      wm.openReloginTerminal('w1', W1, 'claude');
      new wm.WorkerManager().openTerminal({ name: 'w1', configDir: W1 }, 'fix `the` "bug" $HOME');
      new wm.WorkerManager().openTerminal({ name: 'main', configDir: DEFAULT, provider: 'claude' });
      return rec.terminals.map((t) => ({ name: t.opts.name, env: sortKeys(t.opts.env), sent: t.sent }));
    };
    const nowTerms = claudeTerminals(wmMod);
    check('T7 the Claude Code terminals themselves: re-login of the default directory has CLAUDE_CONFIG_DIR removed and runs `claude auth login`; a worker\'s sets its directory verbatim and drops the OAuth token; open-session quotes the prompt',
      nowTerms.length === 4 && nowTerms[0].env.CLAUDE_CONFIG_DIR === null && /^claude auth login/.test(nowTerms[0].sent[0]) && nowTerms[1].env.CLAUDE_CONFIG_DIR === W1 && nowTerms[1].env.CLAUDE_CODE_OAUTH_TOKEN === null
      && nowTerms[2].sent[0] === "claude 'fix `the` \"bug\" $HOME'" && nowTerms[2].env.CLAUDE_CONFIG_DIR === W1 && nowTerms[3].sent[0] === 'claude' && nowTerms.every((t) => IDENTITY.every((k) => t.env[k] === null)),
      nowTerms.map((t) => `${t.name}: ${t.sent[0]}`).join(' ; '));
    if (baseWm !== undefined) {
      const baseTerms = claudeTerminals(baseWm);
      const butPrompt = (terms) => JSON.stringify(terms.map((t, i) => (i === 2 ? { ...t, sent: [] } : t)));
      check('T7b [UPDATED for W5 SHELL-A] those four terminals — name, environment and command line — are identical to the ones the tree before this change opened, except that the session prompt is now single-quoted (it was a double-quoted string with backslash escapes)',
        butPrompt(nowTerms) === butPrompt(baseTerms) && baseTerms[2].sent[0] === 'claude "fix \\`the\\` \\"bug\\" \\$HOME"', `${nowTerms.length} vs ${baseTerms.length}: ${baseTerms[2] && baseTerms[2].sent[0]}`);
      const before = baseWm.accountTerminalEnv('codex', CXOWN);
      check('T8 [the defect, seen by this probe] before this change the same Codex terminal environment did NOT mention the four Anthropic variables at all (so the terminal inherited them)',
        CREDENTIALS.every((k) => !(k in before)) && IDENTITY.every((k) => before[k] === null), CREDENTIALS.filter((k) => k in before).join(',') || 'none of the four present');
    } else {
      skip('T7b those four terminals are identical to the ones the tree before this change opened, except that the session prompt is now single-quoted', NO_BASE_BUILD);
      skip('T8 [the defect, seen by this probe] before this change the same Codex terminal environment did NOT mention the Anthropic variables at all', NO_BASE_BUILD);
    }
    reset();
    let threw;
    try { direct.openTerminal({ name: 'odd', configDir: W1, provider: 'codexx' }); } catch (e) { threw = e; }
    // [2.0: was "is opened as Claude Code (the registry's own reading rule) — not a crash": one terminal, `claude`,
    // the Claude environment of that directory.] An unknown provider is no longer read as Claude Code anywhere:
    // the registry never produces such a worker, and for a hand-built one workerProvider refuses to classify it
    // — as ANY provider — rather than aim one vendor's CLI at another's directory. So nothing is opened at all.
    check('T9 an account object carrying a provider id this version does not know is REFUSED (TypeError: unknown provider), and no terminal is opened for it — neither a Claude Code one nor a half-built one',
      threw instanceof TypeError && /^workerProvider: unknown provider/.test(threw.message) && rec.terminals.length === 0, threw ? String(threw) : `${rec.terminals.length} terminal(s): ${rec.terminals[0] && rec.terminals[0].sent[0]}`);
  });

  /* ============================================ K. Codex: where to keep the login */
  await section('K', async () => {
    const LINE = 'cli_auth_credentials_store = "keyring"';
    const homeOf = (name) => path.join(HOME, `.codex-${name}`);
    const cfgOf = (name) => path.join(homeOf(name), 'config.toml');
    const picksWithStore = () => rec.quickPicks.filter((q) => q.items.some((i) => 'store' in i));
    check('K0 the line this extension writes is exactly the documented one', wmMod.CODEX_KEYRING_CONFIG_LINE === LINE, wmMod.CODEX_KEYRING_CONFIG_LINE);

    // --- keychain on a new home; observe WHEN the file exists
    const seen = { atRefresh: [], atTerminal: [] };
    const stubRefresh = usage.refreshProviderUsage;
    usage.refreshProviderUsage = (opts) => { seen.atRefresh.push(fs.existsSync(cfgOf('kc1'))); return stubRefresh(opts); };
    const stubTerminal = vscode.window.createTerminal;
    vscode.window.createTerminal = (opts) => { seen.atTerminal.push(fs.existsSync(cfgOf('kc1'))); return stubTerminal(opts); };
    reset();
    answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickStore('keychain'), pickLabel('gpt-5.6-sol'));
    answers.input.push('kc1');
    answers.message.push((items) => items.find((i) => i === 'Open Login Terminal'));
    await run('addWorker');
    await new Promise((r) => realSetTimeout(r, 20));
    usage.refreshProviderUsage = stubRefresh;
    vscode.window.createTerminal = stubTerminal;
    const storePick = rec.quickPicks[2];
    check('K1 a Codex login of the worker\'s own adds ONE step, after the login choice and before the model: where to keep the login — "System keychain" or "File in the account folder (Codex\'s default)"',
      rec.quickPicks.length === 4 && storePick && JSON.stringify(storePick.items.map((i) => i.label)) === JSON.stringify(['System keychain', "File in the account folder (Codex's default)"])
      && JSON.stringify(storePick.items.map((i) => i.store)) === '["keychain","file"]' && rec.quickPicks[1].items.some((i) => i.login === 'separate') && rec.quickPicks[3].items.some((i) => i.label === 'gpt-5.6-sol'),
      rec.quickPicks.map((q) => q.items.map((i) => i.label).slice(0, 2).join('/')).join(' → '));
    const kcDetail = storePick ? storePick.items[0].detail : '';
    // K-SHELL (K10): the trade-off is the two words BESIDE each label (the description), where it is read at a
    // glance; the one line under it says where the sign-in then lives. Same facts, each in one line that fits.
    // [second review, §9.11: the keychain item's detail had to say "login detection and dispatch still work".] That was
    // never verified end to end and is no longer claimed: each item says what is stored where, and nothing more.
    check('K1b the keychain item states the trade-off beside its label (no plan-usage reading) and says where the sign-in is kept — the OS keychain, no token file in the account folder — without claiming that anything "still works"; the file item says plan usage is readable and names auth.json; no detail needs a second line',
      /no plan-usage reading/.test(storePick.items[0].description) && kcDetail === 'The sign-in is kept in the OS keychain; no token file is written to the account folder.'
      && !/still work|login detection/i.test(storePick.items.map((i) => `${i.description} ${i.detail}`).join(' '))
      && /plan usage readable/.test(storePick.items[1].description) && storePick.items[1].detail === 'The sign-in token is a plain file, auth.json, in the account folder.' && storePick.items.every((i) => i.detail.length <= 90),
      `${storePick.items.map((i) => `${i.description} | ${i.detail} (${i.detail.length})`).join(' ;; ')}`);
    const st = fs.existsSync(cfgOf('kc1')) ? fs.lstatSync(cfgOf('kc1')) : undefined;
    check('K2 keychain on a NEW home → <home>/config.toml is created holding exactly that one line, as a regular file readable by its owner only (no group / world bits)',
      st !== undefined && st.isFile() && fs.readFileSync(cfgOf('kc1'), 'utf8') === `${LINE}\n` && (st.mode & 0o077) === 0 && (st.mode & 0o600) === 0o600 && JSON.stringify(fs.readdirSync(homeOf('kc1'))) === '["config.toml"]',
      st && `${JSON.stringify(fs.readFileSync(cfgOf('kc1'), 'utf8'))} mode ${(st.mode & 0o777).toString(8)} dir: ${fs.readdirSync(homeOf('kc1')).join(',')}`);
    check('K3 it is written BEFORE the status reading of the new account is requested and BEFORE the login terminal opens (which runs `codex login` under CODEX_HOME=<home>)',
      seen.atRefresh.length >= 1 && seen.atRefresh.every(Boolean) && JSON.stringify(seen.atTerminal) === '[true]' && rec.terminals.length === 1 && rec.terminals[0].opts.env.CODEX_HOME === homeOf('kc1') && rec.terminals[0].sent.join('|') === 'codex login',
      JSON.stringify(seen));
    const regText = fs.readFileSync(registry.REGISTRY_FILE, 'utf8');
    check('K4 nothing about the choice is recorded in the registry: the entry is name / configDir / model / provider, and the file mentions neither "keyring" nor "keychain"',
      JSON.stringify(entryOf('kc1')) === JSON.stringify({ name: 'kc1', configDir: homeOf('kc1'), model: 'gpt-5.6-sol', provider: 'codex' }) && !/keyring|keychain/i.test(regText), JSON.stringify(entryOf('kc1')));
    const told = rec.messages.find((m) => /Worker "kc1" added on Codex/.test(m.msg));
    check('K5 the user is told the login will be kept in the system keychain and which file says so; no warning is raised',
      told !== undefined && /system keychain/.test(told.msg) && told.msg.includes(cfgOf('kc1')) && !rec.messages.some((m) => m.level === 'warning'), told && told.msg);

    // --- file (Codex's default)
    reset();
    answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickStore('file'), pickLabel('gpt-5.6-sol'));
    answers.input.push('kf1');
    answers.message.push(() => 'Later');
    await run('addWorker');
    const toldFile = rec.messages.find((m) => /Worker "kf1" added on Codex/.test(m.msg));
    check('K6 "File in the account folder" → NO config.toml: the home is created and left empty, the worker is added, and nothing about a keychain is said',
      !fs.existsSync(cfgOf('kf1')) && JSON.stringify(fs.readdirSync(homeOf('kf1'))) === '[]' && JSON.stringify(entryOf('kf1')) === JSON.stringify({ name: 'kf1', configDir: homeOf('kf1'), model: 'gpt-5.6-sol', provider: 'codex' })
      && toldFile !== undefined && !/keychain/i.test(toldFile.msg) && !rec.messages.some((m) => m.level === 'warning'), toldFile && toldFile.msg);

    // --- an existing config.toml is never touched
    fs.mkdirSync(homeOf('kx1'));
    const THEIRS = Buffer.concat([Buffer.from('model = "o9"\n# written by the user — keep me\r\n[profiles.x]\ncli_auth_credentials_store = "file"\n'), Buffer.from([0xff, 0xfe, 0x00, 0x0a])]);
    fs.writeFileSync(cfgOf('kx1'), THEIRS, { mode: 0o644 });
    fs.chmodSync(cfgOf('kx1'), 0o644);
    fs.utimesSync(cfgOf('kx1'), new Date('2020-01-02T03:04:05Z'), new Date('2020-01-02T03:04:05Z'));
    const beforeStat = fs.statSync(cfgOf('kx1'));
    reset();
    answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickLabel('gpt-5.6-sol'));
    answers.input.push('kx1');
    answers.message.push((items) => items.find((i) => i === 'Use Existing Directory'), () => 'Later');
    await run('addWorker');
    const afterStat = fs.statSync(cfgOf('kx1'));
    check('K7 an EXISTING config.toml in the chosen directory is untouched byte for byte — same bytes, same mode, same modification time, same inode — and the home holds nothing new',
      fs.readFileSync(cfgOf('kx1')).equals(THEIRS) && (afterStat.mode & 0o777) === 0o644 && afterStat.mtimeMs === beforeStat.mtimeMs && afterStat.ino === beforeStat.ino && afterStat.size === THEIRS.length
      && JSON.stringify(fs.readdirSync(homeOf('kx1'))) === '["config.toml"]', `${afterStat.size} bytes, mode ${(afterStat.mode & 0o777).toString(8)}, mtime ${new Date(afterStat.mtimeMs).toISOString()}`);
    const warn = rec.messages.find((m) => m.level === 'warning' && /keychain setting/.test(m.msg));
    check('K8 [UPDATED for W5 SHELL-A] for a folder that already holds something the storage step is NOT offered: provider → login → model, no pick carries a storage choice, the worker is added on that folder, and nothing is said about a keychain',
      rec.quickPicks.length === 3 && picksWithStore().length === 0 && warn === undefined && !rec.messages.some((m) => /keychain/i.test(m.msg)) && entryOf('kx1') !== undefined && entryOf('kx1').configDir === homeOf('kx1'),
      `${rec.quickPicks.length} picks, ${picksWithStore().length} with a storage choice :: ${rec.messages.map((m) => m.msg.slice(0, 70)).join(' | ')}`);
    const direct = wmMod.writeCodexKeyringConfig(homeOf('kx1'));
    check('K8b [NEW for W5 SHELL-A] the writer itself, asked about that folder, reports "exists" and leaves the file byte for byte', direct.outcome === 'exists' && fs.readFileSync(cfgOf('kx1')).equals(THEIRS), direct.outcome);

    // --- variants of "something is already there"
    fs.mkdirSync(homeOf('ks1'));
    const TARGET = path.join(HOME, 'somewhere-else.toml');
    fs.writeFileSync(TARGET, 'theirs = true\n');
    fs.symlinkSync(TARGET, cfgOf('ks1'));
    fs.mkdirSync(homeOf('ks2'));
    const DANGLING = path.join(HOME, 'not-there-yet.toml');
    fs.symlinkSync(DANGLING, cfgOf('ks2'));
    fs.mkdirSync(homeOf('ks3'));
    fs.mkdirSync(cfgOf('ks3'));
    const r1 = wmMod.writeCodexKeyringConfig(homeOf('ks1'));
    const r2 = wmMod.writeCodexKeyringConfig(homeOf('ks2'));
    const r3 = wmMod.writeCodexKeyringConfig(homeOf('ks3'));
    check('K9 same class, other shapes: a symlink at config.toml is not followed (its target keeps its bytes), a DANGLING symlink does not get its target created, a directory of that name is left alone — all three report "exists"',
      r1.outcome === 'exists' && fs.readFileSync(TARGET, 'utf8') === 'theirs = true\n' && fs.lstatSync(cfgOf('ks1')).isSymbolicLink() && r2.outcome === 'exists' && !fs.existsSync(DANGLING) && fs.lstatSync(cfgOf('ks2')).isSymbolicLink()
      && r3.outcome === 'exists' && fs.statSync(cfgOf('ks3')).isDirectory(), [r1.outcome, r2.outcome, r3.outcome].join(','));
    const again = wmMod.writeCodexKeyringConfig(homeOf('kc1'));
    check('K10 asking a second time for a home that already has the file reports "exists" and rewrites nothing', again.outcome === 'exists' && fs.readFileSync(cfgOf('kc1'), 'utf8') === `${LINE}\n`, again.outcome);

    // --- the login already on this machine
    reset();
    answers.quickPick.push(pickLabel('Codex'), pickLogin('ambient'), pickLabel('Let the CLI choose'));
    answers.input.push('ka0');
    answers.message.push(() => 'Later');
    await run('addWorker');
    check('K11 the AMBIENT-login path never offers the step: provider → login → model, no pick carries a storage choice, and nothing is created at the machine\'s own Codex home',
      rec.quickPicks.length === 3 && picksWithStore().length === 0 && entryOf('ka0') !== undefined && entryOf('ka0').configDir === CODEX_DEFAULT && !fs.existsSync(CODEX_DEFAULT),
      `${rec.quickPicks.length} picks, ${picksWithStore().length} with a storage choice`);
    fs.mkdirSync(CODEX_DEFAULT); // the user's own Codex home now exists
    const LINKED = homeOf('linked');
    fs.symlinkSync(CODEX_DEFAULT, LINKED);
    const a1 = wmMod.writeCodexKeyringConfig(CODEX_DEFAULT);
    const a2 = wmMod.writeCodexKeyringConfig(CODEX_DEFAULT + path.sep);
    const a3 = wmMod.writeCodexKeyringConfig(LINKED);
    check('K12 the writer itself refuses the machine\'s own Codex home — by its path, by another spelling of it, and through a symlink that leads to it: "ambient", and that directory stays empty',
      a1.outcome === 'ambient' && a2.outcome === 'ambient' && a3.outcome === 'ambient' && JSON.stringify(fs.readdirSync(CODEX_DEFAULT)) === '[]', [a1.outcome, a2.outcome, a3.outcome].join(','));

    // --- other providers, and the Claude Code flow
    reset();
    answers.quickPick.push(pickLabel('Antigravity'), pickLogin('separate'), pickLabel('gemini-3.8-flash-high'));
    answers.input.push('kg1');
    answers.message.push((items) => items.find((i) => i === 'Continue Anyway'));
    await run('addWorker');
    const agPicks = rec.quickPicks.length;
    const agStore = picksWithStore().length;
    reset();
    answers.quickPick.push(pickLabel('Cursor'), pickLabel('auto'));
    answers.input.push('kcur');
    answers.message.push(() => 'Later');
    await run('addWorker');
    const curStore = picksWithStore().length;
    reset();
    answers.quickPick.push(pickLabel('Claude Code'), pickLabel('opus'));
    answers.input.push('kcl');
    answers.message.push(() => 'Later');
    await run('addWorker');
    check('K13 no other provider is offered the step — Antigravity with a login of its own (3 picks), Cursor, Claude Code — and none of their homes gets a config.toml',
      agPicks === 3 && agStore === 0 && curStore === 0 && picksWithStore().length === 0 && entryOf('kg1') !== undefined && entryOf('kcur') !== undefined && entryOf('kcl') !== undefined
      && !fs.existsSync(path.join(HOME, '.agy-kg1', 'config.toml')) && !fs.existsSync(path.join(CURSOR_DEFAULT, 'config.toml')) && !fs.existsSync(path.join(HOME, '.claude-kcl', 'config.toml')),
      `antigravity ${agPicks} picks / ${agStore} storage; cursor ${curStore}; claude ${picksWithStore().length}`);

    // --- interrupted and failing paths
    reset();
    answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), undefined);
    answers.input.push('kd1');
    await run('addWorker');
    check('K14 dismissing the step (Escape) abandons the whole add: no worker, no directory, no file, no terminal', rec.quickPicks.length === 3 && entryOf('kd1') === undefined && !fs.existsSync(homeOf('kd1')) && rec.terminals.length === 0,
      `${rec.quickPicks.length} picks`);
    fs.mkdirSync(homeOf('kr1'));
    fs.chmodSync(homeOf('kr1'), 0o555); // exists, empty, not writable: the create must fail
    reset();
    answers.quickPick.push(pickLabel('Codex'), pickLogin('separate'), pickStore('keychain'), pickLabel('gpt-5.6-sol'));
    answers.input.push('kr1');
    answers.message.push(undefined, () => 'Later');
    await run('addWorker');
    const failWarn = rec.messages.find((m) => m.level === 'warning' && /keychain setting/.test(m.msg));
    check('K15 a config.toml that cannot be created (read-only home) is reported, not swallowed: a modal says the setting could NOT be applied and gives the line; nothing is left behind; the reason is in the output channel',
      failWarn !== undefined && failWarn.modal === true && /could NOT be applied/.test(failWarn.msg) && failWarn.detail.includes(LINE) && !fs.existsSync(cfgOf('kr1')) && entryOf('kr1') !== undefined
      && rec.channels[0].lines.some((l) => l.startsWith('[codex keychain]') && l.includes(cfgOf('kr1'))), failWarn && failWarn.msg);
    fs.chmodSync(homeOf('kr1'), 0o755);
    const missing = wmMod.writeCodexKeyringConfig(path.join(HOME, '.codex-never-made'));
    check('K16 a home that does not exist is "failed" and is NOT created by the writer', missing.outcome === 'failed' && !fs.existsSync(path.join(HOME, '.codex-never-made')), missing.outcome);
  });

  /* ============================ L. "used by Claude Code before" — never "a login" */
  await section('L', async () => {
    const USED = path.join(HOME, '.claude-used');
    const LEGACY = path.join(HOME, '.claude-legacy');
    const FRESH = path.join(HOME, '.claude-fresh');
    // [second review, §9.4] An empty directory (FRESH) is no longer offered by Import — it does not look like a
    // config directory. The third state of the picker, "offered, not used by Claude Code yet", is now played by
    // UNUSED: a directory that looks like one (it has a projects/ directory) but holds neither sign-in file.
    const UNUSED = path.join(HOME, '.claude-unused');
    for (const d of [USED, LEGACY, FRESH]) fs.mkdirSync(d);
    fs.mkdirSync(path.join(UNUSED, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(USED, '.claude.json'), '{"oauthAccount":{"emailAddress":"someone@example.test"}}');
    const SECRET = path.join(LEGACY, '.credentials.json');
    fs.writeFileSync(SECRET, '{"token":"SECRET-DO-NOT-READ"}');
    // any attempt to open or read the credential file is recorded
    const touched = [];
    const spy = (name) => { const orig = fs[name]; fs[name] = function (p, ...rest) { if (typeof p === 'string' && p.endsWith('.credentials.json')) touched.push(name); return orig.call(this, p, ...rest); }; return () => { fs[name] = orig; }; };
    const unspy = ['readFileSync', 'openSync', 'createReadStream', 'readFile', 'open'].map(spy);

    check('L0 the old name is gone and the new one says what is detected: dirUsedByClaudeCode is true for a directory holding .claude.json or a legacy .credentials.json, false for an empty or missing one',
      wmMod.dirHasLogin === undefined && typeof wmMod.dirUsedByClaudeCode === 'function' && wmMod.dirUsedByClaudeCode(USED) === true && wmMod.dirUsedByClaudeCode(LEGACY) === true
      && wmMod.dirUsedByClaudeCode(FRESH) === false && wmMod.dirUsedByClaudeCode(UNUSED) === false && wmMod.dirUsedByClaudeCode(path.join(HOME, '.claude-nowhere')) === false, Object.keys(wmMod).filter((k) => /^dir/.test(k)).join(','));
    const found = direct.discoverConfigDirs();
    const by = (d) => found.find((f) => f.dir === d);
    check('L1 discoverConfigDirs reports `usedBefore` (a boolean) and no longer a `loggedIn` field — true for the two directories with a sign-in file, false for the one that only looks like a config directory; the EMPTY directory is not offered at all',
      by(USED) && by(USED).usedBefore === true && by(LEGACY).usedBefore === true && by(UNUSED) && by(UNUSED).usedBefore === false && by(FRESH) === undefined && found.every((f) => typeof f.usedBefore === 'boolean' && !('loggedIn' in f)), JSON.stringify(found.map((f) => [path.basename(f.dir), f.usedBefore])));

    reset();
    answers.quickPick.push(undefined);
    await run('importWorkers');
    const pick = rec.quickPicks[0];
    // [was: the item whose description IS the directory.] A directory is shown as one display-safe line of at most 200
    // characters (views.rowText), so under a long temp path the description is the path's head; the item is found by the
    // entry it carries, and what it shows of the path is asserted in L2.
    const itemOf = (d) => pick && pick.items.find((i) => i.entry && i.entry.dir === d);
    // [UPDATED wave 8: picker paths are shown whole (up to 1,024 characters) — a cut path reads as another directory]
    const shownDir = (d) => d;
    const pickText = pick ? [pick.opts.placeHolder, ...pick.items.flatMap((i) => [i.label, i.detail])].join(' | ') : '';
    check('L2 the IMPORT PICKER says "has been used by Claude Code before" and that sign-in is checked after adding — for a .claude.json directory and for a legacy .credentials.json one alike; an unused directory says "not used by Claude Code yet"',
      pick !== undefined && [USED, LEGACY, UNUSED].every((d) => itemOf(d) !== undefined && itemOf(d).description === shownDir(d))
      && /has been used by Claude Code before/.test(itemOf(USED).detail) && /checked after adding/.test(itemOf(USED).detail) && itemOf(LEGACY).detail === itemOf(USED).detail
      && /not used by Claude Code yet/.test(itemOf(UNUSED).detail) && itemOf(FRESH) === undefined, pick && [itemOf(USED).detail, itemOf(UNUSED).detail].join(' || '));
    check('L3 nothing in the import picker — placeholder, labels, details — says "login" any more, and nothing claims an account is or is not signed in',
      pick !== undefined && !/log(ged)?[ -]?in\b|login/i.test(pickText) && !/found|no login|logged/i.test(pickText), pickText.slice(0, 400));

    reset();
    answers.quickPick.push(pickLabel('Claude Code'), pickLabel('opus'));
    answers.input.push('used');
    await run('addWorker');
    const modal = rec.messages.find((m) => m.modal === true);
    check('L4 the ADD-FLOW MODAL for a directory that already exists says it "has been used by Claude Code before" and that sign-in is checked after adding; its button is "Use Existing Directory"; dismissing it adds nothing',
      modal !== undefined && modal.level === 'warning' && /has been used by Claude Code before/.test(modal.msg) && /checked after adding/.test(modal.msg) && modal.msg.includes(USED)
      && JSON.stringify(modal.items) === '["Use Existing Directory"]' && entryOf('used') === undefined, modal && `${modal.msg} ${JSON.stringify(modal.items)}`);
    check('L5 the modal and its button no longer say "login" — nothing claims the directory holds one', modal !== undefined && !/login/i.test(modal.msg) && !modal.items.some((i) => /login/i.test(i)), modal && modal.msg);
    reset();
    answers.quickPick.push(pickLabel('Claude Code'), pickLabel('opus'));
    answers.input.push('fresh');
    answers.message.push(() => 'Later');
    await run('addWorker');
    check('L6 a directory Claude Code has NOT run under raises no such modal (the worker is simply added)', !rec.messages.some((m) => m.modal === true) && entryOf('fresh') !== undefined && entryOf('fresh').configDir === FRESH);
    reset();
    answers.quickPick.push(pickLabel('Claude Code'), pickLabel('opus'));
    answers.input.push('legacy');
    answers.message.push((items) => items.find((i) => i === 'Use Existing Directory'), () => 'Later');
    await run('addWorker');
    check('L7 confirming the modal adds the worker on that directory (legacy .credentials.json case)', entryOf('legacy') !== undefined && entryOf('legacy').configDir === LEGACY);
    for (const u of unspy) u();
    check('L8 no credential is ever read: through all of the above the .credentials.json file was never opened or read (only its existence was asked), and its bytes are unchanged',
      touched.length === 0 && fs.readFileSync(SECRET, 'utf8') === '{"token":"SECRET-DO-NOT-READ"}', touched.join(',') || 'never opened');
    const src = ['src/extension.ts', 'src/workerManager.ts'].map((f) => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n');
    const stale = ['login found', 'no login yet', 'contains a Claude login', 'Use Existing Login', 'dirHasLogin', 'reuse that existing login'].filter((t) => src.includes(t));
    check('L9 the stale phrases are gone from the source of both files, and no keychain is consulted (no `security` call, no keychain module)', stale.length === 0 && !/find-generic-password|keytar|['"]security['"]/.test(src), stale.join(',') || 'none left');
  });

  /* ========================================= X. D2 on the host side (extension shell) */
  await section('X', async () => {
    const CX2 = path.join(HOME, '.codex-cx2');
    const REMOVED = path.join(HOME, '.claude-removed');
    fs.mkdirSync(CX2, { recursive: true });
    // A registry only a hand edit produces: a Codex worker on the MAIN Claude directory, another on
    // a Claude worker's directory, and a well-formed one with a home of its own.
    registry.updateRegistry((r) => {
      r.workers = [
        { name: 'cxmain', configDir: mainDir, model: 'gpt-5.5', provider: 'codex' },
        { name: 'cxw1', configDir: W1, model: '', provider: 'codex' },
        { name: 'w1', configDir: W1, model: 'opus' },
        { name: 'cx2', configDir: CX2, model: 'gpt-5.5', provider: 'codex' },
      ];
    });
    // [2.0: was readReg().workers names === 'cxmain,cxw1,w1,cx2' — one array, in the order given.] The file keeps
    // Claude Code accounts under `workers` and the other vendors' under `vendorWorkers`, and reads them in that order.
    check('X0 the registry holds all four (the pair on one directory is allowed there: different providers): the Claude Code account under `workers`, the three Codex accounts under `vendorWorkers`',
      readWorkers().map((w) => w.name).join(',') === 'w1,cxmain,cxw1,cx2' && readReg().workers.map((w) => w.name).join(',') === 'w1' && !('provider' in readReg().workers[0])
      && readReg().vendorWorkers.map((w) => `${w.name}:${w.provider}`).join(',') === 'cxmain:codex,cxw1:codex,cx2:codex', readWorkers().map((w) => `${w.name}:${w.provider || 'claude'}`).join(','));
    const now = Date.now();
    const entry = (name, dir, over) => ({ name, configDir: dir, available: false, subscriptionType: null, windows: [], sessionCostUsd: null, extraUsage: null, fetchedAt: now, ...over });
    fs.mkdirSync(path.dirname(usage.USAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(usage.USAGE_CACHE_FILE, JSON.stringify({
      [mainDir]: entry('main', mainDir, { available: true, subscriptionType: 'max', windows: [{ kind: 'session', label: 'Session (5hr)', percent: 12, severity: 'normal', resetsAt: null }, { kind: 'weekly_all', label: 'Weekly (7 day)', percent: 77, severity: 'warning', resetsAt: null }] }),
      // [CA: `auth.loggedIn: false` alone is `unconfirmed`, no longer "expired" (contract-2.0-fixes "Login state (CA)").]
      // The Claude worker is logged out the CA way: two "not logged in" probes 20 s apart through its own
      // binding, the newer one in this process. X4 and X12 still prove the Codex worker on that directory is
      // never shown the Claude account's state.
      [W1]: entry('w1', W1, {
        auth: { loggedIn: false, method: null, email: null, checkedAt: now },
        loginProbes: [now - 20_000, now].map((at) => ({ at, path: usage.loginProbePath(W1), result: 'out', via: 'status', reason: 'claude auth status said not logged in' })),
      }),
      [CX2]: entry('cx2', CX2, { available: true, subscriptionType: 'chatgpt', auth: { loggedIn: true, method: 'chatgpt', email: null, checkedAt: now }, windows: [{ kind: 'session', label: '5h limit', percent: 34, severity: 'normal', resetsAt: null }] }),
    }));

    // --- the stale-session-file prune
    litterScript.calls.length = 0;
    litterScript.next = (dirs) => dirs.map((d) => ({ configDir: d, scanned: 1, removed: 0, truncated: false, errors: 0 }));
    reset();
    await run('cleanSessionLitter');
    check('X1 the session-file prune is handed the Claude Code directories ONLY — main and the Claude worker\'s, each once — never a vendor home, although Codex workers are registered on both of those directories too',
      JSON.stringify(litterScript.calls[0]) === JSON.stringify([mainDir, W1]), JSON.stringify(litterScript.calls[0]));

    // --- re-login
    reset();
    await run('reloginWorker', { configDir: mainDir });
    await run('reloginWorker', mainDir);
    await run('reloginWorker', { configDir: W1 });
    check('X2 re-login addressed by a bare DIRECTORY that a Claude account and a Codex worker share means the Claude account: `claude auth login` under claudeTerminalEnv (main: CLAUDE_CONFIG_DIR removed; w1: its directory) — never `codex login`',
      rec.terminals.length === 3 && rec.terminals.every((t) => /^claude auth login/.test(t.sent[0])) && rec.terminals[0].opts.env.CLAUDE_CONFIG_DIR === null && rec.terminals[1].opts.env.CLAUDE_CONFIG_DIR === null
      && rec.terminals[2].opts.env.CLAUDE_CONFIG_DIR === W1 && rec.terminals[2].opts.name === 'login: w1' && rec.terminals.every((t) => !('CODEX_HOME' in t.opts.env)),
      rec.terminals.map((t) => `${t.opts.name}: ${t.sent[0]}`).join(' ; '));
    reset();
    answers.quickPick.push(pickLabel('cxmain'));
    await run('reloginWorker');
    const relPick = rec.quickPicks[0];
    const relItem = (n) => relPick && relPick.items.find((i) => i.label === n);
    check('X3 the palette\'s account pick lists the Codex worker registered on main\'s directory as ITSELF (labelled Codex), beside main — it is not folded into main',
      relPick !== undefined && JSON.stringify(relPick.items.map((i) => i.label).sort()) === JSON.stringify(['cx2', 'cxmain', 'cxw1', 'main', 'w1']) && relItem('cxmain').detail === 'Codex' && relItem('main').detail === undefined,
      relPick && relPick.items.map((i) => `${i.label}(${i.detail || 'Claude Code'})`).join(','));
    check('X4 in that pick the Claude worker with an expired login is marked expired, and the Codex worker on the SAME directory is not — it is not read as that Claude account',
      relPick !== undefined && /^login expired/.test(relItem('w1').description) && relItem('cxw1').description === W1 && relItem('cxmain').description === mainDir, relPick && [relItem('w1').description, relItem('cxw1').description].join(' || '));
    const tCxMain = rec.terminals[0];
    check('X5 picking it signs in with ITS CLI: `codex login`, CODEX_HOME set to the registered directory, and CLAUDE_CONFIG_DIR and the Anthropic credentials removed — `claude` is never pointed at it',
      rec.terminals.length === 1 && tCxMain.sent.join('|') === 'codex login' && tCxMain.opts.env.CODEX_HOME === mainDir && allNulled(tCxMain.opts.env), tCxMain && `${tCxMain.sent.join('|')} CODEX_HOME=${tCxMain.opts.env.CODEX_HOME}`);
    reset();
    await run('reloginWorker', { name: 'cxmain' });
    await run('loginWorker', { name: 'cxw1' });
    await run('openWorkerSession', { name: 'cxw1' });
    check('X6 the tree commands on those rows do the same (re-login, login, open session): the Codex CLI each time, never `claude`',
      rec.terminals.length === 3 && rec.terminals.map((t) => t.sent.join('|')).join(';') === 'codex login;codex login;codex' && rec.terminals.every((t) => allNulled(t.opts.env) && !/claude/.test(t.sent.join(' '))),
      rec.terminals.map((t) => t.sent.join('|')).join(';'));

    // --- the dashboard's account actions, through the REAL account resolver
    const stubResolve = uiModel.resolveAccount;
    uiModel.resolveAccount = realResolveAccount;
    const known = uiModel.knownAccounts();
    check('X7 the account list the dashboard is built from: main is Claude Code and is NOT merged with the Codex worker on its directory; the Claude worker owns its directory although a Codex worker is listed before it; the Codex worker with its own home is listed as Codex',
      JSON.stringify(known.map((a) => `${a.name}:${a.provider}:${a.isMain}:${a.isWorker}`)) === JSON.stringify(['main:claude:true:false', 'w1:claude:false:true', 'cx2:codex:false:true']),
      known.map((a) => `${a.name}:${a.provider}`).join(','));
    reset();
    await run('accountAction', { action: 'relogin', account: uiModel.accountKeyFor(mainDir) });
    await run('accountAction', { action: 'relogin', account: uiModel.accountKeyFor(W1) });
    await run('accountAction', { action: 'relogin', account: uiModel.accountKeyFor(CX2) });
    check('X8 the dashboard\'s re-login on those three cards: main → `claude auth login`; the shared worker directory → `claude auth login` for w1; the Codex card → `codex login` with CODEX_HOME',
      rec.terminals.length === 3 && /^claude auth login/.test(rec.terminals[0].sent[0]) && rec.terminals[0].opts.env.CLAUDE_CONFIG_DIR === null && /^claude auth login/.test(rec.terminals[1].sent[0])
      && rec.terminals[1].opts.env.CLAUDE_CONFIG_DIR === W1 && rec.terminals[2].sent.join('|') === 'codex login' && rec.terminals[2].opts.env.CODEX_HOME === CX2 && rec.terminals[2].opts.env.CLAUDE_CONFIG_DIR === null,
      rec.terminals.map((t) => t.sent[0]).join(' ; '));
    uiModel.resolveAccount = stubResolve;
    const GHOST = path.join(HOME, '.codex-ghost');
    accounts.set('9'.repeat(16), { name: 'ghost', configDir: GHOST, isMain: false, isWorker: true, provider: 'codex' });
    reset();
    await run('accountAction', { action: 'openSession', account: '9'.repeat(16) });
    await run('accountAction', { action: 'relogin', account: '9'.repeat(16) });
    check('X9 an account the list calls Codex whose registry entry cannot be found (removed between the two reads) is still treated as Codex — `claude` is NOT started with CLAUDE_CONFIG_DIR pointed at its home',
      rec.terminals.length === 2 && rec.terminals.map((t) => t.sent.join('|')).join(';') === 'codex;codex login' && rec.terminals.every((t) => t.opts.env.CODEX_HOME === GHOST && t.opts.env.CLAUDE_CONFIG_DIR === null),
      rec.terminals.map((t) => `${t.sent.join('|')} CLAUDE_CONFIG_DIR=${t.opts.env.CLAUDE_CONFIG_DIR}`).join(' ; '));

    // --- the Workers tree
    const wtree = rec.providers['claudeCodeOrchestrator.workers'];
    const roots = Object.fromEntries(wtree.getChildren().map((w) => [w.name, w]));
    const item = (n) => wtree.getTreeItem(roots[n]);
    const rows = (n) => wtree.getChildren(roots[n]).map((r) => wtree.getTreeItem(r));
    const rowOf = (n, label) => rows(n).find((r) => r.label === label);
    const dMain = item('cxmain').description;
    check('X10 Workers tree: the Codex worker on main\'s directory does NOT show main\'s plan usage or plan name — its row says its own state, "not checked yet"',
      /^Codex · /.test(dMain) && !/12%|77%|max|5h|7d|Session|Weekly/.test(dMain) && /not checked yet$/.test(dMain) && !rows('cxmain').some((r) => /^Usage · |^Plan/.test(r.label)), dMain);
    const loginRow = rowOf('cxmain', 'Login');
    check('X11 and its Login row says why there is no reading, instead of promising one "shortly"', loginRow !== undefined && loginRow.description === 'not checked yet' && /No reading is kept for this account/.test(loginRow.tooltip) && !/shortly/.test(loginRow.tooltip), loginRow && loginRow.tooltip);
    const dShared = item('cxw1').description;
    check('X12 the Codex worker on the Claude worker\'s directory is not shown that account\'s "logged out": its row says "not checked yet", while the Claude worker\'s own row says its login expired',
      /not checked yet$/.test(dShared) && !/logged out|expired/.test(dShared) && /login expired/.test(item('w1').description) && rowOf('cxw1', 'Login').description === 'not checked yet', `${dShared} || ${item('w1').description}`);
    check('X13 a Codex worker that owns its directory still shows its own reading, and one that has none yet is still told it will arrive',
      /5h limit 34%/.test(item('cx2').description) && rowOf('cx2', 'Login').description === 'logged in (chatgpt)' && usage.ownsUsageReading({ name: 'cx2', configDir: CX2, provider: 'codex' }) === true
      && usage.ownsUsageReading({ name: 'cxmain', configDir: mainDir, provider: 'codex' }) === false, item('cx2').description);

    // --- a LEDGER RECORD's directory is stored data: `claude` is aimed only at a CURRENT Claude Code account
    // Three directories a record can name: (a) the home of a registered Codex worker, (b) a path
    // no account has, (c) a current Claude Code account's. Each is cancelled from the Tasks
    // tree and stopped / attached to from the Team view.
    const crypto = require('crypto');
    const NOACCT = REMOVED; // (b)
    const plant = (dir, pid) => {
      // what a real vendor home holds, plus an entry that LOOKS like the session being asked about
      fs.mkdirSync(path.join(dir, 'sessions', '2026', '10', '13'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'auth.json'), '{"tokens":"DO-NOT-TOUCH"}', { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "gpt-5.5"\n');
      fs.writeFileSync(path.join(dir, 'sessions', '2026', '10', '13', 'rollout-1.jsonl'), '{"type":"session"}\n');
      fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: 'vend0001-0000-4000-8000-000000000000', jobId: 'vend0001', kind: 'bg', status: 'busy', messagingSocketPath: '/tmp/x.sock' }));
    };
    plant(CX2, 4242001);
    plant(NOACCT, 4242002);
    const snapshot = (dir) => {
      const out = [];
      const walk = (d) => {
        const st = fs.lstatSync(d);
        out.push(`D ${path.relative(dir, d) || '.'} ${(st.mode & 0o7777).toString(8)} ${st.mtimeMs}`);
        for (const name of fs.readdirSync(d).sort()) {
          const full = path.join(d, name);
          const s = fs.lstatSync(full);
          if (s.isDirectory()) walk(full);
          else out.push(`F ${path.relative(dir, full)} ${s.size} ${(s.mode & 0o7777).toString(8)} ${s.mtimeMs} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
        }
      };
      walk(dir);
      return out.join('\n');
    };
    const snapA = snapshot(CX2);
    const snapB = snapshot(NOACCT);
    fs.mkdirSync(path.join(registry.ROOT_DIR, 'mesh'), { recursive: true });
    const LEDGER = path.join(registry.ROOT_DIR, 'mesh', 'probe.json');
    const ledger = (workers) => fs.writeFileSync(LEDGER, JSON.stringify({ ownerPid: 1, cwd: WS, startedAt: 1, workers }));
    const lrec = (over) => ({ name: 'cco-v-1', account: 'x', configDir: CX2, jobId: 'vend0001', model: 'opus', role: 'dispatch', spawnedAt: 1, ...over });
    // `<sandbox>/<id>.md` is the path each task's LOG LINE names for its output; a note about a task goes to its
    // report — the file its id names in the tasks directory (2.0) — and the log-named path is not written to.
    const reportOf = (id) => path.join(registry.TASKS_DIR, `${id}.md`);
    const running = (id, meshWorker) => { fs.mkdirSync(registry.TASKS_DIR, { recursive: true }); fs.writeFileSync(reportOf(id), 'partial output\n'); fs.writeFileSync(path.join(SANDBOX, `${id}.md`), 'partial output\n'); fs.appendFileSync(registry.TASKS_LOG_FILE, `${JSON.stringify({ ts: Date.now(), id, status: 'running', title: `task ${id}`, worker: 'w1', model: 'opus', outputFile: path.join(SANDBOX, `${id}.md`), cwd: WS, meshWorker })}\n`); };
    const lastEventOf = (id) => fs.readFileSync(registry.TASKS_LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.id === id).pop();
    const res = (over) => ({ key: 'worker:vend0001', source: 'worker', name: 'cco-v-1', configDir: undefined, jobId: 'vend0001', worktreeAbs: undefined, branch: undefined, cwd: WS, taskId: undefined, ...over });
    const confirmStop = (items) => items.find((i) => i === 'Stop Session');
    const ADVICE = /no longer registered as a Claude Code account/;
    if (readReg().claudePath !== FAKE_CLAUDE) throw new Error(`registry claudePath is not the fake CLI: ${readReg().claudePath}`);
    check('X14 the account check itself (views.isClaudeAccountDir = the pool\'s claudeAccounts + claudeAccountDirCheck): true for main\'s directory and the Claude worker\'s (any spelling) although Codex workers are registered on both; false for the Codex home, a path no account has, and every value that is not a path',
      views.isClaudeAccountDir(mainDir) && views.isClaudeAccountDir(W1) && views.isClaudeAccountDir(W1 + path.sep) && !views.isClaudeAccountDir(CX2) && !views.isClaudeAccountDir(CX2 + path.sep) && !views.isClaudeAccountDir(NOACCT)
      && [undefined, null, '', 5, {}, [W1]].every((v) => views.isClaudeAccountDir(v) === false));

    // ---- (a) and (b): cancel from the Tasks tree
    const cancelCase = async (label, dir, id, job) => {
      running(id, `cco-${label}`);
      ledger([lrec({ name: `cco-${label}`, configDir: dir, jobId: job, taskId: id })]);
      const ledgerBytes = fs.readFileSync(LEDGER);
      ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
      const before = fakeCalls().length;
      reset();
      await run('cancelTask', { id });
      const ev = lastEventOf(id);
      const note = fs.existsSync(reportOf(id)) ? fs.readFileSync(reportOf(id), 'utf8') : '';
      const logNamedUntouched = fs.readFileSync(path.join(SANDBOX, `${id}.md`), 'utf8') === 'partial output\n';
      return { logNamedUntouched, spawned: fakeCalls().length - before, marked: ledgerCalls.marked.length, removed: ledgerCalls.removed.length, ledgerSame: fs.readFileSync(LEDGER).equals(ledgerBytes), ev, note, messages: rec.messages.map((m) => ({ level: m.level, msg: m.msg })) };
    };
    const ca = await cancelCase('a', CX2, 'tcancela01', 'vend000a');
    const cb = await cancelCase('b', NOACCT, 'tcancelb01', 'vend000b');
    const refusedCancel = (r, job) => r.spawned === 0 && r.marked === 0 && r.removed === 0 && r.ledgerSame && r.logNamedUntouched
      && r.messages.length === 1 && r.messages[0].level === 'warning' && /cancelled here; the session itself was not stopped/.test(r.messages[0].msg) && ADVICE.test(r.messages[0].msg) && r.messages[0].msg.includes(`\`claude stop ${job}\``)
      && r.ev.status === 'error' && /^cancelled by user/.test(r.ev.error) && /cancelled here; the session itself was not stopped/.test(r.ev.error) && /was NOT stopped/.test(r.note) && /CANCELLED: cancelled by user — cancelled here/.test(r.note);
    check('X15 (a) Tasks-tree cancel, ledger directory = a registered CODEX worker\'s home: no process is started, no ledger mark, no `claude rm`, the ledger file is byte-identical; the task is closed in OUR record and the record, the output note and the message all say "cancelled here; the session itself was not stopped", with the one-sentence way to stop it',
      refusedCancel(ca, 'vend000a'), JSON.stringify({ spawned: ca.spawned, marked: ca.marked, removed: ca.removed, error: ca.ev && ca.ev.error, msg: ca.messages.map((m) => m.msg) }));
    check('X16 (b) Tasks-tree cancel, ledger directory = a path NO account has: the same — nothing started, nothing marked, said truthfully',
      refusedCancel(cb, 'vend000b'), JSON.stringify({ spawned: cb.spawned, marked: cb.marked, removed: cb.removed, error: cb.ev && cb.ev.error, msg: cb.messages.map((m) => m.msg) }));
    const cc = await cancelCase('c', W1, 'tcancelc01', 'abcd000c');
    const ccCall = fakeCalls().slice(-1)[0];
    check('X17 (c) Tasks-tree cancel, ledger directory = a CURRENT Claude Code account: as before — `claude stop <job>` runs under that account (claudeEnv), the ledger is marked by job id, the teardown runs, the record says "cancelled by user" and the message "Dispatched task cancelled."',
      cc.spawned === 1 && ccCall.argv.join(' ') === 'stop abcd000c' && ccCall.env.CLAUDE_CONFIG_DIR === W1 && !('CLAUDECODE' in ccCall.env) && cc.marked === 1 && ledgerCalls.marked[0].jobId === 'abcd000c' && cc.removed === 1 && ledgerCalls.removed[0].configDir === W1
      && cc.ev.status === 'error' && cc.ev.error === 'cancelled by user' && cc.messages.length === 1 && cc.messages[0].level === 'info' && cc.messages[0].msg === 'Dispatched task cancelled.', JSON.stringify({ spawned: cc.spawned, marked: cc.marked, removed: cc.removed, error: cc.ev && cc.ev.error, msg: cc.messages.map((m) => m.msg) }));

    // ---- cancel ALL: one of each at once
    running('tall00000a', 'cco-all-a'); running('tall00000c', 'cco-all-c');
    ledger([lrec({ name: 'cco-all-a', configDir: CX2, jobId: 'vendalla', taskId: 'tall00000a' }), lrec({ name: 'cco-all-c', configDir: W1, jobId: 'abcdallc', taskId: 'tall00000c' })]);
    ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
    let before = fakeCalls().length;
    reset();
    answers.message.push((items) => items.find((i) => i === 'Cancel Dispatches'));
    await run('cancelAllTasks');
    const allCalls = fakeCalls().slice(before);
    const allWarn = rec.messages.find((m) => m.level === 'warning' && !m.modal);
    check('X18 "Cancel all": the Claude-account session is stopped, the one recorded under the Codex home is not (one `claude stop`, one ledger mark), and a second message says which dispatch is cancelled here only and names its job id',
      allCalls.length === 1 && allCalls[0].argv.join(' ') === 'stop abcdallc' && ledgerCalls.marked.length === 1 && ledgerCalls.marked[0].jobId === 'abcdallc' && allWarn !== undefined && /cancelled here only/.test(allWarn.msg) && ADVICE.test(allWarn.msg) && /vendalla/.test(allWarn.msg)
      && !/abcdallc/.test(allWarn.msg) && /cancelled here; the session itself was not stopped/.test(lastEventOf('tall00000a').error) && lastEventOf('tall00000c').error === 'cancelled by user', rec.messages.map((m) => `${m.level}: ${m.msg}`).join(' | '));

    // ---- (a) and (b): stop from the Team view (rows as team.ts builds them: no account → no directory; and a STALE row that still carries one)
    const stopCase = async (label, key, resolved, records) => {
      team.resolved.set(key, res({ key, ...resolved }));
      ledger(records);
      const ledgerBytes = fs.readFileSync(LEDGER);
      ledgerCalls.marked.length = 0; ledgerCalls.removed.length = 0;
      const b = fakeCalls().length;
      reset();
      answers.message.push(confirmStop);
      await run('stopSession', { key });
      return { spawned: fakeCalls().length - b, marked: ledgerCalls.marked.length, removed: ledgerCalls.removed.length, ledgerSame: fs.readFileSync(LEDGER).equals(ledgerBytes), messages: rec.messages.filter((m) => !m.modal).map((m) => ({ level: m.level, msg: m.msg })), modals: rec.messages.filter((m) => m.modal).length };
    };
    const refusedStop = (r, job) => r.spawned === 0 && r.marked === 0 && r.removed === 0 && r.ledgerSame && r.modals === 1 && r.messages.length === 1 && r.messages[0].level === 'warning'
      && /was not stopped/.test(r.messages[0].msg) && ADVICE.test(r.messages[0].msg) && r.messages[0].msg.includes(`\`claude stop ${job}\``);
    const sa = await stopCase('a', 'worker:vendsa01', { name: 'cco-sa', jobId: 'vendsa01' }, [lrec({ name: 'cco-sa', configDir: CX2, jobId: 'vendsa01' })]);
    const sa2 = await stopCase('a-stale', 'worker:vendsa02', { name: 'cco-sa2', jobId: 'vendsa02', configDir: CX2 }, [lrec({ name: 'cco-sa2', configDir: CX2, jobId: 'vendsa02' })]);
    const sa3 = await stopCase('a-stale-no-record', 'worker:vendsa03', { name: 'cco-sa3', jobId: 'vendsa03', configDir: `${CX2}${path.sep}..${path.sep}${path.basename(CX2)}${path.sep}` }, []);
    const sb = await stopCase('b', 'worker:vendsb01', { name: 'cco-sb', jobId: 'vendsb01' }, [lrec({ name: 'cco-sb', configDir: NOACCT, jobId: 'vendsb01' })]);
    check('X19 (a) Team-view stop, directory = the Codex worker\'s home — whether it comes from the ledger record (a row with no account), from a stale row that still carries it, or from such a row with no record and another spelling of the path: no process, no ledger mark, the ledger file byte-identical, and the user is told the account is no longer registered and how to stop it',
      refusedStop(sa, 'vendsa01') && refusedStop(sa2, 'vendsa02') && refusedStop(sa3, 'vendsa03'), JSON.stringify([sa, sa2, sa3].map((r) => ({ spawned: r.spawned, marked: r.marked, msg: r.messages.map((m) => m.msg.slice(0, 90)) }))));
    check('X20 (b) Team-view stop, directory = a path NO account has: the same', refusedStop(sb, 'vendsb01'), JSON.stringify({ spawned: sb.spawned, marked: sb.marked, msg: sb.messages.map((m) => m.msg) }));
    // a dispatch still running on that session: the stop goes through the cancel path
    running('tstop0000a', 'cco-sa4');
    const sa4 = await stopCase('a-running', 'worker:vendsa04', { name: 'cco-sa4', jobId: 'vendsa04', taskId: 'tstop0000a' }, [lrec({ name: 'cco-sa4', configDir: CX2, jobId: 'vendsa04', taskId: 'tstop0000a' })]);
    check('X21 (a) Team-view stop while a dispatch is still running on that session: nothing is started; the task is closed in our record ("cancelled here; the session itself was not stopped") and the message says the task is cancelled here only',
      sa4.spawned === 0 && sa4.marked === 0 && sa4.removed === 0 && sa4.ledgerSame && sa4.messages.length === 1 && sa4.messages[0].level === 'warning' && /its running task is cancelled here only/.test(sa4.messages[0].msg) && ADVICE.test(sa4.messages[0].msg)
      && /cancelled here; the session itself was not stopped/.test(lastEventOf('tstop0000a').error), JSON.stringify({ msg: sa4.messages.map((m) => m.msg), error: lastEventOf('tstop0000a').error }));
    const sc = await stopCase('c', 'worker:abcdsc01', { name: 'cco-sc', jobId: 'abcdsc01', configDir: W1 }, [lrec({ name: 'cco-sc', configDir: W1, jobId: 'abcdsc01' })]);
    const scCall = fakeCalls().slice(-1)[0];
    const sc2 = await stopCase('c-main', 'worker:abcdsc02', { name: 'cco-sc2', jobId: 'abcdsc02', configDir: mainDir }, [lrec({ name: 'cco-sc2', configDir: mainDir, jobId: 'abcdsc02' })]);
    const sc2Call = fakeCalls().slice(-1)[0];
    check('X22 (c) Team-view stop, directory = a CURRENT Claude Code account (the worker\'s, and main\'s — both also named by a Codex worker): as before — `claude stop <job>` under claudeEnv (the worker\'s directory set; main\'s default directory with CLAUDE_CONFIG_DIR absent), the ledger marked, the teardown run, "Stopped session"',
      sc.spawned === 1 && scCall.argv.join(' ') === 'stop abcdsc01' && scCall.env.CLAUDE_CONFIG_DIR === W1 && sc.marked === 1 && sc.removed === 1 && sc.messages.some((m) => m.level === 'info' && /^Stopped session "cco-sc"/.test(m.msg))
      && sc2.spawned === 1 && sc2Call.argv.join(' ') === 'stop abcdsc02' && !('CLAUDE_CONFIG_DIR' in sc2Call.env) && sc2.marked === 1 && sc2.messages.some((m) => m.level === 'info' && /^Stopped session "cco-sc2"/.test(m.msg)),
      JSON.stringify([sc, sc2].map((r) => ({ spawned: r.spawned, marked: r.marked, removed: r.removed, msg: r.messages.map((m) => m.msg.slice(0, 60)) }))));

    // ---- attach / logs from the Team view
    team.resolved.set('worker:vendat01', res({ key: 'worker:vendat01', name: 'cco-at1', jobId: 'vendat01' })); // (a)/(b) as team.ts builds it: no directory
    team.resolved.set('worker:vendat02', res({ key: 'worker:vendat02', name: 'cco-at2', jobId: 'vendat02', configDir: CX2 })); // (a) stale row
    team.resolved.set('worker:vendat03', res({ key: 'worker:vendat03', name: 'cco-at3', jobId: 'vendat03', configDir: NOACCT })); // (b) stale row
    team.resolved.set('worker:abcda004', res({ key: 'worker:abcda004', name: 'cco-at4', jobId: 'abcda004', configDir: W1 })); // (c)
    reset();
    before = fakeCalls().length;
    for (const key of ['worker:vendat01', 'worker:vendat02', 'worker:vendat03']) {
      await run('attachSession', { key });
      await run('sessionLogs', { key });
    }
    check('X23 (a)/(b) attach and logs from the Team view open NO terminal for a session whose directory is not a current Claude Code account\'s (absent, the Codex home, a path no account has): six warnings, each naming the `claude attach|logs <job id>` to run under that account instead',
      rec.terminals.length === 0 && fakeCalls().length === before && rec.messages.length === 6 && rec.messages.every((m) => m.level === 'warning' && ADVICE.test(m.msg))
      && rec.messages[0].msg.includes('`claude attach vendat01`') && rec.messages[1].msg.includes('`claude logs vendat01`') && rec.messages[5].msg.includes('`claude logs vendat03`'), rec.messages.map((m) => m.msg.slice(0, 70)).join(' | '));
    reset();
    await run('attachSession', { key: 'worker:abcda004' });
    await run('sessionLogs', { key: 'worker:abcda004' });
    check('X24 (c) attach and logs for a current Claude Code account still open `claude attach|logs <job>` under claudeTerminalEnv',
      rec.terminals.length === 2 && rec.terminals[0].sent[0] === 'claude attach abcda004' && rec.terminals[1].sent[0] === 'claude logs abcda004' && rec.terminals.every((t) => same(t.opts.env, platform.claudeTerminalEnv(W1))) && rec.messages.length === 0,
      rec.terminals.map((t) => t.sent[0]).join(' | '));

    check('X25 through every one of those cancels, stops, attaches and logs, the Codex worker\'s home is BYTE-IDENTICAL — same files, sizes, modes, modification times and content hashes, directories included — and so is the directory no account has',
      snapshot(CX2) === snapA && snapshot(NOACCT) === snapB && snapA.split('\n').length >= 9, `${snapA.split('\n').length} entries under the Codex home, ${snapB.split('\n').length} under the other`);
    const stops = fakeCalls().filter((c) => c.env.CLAUDE_CONFIG_DIR === CX2 || c.env.CLAUDE_CONFIG_DIR === NOACCT || c.argv.some((a) => /^vend/.test(a)));
    check('X26 and the fake `claude` was never started with CLAUDE_CONFIG_DIR pointed at either directory, nor for any of those job ids', stops.length === 0, JSON.stringify(stops.map((c) => c.argv)));
    ledger([]);
    for (const k of [...team.resolved.keys()]) team.resolved.delete(k);

    // --- removing a worker: only a reading the worker OWNED goes with it
    const cached = () => Object.keys(JSON.parse(fs.readFileSync(usage.USAGE_CACHE_FILE, 'utf8'))).map((k) => path.basename(k)).sort().join(',');
    const start = cached();
    direct.remove('cxmain');
    const afterCxMain = cached();
    direct.remove('cxw1');
    const afterCxW1 = cached();
    direct.remove('cx2');
    const afterCx2 = cached();
    direct.remove('w1');
    const afterW1 = cached();
    check('X27 removing the Codex worker that was registered on main\'s directory does NOT delete main\'s usage reading (it never owned it); removing the one on the Claude worker\'s directory keeps that reading too; removing an owner — the Codex worker with its own home, then the Claude worker — still drops its own entry, as before',
      start === '.claude,.claude-w1,.codex-cx2' && afterCxMain === start && afterCxW1 === start && afterCx2 === '.claude,.claude-w1' && afterW1 === '.claude' && readReg().workers.length === 0,
      [start, afterCxMain, afterCxW1, afterCx2, afterW1].join(' → '));
  });

  /* ------------------------------------------------------------------- epilogue */
  for (const d of context.subscriptions) { try { d.dispose(); } catch { /* stub disposables */ } }
  const strayCalls = fakeCalls().filter((c) => c.argv[0] !== 'stop');
  check('Z1 the fake claude was only ever asked to `stop`', strayCalls.length === 0, JSON.stringify(strayCalls.map((c) => c.argv)));
  check('Z2 no program outside the allowlist was started (blocked attempts are path lookups only, never a CLI run) — no codex, cursor-agent or agy',
    blockedSpawns.every((b) => /-lc/.test(b) && /command -v/.test(b)), blockedSpawns.join(' ; ') || 'none attempted');
  check('Z3 nothing was written to the real home directory by this probe', os.homedir() === HOME && REAL_HOME !== HOME && registry.ROOT_DIR.startsWith(HOME));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`\n${H.passes} passed, ${H.failures} failed${H.skips ? `, ${H.skips} skipped` : ''}`);
  process.exit(H.failures === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`FAIL — probe crashed: ${e && e.stack}`);
  process.exit(1);
});
