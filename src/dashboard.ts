import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  readOrchestrators,
  readRegistry,
  readStats,
  readTaskEvents,
  TaskEvent,
  windowUsage,
} from './registry';
import { isFrontierTier } from './prompts';
import { formatAge, formatRelativeReset, getCachedUsage, isElevated, listAccounts, USAGE_CACHE_FILE } from './usage';

const NO_LIMITS_MESSAGE =
  'No plan limits — this login is a token / non-subscription account. Live usage appears only for ' +
  'subscription logins (log this dir into a subscription, or point the main session at a subscription config dir).';

/** One usage card, fully resolved for the webview. `state` picks the message the card renders. */
interface UsageCard {
  name: string;
  label: string;
  state: 'refreshing' | 'error' | 'unavailable' | 'ok';
  message: string | null;
  subscriptionType: string | null;
  ageMinutes: number | null;
  windows: { label: string; percent: number; severity: string; elevated: boolean; reset: string }[];
  /** Overage billing state for an `ok` card; null on every other state and when unreported. */
  overage: { enabled: boolean; percent: number | null; spendLabel: string | null } | null;
  /**
   * Set on an `ok` card only when the plan-usage windows are the last-good
   * reading carried forward (upstream get_usage returned no data); null when
   * the numbers are fresh and on every other state. `since` is the age of that
   * last-good reading, e.g. `6m ago`.
   */
  stale: { since: string } | null;
}

/**
 * Normalize `AccountUsage.extraUsage` from the cache file. The file is external
 * input (hand-editable, truncatable), so the declared type is not a guarantee:
 * anything off-shape degrades to the safe reading rather than to a misleading
 * "overage is on" or a rendered `null` / `NaN`.
 */
function parseOverage(raw: unknown): UsageCard['overage'] {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  return {
    enabled: rec.enabled === true,
    percent:
      typeof rec.percent === 'number' && isFinite(rec.percent)
        ? Math.max(0, Math.min(100, rec.percent))
        : null,
    spendLabel: typeof rec.spendLabel === 'string' ? rec.spendLabel : null,
  };
}

/** Cached (never spawning) usage for 'main' + every worker, shaped for rendering. */
function usageCards(now: number): UsageCard[] {
  let accounts: { name: string; configDir: string }[];
  try {
    accounts = listAccounts();
  } catch {
    return [];
  }
  return accounts.map(({ name, configDir }): UsageCard => {
    const label = name === 'main' ? 'main (this session)' : name;
    const card: UsageCard = {
      name,
      label,
      state: 'refreshing',
      message: 'usage: — (refreshing)',
      subscriptionType: null,
      ageMinutes: null,
      windows: [],
      overage: null,
      stale: null,
    };
    const u = getCachedUsage(configDir);
    if (!u) {
      return card;
    }
    card.subscriptionType = u.subscriptionType;
    card.ageMinutes =
      typeof u.fetchedAt === 'number' && isFinite(u.fetchedAt)
        ? Math.max(0, Math.floor((now - u.fetchedAt) / 60_000))
        : null;
    if (u.error !== undefined) {
      return { ...card, state: 'error', message: `usage unavailable: ${u.error}` };
    }
    if (!u.available) {
      return { ...card, state: 'unavailable', message: NO_LIMITS_MESSAGE };
    }
    return {
      ...card,
      state: 'ok',
      message: null,
      overage: parseOverage(u.extraUsage),
      stale: u.windowsStale === true ? { since: formatAge(u.windowsFetchedAt) } : null,
      // The cache file is external input: a truncated/hand-edited entry may lack
      // windows, or carry null / non-object / malformed elements inside them.
      windows: (Array.isArray(u.windows) ? u.windows : [])
        .filter((w) => typeof w === 'object' && w !== null)
        .map((w) => {
          const rec = w as unknown as Record<string, unknown>;
          const percent =
            typeof rec.percent === 'number' && isFinite(rec.percent)
              ? Math.max(0, Math.min(100, rec.percent))
              : 0;
          const severity = typeof rec.severity === 'string' ? rec.severity : 'normal';
          return {
            label: typeof rec.label === 'string' ? rec.label : '',
            percent,
            severity,
            elevated: isElevated(severity),
            reset: formatRelativeReset(typeof rec.resetsAt === 'string' ? rec.resetsAt : null),
          };
        }),
    };
  });
}

const SETTING_KEYS = [
  'workerPermissionMode',
  'claudePath',
  'quotaCooldownMinutes',
  'frontierWorkerDispatch',
] as const;
const COMMAND_IDS = ['installMcp', 'addDispatchPolicy', 'addWorker', 'clearTasks'] as const;

/** Per-day done/error counts for the trailing N days, scoped to a workspace. */
function dailyCounts(root: string | undefined, days: number) {
  const byId = new Map<string, TaskEvent>();
  for (const e of readTaskEvents()) {
    byId.set(e.id, e);
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - (days - 1) * dayMs;
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(start + i * dayMs);
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, done: 0, error: 0 };
  });
  for (const e of byId.values()) {
    if (e.status === 'running' || e.ts < start) {
      continue;
    }
    if (root && !(e.cwd && (e.cwd === root || e.cwd.startsWith(root + '/')))) {
      continue;
    }
    const idx = Math.floor((e.ts - start) / dayMs);
    if (idx >= 0 && idx < days) {
      buckets[idx][e.status === 'done' ? 'done' : 'error']++;
    }
  }
  return buckets;
}

/**
 * Editor-tab dashboard: stat tiles, activity/usage charts, worker + task
 * tables, and a settings panel. Data is pushed every 2s; setting edits and
 * quick actions round-trip through the extension host.
 */
export function openDashboard(): void {
  const panel = vscode.window.createWebviewPanel(
    'ccOrchestratorDashboard',
    'Orchestrator Dashboard',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = dashboardHtml();

  const send = () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const registry = readRegistry();
    const stats = readStats();
    const now = Date.now();
    const workers = registry.workers.map((w) => {
      const s = stats[w.name];
      return {
        name: w.name,
        preferred: Boolean(w.preferred),
        model: w.model,
        coolingDown: (s?.cooldownUntil ?? 0) > now,
        cooldownUntil: s?.cooldownUntil,
        totals: s ?? null,
        session: windowUsage(w.name, 5 * 60 * 60 * 1000),
        week: windowUsage(w.name, 7 * 24 * 60 * 60 * 1000),
      };
    });
    const byId = new Map<string, TaskEvent>();
    for (const e of readTaskEvents()) {
      byId.set(e.id, e);
    }
    const all = [...byId.values()];
    const tasks = all
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100)
      .map((e) => ({
        ...e,
        inWorkspace: Boolean(root && e.cwd && (e.cwd === root || e.cwd.startsWith(root + '/'))),
      }));
    const checkin = root ? readOrchestrators()[root] : undefined;
    const cfg = vscode.workspace.getConfiguration('claudeCodeOrchestrator');
    void panel.webview.postMessage({
      type: 'data',
      workspace: root ?? null,
      orchestrator: checkin
        ? { model: checkin.model, ts: checkin.ts, calibrated: !isFrontierTier(checkin.model) }
        : null,
      workers,
      tasks,
      running: all.filter((e) => e.status === 'running').length,
      daily: dailyCounts(root, 14),
      usage: usageCards(now),
      settings: {
        workerPermissionMode: cfg.get('workerPermissionMode', 'acceptEdits'),
        claudePath: cfg.get('claudePath', 'claude'),
        quotaCooldownMinutes: cfg.get('quotaCooldownMinutes', 30),
        frontierWorkerDispatch: cfg.get('frontierWorkerDispatch', 'block'),
      },
    });
  };

  const timer = setInterval(send, 2000);
  // The cache is rewritten by the background refresher; re-push as soon as it changes.
  const onCacheChange = () => send();
  fs.watchFile(USAGE_CACHE_FILE, { interval: 2000 }, onCacheChange);
  panel.onDidDispose(() => {
    clearInterval(timer);
    fs.unwatchFile(USAGE_CACHE_FILE, onCacheChange);
  });
  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; file?: string; key?: string; value?: unknown; id?: string }) => {
      if (msg.type === 'openTask' && msg.file) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.file));
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } catch {
          void vscode.window.showWarningMessage(`Task output not found: ${msg.file}`);
        }
      } else if (msg.type === 'setSetting' && (SETTING_KEYS as readonly string[]).includes(msg.key ?? '')) {
        await vscode.workspace
          .getConfiguration('claudeCodeOrchestrator')
          .update(msg.key!, msg.value, vscode.ConfigurationTarget.Global);
        send();
      } else if (msg.type === 'runCommand' && (COMMAND_IDS as readonly string[]).includes(msg.id ?? '')) {
        await vscode.commands.executeCommand(`claudeCodeOrchestrator.${msg.id}`);
        send();
      } else if (msg.type === 'cancelTask' && msg.id) {
        await vscode.commands.executeCommand('claudeCodeOrchestrator.cancelTask', { id: msg.id });
      } else if (msg.type === 'cancelAllTasks') {
        await vscode.commands.executeCommand('claudeCodeOrchestrator.cancelAllTasks');
      }
    },
  );
  send();
}

/** Exported for headless rendering tests. */
export function dashboardHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  :root {
    --c-done: var(--vscode-charts-blue, #3794ff);
    --c-error: var(--vscode-charts-red, #f14c4c);
    --c-in: var(--vscode-charts-blue, #3794ff);
    --c-out: var(--vscode-charts-purple, #b180d7);
    --c-muted: var(--vscode-descriptionForeground);
    --c-usage: var(--vscode-charts-green, #89d185);
    --c-usage-warn: var(--vscode-editorWarning-foreground, #cca700);
    --c-usage-crit: var(--vscode-errorForeground, #f14c4c);
    --card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --border: var(--vscode-panel-border, #4444);
  }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 18px 40px; }
  h1 { font-size: 1.15em; margin: 0 0 2px; }
  #meta { color: var(--c-muted); font-size: 0.88em; margin: 0 0 14px; }
  .grid { display: grid; gap: 12px; }
  .tiles { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); margin-bottom: 12px; }
  .charts { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); margin-bottom: 12px; }
  .bottom { grid-template-columns: 2fr 1fr; align-items: start; }
  @media (max-width: 860px) { .bottom { grid-template-columns: 1fr; } }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; }
  .card h2 { font-size: 0.82em; font-weight: 600; color: var(--c-muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 8px; }
  .tile .num { font-size: 1.55em; font-weight: 600; line-height: 1.2; }
  .tile .sub { color: var(--c-muted); font-size: 0.82em; margin-top: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  th { color: var(--c-muted); font-weight: 600; }
  td.title { white-space: normal; }
  .muted { color: var(--c-muted); }
  .ok { color: var(--vscode-charts-green, #89d185); }
  .err { color: var(--c-error); }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .task-link { cursor: pointer; text-decoration: underline; }
  .badge { border: 1px solid var(--border); border-radius: 8px; padding: 0 6px; font-size: 0.85em; }
  .legend { display: flex; gap: 14px; margin-top: 6px; font-size: 0.82em; color: var(--c-muted); }
  .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: baseline; }
  svg text { fill: var(--c-muted); font-size: 9.5px; font-family: var(--vscode-font-family); }
  svg .grid-line { stroke: var(--border); stroke-width: 1; }
  svg .val { fill: var(--vscode-foreground); font-size: 10px; }
  label { display: block; color: var(--c-muted); font-size: 0.82em; margin: 10px 0 3px; }
  select, input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; padding: 4px 6px; font-family: inherit; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
  button { background: var(--vscode-button-secondaryBackground, var(--card-bg)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--border); border-radius: 3px; padding: 4px 10px; cursor: pointer; font-family: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--border)); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:disabled:hover { background: var(--vscode-button-secondaryBackground, var(--card-bg)); }
  .cancel-btn { color: var(--vscode-errorForeground, #f14c4c); padding: 1px 8px; font-size: 0.85em; }
  #saved { color: var(--vscode-charts-green, #89d185); font-size: 0.8em; margin-left: 6px; opacity: 0; transition: opacity 0.3s; }
  .empty { color: var(--c-muted); padding: 18px 0; text-align: center; }
  .usage { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 12px; }
  .usage .card h2 { text-transform: none; letter-spacing: 0; font-size: 0.92em; color: var(--vscode-foreground); }
  .u-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 8px; }
  .u-age { color: var(--c-muted); font-size: 0.78em; white-space: nowrap; }
  .u-note { color: var(--c-muted); font-size: 0.85em; margin: 0; }
  .u-note.err { color: var(--c-error); }
  .u-win + .u-win { margin-top: 9px; }
  .u-label { display: flex; justify-content: space-between; gap: 8px; font-size: 0.82em; margin-bottom: 3px; }
  .u-pct { font-variant-numeric: tabular-nums; }
  .u-track { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
  .u-fill { height: 100%; border-radius: 3px; background: var(--c-usage); }
  .u-fill.warning { background: var(--c-usage-warn); }
  .u-fill.critical { background: var(--c-usage-crit); }
  .u-win.warning .u-pct { color: var(--c-usage-warn); }
  .u-win.critical .u-pct { color: var(--c-usage-crit); }
  .u-reset { color: var(--c-muted); font-size: 0.78em; margin-top: 3px; }
  .u-extra { font-size: 0.8em; margin: 10px 0 0; color: var(--c-muted); cursor: help; }
  .u-extra.on { color: var(--c-usage-warn); font-weight: 600; }
  .u-stale { font-size: 0.8em; margin: 6px 0 0; color: var(--c-usage-warn); cursor: help; }
</style>
</head>
<body>
  <h1>Orchestrator Dashboard</h1>
  <p id="meta"></p>

  <div class="grid tiles" id="tiles"></div>

  <div class="grid charts">
    <div class="card">
      <h2>Tasks · last 14 days (this workspace)</h2>
      <div id="dailyChart"></div>
      <div class="legend">
        <span><span class="swatch" style="background:var(--c-done)"></span>done</span>
        <span><span class="swatch" style="background:var(--c-error)"></span>error</span>
      </div>
    </div>
    <div class="card">
      <h2>Tokens by worker · 7 days (all workspaces)</h2>
      <div id="workerChart"></div>
      <div class="legend">
        <span><span class="swatch" style="background:var(--c-in)"></span>input</span>
        <span><span class="swatch" style="background:var(--c-out)"></span>output</span>
      </div>
    </div>
  </div>

  <h2 style="font-size:0.82em;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 8px">Live plan usage</h2>
  <div class="grid usage" id="usage"></div>

  <div class="grid bottom">
    <div>
      <div class="card" style="margin-bottom:12px">
        <h2>Worker accounts</h2>
        <table id="workers"><thead><tr>
          <th>account</th><th>model</th><th>status</th><th>session 5h</th><th>weekly 7d</th><th>all time</th>
        </tr></thead><tbody></tbody></table>
      </div>
      <div class="card">
        <h2>Dispatched tasks <label style="display:inline;font-size:1em;margin-left:8px"><input type="checkbox" id="scope" checked style="width:auto"> this workspace only</label></h2>
        <table id="tasks"><thead><tr>
          <th></th><th>title</th><th>worker</th><th>model</th><th>tokens</th><th>when</th>
        </tr></thead><tbody></tbody></table>
      </div>
    </div>
    <div class="card">
      <h2>Settings<span id="saved">saved ✓</span></h2>
      <label for="s-perm">worker permission mode</label>
      <select id="s-perm">
        <option>default</option><option>acceptEdits</option><option>plan</option><option>bypassPermissions</option>
      </select>
      <label for="s-path">claude CLI path</label>
      <input id="s-path" type="text" spellcheck="false">
      <label for="s-cool">quota cooldown (minutes)</label>
      <input id="s-cool" type="number" min="1">
      <label for="s-frontier">frontier worker dispatch (claude-fable-5 — may bill per use)</label>
      <select id="s-frontier">
        <option value="block">block (billing guard)</option><option value="allow">allow</option>
      </select>
      <div class="actions">
        <button data-cmd="installMcp">Register MCP here</button>
        <button data-cmd="addDispatchPolicy">Add policy to CLAUDE.md</button>
        <button data-cmd="addWorker">Add worker</button>
        <button data-cmd="clearTasks">Clear task history</button>
        <button id="cancel-all">Cancel all running</button>
      </div>
      <p class="muted" style="font-size:0.8em;margin-top:12px">
        Charts and the Worker Accounts table count only dispatches made through this extension, not the
        account's overall consumption. For an account's real plan quota, see the Live plan usage panel above
        — it refreshes automatically and via the Refresh Account Usage command.
      </p>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let data = null;
  let editing = null; // input id being edited — don't clobber while typing

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const tok = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e4 ? (n/1e3).toFixed(1)+'k' : String(n ?? 0);

  window.addEventListener('message', (e) => { if (e.data.type === 'data') { data = e.data; render(); } });
  document.getElementById('scope').addEventListener('change', render);

  // --- settings wiring ---
  function flashSaved() {
    const el = document.getElementById('saved');
    el.style.opacity = 1; setTimeout(() => (el.style.opacity = 0), 1200);
  }
  function bindSetting(id, key, parse, event, debounceMs) {
    const el = document.getElementById(id);
    let t;
    el.addEventListener(event, () => {
      editing = id;
      clearTimeout(t);
      t = setTimeout(() => {
        vscode.postMessage({ type: 'setSetting', key, value: parse(el.value) });
        editing = null; flashSaved();
      }, debounceMs);
    });
    el.addEventListener('blur', () => { if (editing === id) editing = null; });
  }
  bindSetting('s-perm', 'workerPermissionMode', (v) => v, 'change', 0);
  bindSetting('s-path', 'claudePath', (v) => v.trim(), 'input', 700);
  bindSetting('s-cool', 'quotaCooldownMinutes', (v) => Math.max(1, Number(v) || 30), 'input', 700);
  bindSetting('s-frontier', 'frontierWorkerDispatch', (v) => v, 'change', 0);
  for (const b of document.querySelectorAll('button[data-cmd]')) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'runCommand', id: b.dataset.cmd }));
  }
  document.getElementById('cancel-all').addEventListener('click', () => vscode.postMessage({ type: 'cancelAllTasks' }));

  // --- charts (hand-rolled SVG, theme-var colors) ---
  function dailyChart(daily) {
    const W = 460, H = 150, padL = 26, padB = 16, padT = 8;
    const plotW = W - padL - 6, plotH = H - padB - padT;
    const max = Math.max(1, ...daily.map((d) => d.done + d.error));
    const step = plotW / daily.length, barW = Math.max(6, step * 0.62);
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="tasks per day">';
    // 3 recessive gridlines + y labels
    for (let i = 0; i <= 2; i++) {
      const v = Math.ceil(max * i / 2), y = padT + plotH - (plotH * i / 2);
      s += '<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + W + '" y2="' + y + '"/>' +
           '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end">' + v + '</text>';
    }
    daily.forEach((d, i) => {
      const x = padL + i * step + (step - barW) / 2;
      const hDone = plotH * d.done / max, hErr = plotH * d.error / max;
      const yDone = padT + plotH - hDone;
      const tip = '<title>' + esc(d.label) + ' — ' + d.done + ' done, ' + d.error + ' error</title>';
      if (d.done > 0) s += '<rect x="' + x + '" y="' + yDone + '" width="' + barW + '" height="' + hDone + '" rx="2" fill="var(--c-done)">' + tip + '</rect>';
      if (d.error > 0) s += '<rect x="' + x + '" y="' + (yDone - hErr - 2) + '" width="' + barW + '" height="' + hErr + '" rx="2" fill="var(--c-error)">' + tip + '</rect>';
      if (i % 2 === 0) s += '<text x="' + (x + barW / 2) + '" y="' + (H - 3) + '" text-anchor="middle">' + esc(d.label) + '</text>';
    });
    return s + '</svg>';
  }

  function workerChart(workers) {
    const rows = workers.map((w) => ({ name: w.name, inT: w.week.inputTokens, outT: w.week.outputTokens }));
    const max = Math.max(1, ...rows.map((r) => r.inT + r.outT));
    const W = 460, rowH = 26, padL = 92, padR = 56;
    const H = rows.length * rowH + 6;
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="tokens per worker">';
    rows.forEach((r, i) => {
      const y = i * rowH + 6, h = 12;
      const wIn = (W - padL - padR) * r.inT / max, wOut = (W - padL - padR) * r.outT / max;
      const tip = '<title>' + esc(r.name) + ' — ' + tok(r.inT) + ' in / ' + tok(r.outT) + ' out</title>';
      s += '<text x="' + (padL - 6) + '" y="' + (y + h - 2) + '" text-anchor="end">' + esc(r.name) + '</text>';
      if (r.inT > 0) s += '<rect x="' + padL + '" y="' + y + '" width="' + Math.max(2, wIn) + '" height="' + h + '" rx="2" fill="var(--c-in)">' + tip + '</rect>';
      if (r.outT > 0) s += '<rect x="' + (padL + Math.max(2, wIn) + 2) + '" y="' + y + '" width="' + Math.max(2, wOut) + '" height="' + h + '" rx="2" fill="var(--c-out)">' + tip + '</rect>';
      s += '<text class="val" x="' + (padL + Math.max(2, wIn) + wOut + 8) + '" y="' + (y + h - 2) + '">' + tok(r.inT + r.outT) + '</text>';
    });
    return s + '</svg>';
  }

  // --- live plan usage ---
  function usageBar(w) {
    const cls = w.elevated ? (w.severity === 'critical' ? 'critical' : 'warning') : '';
    const pct = Math.max(0, Math.min(100, Number(w.percent) || 0));
    return '<div class="u-win ' + cls + '">' +
      '<div class="u-label"><span>' + esc(w.label) + '</span><span class="u-pct">' + Math.round(pct) + '%</span></div>' +
      '<div class="u-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) +
        '" aria-label="' + esc(w.label) + '"><div class="u-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
      '<div class="u-reset">resets ' + esc(w.reset) + '</div></div>';
  }

  const OVERAGE_ON_TIP =
    'Extra usage is ON: dispatching past a plan window bills real money against the monthly ' +
    'overage cap for this account instead of being blocked.';
  const OVERAGE_OFF_TIP =
    'Extra usage is off: exhausting a plan window blocks further work on this account. No money is spent.';

  // One line under the bars: money-risk signal when overage is on, muted when off, nothing when unreported.
  function overageLine(o) {
    if (!o) return '';
    if (o.enabled !== true) {
      return '<p class="u-extra" title="' + esc(OVERAGE_OFF_TIP) + '">Extra usage: off</p>';
    }
    const spend = typeof o.spendLabel === 'string' && o.spendLabel ? ' — ' + esc(o.spendLabel) : '';
    const pct = Number.isFinite(o.percent) ? ' (' + Math.round(o.percent) + '% of cap)' : '';
    return '<p class="u-extra on" title="' + esc(OVERAGE_ON_TIP) + '">⚠ Extra usage: ON' + spend + pct + '</p>';
  }

  const STALE_TIP =
    'These plan-usage numbers are the last good reading, not a live one: upstream get_usage returned no ' +
    'rate-limit data, so the previous window values are carried forward (up to 30 minutes) rather than shown as empty.';

  // A warning line under the bars when the window numbers are carried-forward, not live.
  function staleLine(stale) {
    if (!stale) return '';
    return '<p class="u-stale" title="' + esc(STALE_TIP) + '">⏱ plan usage as of ' + esc(stale.since) +
      ' — upstream returned no data</p>';
  }

  function usageCard(c) {
    const age = Number.isFinite(c.ageMinutes) ? 'updated ' + c.ageMinutes + 'm ago' : '';
    const plan = c.subscriptionType ? ' <span class="badge muted">' + esc(c.subscriptionType) + '</span>' : '';
    let body;
    if (c.state === 'ok') {
      body = (c.windows.length ? c.windows.map(usageBar).join('') : '<p class="u-note">no rate-limit windows reported</p>') +
        staleLine(c.stale) +
        overageLine(c.overage);
    } else {
      body = '<p class="u-note' + (c.state === 'error' ? ' err' : '') + '">' + esc(c.message) + '</p>';
    }
    return '<div class="card"><div class="u-head"><h2>' + esc(c.label) + plan + '</h2>' +
      '<span class="u-age">' + esc(age) + '</span></div>' + body + '</div>';
  }

  function render() {
    if (!data) return;
    const o = data.orchestrator;
    document.getElementById('meta').textContent =
      (data.workspace ? 'workspace: ' + data.workspace : 'no workspace open') + '   |   main session: ' +
      (o ? o.model + (o.calibrated ? ' (calibration active)' : ' (frontier tier)') : 'not checked in yet');

    // tiles
    const d7 = data.daily.slice(-7);
    const done7 = d7.reduce((a, d) => a + d.done, 0), err7 = d7.reduce((a, d) => a + d.error, 0);
    const inW = data.workers.reduce((a, w) => a + w.week.inputTokens, 0);
    const outW = data.workers.reduce((a, w) => a + w.week.outputTokens, 0);
    const cost = data.workers.reduce((a, w) => a + w.week.costUsd, 0);
    const rate = done7 + err7 > 0 ? Math.round(done7 / (done7 + err7) * 100) + '%' : '–';
    document.getElementById('tiles').innerHTML = [
      ['Running now', data.running, 'active dispatches'],
      ['Tasks · 7d', done7 + err7, done7 + ' done · ' + err7 + ' error'],
      ['Success rate · 7d', rate, 'this workspace'],
      ['Tokens · 7d', tok(inW + outW), tok(inW) + ' in / ' + tok(outW) + ' out'],
      ['Est. cost · 7d', cost > 0 ? '$' + cost.toFixed(2) : '–', 'all workers'],
    ].map(([t, n, sub]) => '<div class="card tile"><h2>' + t + '</h2><div class="num">' + n + '</div><div class="sub">' + sub + '</div></div>').join('');

    // charts
    document.getElementById('dailyChart').innerHTML =
      data.daily.some((d) => d.done + d.error > 0) ? dailyChart(data.daily) : '<div class="empty">no dispatches in the last 14 days</div>';
    document.getElementById('workerChart').innerHTML =
      data.workers.length && data.workers.some((w) => w.week.inputTokens + w.week.outputTokens > 0)
        ? workerChart(data.workers) : '<div class="empty">no worker usage in the last 7 days</div>';

    // live plan usage cards
    const accounts = data.usage || [];
    document.getElementById('usage').innerHTML =
      accounts.length ? accounts.map(usageCard).join('') : '<div class="empty">no accounts configured</div>';

    // workers table
    const usage = (u) => u.tasks === 0 ? '<span class="muted">–</span>' : u.tasks + ' · ' + tok(u.inputTokens) + '/' + tok(u.outputTokens);
    document.querySelector('#workers tbody').innerHTML = data.workers.map((w) => {
      const status = w.coolingDown
        ? '<span class="warn">⏸ until ' + new Date(w.cooldownUntil).toLocaleTimeString() + '</span>'
        : '<span class="ok">available</span>';
      const total = w.totals
        ? w.totals.tasks + ' · ' + tok(w.totals.inputTokens) + '/' + tok(w.totals.outputTokens) + (w.totals.costUsd ? ' · $' + w.totals.costUsd.toFixed(2) : '')
        : '<span class="muted">–</span>';
      return '<tr><td><b>' + (w.preferred ? '★ ' : '') + esc(w.name) + '</b></td><td>' + esc(w.model) + '</td><td>' + status +
        '</td><td>' + usage(w.session) + '</td><td>' + usage(w.week) + '</td><td>' + total + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">no workers registered</td></tr>';

    // tasks table
    const scoped = document.getElementById('scope').checked;
    const tasks = data.tasks.filter((t) => !scoped || t.inWorkspace);
    document.querySelector('#tasks tbody').innerHTML = tasks.map((t) => {
      const icon = t.status === 'running' ? '⟳' : t.status === 'done' ? '<span class="ok">✓</span>' : '<span class="err">✗</span>';
      const tokens = t.inputTokens != null ? tok(t.inputTokens) + '/' + tok(t.outputTokens) : '<span class="muted">–</span>';
      const ws = t.inWorkspace ? '' : ' <span class="badge muted">other ws</span>';
      const cancel = (t.status === 'running' && t.id)
        ? ' <button class="cancel-btn" data-cancel="' + esc(t.id) + '">Cancel</button>' : '';
      return '<tr><td>' + icon + '</td><td class="title"><span class="task-link" data-file="' + esc(t.outputFile) + '">' +
        esc(t.title) + '</span>' + ws + '</td><td>' + esc(t.worker) + '</td><td>' + esc(t.model) +
        '</td><td>' + tokens + '</td><td class="muted">' + new Date(t.ts).toLocaleTimeString() + cancel + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">no dispatched tasks yet</td></tr>';
    for (const el of document.querySelectorAll('.task-link')) {
      el.onclick = () => vscode.postMessage({ type: 'openTask', file: el.dataset.file });
    }
    for (const el of document.querySelectorAll('.cancel-btn')) {
      el.onclick = () => vscode.postMessage({ type: 'cancelTask', id: el.dataset.cancel });
    }
    document.getElementById('cancel-all').disabled = !(data.running > 0);

    // settings (skip fields being edited)
    if (editing !== 's-perm') document.getElementById('s-perm').value = data.settings.workerPermissionMode;
    if (editing !== 's-path') document.getElementById('s-path').value = data.settings.claudePath;
    if (editing !== 's-cool') document.getElementById('s-cool').value = data.settings.quotaCooldownMinutes;
    if (editing !== 's-frontier') document.getElementById('s-frontier').value = data.settings.frontierWorkerDispatch;
  }
</script>
</body>
</html>`;
}
