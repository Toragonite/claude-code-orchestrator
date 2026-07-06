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

/**
 * Editor-tab dashboard: worker accounts with quota-window usage plus the
 * dispatched-task feed. Data is pushed from the extension every 2s (the
 * MCP server writes the underlying files from a separate process).
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
        name: (w.preferred ? '★ ' : '') + w.name,
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
    const tasks = [...byId.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 200)
      .map((e) => ({
        ...e,
        inWorkspace: Boolean(root && e.cwd && (e.cwd === root || e.cwd.startsWith(root + '/'))),
      }));
    const checkin = root ? readOrchestrators()[root] : undefined;
    const orchestrator = checkin
      ? { model: checkin.model, ts: checkin.ts, calibrated: !isFrontierTier(checkin.model) }
      : null;
    void panel.webview.postMessage({
      type: 'data',
      workers,
      tasks,
      workspace: root ?? null,
      orchestrator,
    });
  };

  const timer = setInterval(send, 2000);
  panel.onDidDispose(() => clearInterval(timer));
  panel.webview.onDidReceiveMessage(async (msg: { type: string; file?: string }) => {
    if (msg.type === 'openTask' && msg.file) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.file));
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } catch {
        void vscode.window.showWarningMessage(`Task output not found: ${msg.file}`);
      }
    }
  });
  send();
}

function dashboardHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
  h2 { font-size: 1.1em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
  th, td { text-align: left; padding: 5px 12px 5px 0; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.title { white-space: normal; }
  .muted { color: var(--vscode-descriptionForeground); }
  .ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .err { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .task-link { cursor: pointer; text-decoration: underline; }
  .badge { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 6px; font-size: 0.85em; }
  label { user-select: none; }
  #meta { margin: 4px 0 0; }
</style>
</head>
<body>
  <h2>Worker Accounts</h2>
  <p id="meta" class="muted"></p>
  <table id="workers"><thead><tr>
    <th>account</th><th>default model</th><th>status</th>
    <th>session (5h)</th><th>weekly (7d)</th><th>all time</th>
  </tr></thead><tbody></tbody></table>

  <h2>Dispatched Tasks</h2>
  <p><label><input type="checkbox" id="scope" checked> this workspace only</label></p>
  <table id="tasks"><thead><tr>
    <th>status</th><th>title</th><th>worker</th><th>model</th><th>tokens</th><th>when</th>
  </tr></thead><tbody></tbody></table>

<script>
  const vscode = acquireVsCodeApi();
  let data = { workers: [], tasks: [], workspace: null };
  document.getElementById('scope').addEventListener('change', render);
  window.addEventListener('message', (e) => { if (e.data.type === 'data') { data = e.data; render(); } });

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const tok = (n) => n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0);
  const usage = (u) => u.tasks === 0 ? '<span class="muted">–</span>'
    : u.tasks + ' tasks · ' + tok(u.inputTokens) + '/' + tok(u.outputTokens);

  function render() {
    const o = data.orchestrator;
    const main = o
      ? 'main session: ' + o.model + (o.calibrated ? ' (calibration active)' : ' (frontier tier)')
        + ' · checked in ' + new Date(o.ts).toLocaleTimeString()
      : 'main session: not checked in yet — the policy tells it to call orchestrator_briefing before the first dispatch';
    document.getElementById('meta').textContent =
      (data.workspace ? 'workspace: ' + data.workspace : 'no workspace open') + '  |  ' + main;

    document.querySelector('#workers tbody').innerHTML = data.workers.map((w) => {
      const status = w.coolingDown
        ? '<span class="warn">⏸ cooldown until ' + new Date(w.cooldownUntil).toLocaleTimeString() + '</span>'
        : '<span class="ok">available</span>';
      const total = w.totals
        ? w.totals.tasks + ' tasks · ' + tok(w.totals.inputTokens) + '/' + tok(w.totals.outputTokens)
          + (w.totals.costUsd ? ' · ~$' + w.totals.costUsd.toFixed(2) : '')
        : '<span class="muted">–</span>';
      return '<tr><td><b>' + esc(w.name) + '</b></td><td>' + esc(w.model) + '</td><td>' + status
        + '</td><td>' + usage(w.session) + '</td><td>' + usage(w.week) + '</td><td>' + total + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">no workers registered</td></tr>';

    const scoped = document.getElementById('scope').checked;
    const tasks = data.tasks.filter((t) => !scoped || t.inWorkspace);
    document.querySelector('#tasks tbody').innerHTML = tasks.map((t) => {
      const icon = t.status === 'running' ? '⟳' : t.status === 'done' ? '<span class="ok">✓</span>' : '<span class="err">✗</span>';
      const tokens = t.inputTokens != null ? tok(t.inputTokens) + '/' + tok(t.outputTokens) : '<span class="muted">–</span>';
      const ws = t.inWorkspace ? '' : ' <span class="badge muted">other ws</span>';
      return '<tr><td>' + icon + '</td><td class="title"><span class="task-link" data-file="' + esc(t.outputFile) + '">'
        + esc(t.title) + '</span>' + ws + '</td><td>' + esc(t.worker) + '</td><td>' + esc(t.model)
        + '</td><td>' + tokens + '</td><td class="muted">' + new Date(t.ts).toLocaleTimeString() + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">no dispatched tasks yet</td></tr>';

    for (const el of document.querySelectorAll('.task-link')) {
      el.onclick = () => vscode.postMessage({ type: 'openTask', file: el.dataset.file });
    }
  }
</script>
</body>
</html>`;
}
