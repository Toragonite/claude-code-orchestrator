import * as vscode from 'vscode';
import {
  clearOrchestrator,
  readOrchestrators,
  readRegistry,
  readStats,
  readTaskEvents,
  TaskEvent,
  windowUsage,
} from './registry';
import { isFrontierTier } from './prompts';
import { jsonForScript } from './webviewUtil';

const SETTING_KEYS = [
  'workerPermissionMode',
  'claudePath',
  'quotaCooldownMinutes',
  'frontierWorkerDispatch',
] as const;
const COMMAND_IDS = ['installMcp', 'addDispatchPolicy', 'addWorker', 'clearTasks', 'openAssetManager'] as const;

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
    vscode.l10n.t('Orchestrator Dashboard'),
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = dashboardHtml(dashboardStrings());

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
      orchestrator: checkin?.model
        ? { model: checkin.model, ts: checkin.ts, calibrated: !isFrontierTier(checkin.model) }
        : null,
      sessionLastSeen: checkin?.lastSeen ?? null,
      workers,
      tasks,
      running: all.filter((e) => e.status === 'running').length,
      daily: dailyCounts(root, 14),
      settings: {
        workerPermissionMode: cfg.get('workerPermissionMode', 'acceptEdits'),
        claudePath: cfg.get('claudePath', 'claude'),
        quotaCooldownMinutes: cfg.get('quotaCooldownMinutes', 30),
        frontierWorkerDispatch: cfg.get('frontierWorkerDispatch', 'block'),
      },
    });
  };

  const timer = setInterval(send, 2000);
  panel.onDidDispose(() => clearInterval(timer));
  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; file?: string; key?: string; value?: unknown; id?: string }) => {
      if (msg.type === 'openTask' && msg.file) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.file));
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } catch {
          void vscode.window.showWarningMessage(vscode.l10n.t('Task output not found: {0}', msg.file));
        }
      } else if (msg.type === 'setSetting' && (SETTING_KEYS as readonly string[]).includes(msg.key ?? '')) {
        await vscode.workspace
          .getConfiguration('claudeCodeOrchestrator')
          .update(msg.key!, msg.value, vscode.ConfigurationTarget.Global);
        send();
      } else if (msg.type === 'runCommand' && (COMMAND_IDS as readonly string[]).includes(msg.id ?? '')) {
        await vscode.commands.executeCommand(`claudeCodeOrchestrator.${msg.id}`);
        send();
      } else if (msg.type === 'resetCheckin') {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
          clearOrchestrator(root);
        }
        send();
      }
    },
  );
  send();
}

export interface DashboardStrings {
  title: string;
  chartTasksTitle: string;
  legendDone: string;
  legendError: string;
  chartTokensTitle: string;
  legendInput: string;
  legendOutput: string;
  workersTitle: string;
  thAccount: string;
  thModel: string;
  thStatus: string;
  thSession5h: string;
  thWeekly7d: string;
  thAllTime: string;
  tasksTitle: string;
  scopeLabel: string;
  thTitle: string;
  thWorker: string;
  thTokens: string;
  thWhen: string;
  settingsTitle: string;
  savedNote: string;
  permLabel: string;
  pathLabel: string;
  coolLabel: string;
  frontierLabel: string;
  frontierBlock: string;
  frontierAllow: string;
  btnInstallMcp: string;
  btnAddPolicy: string;
  btnAddWorker: string;
  btnManageAssets: string;
  btnClearTasks: string;
  btnResetCheckin: string;
  resetCheckinTip: string;
  footnote: string;
  metaWorkspace: string;
  metaNoWorkspace: string;
  metaMainSession: string;
  calibrationActive: string;
  frontierTier: string;
  briefedAgo: string;
  activeAgo: string;
  sessionPendingBrief: string;
  notCheckedIn: string;
  tileRunningNow: string;
  tileRunningNowSub: string;
  tileTasks7d: string;
  tileTasksSub: string;
  tileSuccess: string;
  tileSuccessSub: string;
  tileTokens: string;
  tileTokensSub: string;
  tileCost: string;
  tileCostSub: string;
  emptyDaily: string;
  emptyWorkerUsage: string;
  ariaTasksPerDay: string;
  chartDayTip: string;
  ariaTokensPerWorker: string;
  chartWorkerTip: string;
  statusCoolingUntil: string;
  statusAvailable: string;
  emptyWorkers: string;
  badgeOtherWs: string;
  emptyTasks: string;
}

/** Localized strings for the page. Must be called from the extension host. */
export function dashboardStrings(): DashboardStrings {
  return {
    title: vscode.l10n.t('Orchestrator Dashboard'),
    chartTasksTitle: vscode.l10n.t('Tasks · last 14 days (this workspace)'),
    legendDone: vscode.l10n.t('done'),
    legendError: vscode.l10n.t('error'),
    chartTokensTitle: vscode.l10n.t('Tokens by worker · 7 days (all workspaces)'),
    legendInput: vscode.l10n.t('input'),
    legendOutput: vscode.l10n.t('output'),
    workersTitle: vscode.l10n.t('Worker accounts'),
    thAccount: vscode.l10n.t('account'),
    thModel: vscode.l10n.t('model'),
    thStatus: vscode.l10n.t('status'),
    thSession5h: vscode.l10n.t('session 5h'),
    thWeekly7d: vscode.l10n.t('weekly 7d'),
    thAllTime: vscode.l10n.t('all time'),
    tasksTitle: vscode.l10n.t('Dispatched tasks'),
    scopeLabel: vscode.l10n.t('this workspace only'),
    thTitle: vscode.l10n.t('title'),
    thWorker: vscode.l10n.t('worker'),
    thTokens: vscode.l10n.t('tokens'),
    thWhen: vscode.l10n.t('when'),
    settingsTitle: vscode.l10n.t('Settings'),
    savedNote: vscode.l10n.t('saved ✓'),
    permLabel: vscode.l10n.t('worker permission mode'),
    pathLabel: vscode.l10n.t('claude CLI path'),
    coolLabel: vscode.l10n.t('quota cooldown (minutes)'),
    frontierLabel: vscode.l10n.t('frontier worker dispatch (claude-fable-5 — may bill per use)'),
    frontierBlock: vscode.l10n.t('block (billing guard)'),
    frontierAllow: vscode.l10n.t('allow'),
    btnInstallMcp: vscode.l10n.t('Register MCP here'),
    btnAddPolicy: vscode.l10n.t('Add policy to CLAUDE.md'),
    btnAddWorker: vscode.l10n.t('Add worker'),
    btnManageAssets: vscode.l10n.t('Manage assets'),
    btnClearTasks: vscode.l10n.t('Clear task history'),
    btnResetCheckin: vscode.l10n.t('Reset session check-in'),
    resetCheckinTip: vscode.l10n.t(
      'Clear the recorded main-session check-in for this workspace — use after switching the main account; the next orchestrator_briefing call re-registers it.',
    ),
    footnote: vscode.l10n.t(
      "Charts count only dispatches made through this extension. For an account's real plan quota, open its worker terminal and run /usage.",
    ),
    metaWorkspace: vscode.l10n.t('workspace: {0}'),
    metaNoWorkspace: vscode.l10n.t('no workspace open'),
    metaMainSession: vscode.l10n.t('main session: {0}'),
    calibrationActive: vscode.l10n.t('(calibration active)'),
    frontierTier: vscode.l10n.t('(frontier tier)'),
    briefedAgo: vscode.l10n.t('briefed {0} ago'),
    activeAgo: vscode.l10n.t('active {0} ago'),
    sessionPendingBrief: vscode.l10n.t('active {0} ago — briefing pending (model unknown)'),
    notCheckedIn: vscode.l10n.t('not checked in yet'),
    tileRunningNow: vscode.l10n.t('Running now'),
    tileRunningNowSub: vscode.l10n.t('active dispatches'),
    tileTasks7d: vscode.l10n.t('Tasks · 7d'),
    tileTasksSub: vscode.l10n.t('{0} done · {1} error'),
    tileSuccess: vscode.l10n.t('Success rate · 7d'),
    tileSuccessSub: vscode.l10n.t('this workspace'),
    tileTokens: vscode.l10n.t('Tokens · 7d'),
    tileTokensSub: vscode.l10n.t('{0} in / {1} out'),
    tileCost: vscode.l10n.t('Est. cost · 7d'),
    tileCostSub: vscode.l10n.t('all workers'),
    emptyDaily: vscode.l10n.t('no dispatches in the last 14 days'),
    emptyWorkerUsage: vscode.l10n.t('no worker usage in the last 7 days'),
    ariaTasksPerDay: vscode.l10n.t('tasks per day'),
    chartDayTip: vscode.l10n.t('{0} — {1} done, {2} error'),
    ariaTokensPerWorker: vscode.l10n.t('tokens per worker'),
    chartWorkerTip: vscode.l10n.t('{0} — {1} in / {2} out'),
    statusCoolingUntil: vscode.l10n.t('⏸ until {0}'),
    statusAvailable: vscode.l10n.t('available'),
    emptyWorkers: vscode.l10n.t('no workers registered'),
    badgeOtherWs: vscode.l10n.t('other ws'),
    emptyTasks: vscode.l10n.t('no dispatched tasks yet'),
  };
}

/** HTML-escape for static-body interpolation (localized strings are untrusted). */
const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => HTML_ESC[c]);

/** Pure: same strings in, same HTML out. Exported for headless rendering tests. */
export function dashboardHtml(s: DashboardStrings): string {
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
  #saved { color: var(--vscode-charts-green, #89d185); font-size: 0.8em; margin-left: 6px; opacity: 0; transition: opacity 0.3s; }
  .empty { color: var(--c-muted); padding: 18px 0; text-align: center; }
</style>
</head>
<body>
  <h1>${escHtml(s.title)}</h1>
  <p id="meta"></p>

  <div class="grid tiles" id="tiles"></div>

  <div class="grid charts">
    <div class="card">
      <h2>${escHtml(s.chartTasksTitle)}</h2>
      <div id="dailyChart"></div>
      <div class="legend">
        <span><span class="swatch" style="background:var(--c-done)"></span>${escHtml(s.legendDone)}</span>
        <span><span class="swatch" style="background:var(--c-error)"></span>${escHtml(s.legendError)}</span>
      </div>
    </div>
    <div class="card">
      <h2>${escHtml(s.chartTokensTitle)}</h2>
      <div id="workerChart"></div>
      <div class="legend">
        <span><span class="swatch" style="background:var(--c-in)"></span>${escHtml(s.legendInput)}</span>
        <span><span class="swatch" style="background:var(--c-out)"></span>${escHtml(s.legendOutput)}</span>
      </div>
    </div>
  </div>

  <div class="grid bottom">
    <div>
      <div class="card" style="margin-bottom:12px">
        <h2>${escHtml(s.workersTitle)}</h2>
        <table id="workers"><thead><tr>
          <th>${escHtml(s.thAccount)}</th><th>${escHtml(s.thModel)}</th><th>${escHtml(s.thStatus)}</th><th>${escHtml(s.thSession5h)}</th><th>${escHtml(s.thWeekly7d)}</th><th>${escHtml(s.thAllTime)}</th>
        </tr></thead><tbody></tbody></table>
      </div>
      <div class="card">
        <h2>${escHtml(s.tasksTitle)} <label style="display:inline;font-size:1em;margin-left:8px"><input type="checkbox" id="scope" checked style="width:auto"> ${escHtml(s.scopeLabel)}</label></h2>
        <table id="tasks"><thead><tr>
          <th></th><th>${escHtml(s.thTitle)}</th><th>${escHtml(s.thWorker)}</th><th>${escHtml(s.thModel)}</th><th>${escHtml(s.thTokens)}</th><th>${escHtml(s.thWhen)}</th>
        </tr></thead><tbody></tbody></table>
      </div>
    </div>
    <div class="card">
      <h2>${escHtml(s.settingsTitle)}<span id="saved">${escHtml(s.savedNote)}</span></h2>
      <label for="s-perm">${escHtml(s.permLabel)}</label>
      <select id="s-perm">
        <option>default</option><option>acceptEdits</option><option>plan</option><option>bypassPermissions</option>
      </select>
      <label for="s-path">${escHtml(s.pathLabel)}</label>
      <input id="s-path" type="text" spellcheck="false">
      <label for="s-cool">${escHtml(s.coolLabel)}</label>
      <input id="s-cool" type="number" min="1">
      <label for="s-frontier">${escHtml(s.frontierLabel)}</label>
      <select id="s-frontier">
        <option value="block">${escHtml(s.frontierBlock)}</option><option value="allow">${escHtml(s.frontierAllow)}</option>
      </select>
      <div class="actions">
        <button data-cmd="installMcp">${escHtml(s.btnInstallMcp)}</button>
        <button data-cmd="addDispatchPolicy">${escHtml(s.btnAddPolicy)}</button>
        <button data-cmd="addWorker">${escHtml(s.btnAddWorker)}</button>
        <button data-cmd="openAssetManager">${escHtml(s.btnManageAssets)}</button>
        <button data-cmd="clearTasks">${escHtml(s.btnClearTasks)}</button>
        <button id="reset-checkin" title="${escHtml(s.resetCheckinTip)}">${escHtml(s.btnResetCheckin)}</button>
      </div>
      <p class="muted" style="font-size:0.8em;margin-top:12px">
        ${escHtml(s.footnote)}
      </p>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const S = ${jsonForScript(s)};
  const fmt = (s, ...a) => String(s).replace(/\\{(\\d+)\\}/g, (_, i) => a[i]);
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
  document.getElementById('reset-checkin').addEventListener('click', () => vscode.postMessage({ type: 'resetCheckin' }));

  // --- charts (hand-rolled SVG, theme-var colors) ---
  function dailyChart(daily) {
    const W = 460, H = 150, padL = 26, padB = 16, padT = 8;
    const plotW = W - padL - 6, plotH = H - padB - padT;
    const max = Math.max(1, ...daily.map((d) => d.done + d.error));
    const step = plotW / daily.length, barW = Math.max(6, step * 0.62);
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(S.ariaTasksPerDay) + '">';
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
      const tip = '<title>' + esc(fmt(S.chartDayTip, d.label, d.done, d.error)) + '</title>';
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
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(S.ariaTokensPerWorker) + '">';
    rows.forEach((r, i) => {
      const y = i * rowH + 6, h = 12;
      const wIn = (W - padL - padR) * r.inT / max, wOut = (W - padL - padR) * r.outT / max;
      const tip = '<title>' + esc(fmt(S.chartWorkerTip, r.name, tok(r.inT), tok(r.outT))) + '</title>';
      s += '<text x="' + (padL - 6) + '" y="' + (y + h - 2) + '" text-anchor="end">' + esc(r.name) + '</text>';
      if (r.inT > 0) s += '<rect x="' + padL + '" y="' + y + '" width="' + Math.max(2, wIn) + '" height="' + h + '" rx="2" fill="var(--c-in)">' + tip + '</rect>';
      if (r.outT > 0) s += '<rect x="' + (padL + Math.max(2, wIn) + 2) + '" y="' + y + '" width="' + Math.max(2, wOut) + '" height="' + h + '" rx="2" fill="var(--c-out)">' + tip + '</rect>';
      s += '<text class="val" x="' + (padL + Math.max(2, wIn) + wOut + 8) + '" y="' + (y + h - 2) + '">' + tok(r.inT + r.outT) + '</text>';
    });
    return s + '</svg>';
  }

  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h';
  };

  function render() {
    if (!data) return;
    const o = data.orchestrator;
    let session;
    if (o) {
      session = o.model + ' ' + (o.calibrated ? S.calibrationActive : S.frontierTier) +
        ' · ' + fmt(S.briefedAgo, ago(o.ts)) +
        (data.sessionLastSeen && data.sessionLastSeen > o.ts ? ' · ' + fmt(S.activeAgo, ago(data.sessionLastSeen)) : '');
    } else if (data.sessionLastSeen) {
      session = fmt(S.sessionPendingBrief, ago(data.sessionLastSeen));
    } else {
      session = S.notCheckedIn;
    }
    document.getElementById('meta').textContent =
      (data.workspace ? fmt(S.metaWorkspace, data.workspace) : S.metaNoWorkspace) + '   |   ' + fmt(S.metaMainSession, session);

    // tiles
    const d7 = data.daily.slice(-7);
    const done7 = d7.reduce((a, d) => a + d.done, 0), err7 = d7.reduce((a, d) => a + d.error, 0);
    const inW = data.workers.reduce((a, w) => a + w.week.inputTokens, 0);
    const outW = data.workers.reduce((a, w) => a + w.week.outputTokens, 0);
    const cost = data.workers.reduce((a, w) => a + w.week.costUsd, 0);
    const rate = done7 + err7 > 0 ? Math.round(done7 / (done7 + err7) * 100) + '%' : '–';
    document.getElementById('tiles').innerHTML = [
      [S.tileRunningNow, data.running, S.tileRunningNowSub],
      [S.tileTasks7d, done7 + err7, fmt(S.tileTasksSub, done7, err7)],
      [S.tileSuccess, rate, S.tileSuccessSub],
      [S.tileTokens, tok(inW + outW), fmt(S.tileTokensSub, tok(inW), tok(outW))],
      [S.tileCost, cost > 0 ? '$' + cost.toFixed(2) : '–', S.tileCostSub],
    ].map(([t, n, sub]) => '<div class="card tile"><h2>' + esc(t) + '</h2><div class="num">' + esc(n) + '</div><div class="sub">' + esc(sub) + '</div></div>').join('');

    // charts
    document.getElementById('dailyChart').innerHTML =
      data.daily.some((d) => d.done + d.error > 0) ? dailyChart(data.daily) : '<div class="empty">' + esc(S.emptyDaily) + '</div>';
    document.getElementById('workerChart').innerHTML =
      data.workers.length && data.workers.some((w) => w.week.inputTokens + w.week.outputTokens > 0)
        ? workerChart(data.workers) : '<div class="empty">' + esc(S.emptyWorkerUsage) + '</div>';

    // workers table
    const usage = (u) => u.tasks === 0 ? '<span class="muted">–</span>' : u.tasks + ' · ' + tok(u.inputTokens) + '/' + tok(u.outputTokens);
    document.querySelector('#workers tbody').innerHTML = data.workers.map((w) => {
      const status = w.coolingDown
        ? '<span class="warn">' + esc(fmt(S.statusCoolingUntil, new Date(w.cooldownUntil).toLocaleTimeString())) + '</span>'
        : '<span class="ok">' + esc(S.statusAvailable) + '</span>';
      const total = w.totals
        ? w.totals.tasks + ' · ' + tok(w.totals.inputTokens) + '/' + tok(w.totals.outputTokens) + (w.totals.costUsd ? ' · $' + w.totals.costUsd.toFixed(2) : '')
        : '<span class="muted">–</span>';
      return '<tr><td><b>' + (w.preferred ? '★ ' : '') + esc(w.name) + '</b></td><td>' + esc(w.model) + '</td><td>' + status +
        '</td><td>' + usage(w.session) + '</td><td>' + usage(w.week) + '</td><td>' + total + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">' + esc(S.emptyWorkers) + '</td></tr>';

    // tasks table
    const scoped = document.getElementById('scope').checked;
    const tasks = data.tasks.filter((t) => !scoped || t.inWorkspace);
    document.querySelector('#tasks tbody').innerHTML = tasks.map((t) => {
      const icon = t.status === 'running' ? '⟳' : t.status === 'done' ? '<span class="ok">✓</span>' : '<span class="err">✗</span>';
      const tokens = t.inputTokens != null ? tok(t.inputTokens) + '/' + tok(t.outputTokens) : '<span class="muted">–</span>';
      const ws = t.inWorkspace ? '' : ' <span class="badge muted">' + esc(S.badgeOtherWs) + '</span>';
      return '<tr><td>' + icon + '</td><td class="title"><span class="task-link" data-file="' + esc(t.outputFile) + '">' +
        esc(t.title) + '</span>' + ws + '</td><td>' + esc(t.worker) + '</td><td>' + esc(t.model) +
        '</td><td>' + tokens + '</td><td class="muted">' + new Date(t.ts).toLocaleTimeString() + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">' + esc(S.emptyTasks) + '</td></tr>';
    for (const el of document.querySelectorAll('.task-link')) {
      el.onclick = () => vscode.postMessage({ type: 'openTask', file: el.dataset.file });
    }

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
