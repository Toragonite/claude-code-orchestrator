import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { ROOT_DIR, TASKS_LOG_FILE } from './registry';
import { meshStateFile } from './mesh/contract';
import { collectSessions, invalidateTeamCache, ResolvedSession, resolveSession } from './team';
import { claudeTerminalEnv } from './platform';
import { providerInfo } from './providers';
import { UiSession, UiSessionAction, UiSessionStatus } from './uiTypes';
import {
  accountNotRegisteredAdvice,
  isClaudeAccountDir,
  isInsideDir,
  isJobId,
  isWorkersTreeRow,
  noIcons,
  pickText,
  rowText,
  rowTextCut,
  stopSession as stopSessionProcess,
} from './views';
import { openCommandTerminal, terminalProviderCommand } from './workerManager';
import {
  ATTACH_LEASE,
  BOARD_RENDER_ORDER,
  BOARD_TITLE_MAX_CHARS,
  clockHHMM,
  clockHHMMSS,
  COMMAND_SPELLING,
  GIT_TIMEOUTS_MS,
  kTokens,
  MESSAGE_MAX_BYTES,
  METHOD_TEAM,
  NOTE_MAX_BYTES,
  TEAM_NAME,
  teamBranchOf,
  teamSlugOf,
  WORKTREES_DIR_NAME,
  type BoardTask,
  type FeedItem,
  type MemberState,
  type TakeoverPlan,
  type TaskState,
} from './team/contract';
import { RPC_ERROR } from './mcp/host-protocol';
import { feedItemsOf, type TeamCallOutcome, type TeamClient, type TeamNotice, type TeamSnapshot } from './teamClient';

/**
 * The Team view: every live Claude Code session that belongs to this workspace, across
 * accounts — the `--bg` workers this extension dispatched, the teammates of a native agent
 * team, and any other session of a known account working here — and, above them, the `Teams`
 * group: the Claude Code Orchestrator teams of this workspace (team contract §8.1), from
 * teamClient's snapshots, with their roster, board and messages.
 *
 * It renders what `team.ts` collected and nothing else. Every string on a row has already
 * been flattened and capped there (uiTypes rule 1), a row is addressed by its opaque
 * `SessionKey`, and an action resolves that key again through `resolveSession` at the moment
 * it runs — a tree node is never trusted to still describe a real session.
 */

type TeamGroupId = 'working' | 'waiting' | 'parked';

interface TeamGroup {
  kind: 'group';
  id: TeamGroupId;
  sessions: UiSession[];
}

export type TeamNode = TeamGroup | UiSession | TeamModeNode;

/*
 * Which kind a node is, and which session a row stands for, is what THIS tree made of it —
 * remembered here when a node is handed to the editor — never a property read back off the
 * element a command receives. (The same rule the Workers tree keeps for its rows.)
 */
const groupRows = new WeakSet<object>();
/** Each session row handed out → the key `team.ts` made the row with. */
const sessionRows = new WeakMap<object, string>();

function isGroup(node: TeamNode): node is TeamGroup {
  return groupRows.has(node);
}

const GROUP_ORDER: readonly TeamGroupId[] = ['working', 'waiting', 'parked'];

/**
 * Which group a session is listed under. `unknown` is parked rather than working: a session
 * whose state could not be read must never be shown as busy, and "Parked" is the group a
 * reader goes to when deciding what to look at.
 */
function groupOf(status: UiSessionStatus): TeamGroupId {
  if (status === 'busy') {
    return 'working';
  }
  return status === 'waiting' ? 'waiting' : 'parked';
}

function groupLabel(id: TeamGroupId): string {
  switch (id) {
    case 'working':
      return vscode.l10n.t('Working');
    case 'waiting':
      return vscode.l10n.t('Waiting');
    default:
      return vscode.l10n.t('Parked');
  }
}

const GROUP_ICON: Record<TeamGroupId, string> = {
  working: 'sync',
  waiting: 'bell',
  parked: 'debug-pause',
};

function statusLabel(status: UiSessionStatus): string {
  switch (status) {
    case 'busy':
      return vscode.l10n.t('working');
    case 'waiting':
      return vscode.l10n.t('waiting');
    case 'idle':
      return vscode.l10n.t('idle');
    case 'stopped':
      return vscode.l10n.t('stopped');
    default:
      return vscode.l10n.t('status unknown');
  }
}

/**
 * Row icon: the SHAPE says the status, the COLOUR says where the session comes from (a
 * dispatched worker, a native teammate, any other peer). An idle row has no activity to
 * show, so its shape names the source instead. Status is never carried by colour alone —
 * the group a row sits in and its description say it in words.
 */
function sessionIcon(session: UiSession): vscode.ThemeIcon {
  const color =
    session.source === 'worker'
      ? new vscode.ThemeColor('charts.blue')
      : session.source === 'teammate'
        ? new vscode.ThemeColor('charts.green')
        : undefined;
  let shape: string;
  switch (session.status) {
    case 'busy':
      shape = 'sync~spin';
      break;
    case 'waiting':
      shape = 'bell-dot';
      break;
    case 'idle':
      shape =
        session.source === 'worker'
          ? 'server-process'
          : session.source === 'teammate'
            ? 'person'
            : 'terminal';
      break;
    case 'stopped':
      shape = 'circle-slash';
      break;
    default:
      shape = 'question';
  }
  return new vscode.ThemeIcon(shape, color);
}

/**
 * `contextValue` of a session row. The base is `session.<source>`; `.attachable` is added
 * when attach / logs can be offered, `.stoppable` when stop can, and `.branch` when there
 * is a result branch to diff. The menus in package.json match these as substrings, so the
 * order of the suffixes never matters to them.
 */
function sessionContext(session: UiSession): string {
  return (
    `session.${session.source}` +
    (session.canAttach ? '.attachable' : '') +
    (session.canStop ? '.stoppable' : '') +
    (session.branch ? '.branch' : '')
  );
}

/** Only what a row actually renders — so a heartbeat that changes nothing visible is not a refresh. */
function signature(sessions: UiSession[]): string {
  return JSON.stringify(
    sessions.map((s) => [
      s.key,
      s.source,
      s.name,
      s.accountName,
      s.status,
      s.detail,
      s.taskId,
      s.taskTitle,
      s.model,
      s.startedAt,
      s.location,
      s.branch,
      s.unmerged,
      s.settled,
      s.canAttach,
      s.canStop,
      s.team,
      s.role,
    ]),
  );
}

/** A row `team.ts` handed over that this view can render and address. */
function isRenderable(session: unknown): session is UiSession {
  const s = session as Partial<UiSession> | null | undefined;
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.key === 'string' &&
    s.key !== '' &&
    typeof s.name === 'string' &&
    typeof s.source === 'string' &&
    typeof s.status === 'string'
  );
}

/** How often the view re-reads the sessions while it is on screen. */
const TEAM_POLL_MS = 5_000;
/** Stat-poll interval for the two files whose change means "the team changed". */
const TEAM_WATCH_MS = 2_000;

export class TeamProvider implements vscode.TreeDataProvider<TeamNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private visible = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Signature of the rows last handed to VS Code, so an unchanged poll redraws nothing. */
  private rendered = '';
  /** The team client's change count when the tree was last drawn. */
  private renderedTeams = -1;
  private readonly teamListener: { dispose(): void } | undefined;

  // Own listener references: `fs.unwatchFile(file)` without one removes EVERY listener on
  // that path, and the Tasks and History views watch the task log too.
  private readonly onLedgerChange = (): void => this.onSourceChange();
  private readonly onTasksChange = (): void => this.onSourceChange();
  /** This workspace's mesh ledger — written by the MCP server as workers spawn, settle and stop. */
  private readonly ledgerPath: string | undefined;

  constructor(private readonly teams?: TeamClient) {
    // A team snapshot changed (teamClient coalesces and rate-limits them, A14): redraw while shown.
    this.teamListener = teams?.onDidChange(() => {
      if (this.visible) {
        this._onDidChangeTreeData.fire();
      }
    });
    const root = workspaceRoot();
    if (root) {
      // watchFile tolerates a path that does not exist yet and fires when it appears.
      this.ledgerPath = meshStateFile(root);
      fs.watchFile(this.ledgerPath, { interval: TEAM_WATCH_MS }, this.onLedgerChange);
    }
    fs.watchFile(TASKS_LOG_FILE, { interval: TEAM_WATCH_MS }, this.onTasksChange);
  }

  dispose(): void {
    this.stopPolling();
    this.teamListener?.dispose();
    if (this.ledgerPath) {
      fs.unwatchFile(this.ledgerPath, this.onLedgerChange);
    }
    fs.unwatchFile(TASKS_LOG_FILE, this.onTasksChange);
    this._onDidChangeTreeData.dispose();
  }

  /** Called by the tree view when it is shown or hidden. Nothing is read while it is hidden. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      this.refresh();
      this.timer = setInterval(() => this.poll(), TEAM_POLL_MS);
    } else {
      this.stopPolling();
    }
  }

  /** Re-read now, bypassing the collector's short cache, and redraw. */
  refresh(): void {
    invalidateTeamCache();
    this.teams?.refresh();
    this._onDidChangeTreeData.fire();
  }

  private stopPolling(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The 5 s tick: redraw only when something a row shows has changed. */
  private poll(): void {
    if (signature(this.collect()) !== this.rendered || (this.teams?.changeCount ?? -1) !== this.renderedTeams) {
      this._onDidChangeTreeData.fire();
    }
  }

  private onSourceChange(): void {
    // The collector caches for a few seconds; a ledger or task-log write is exactly the
    // moment that cache is stale. While hidden only the cache is dropped — becoming
    // visible refreshes anyway.
    invalidateTeamCache();
    if (this.visible) {
      this._onDidChangeTreeData.fire();
    }
  }

  /** Total: a collector failure renders as an empty view (the welcome text), never as a tree error. */
  private collect(): UiSession[] {
    try {
      const sessions: unknown = collectSessions({ workspaceRoot: workspaceRoot(), scope: 'workspace' });
      return Array.isArray(sessions) ? sessions.filter(isRenderable) : [];
    } catch {
      return [];
    }
  }

  getChildren(node?: TeamNode): TeamNode[] {
    if (node) {
      const teamNode = teamModeNodeOf(node);
      if (teamNode !== undefined) {
        if (this.teams === undefined) {
          return [];
        }
        try {
          return teamChildren(this.teams, teamNode);
        } catch {
          return [];
        }
      }
      return isGroup(node) ? node.sessions : [];
    }
    // The Teams group heads the view when this workspace has a team (§8.1).
    const top: TeamNode[] = [];
    this.renderedTeams = this.teams?.changeCount ?? -1;
    if (this.teams !== undefined && this.teams.teams().length > 0) {
      top.push(remember({ kind: 'teams' }));
    }
    const sessions = this.collect();
    this.rendered = signature(sessions);
    const groups = new Map<TeamGroupId, UiSession[]>();
    for (const session of sessions) {
      const id = groupOf(session.status);
      const list = groups.get(id);
      if (list) {
        list.push(session);
      } else {
        groups.set(id, [session]);
      }
    }
    for (const session of sessions) {
      sessionRows.set(session, session.key);
    }
    // A group with nothing in it is not drawn; with no sessions at all the view is empty
    // and VS Code shows its welcome text instead.
    return top.concat(GROUP_ORDER.flatMap((id) => {
      const list = groups.get(id);
      if (!list) {
        return [];
      }
      const group: TeamGroup = { kind: 'group', id, sessions: list };
      groupRows.add(group);
      return [group];
    }));
  }

  getTreeItem(element: TeamNode): vscode.TreeItem {
    const teamNode = teamModeNodeOf(element);
    if (teamNode !== undefined) {
      if (this.teams === undefined) {
        return new vscode.TreeItem('-', vscode.TreeItemCollapsibleState.None);
      }
      try {
        return teamItem(this.teams, teamNode);
      } catch {
        return new vscode.TreeItem('-', vscode.TreeItemCollapsibleState.None);
      }
    }
    // Not one of the Teams group's: a session group or a session row, as before team mode.
    const node = element as TeamGroup | UiSession;
    if (isGroup(node)) {
      const item = new vscode.TreeItem(groupLabel(node.id), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `team-group:${node.id}`;
      item.description = String(node.sessions.length);
      item.iconPath = new vscode.ThemeIcon(GROUP_ICON[node.id]);
      item.contextValue = 'sessionGroup';
      return item;
    }
    const item = new vscode.TreeItem(node.name || '-', vscode.TreeItemCollapsibleState.None);
    item.id = `team:${node.key}`;
    // account · task title or role — plus the status in words where the group cannot say it
    // (Parked holds idle, stopped and unreadable sessions alike).
    const what = node.taskTitle ?? node.role ?? undefined;
    const parts = [node.accountName, what];
    if (node.status === 'stopped' || node.status === 'unknown') {
      parts.push(statusLabel(node.status));
    }
    item.description = parts.filter((part) => typeof part === 'string' && part !== '').join(' · ');
    item.iconPath = sessionIcon(node);
    item.contextValue = sessionContext(node);
    item.tooltip = sessionTooltip(node);
    return item;
  }
}

/**
 * Hover for a session row. Every value is appended with `appendText`, which escapes markdown:
 * names, titles, branches and "waiting for" text all originate in files other processes
 * write, and none of it may render as a link, an image or a command URI.
 */
function sessionTooltip(session: UiSession): vscode.MarkdownString {
  const tip = new vscode.MarkdownString();
  const line = (text: string): void => {
    tip.appendMarkdown('\n\n');
    tip.appendText(text);
  };
  tip.appendMarkdown('**');
  tip.appendText(session.name || '-');
  tip.appendMarkdown('**');
  const origin =
    session.source === 'worker'
      ? vscode.l10n.t('Dispatched session worker')
      : session.source === 'teammate'
        ? vscode.l10n.t('Agent-team teammate')
        : session.kind === 'background'
          ? vscode.l10n.t('Background session')
          : vscode.l10n.t('Interactive session');
  line(vscode.l10n.t('{0} · account {1}', origin, session.accountName || '-'));
  line(
    session.detail
      ? vscode.l10n.t('Status: {0} — {1}', statusLabel(session.status), session.detail)
      : vscode.l10n.t('Status: {0}', statusLabel(session.status)),
  );
  if (session.taskTitle) {
    line(
      session.taskId
        ? vscode.l10n.t('Task: {0} ({1})', session.taskTitle, session.taskId)
        : vscode.l10n.t('Task: {0}', session.taskTitle),
    );
    if (session.settled) {
      line(vscode.l10n.t('Its dispatch has finished; the session stays available until it is stopped.'));
    }
  }
  if (session.team) {
    line(vscode.l10n.t('Team: {0}', session.team));
  }
  if (session.role) {
    line(vscode.l10n.t('Role: {0}', session.role));
  }
  if (session.model) {
    line(vscode.l10n.t('Model: {0}', session.model));
  }
  if (session.location) {
    line(vscode.l10n.t('Location: {0}', session.location));
  }
  if (session.branch) {
    line(
      session.unmerged
        ? vscode.l10n.t('Branch: {0} (worktree still on disk — not merged yet)', session.branch)
        : vscode.l10n.t('Branch: {0}', session.branch),
    );
  }
  if (typeof session.startedAt === 'number' && Number.isFinite(session.startedAt)) {
    line(vscode.l10n.t('Started: {0}', new Date(session.startedAt).toLocaleString()));
  }
  if (session.source !== 'teammate' && session.status !== 'stopped' && session.name) {
    line(
      vscode.l10n.t(
        'Message it from your Claude Code session with SendMessage(to: "{0}").',
        session.name,
      ),
    );
  }
  return tip;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/* ------------------------------------------------------------------------- *
 * Session actions (the `sessionAction` command and its per-action menu twins)
 * ------------------------------------------------------------------------- */

export const SESSION_ACTIONS: readonly UiSessionAction[] = [
  'attach',
  'logs',
  'stop',
  'copyName',
  'openDiff',
];

function isSessionAction(value: unknown): value is UiSessionAction {
  return typeof value === 'string' && (SESSION_ACTIONS as readonly string[]).includes(value);
}

/**
 * The session key a command argument names, or undefined.
 *
 *  - A session row of the Team tree: the key the row was made with (sessionRows).
 *  - A group row, and any row of the Workers tree: none. Neither stands for a session, and a
 *    `key` property on such an element is not one — a Workers row is a registry entry as
 *    read, with whatever keys its file holds.
 *  - Anything else is a payload its sender built — `{ key }`, `{ action, key }` from the
 *    dashboard host: the key it names (one that says it is a group names none).
 *
 * Whatever comes out is only a NAME: runSessionAction resolves it against the rows team.ts
 * last produced, and a key that matches none does nothing.
 */
export function sessionKeyOf(arg: unknown): string | undefined {
  if (typeof arg !== 'object' || arg === null) {
    return undefined;
  }
  const own = sessionRows.get(arg);
  if (own !== undefined) {
    return own;
  }
  if (groupRows.has(arg) || teamNodes.has(arg) || isWorkersTreeRow(arg)) {
    return undefined;
  }
  const rec = arg as { key?: unknown; kind?: unknown };
  if (rec.kind === 'group') {
    return undefined;
  }
  return typeof rec.key === 'string' && rec.key !== '' ? rec.key : undefined;
}

/** The action named by a `sessionAction` argument, when it names a real one. */
export function sessionActionOf(arg: unknown): UiSessionAction | undefined {
  const action = (arg as { action?: unknown } | null | undefined)?.action;
  return isSessionAction(action) ? action : undefined;
}

/**
 * Ask which action to run on a tree row (the `sessionAction` command invoked with a row and
 * no action). Only actions the row supports are offered.
 */
export async function pickSessionAction(node: unknown): Promise<UiSessionAction | undefined> {
  if (!isRenderable(node)) {
    return undefined;
  }
  const items: (vscode.QuickPickItem & { action: UiSessionAction })[] = [];
  if (node.canAttach) {
    items.push({ label: vscode.l10n.t('Attach in Terminal'), action: 'attach' });
    items.push({ label: vscode.l10n.t('Show Logs'), action: 'logs' });
  }
  if (node.branch) {
    items.push({ label: vscode.l10n.t('Open Branch Diff'), action: 'openDiff' });
  }
  items.push({ label: vscode.l10n.t('Copy Session Name'), action: 'copyName' });
  if (node.canStop) {
    items.push({ label: vscode.l10n.t('Stop Session'), action: 'stop' });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Action for session "{0}"', node.name),
  });
  return picked?.action;
}

/**
 * Run one action on the session `key` names. The key is resolved HERE, against the last
 * collection: an unknown key — a stale dashboard card, a row whose session has gone, a
 * value some other caller made up — does nothing at all.
 */
export async function runSessionAction(
  action: UiSessionAction,
  key: unknown,
  provider: TeamProvider | undefined,
): Promise<void> {
  if (!isSessionAction(action)) {
    return;
  }
  let session: ResolvedSession | undefined;
  try {
    session = resolveSession(key);
  } catch {
    session = undefined;
  }
  if (!session) {
    // Nothing is done for an unknown key; redrawing is how a stale row disappears.
    provider?.refresh();
    return;
  }
  switch (action) {
    case 'attach':
    case 'logs':
      openSessionTerminal(action, session);
      return;
    case 'copyName':
      await vscode.env.clipboard.writeText(session.name);
      // The status bar draws `$(name)` as an icon, and a session's name is not ours.
      vscode.window.setStatusBarMessage(
        noIcons(vscode.l10n.t('Copied session name "{0}"', session.name)),
        4000,
      );
      return;
    case 'openDiff':
      await openSessionDiff(session);
      return;
    case 'stop':
      await stopSession(session, provider);
      return;
  }
}

/**
 * A job id as it may be typed into a terminal: the first 8 hexadecimal characters of the
 * session id, which is what the CLI names a background job. Narrower than `views.isJobId`,
 * which also has to accept whatever a later CLI might print for a child process's argument.
 */
const TERMINAL_JOB_ID = /^[0-9a-f]{8}$/;

/**
 * `claude attach <jobId>` / `claude logs <jobId>` in an integrated terminal, as the account
 * the session runs under. Attach opens the live session (detaching leaves it running); logs
 * prints its recent output. Needs a job id and an account — a teammate has neither.
 *
 * The account directory is checked HERE, at the moment of the action, against the current
 * Claude Code accounts (views.isClaudeAccountDir — the pool's rule): a resolved row is a few
 * seconds old, and a row whose worker was recorded under a directory no Claude Code account
 * has any more carries no directory at all. Either way no terminal is opened — `claude` is
 * never pointed at a directory that is not a registered Claude Code account's — and the user
 * is told how to reach the session themselves.
 *
 * What is typed is `claude <verb> <jobId>` and nothing else can be: the verb is one of the two
 * named here, and the job id — a value from files other processes write — must have the exact
 * shape the CLI gives one (`TERMINAL_JOB_ID`) before it is handed to the terminal line.
 */
function openSessionTerminal(verb: 'attach' | 'logs', session: ResolvedSession): void {
  if (verb !== 'attach' && verb !== 'logs') {
    return;
  }
  if (!isJobId(session.jobId)) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Session "{0}" cannot be attached to from here — it has no background job id.',
        session.name,
      ),
    );
    return;
  }
  if (!isClaudeAccountDir(session.configDir)) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Session "{0}" cannot be opened from here. {1}',
        session.name,
        accountNotRegisteredAdvice(verb, session.jobId),
      ),
    );
    return;
  }
  if (!TERMINAL_JOB_ID.test(session.jobId)) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Session "{0}" cannot be opened from here: its job id is not in the form this extension types into a terminal (8 hexadecimal characters).',
        session.name,
      ),
    );
    return;
  }
  openCommandTerminal(
    { name: `${verb}: ${session.name}`, env: claudeTerminalEnv(session.configDir) },
    terminalProviderCommand('claude'),
    [verb, session.jobId],
  );
}

/**
 * Stop a session: `claude stop <jobId>` as a child process, then the same ledger mark and
 * `claude rm` teardown a task cancel performs; a dispatch still running on it is recorded as
 * cancelled (views.stopSession). Asked for behind a modal confirmation — a stop ends whatever
 * turn the session is in the middle of. Never offered for a teammate, or for a peer with no
 * job id: neither is addressable by one.
 */
async function stopSession(session: ResolvedSession, provider: TeamProvider | undefined): Promise<void> {
  if (session.source === 'teammate' || !isJobId(session.jobId)) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Session "{0}" cannot be stopped from here — it is not a background job this extension can address.',
        session.name,
      ),
    );
    return;
  }
  const stopLabel = vscode.l10n.t('Stop Session');
  const confirm = await vscode.window.showWarningMessage(
    vscode.l10n.t('Stop session "{0}"?', session.name),
    {
      modal: true,
      // Only a dispatched worker gets the teardown after the stop; any other session is
      // stopped and nothing else of it is touched.
      detail:
        session.source === 'worker'
          ? vscode.l10n.t(
              'Its current turn ends immediately, and a dispatch still running on it is recorded as cancelled. A worktree holding uncommitted changes or unpushed commits is kept; a clean one is removed together with its branch.',
            )
          : vscode.l10n.t('Its current turn ends immediately.'),
    },
    stopLabel,
  );
  if (confirm !== stopLabel) {
    return;
  }
  const jobId = session.jobId;
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Stopping session "{0}"…', session.name),
    },
    () =>
      stopSessionProcess({
        jobId,
        configDir: session.configDir,
        name: session.name,
        taskId: session.taskId,
      }),
  );
  provider?.refresh();
  if (result.accountNotRegistered === true) {
    // Nothing was run and no ledger mark was changed: the session is whatever it was. If a
    // dispatch was running on it, that task IS closed in our own record — said as exactly that.
    void vscode.window.showWarningMessage(
      result.cancelledTask
        ? vscode.l10n.t(
            'Session "{0}" was not stopped; its running task is cancelled here only. {1}',
            session.name,
            accountNotRegisteredAdvice('stop', jobId),
          )
        : vscode.l10n.t(
            'Session "{0}" was not stopped. {1}',
            session.name,
            accountNotRegisteredAdvice('stop', jobId),
          ),
    );
    return;
  }
  if (!result.stopped) {
    const failure = [
      vscode.l10n.t(
        'Could not stop session "{0}": {1}',
        session.name,
        result.error ?? vscode.l10n.t('unknown error'),
      ),
    ];
    if (result.cancelledTask) {
      // The task row is closed either way; saying so keeps the two facts from contradicting.
      failure.push(vscode.l10n.t('Its running task was still recorded as cancelled.'));
    }
    void vscode.window.showErrorMessage(failure.join(' '));
    return;
  }
  const sentences = [
    result.cancelledTask
      ? vscode.l10n.t('Stopped session "{0}" and recorded its running task as cancelled.', session.name)
      : vscode.l10n.t('Stopped session "{0}".', session.name),
  ];
  // Teardown notes are the only place a KEPT worktree is reported; they come in English from
  // the shared finisher and are shown as written.
  const notes = result.notes.replace(/\s+/g, ' ').trim();
  if (notes) {
    sentences.push(notes);
  }
  void vscode.window.showInformationMessage(sentences.join(' '));
}

/* ------------------------------------------------------------------------- *
 * Branch diff (read-only document)
 * ------------------------------------------------------------------------- */

const DIFF_SCHEME = 'cco-session-diff';
/** Diff documents kept in memory for the content provider; the oldest is dropped past this. */
const DIFF_DOCS_MAX = 8;
const GIT_TIMEOUT_MS = 20_000;
const GIT_DIFF_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A branch name that is safe to hand to git as part of a revision. The name comes from the
 * mesh ledger, so it is checked rather than trusted: the alphabet excludes everything that
 * means something in revision syntax (`:`, `^`, `~`, `@{`, whitespace), `..` is refused, and
 * it cannot start with `-`. It is additionally passed as `refs/heads/<name>`, which pins it
 * to a local branch whatever it is called.
 */
function isSafeBranch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  );
}

interface GitOutcome {
  ok: boolean;
  stdout: string;
  /** Short reason when not ok. */
  problem: string;
}

/** One read-only git call in `cwd`. No shell; never rejects. */
function runGit(cwd: string, args: string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_DIFF_MAX_BYTES, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const text = `${stderr ?? ''}`.replace(/\s+/g, ' ').trim();
            resolve({ ok: false, stdout: '', problem: (text || err.message).slice(0, 300) });
            return;
          }
          resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : String(stdout), problem: '' });
        },
      );
    } catch (err) {
      resolve({ ok: false, stdout: '', problem: err instanceof Error ? err.message : String(err) });
    }
  });
}

const diffDocs = new Map<string, string>();
let diffSeq = 0;

/**
 * Serves the diff text computed by openSessionDiff, looked up by the id in the URI's query.
 * It never runs git itself: a URI is something anything can ask VS Code to open, so the
 * only thing one can do here is name a diff that was already taken. Unknown ids are empty.
 */
const diffContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return diffDocs.get(uri.query) ?? '';
  },
};

/**
 * Show what a session's result branch adds on top of the workspace's current HEAD:
 * `git diff HEAD...<branch>` (changes since the two diverged), in a read-only document.
 * It shows COMMITTED work only — which is where a session worker's result lives, since its
 * worktree is committed when its dispatch settles.
 */
async function openSessionDiff(session: ResolvedSession): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder first.'));
    return;
  }
  if (!isSafeBranch(session.branch)) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Session "{0}" has no result branch to compare.', session.name),
    );
    return;
  }
  const branch = session.branch;
  const ref = `refs/heads/${branch}`;
  const exists = await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!exists.ok) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Branch "{0}" was not found in this workspace\'s repository — it may already be merged and deleted.',
        branch,
      ),
    );
    return;
  }
  // --no-ext-diff / --no-textconv: a diff taken for display must never run a helper program
  // configured for the repository.
  const diff = await runGit(root, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    `HEAD...${ref}`,
    '--',
  ]);
  if (!diff.ok) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Could not compare "{0}" with HEAD: {1}', branch, diff.problem),
    );
    return;
  }
  if (diff.stdout.trim() === '') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Branch "{0}" has no committed changes on top of HEAD.', branch),
    );
    return;
  }
  const id = String(++diffSeq);
  diffDocs.set(id, diff.stdout);
  for (const stale of [...diffDocs.keys()].slice(0, Math.max(0, diffDocs.size - DIFF_DOCS_MAX))) {
    diffDocs.delete(stale);
  }
  // The path is only the tab title; the query is the lookup key. `.diff` selects the language.
  const title = `HEAD...${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.diff`;
  const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${title}`, query: id });
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Could not open the diff for "{0}": {1}',
        branch,
        err instanceof Error ? err.message : String(err),
      ),
    );
  }
}

/**
 * Create the Team tree view and everything that keeps it current: refresh when it becomes
 * visible, every 5 s while it is visible, when the mesh ledger or the task log changes, and —
 * given the team client — when a team snapshot changes; with the client also the Teams group's
 * status bar item, notifications, read marks and take-over terminals (§8.1). Returns the
 * provider so commands can refresh it after acting on a session.
 */
export function registerTeamView(context: vscode.ExtensionContext, teams?: TeamClient): TeamProvider {
  const provider = new TeamProvider(teams);
  const view = vscode.window.createTreeView('claudeCodeOrchestrator.team', {
    treeDataProvider: provider,
  });
  provider.setVisible(view.visible);
  context.subscriptions.push(
    provider,
    view,
    view.onDidChangeVisibility((e) => provider.setVisible(e.visible)),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider),
    ...(teams === undefined ? [] : registerTeamModeSurface(teams, view)),
  );
  return provider;
}

/* ========================================================================= *
 * TEAMMATE MODE — the `Teams` group, its commands, the status bar item and the notifications
 * (team contract §8.1). Everything shown comes from teamClient's snapshots: the ENGINE's state,
 * never a guess from a terminal, and every string of it is host data — flattened and capped here
 * (views.rowText) and appended to hovers with appendText, never as markdown.
 * ========================================================================= */

/** A node of the Teams group. Which one an element is, is what THIS tree recorded (teamNodes). */
type TeamModeNode =
  | { kind: 'teams' }
  | { kind: 'team'; teamId: string }
  | { kind: 'teamInfo'; teamId: string; id: string; text: string; icon: string; tooltip: string | undefined }
  | { kind: 'member'; teamId: string; name: string }
  | { kind: 'board'; teamId: string }
  | { kind: 'boardState'; teamId: string; state: TaskState }
  | { kind: 'task'; teamId: string; taskId: string }
  | { kind: 'messages'; teamId: string }
  | { kind: 'message'; teamId: string; seq: number };

const teamNodes = new WeakMap<object, TeamModeNode>();

function teamModeNodeOf(node: unknown): TeamModeNode | undefined {
  return typeof node === 'object' && node !== null ? teamNodes.get(node) : undefined;
}

function remember<T extends TeamModeNode>(node: T): T {
  teamNodes.set(node, node);
  return node;
}

/** Warning rows shown under a team, at most. */
const TEAM_WARNINGS_SHOWN = 10;
/** Characters of a body or note shown in a hover. */
const HOVER_BODY_MAX = 2_000;
/** Activity items asked for when an activity channel opens. */
const ACTIVITY_BACKLOG = 200;
/** One activity line, at most. */
const ACTIVITY_LINE_MAX = 500;
/** Files of a member's changes offered in the picker. */
const CHANGES_SHOWN_MAX = 2_000;
const CHANGES_MAX_BYTES = 8 * 1024 * 1024;
const BASE_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** A full commit id, the only base a worktree is created from (§2.1). */
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** Where every member worktree lives (§2.1). */
const TEAM_WORKTREES_ROOT = path.join(ROOT_DIR, WORKTREES_DIR_NAME);

function teamStatusText(snap: TeamSnapshot): string {
  if (!snap.believed) {
    return vscode.l10n.t('suspended (host gone — resume it from a lead session)');
  }
  switch (snap.state.status) {
    case 'active':
      return vscode.l10n.t('active');
    case 'suspended':
      return vscode.l10n.t('suspended');
    case 'ended':
      return vscode.l10n.t('ended');
    case 'readonly':
      return vscode.l10n.t('read-only (log full)');
    default:
      return vscode.l10n.t('damaged');
  }
}

/** A member's state in words; `running`/`attached` of a snapshot that is not believed (L7) is "was running". */
function memberStateText(snap: TeamSnapshot, member: MemberState): string {
  if (!snap.believed && (member.state === 'running' || member.state === 'attached')) {
    return vscode.l10n.t('was running');
  }
  switch (member.state) {
    case 'starting':
      return vscode.l10n.t('starting');
    case 'idle':
      return vscode.l10n.t('idle');
    case 'running':
      return vscode.l10n.t('running');
    case 'pausing':
      return vscode.l10n.t('pausing');
    case 'paused':
      return vscode.l10n.t('paused');
    case 'attach_pending':
      return vscode.l10n.t('take-over starting');
    case 'attached':
      return vscode.l10n.t('taken over');
    case 'blocked':
      return vscode.l10n.t('blocked');
    case 'stopped':
      return vscode.l10n.t('stopped');
    default:
      return vscode.l10n.t('ended');
  }
}

function memberIcon(snap: TeamSnapshot, member: MemberState): vscode.ThemeIcon {
  if (!snap.believed && (member.state === 'running' || member.state === 'attached')) {
    return new vscode.ThemeIcon('question');
  }
  switch (member.state) {
    case 'starting':
      return new vscode.ThemeIcon('loading~spin');
    case 'running':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    case 'pausing':
    case 'paused':
      return new vscode.ThemeIcon('debug-pause');
    case 'attach_pending':
    case 'attached':
      return new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green'));
    case 'blocked':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'stopped':
      return new vscode.ThemeIcon('circle-slash');
    case 'ended':
      return new vscode.ThemeIcon('pass');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function taskStateText(state: TaskState): string {
  switch (state) {
    case 'open':
      return vscode.l10n.t('Open');
    case 'claimed':
      return vscode.l10n.t('Claimed');
    case 'blocked':
      return vscode.l10n.t('Blocked');
    case 'review':
      return vscode.l10n.t('Review');
    case 'done':
      return vscode.l10n.t('Done');
    default:
      return vscode.l10n.t('Cancelled');
  }
}

function mailboxText(member: MemberState): string {
  switch (member.mailbox) {
    case 'tools':
      return vscode.l10n.t('team tools');
    case 'turns-only':
      return member.mailboxReason
        ? vscode.l10n.t('turns-only ({0})', rowText(member.mailboxReason, 80))
        : vscode.l10n.t('turns-only');
    default:
      return vscode.l10n.t('not yet known');
  }
}

/** Running members — `running` is believed only with a live owner (L7). */
function runningCount(snap: TeamSnapshot): number {
  return snap.believed ? snap.state.members.filter((m) => m.state === 'running').length : 0;
}

/** The children of one Teams-group node, made fresh from the current snapshots. */
function teamChildren(client: TeamClient, node: TeamModeNode): TeamModeNode[] {
  if (node.kind === 'teams') {
    return client.teams().map((snap) => remember({ kind: 'team', teamId: snap.teamId }));
  }
  const snap = client.team(node.teamId);
  if (snap === undefined) {
    return [];
  }
  const { state } = snap;
  switch (node.kind) {
    case 'team': {
      const out: TeamModeNode[] = [];
      const info = (id: string, text: string, icon: string, tooltip?: string): void => {
        out.push(remember({ kind: 'teamInfo', teamId: snap.teamId, id, text, icon, tooltip }));
      };
      if (!snap.believed || state.status === 'suspended') {
        info(
          'resume',
          vscode.l10n.t('Suspended — resume it from a lead session: {0} team_resume {1}', COMMAND_SPELLING, rowText(state.name, 32)),
          'debug-pause',
        );
      } else if (!snap.live && state.status === 'active') {
        info('readonly', vscode.l10n.t('Read-only here: no dispatch host of this workspace leads it.'), 'eye');
      }
      if (state.status === 'damaged' && state.damagedReason) {
        info('damaged', vscode.l10n.t('Damaged: {0}', rowText(state.damagedReason, 200)), 'warning');
      }
      const b = state.budgets;
      info(
        'budget',
        b.pingPongTripped
          ? vscode.l10n.t('Budget: {0}/{1} turns today · {2}/{3} running · message loop stopped', b.turnsToday, b.turnsPerDay, b.running, b.maxRunning)
          : vscode.l10n.t('Budget: {0}/{1} turns today · {2}/{3} running', b.turnsToday, b.turnsPerDay, b.running, b.maxRunning),
        b.pingPongTripped ? 'warning' : 'dashboard',
        vscode.l10n.t(
          'Turns so far: {0} · tokens {1} in / {2} out{3}',
          state.totals.turns,
          kTokens(state.totals.inputTokens),
          kTokens(state.totals.outputTokens),
          state.totals.costUsd === null ? '' : ` · $${state.totals.costUsd.toFixed(2)}`,
        ),
      );
      state.warnings.slice(0, TEAM_WARNINGS_SHOWN).forEach((w, i) => {
        info(`warning-${i}`, rowText(w.text, 200), 'warning', rowText(w.text, HOVER_BODY_MAX));
      });
      for (const member of state.members) {
        out.push(remember({ kind: 'member', teamId: snap.teamId, name: member.name }));
      }
      out.push(remember({ kind: 'board', teamId: snap.teamId }));
      out.push(remember({ kind: 'messages', teamId: snap.teamId }));
      return out;
    }
    case 'board':
      return BOARD_RENDER_ORDER.filter((s) => state.board.some((t) => t.state === s)).map((s) =>
        remember({ kind: 'boardState', teamId: snap.teamId, state: s }),
      );
    case 'boardState':
      return state.board
        .filter((t) => t.state === node.state)
        .map((t) => remember({ kind: 'task', teamId: snap.teamId, taskId: t.id }));
    case 'messages':
      return snap.messages.map((m) => remember({ kind: 'message', teamId: snap.teamId, seq: m.seq }));
    default:
      return [];
  }
}

/** `contextValue` of a Teams-group node. package.json's menus match these with regular expressions. */
function teamContext(snap: TeamSnapshot, node: TeamModeNode): string {
  const live = snap.live && snap.believed ? '.live' : '';
  switch (node.kind) {
    case 'team':
      return `ccoTeam.team${live}${snap.state.status === 'ended' ? '.ended' : ''}`;
    case 'member': {
      const member = snap.state.members.find((m) => m.name === node.name);
      if (member === undefined) {
        return 'ccoTeam.member';
      }
      const s = member.state;
      return (
        `ccoTeam.member${live}` +
        (s !== 'stopped' && s !== 'ended' ? '.active' : '') +
        (s === 'stopped' ? '.stopped' : '') +
        (s === 'paused' || s === 'blocked' ? '.paused' : '') +
        (s === 'attached' || s === 'attach_pending' ? '.attached' : '') +
        (member.provider === 'claude' && s !== 'attached' && s !== 'attach_pending' && s !== 'stopped' && s !== 'ended'
          ? '.claude'
          : '') +
        (member.worktree.branch !== '' ? '.branch' : '')
      );
    }
    case 'board':
      return `ccoTeam.board${live}`;
    case 'task': {
      const task = snap.state.board.find((t) => t.id === node.taskId);
      return `ccoTeam.task.${task?.state ?? 'unknown'}${live}`;
    }
    case 'messages':
      return 'ccoTeam.messages';
    default:
      return `ccoTeam.${node.kind}`;
  }
}

/** The tree item of one Teams-group node; a node whose team is gone renders as a plain dash. */
function teamItem(client: TeamClient, node: TeamModeNode): vscode.TreeItem {
  if (node.kind === 'teams') {
    const item = new vscode.TreeItem(vscode.l10n.t('Teams'), vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'cco-teams';
    item.description = String(client.teams().length);
    item.iconPath = new vscode.ThemeIcon('organization');
    item.contextValue = 'ccoTeam.teams';
    return item;
  }
  const snap = client.team(node.teamId);
  if (snap === undefined) {
    return new vscode.TreeItem('-', vscode.TreeItemCollapsibleState.None);
  }
  const { state } = snap;
  const teamName = rowText(state.name, 32) || '-';
  const base = `cco-team:${snap.teamId}`;
  let item: vscode.TreeItem;
  switch (node.kind) {
    case 'team': {
      item = new vscode.TreeItem(
        vscode.l10n.t(
          'Team {0} · {1} · {2} running · {3} unread for the lead',
          teamName,
          teamStatusText(snap),
          runningCount(snap),
          state.lead.unread,
        ),
        snap.live ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = base;
      item.iconPath = new vscode.ThemeIcon(snap.live ? 'organization' : 'archive');
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown('**');
      tip.appendText(vscode.l10n.t('Team {0}', teamName));
      tip.appendMarkdown('**');
      const line = (text: string): void => {
        tip.appendMarkdown('\n\n');
        tip.appendText(text);
      };
      if (state.title) {
        line(rowText(state.title, 120));
      }
      if (state.goal) {
        line(vscode.l10n.t('Goal: {0}', rowText(state.goal, HOVER_BODY_MAX)));
      }
      line(vscode.l10n.t('Status: {0}', teamStatusText(snap)));
      line(vscode.l10n.t('Base commit: {0}', rowText(state.baseCommit, 40)));
      line(vscode.l10n.t('Unread: {0} for the lead · {1} for you', state.lead.unread, state.user.unread));
      item.tooltip = tip;
      break;
    }
    case 'teamInfo':
      item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.id = `${base}:info:${node.id}`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      break;
    case 'member': {
      const member = state.members.find((m) => m.name === node.name);
      if (member === undefined) {
        return new vscode.TreeItem('-', vscode.TreeItemCollapsibleState.None);
      }
      item = new vscode.TreeItem(
        member.role ? `${member.name} · ${rowText(member.role, 80)}` : member.name,
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = `${base}:member:${member.name}`;
      const model = rowText(member.modelUsed ?? member.model, 64) || vscode.l10n.t('default model');
      const task = member.tasks.length > 0 ? member.tasks.join(', ') : undefined;
      item.description = [
        providerInfo(member.provider).label,
        rowText(member.accountLabel, 64) || undefined,
        model,
        memberStateText(snap, member),
        member.mailbox === 'turns-only' ? vscode.l10n.t('turns-only') : undefined,
        task,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');
      item.iconPath = memberIcon(snap, member);
      item.tooltip = memberTooltip(snap, member);
      break;
    }
    case 'board': {
      const open = state.board.filter((t) => t.state !== 'done' && t.state !== 'cancelled').length;
      item = new vscode.TreeItem(vscode.l10n.t('Board'), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${base}:board`;
      item.description = vscode.l10n.t('{0} tasks · {1} not done', state.board.length, open);
      item.iconPath = new vscode.ThemeIcon('project');
      break;
    }
    case 'boardState': {
      const n = state.board.filter((t) => t.state === node.state).length;
      item = new vscode.TreeItem(
        taskStateText(node.state),
        node.state === 'done' || node.state === 'cancelled'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `${base}:board:${node.state}`;
      item.description = String(n);
      break;
    }
    case 'task': {
      const task = state.board.find((t) => t.id === node.taskId);
      if (task === undefined) {
        return new vscode.TreeItem('-', vscode.TreeItemCollapsibleState.None);
      }
      item = new vscode.TreeItem(`${task.id} ${rowText(task.title, 120)}`, vscode.TreeItemCollapsibleState.None);
      item.id = `${base}:task:${task.id}`;
      item.description = [
        task.assignee,
        task.paths.length > 0 ? rowText(task.paths.join(', '), 80) : undefined,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(' · ');
      item.iconPath = new vscode.ThemeIcon(
        task.state === 'done' ? 'pass' : task.state === 'blocked' ? 'warning' : task.state === 'cancelled' ? 'circle-slash' : 'circle-large-outline',
      );
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown('**');
      tip.appendText(`${task.id} · ${taskStateText(task.state)}`);
      tip.appendMarkdown('**\n\n');
      tip.appendText(rowText(task.title, 120));
      if (task.assignee) {
        tip.appendMarkdown('\n\n');
        tip.appendText(vscode.l10n.t('Held by {0}', task.assignee));
      }
      if (task.paths.length > 0) {
        tip.appendMarkdown('\n\n');
        tip.appendText(vscode.l10n.t('Paths: {0}', rowText(task.paths.join(', '), 600)));
      }
      if (task.note) {
        tip.appendMarkdown('\n\n');
        tip.appendText(vscode.l10n.t('Note: {0}', rowText(task.note, HOVER_BODY_MAX)));
      }
      if (task.body) {
        tip.appendMarkdown('\n\n');
        tip.appendText(rowTextCut(task.body, HOVER_BODY_MAX));
      }
      item.tooltip = tip;
      break;
    }
    case 'messages': {
      item = new vscode.TreeItem(vscode.l10n.t('Messages'), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${base}:messages`;
      item.description = snap.live
        ? state.user.unread > 0
          ? vscode.l10n.t('{0} unread', state.user.unread)
          : String(snap.messages.length)
        : vscode.l10n.t('shown while a host leads the team');
      item.iconPath = new vscode.ThemeIcon(state.user.unread > 0 ? 'mail' : 'mail-read');
      break;
    }
    case 'message': {
      const message = snap.messages.find((m) => m.seq === node.seq);
      if (message === undefined) {
        return new vscode.TreeItem('-', vscode.TreeItemCollapsibleState.None);
      }
      const head = message.body === undefined ? vscode.l10n.t('(long message)') : rowText(message.body, 120);
      item = new vscode.TreeItem(
        `${rowText(message.from, 32)} → ${rowText(message.to, 32)}: ${head}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = `${base}:message:${message.seq}`;
      item.description = [
        clockHHMM(message.ts),
        message.kind,
        message.urgent ? vscode.l10n.t('urgent') : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(' · ');
      item.iconPath = new vscode.ThemeIcon(message.kind === 'notice' ? 'info' : message.kind === 'report' ? 'note' : 'comment');
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown('**');
      tip.appendText(`${message.id} · ${rowText(message.from, 32)} → ${rowText(message.to, 32)} · ${message.kind}`);
      tip.appendMarkdown('**\n\n');
      tip.appendText(message.body === undefined ? '' : rowTextCut(message.body, HOVER_BODY_MAX));
      if (message.cut) {
        tip.appendMarkdown('\n\n');
        tip.appendText(vscode.l10n.t('({0} bytes in all — the lead reads the whole text with cco team_inbox)', message.bytes));
      }
      item.tooltip = tip;
      break;
    }
    default:
      return new vscode.TreeItem('-', vscode.TreeItemCollapsibleState.None);
  }
  item.contextValue = teamContext(snap, node);
  return item;
}

function memberTooltip(snap: TeamSnapshot, member: MemberState): vscode.MarkdownString {
  const tip = new vscode.MarkdownString();
  const line = (text: string): void => {
    tip.appendMarkdown('\n\n');
    tip.appendText(text);
  };
  tip.appendMarkdown('**');
  tip.appendText(member.role ? `${member.name} · ${rowText(member.role, 80)}` : member.name);
  tip.appendMarkdown('**');
  line(
    vscode.l10n.t(
      '{0} · {1} · state {2}',
      providerInfo(member.provider).label,
      rowText(member.accountLabel, 64) || '-',
      memberStateText(snap, member),
    ),
  );
  if (member.reason) {
    line(vscode.l10n.t('Reason: {0} — {1}', rowText(member.reason.code, 32), rowText(member.reason.text, 300)));
  }
  if (member.worktree.branch) {
    line(vscode.l10n.t('Branch: {0} · base {1}', rowText(member.worktree.branch, 120), rowText(member.worktree.baseCommit, 12)));
  }
  if (member.worktree.ahead !== undefined || member.worktree.dirty !== undefined) {
    line(
      vscode.l10n.t(
        '{0} commits ahead · {1}',
        member.worktree.ahead ?? '?',
        member.worktree.dirty === true ? vscode.l10n.t('uncommitted changes') : vscode.l10n.t('clean'),
      ),
    );
  }
  line(vscode.l10n.t('Pending messages: {0}', member.pending));
  line(
    vscode.l10n.t(
      'Usage: {0} turns · {1} in / {2} out{3}',
      member.turns,
      kTokens(member.tokens.in),
      kTokens(member.tokens.out),
      member.costUsd === null ? '' : ` · $${member.costUsd.toFixed(2)}`,
    ),
  );
  if (member.rssMb !== undefined) {
    line(vscode.l10n.t('Memory: {0} MB', Math.round(member.rssMb)));
  }
  line(vscode.l10n.t('Mailbox: {0}', mailboxText(member)));
  line(member.runsCommands ? vscode.l10n.t('Runs shell commands: yes') : vscode.l10n.t('Runs shell commands: no'));
  if (member.elevated === 'cursor-force') {
    line(vscode.l10n.t('Runs with --force: commands run without approval (teamCursorForce).'));
  } else if (member.elevated === 'agy-skip-permissions') {
    line(vscode.l10n.t('Runs with --dangerously-skip-permissions: commands run without approval (teamAgySkipPermissions).'));
  }
  if (member.sharesLeadPlan) {
    line(vscode.l10n.t("Shares the lead's plan."));
  }
  if (member.billableOverage) {
    line(vscode.l10n.t('Billing overage: its turns may spend money past the plan window.'));
  }
  line(vscode.l10n.t('Port base: {0}', member.portBase));
  if (member.turn && snap.believed) {
    line(vscode.l10n.t('Turn {0} ({1}) since {2}', member.turn.n, member.turn.id, clockHHMM(member.turn.startedAt)));
  } else if (member.lastTurn) {
    line(vscode.l10n.t('Last turn {0}: {1} — {2}', member.lastTurn.n, rowText(member.lastTurn.outcome, 32), rowText(member.lastTurn.head, 200)));
  }
  if (member.attach) {
    line(vscode.l10n.t('Taken over since {0}', clockHHMM(member.attach.since)));
  }
  if (member.lastActivity) {
    line(vscode.l10n.t('Last activity {0}: {1}', clockHHMM(member.lastActivity.ts), rowText(member.lastActivity.text, 200)));
  }
  return tip;
}

/* ------------------------------------------------------------------------- *
 * Commands on the Teams group
 * ------------------------------------------------------------------------- */

/** The words of a refused or unanswered request (host sentences are data: flattened and capped). */
function refusalText(outcome: TeamCallOutcome): string {
  if (outcome.kind === 'unreachable') {
    return vscode.l10n.t('no running dispatch host of this workspace leads this team');
  }
  if (outcome.kind !== 'refused') {
    return '';
  }
  switch (outcome.code) {
    case 'rpc:-32601':
      return vscode.l10n.t("this session's dispatch host is an earlier build without teams — start a new Claude Code session");
    case `rpc:${RPC_ERROR.roleForbidden}`:
      return vscode.l10n.t('the dispatch host does not allow this from the editor');
    case 'bad_answer':
      return vscode.l10n.t('the dispatch host answered with something this editor does not understand');
    default:
      return rowText(outcome.sentence, 300) || rowText(outcome.code, 64);
  }
}

/** The snapshot and the node a command was given, when the node is one of THIS tree's. */
function commandTarget(client: TeamClient, arg: unknown): { node: TeamModeNode; snap: TeamSnapshot } | undefined {
  const node = teamModeNodeOf(arg);
  if (node === undefined || node.kind === 'teams') {
    return undefined;
  }
  const snap = client.team(node.teamId);
  return snap === undefined ? undefined : { node, snap };
}

/** A live team (a connected host owns it and is believed), else a warning and undefined. */
function liveTarget(client: TeamClient, arg: unknown): { node: TeamModeNode; snap: TeamSnapshot } | undefined {
  const target = commandTarget(client, arg);
  if (target === undefined) {
    return undefined;
  }
  if (!target.snap.live || !target.snap.believed) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Team {0} is not led by a running dispatch host of this workspace — steer it from its lead session.',
        rowText(target.snap.state.name, 32),
      ),
    );
    return undefined;
  }
  return target;
}

function memberTarget(
  client: TeamClient,
  arg: unknown,
): { snap: TeamSnapshot; member: MemberState } | undefined {
  const target = liveTarget(client, arg);
  if (target === undefined || target.node.kind !== 'member') {
    return undefined;
  }
  const name = target.node.name;
  const member = target.snap.state.members.find((m) => m.name === name);
  return member === undefined ? undefined : { snap: target.snap, member };
}

function taskTarget(client: TeamClient, arg: unknown): { snap: TeamSnapshot; task: BoardTask } | undefined {
  const target = liveTarget(client, arg);
  if (target === undefined || target.node.kind !== 'task') {
    return undefined;
  }
  const taskId = target.node.taskId;
  const task = target.snap.state.board.find((t) => t.id === taskId);
  return task === undefined ? undefined : { snap: target.snap, task };
}

/** One request; a refusal is said. Resolves to the result on success. */
async function teamCall(
  client: TeamClient,
  snap: TeamSnapshot,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const outcome = await client.call(snap.teamId, method, { teamId: snap.teamId, ...params });
  if (outcome.kind === 'ok') {
    return outcome.result;
  }
  void vscode.window.showWarningMessage(
    vscode.l10n.t('Team {0}: {1}', rowText(snap.state.name, 32), refusalText(outcome)),
  );
  return undefined;
}

function done(text: string): void {
  vscode.window.setStatusBarMessage(noIcons(text), 4000);
}

/** The worktree of a member, when it is where every member worktree lives (§2.1) and is on disk. */
function memberWorktree(member: MemberState): string | undefined {
  const dir = member.worktree.path;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\u0000') || !isInsideDir(TEAM_WORKTREES_ROOT, dir)) {
    return undefined;
  }
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** The member's branch, only when it is exactly the one MD-2 names for it. */
function memberBranch(snap: TeamSnapshot, member: MemberState): string | undefined {
  const expected = teamBranchOf(teamSlugOf(snap.state.name, snap.teamId), member.name);
  return member.worktree.branch === expected && TEAM_NAME.test(snap.state.name) ? expected : undefined;
}

async function sendMessage(client: TeamClient, arg: unknown, toAll: boolean): Promise<void> {
  const target = liveTarget(client, arg);
  if (target === undefined) {
    return;
  }
  const { snap, node } = target;
  const to = !toAll && node.kind === 'member' ? node.name : 'all';
  const value = await vscode.window.showInputBox({
    title: to === 'all' ? vscode.l10n.t('Message to every member of {0}', rowText(snap.state.name, 32)) : vscode.l10n.t('Message to {0}', to),
    prompt:
      to === 'all'
        ? vscode.l10n.t('Sent as you (user); the lead is told.')
        : vscode.l10n.t('Sent as you (user); the lead is told. Start with ! to make it urgent — that stops the turn it is in.'),
    validateInput: (text) => {
      const body = text.startsWith('!') ? text.slice(1).trim() : text.trim();
      if (body === '') {
        return vscode.l10n.t('Write a message.');
      }
      if (to === 'all' && text.startsWith('!')) {
        return vscode.l10n.t('An urgent message goes to one member at a time.');
      }
      return Buffer.byteLength(body, 'utf8') > MESSAGE_MAX_BYTES
        ? vscode.l10n.t('At most {0} bytes.', MESSAGE_MAX_BYTES)
        : undefined;
    },
  });
  if (value === undefined) {
    return;
  }
  const urgent = value.startsWith('!');
  const text = urgent ? value.slice(1).trim() : value.trim();
  if (text === '') {
    return;
  }
  const result = await teamCall(client, snap, METHOD_TEAM.send, { to, text, urgent, tellLead: true });
  if (result !== undefined) {
    done(vscode.l10n.t('Message {0} sent.', rowText(result.msgId, 16)));
  }
}

async function memberOp(
  client: TeamClient,
  arg: unknown,
  op: 'stop' | 'restart' | 'pause' | 'unpause' | 'interrupt',
): Promise<void> {
  const target = memberTarget(client, arg);
  if (target === undefined) {
    return;
  }
  const { snap, member } = target;
  let now: boolean | undefined;
  if (op === 'stop') {
    const later = vscode.l10n.t('Stop After Its Turn');
    const atOnce = vscode.l10n.t('Stop Now');
    const running = member.state === 'running';
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Stop {0}?', member.name),
      {
        modal: true,
        detail: vscode.l10n.t(
          'A stopped member takes no more turns until it is restarted. Its worktree and branch are kept.',
        ),
      },
      ...(running ? [later, atOnce] : [vscode.l10n.t('Stop')]),
    );
    if (choice === undefined) {
      return;
    }
    now = choice === atOnce;
  }
  const params: Record<string, unknown> = { member: member.name, op };
  if (now !== undefined) {
    params.now = now;
  }
  const result = await teamCall(client, snap, METHOD_TEAM.member, params);
  if (result !== undefined) {
    done(vscode.l10n.t('{0}: {1}', member.name, rowText(result.state, 32)));
  }
}

/** The take-over plan (§3.10 step 2), checked by value before anything is started from it. */
function takeoverPlanOf(raw: unknown): TakeoverPlan | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const plan = raw as Record<string, unknown>;
  const env = typeof plan.env === 'object' && plan.env !== null ? (plan.env as Record<string, unknown>) : undefined;
  const set = typeof env?.set === 'object' && env.set !== null && !Array.isArray(env.set) ? (env.set as Record<string, unknown>) : undefined;
  const unset = Array.isArray(env?.unset) ? env.unset : undefined;
  const clean = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\u0000');
  const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
  if (
    typeof plan.lease !== 'string' ||
    !ATTACH_LEASE.test(plan.lease) ||
    !clean(plan.command, 4096) ||
    !path.isAbsolute(plan.command) ||
    !Array.isArray(plan.args) ||
    plan.args.length > 16 ||
    !plan.args.every((a) => clean(a, 4096)) ||
    !clean(plan.cwd, 4096) ||
    !path.isAbsolute(plan.cwd) ||
    !isInsideDir(TEAM_WORKTREES_ROOT, plan.cwd) ||
    set === undefined ||
    unset === undefined ||
    Object.keys(set).length > 64 ||
    !Object.entries(set).every(([k, v]) => ENV_KEY.test(k) && clean(v, 32 * 1024)) ||
    unset.length > 32 ||
    !unset.every((k) => typeof k === 'string' && ENV_KEY.test(k))
  ) {
    return undefined;
  }
  return {
    lease: plan.lease,
    command: plan.command,
    args: plan.args as string[],
    cwd: plan.cwd,
    env: { set: set as Record<string, string>, unset: unset as string[] },
    title: typeof plan.title === 'string' ? plan.title : '',
    note: typeof plan.note === 'string' ? plan.note : '',
  };
}

/** Take-over terminals this window opened → the grant each holds, released when it closes. */
const takeoverTerminals = new Map<vscode.Terminal, { client: TeamClient; teamId: string; lease: string }>();

async function takeOver(client: TeamClient, arg: unknown): Promise<void> {
  const target = memberTarget(client, arg);
  if (target === undefined) {
    return;
  }
  const { snap, member } = target;
  if (member.provider !== 'claude') {
    return; // the menu offers it for Claude members only (S1-3); the host refuses the rest too
  }
  let outcome = await client.call(snap.teamId, METHOD_TEAM.takeover, { teamId: snap.teamId, member: member.name });
  if (outcome.kind === 'refused' && outcome.code === 'member_running') {
    const stop = vscode.l10n.t('Stop the Turn and Take Over');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} is running a turn.', member.name),
      { modal: true, detail: refusalText(outcome) },
      stop,
    );
    if (choice !== stop) {
      return;
    }
    outcome = await client.call(snap.teamId, METHOD_TEAM.takeover, { teamId: snap.teamId, member: member.name, now: true });
  }
  if (outcome.kind !== 'ok') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Team {0}: {1}', rowText(snap.state.name, 32), refusalText(outcome)),
    );
    return;
  }
  const plan = takeoverPlanOf(outcome.result.plan);
  if (plan === undefined) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The take-over plan for {0} was not usable, so no terminal was opened.', member.name),
    );
    return;
  }
  const env: Record<string, string | null> = { ...plan.env.set };
  for (const key of plan.env.unset) {
    env[key] = null;
  }
  // The terminal's own process IS the member's `claude --resume` (§3.10 step 3): its pid is the
  // attach lease the engine watches, so it is started as the shell, not typed into one.
  const terminal = vscode.window.createTerminal({
    name: noIcons(rowText(plan.title, 80)) || vscode.l10n.t('Team member {0}', member.name),
    shellPath: plan.command,
    shellArgs: plan.args,
    cwd: plan.cwd,
    env,
  });
  takeoverTerminals.set(terminal, { client, teamId: snap.teamId, lease: plan.lease });
  terminal.show();
  if (plan.note) {
    void vscode.window.showInformationMessage(rowText(plan.note, 400));
  }
  const pid = await terminal.processId;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    await client.call(snap.teamId, METHOD_TEAM.release, { teamId: snap.teamId, lease: plan.lease });
    return;
  }
  const attached = await client.call(snap.teamId, METHOD_TEAM.attached, { teamId: snap.teamId, lease: plan.lease, pid });
  if (attached.kind !== 'ok') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Team {0}: {1}', rowText(snap.state.name, 32), refusalText(attached)),
    );
  }
}

async function release(client: TeamClient, arg: unknown): Promise<void> {
  const target = memberTarget(client, arg);
  const lease = target?.member.attach?.lease;
  if (target === undefined || lease === undefined || !ATTACH_LEASE.test(lease)) {
    return;
  }
  const result = await teamCall(client, target.snap, METHOD_TEAM.release, { lease });
  if (result !== undefined) {
    done(vscode.l10n.t('{0} is back with the team.', target.member.name));
  }
}

/** Activity channels: one Output channel per member (§8.1), fed while this window lives. */
const activityChannels = new Map<string, vscode.OutputChannel>();

function activityLine(item: FeedItem): string {
  const parts = [clockHHMMSS(item.ts), item.k, item.tool, item.s ?? item.d].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return rowTextCut(parts.join(' '), ACTIVITY_LINE_MAX);
}

async function showActivity(client: TeamClient, arg: unknown): Promise<void> {
  const target = memberTarget(client, arg);
  if (target === undefined) {
    return;
  }
  const { snap, member } = target;
  const key = `${snap.teamId}:${member.name}`;
  let channel = activityChannels.get(key);
  if (channel === undefined) {
    channel = vscode.window.createOutputChannel(
      noIcons(vscode.l10n.t('Team {0} · {1}', rowText(snap.state.name, 32), member.name)),
    );
    activityChannels.set(key, channel);
    const tail = await client.call(snap.teamId, METHOD_TEAM.activityTail, {
      teamId: snap.teamId,
      member: member.name,
      limit: ACTIVITY_BACKLOG,
    });
    if (tail.kind === 'ok') {
      for (const item of feedItemsOf(tail.result.items)) {
        channel.appendLine(activityLine(item));
      }
    }
    client.setActivity(snap.teamId, member.name, true);
  }
  channel.show(true);
}

/** Read-only base documents for Show Changes, by id (the content provider never runs git). */
const baseDocs = new Map<string, string>();
let baseDocSeq = 0;
const BASE_DOCS_MAX = 8;
const BASE_SCHEME = 'cco-team-base';
const baseContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return baseDocs.get(uri.query) ?? '';
  },
};

/** One read-only git call in a member's worktree, hooks off; never rejects. */
function teamGit(cwd: string, args: string[], maxBuffer: number): Promise<{ ok: boolean; stdout: Buffer; problem: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '--no-optional-locks', ...args],
        { cwd, timeout: GIT_TIMEOUTS_MS.diffNames, maxBuffer, windowsHide: true, encoding: 'buffer' },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ ok: false, stdout: Buffer.alloc(0), problem: rowText(String(stderr ?? '') || err.message, 300) });
            return;
          }
          resolve({ ok: true, stdout, problem: '' });
        },
      );
    } catch (err) {
      resolve({ ok: false, stdout: Buffer.alloc(0), problem: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** A repository-relative path git printed, when it can only name a file inside the worktree. */
function changedPathOf(raw: string): string | undefined {
  if (raw === '' || raw.length > 4096 || path.isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw)) {
    return undefined;
  }
  return raw.split('/').some((segment) => segment === '..' || segment === '') ? undefined : raw;
}

async function showChanges(client: TeamClient, arg: unknown): Promise<void> {
  const target = commandTarget(client, arg);
  if (target === undefined || target.node.kind !== 'member') {
    return;
  }
  const { snap } = target;
  const name = target.node.name;
  const member = snap.state.members.find((m) => m.name === name);
  if (member === undefined) {
    return;
  }
  const wt = memberWorktree(member);
  const branch = memberBranch(snap, member);
  const base = member.worktree.baseCommit;
  if (wt === undefined || branch === undefined || !COMMIT_SHA.test(base)) {
    void vscode.window.showWarningMessage(vscode.l10n.t('{0} has no worktree on this machine to compare.', member.name));
    return;
  }
  const listed = await teamGit(
    wt,
    ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', `${base}...refs/heads/${branch}`, '--'],
    CHANGES_MAX_BYTES,
  );
  if (!listed.ok) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Could not list the changes of {0}: {1}', member.name, listed.problem));
    return;
  }
  const files = listed.stdout
    .toString('utf8')
    .split('\u0000')
    .map(changedPathOf)
    .filter((p): p is string => p !== undefined)
    .slice(0, CHANGES_SHOWN_MAX);
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('{0} has no committed changes on {1} yet.', member.name, branch),
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    files.map((file) => ({ label: pickText(file, 200), file })),
    { placeHolder: vscode.l10n.t('Changes of {0} since {1} — pick a file to compare', member.name, base.slice(0, 8)) },
  );
  if (picked === undefined) {
    return;
  }
  const full = path.join(wt, picked.file);
  if (!isInsideDir(wt, full)) {
    return;
  }
  const shown = await teamGit(wt, ['cat-file', 'blob', `${base}:${picked.file}`], BASE_FILE_MAX_BYTES);
  const id = String(++baseDocSeq);
  baseDocs.set(id, shown.ok ? shown.stdout.toString('utf8') : '');
  for (const stale of [...baseDocs.keys()].slice(0, Math.max(0, baseDocs.size - BASE_DOCS_MAX))) {
    baseDocs.delete(stale);
  }
  const left = vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${path.basename(picked.file)}`, query: id });
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    vscode.Uri.file(full),
    vscode.l10n.t('{0} ({1} ↔ {2})', pickText(picked.file, 120), base.slice(0, 8), member.name),
  );
}

async function copyBranch(client: TeamClient, arg: unknown, merge: boolean): Promise<void> {
  const target = commandTarget(client, arg);
  if (target === undefined || target.node.kind !== 'member') {
    return;
  }
  const name = target.node.name;
  const member = target.snap.state.members.find((m) => m.name === name);
  const branch = member === undefined ? undefined : memberBranch(target.snap, member);
  if (branch === undefined) {
    return;
  }
  await vscode.env.clipboard.writeText(merge ? `git merge --no-ff ${branch}` : branch);
  done(merge ? vscode.l10n.t('Copied the merge command for {0}.', branch) : vscode.l10n.t('Copied {0}.', branch));
}

async function openWorktree(client: TeamClient, arg: unknown): Promise<void> {
  const target = commandTarget(client, arg);
  if (target === undefined || target.node.kind !== 'member') {
    return;
  }
  const name = target.node.name;
  const member = target.snap.state.members.find((m) => m.name === name);
  const wt = member === undefined ? undefined : memberWorktree(member);
  if (wt === undefined) {
    void vscode.window.showWarningMessage(vscode.l10n.t('{0} has no worktree on this machine.', name));
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt), { forceNewWindow: true });
}

async function endTeam(client: TeamClient, arg: unknown): Promise<void> {
  const target = liveTarget(client, arg);
  if (target === undefined || target.node.kind !== 'team') {
    return;
  }
  const { snap } = target;
  const drain = vscode.l10n.t('End When Turns Finish');
  const now = vscode.l10n.t('End Now');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('End team {0}?', rowText(snap.state.name, 32)),
    {
      modal: true,
      detail: vscode.l10n.t(
        'Every member stops for good. Worktrees and branches are kept — review and merge them from the lead session. "End When Turns Finish" lets running turns finish (up to 2 minutes); "End Now" stops them.',
      ),
    },
    drain,
    now,
  );
  if (choice === undefined) {
    return;
  }
  if ((await teamCall(client, snap, METHOD_TEAM.end, { now: choice === now })) !== undefined) {
    done(vscode.l10n.t('Team {0} is ending.', rowText(snap.state.name, 32)));
  }
}

async function addTask(client: TeamClient, arg: unknown): Promise<void> {
  const target = liveTarget(client, arg);
  if (target === undefined || (target.node.kind !== 'team' && target.node.kind !== 'board')) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t('New board task for {0}', rowText(target.snap.state.name, 32)),
    prompt: vscode.l10n.t('The task title (one line). Members claim it, or assign it afterwards.'),
    validateInput: (text) =>
      text.trim() === ''
        ? vscode.l10n.t('Write a title.')
        : [...text.trim()].length > BOARD_TITLE_MAX_CHARS
          ? vscode.l10n.t('At most {0} characters.', BOARD_TITLE_MAX_CHARS)
          : undefined,
  });
  if (title === undefined || title.trim() === '') {
    return;
  }
  const result = await teamCall(client, target.snap, METHOD_TEAM.task, { op: 'add', tasks: [{ title: title.trim() }] });
  if (result !== undefined) {
    taskWarnings(result);
    done(vscode.l10n.t('Task added.'));
  }
}

/** The warnings of a board answer (a path overlap, a reassignment), said once. */
function taskWarnings(result: Record<string, unknown>): void {
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((w) => typeof w === 'string') : [];
  if (warnings.length > 0) {
    void vscode.window.showWarningMessage(rowText(warnings.slice(0, 5).join(' · '), 600));
  }
}

async function assignTask(client: TeamClient, arg: unknown): Promise<void> {
  const target = taskTarget(client, arg);
  if (target === undefined) {
    return;
  }
  const { snap, task } = target;
  const members = snap.state.members.filter((m) => m.state !== 'stopped' && m.state !== 'ended');
  const picked = await vscode.window.showQuickPick(
    members.map((m) => ({
      label: m.name,
      description: [rowText(m.role, 60), memberStateText(snap, m)].filter((p) => p !== '').join(' · '),
      name: m.name,
    })),
    { placeHolder: vscode.l10n.t('Assign {0} to…', task.id) },
  );
  if (picked === undefined) {
    return;
  }
  let force = false;
  if (task.assignee !== undefined && task.assignee !== picked.name && task.state !== 'open' && task.state !== 'done') {
    const reassign = vscode.l10n.t('Reassign');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} is held by {1}. Reassign it to {2}?', task.id, task.assignee, picked.name),
      { modal: true },
      reassign,
    );
    if (choice !== reassign) {
      return;
    }
    force = true;
  }
  const result = await teamCall(client, snap, METHOD_TEAM.task, { op: 'assign', task: task.id, to: picked.name, force });
  if (result !== undefined) {
    taskWarnings(result);
    done(vscode.l10n.t('{0} assigned to {1}.', task.id, picked.name));
  }
}

async function moveTask(client: TeamClient, arg: unknown, move: 'done' | 'rework' | 'cancel' | 'reopen'): Promise<void> {
  const target = taskTarget(client, arg);
  if (target === undefined) {
    return;
  }
  const { snap, task } = target;
  let params: Record<string, unknown>;
  switch (move) {
    case 'done':
      params = { op: 'update', task: task.id, state: 'done' };
      break;
    case 'rework': {
      const note = await vscode.window.showInputBox({
        title: vscode.l10n.t('Send {0} back for rework', task.id),
        prompt: vscode.l10n.t('What needs to change (optional) — the member is told.'),
        validateInput: (text) =>
          Buffer.byteLength(text, 'utf8') > NOTE_MAX_BYTES ? vscode.l10n.t('At most {0} bytes.', NOTE_MAX_BYTES) : undefined,
      });
      if (note === undefined) {
        return;
      }
      params = { op: 'update', task: task.id, state: 'claimed', ...(note.trim() !== '' ? { note: note.trim() } : {}) };
      break;
    }
    case 'cancel':
      params = { op: 'cancel', task: task.id };
      break;
    default:
      params = { op: 'reopen', task: task.id };
  }
  const result = await teamCall(client, snap, METHOD_TEAM.task, params);
  if (result !== undefined) {
    taskWarnings(result);
    done(vscode.l10n.t('{0} updated.', task.id));
  }
}

/**
 * The Teams-group commands, by id (each registered by the extension through its guarded
 * registration). Every handler resolves its argument against THIS tree's nodes at the moment it
 * runs and re-reads the snapshot: a node that is not one of them, or a team that is gone, does
 * nothing. Hidden from the command palette (package.json).
 */
export function teamCommandHandlers(client: TeamClient): Record<string, (arg?: unknown) => Promise<void>> {
  return {
    'claudeCodeOrchestrator.teamSendMessage': (arg) => sendMessage(client, arg, false),
    'claudeCodeOrchestrator.teamSendToAll': (arg) => sendMessage(client, arg, true),
    'claudeCodeOrchestrator.teamInterrupt': (arg) => memberOp(client, arg, 'interrupt'),
    'claudeCodeOrchestrator.teamTakeOver': (arg) => takeOver(client, arg),
    'claudeCodeOrchestrator.teamRelease': (arg) => release(client, arg),
    'claudeCodeOrchestrator.teamStopMember': (arg) => memberOp(client, arg, 'stop'),
    'claudeCodeOrchestrator.teamRestartMember': (arg) => memberOp(client, arg, 'restart'),
    'claudeCodeOrchestrator.teamPauseMember': (arg) => memberOp(client, arg, 'pause'),
    'claudeCodeOrchestrator.teamUnpauseMember': (arg) => memberOp(client, arg, 'unpause'),
    'claudeCodeOrchestrator.teamShowActivity': (arg) => showActivity(client, arg),
    'claudeCodeOrchestrator.teamShowChanges': (arg) => showChanges(client, arg),
    'claudeCodeOrchestrator.teamCopyBranch': (arg) => copyBranch(client, arg, false),
    'claudeCodeOrchestrator.teamCopyMergeCommand': (arg) => copyBranch(client, arg, true),
    'claudeCodeOrchestrator.teamOpenWorktree': (arg) => openWorktree(client, arg),
    'claudeCodeOrchestrator.teamEnd': (arg) => endTeam(client, arg),
    'claudeCodeOrchestrator.teamAddTask': (arg) => addTask(client, arg),
    'claudeCodeOrchestrator.teamAssignTask': (arg) => assignTask(client, arg),
    'claudeCodeOrchestrator.teamTaskDone': (arg) => moveTask(client, arg, 'done'),
    'claudeCodeOrchestrator.teamTaskRework': (arg) => moveTask(client, arg, 'rework'),
    'claudeCodeOrchestrator.teamTaskCancel': (arg) => moveTask(client, arg, 'cancel'),
    'claudeCodeOrchestrator.teamTaskReopen': (arg) => moveTask(client, arg, 'reopen'),
  };
}

/* ------------------------------------------------------------------------- *
 * Status bar, notifications, read marks, take-over terminals
 * ------------------------------------------------------------------------- */

function noticeText(notice: TeamNotice): string {
  const team = rowText(notice.teamName, 32);
  const own = notice.text === undefined ? '' : rowText(notice.text, 300);
  if (own !== '') {
    return vscode.l10n.t('Team {0}: {1}', team, own);
  }
  const who = notice.member ?? vscode.l10n.t('a member');
  switch (notice.kind) {
    case 'blocked':
      return vscode.l10n.t('Team {0}: {1} is blocked.', team, who);
    case 'turns-only':
      return vscode.l10n.t('Team {0}: {1} runs turns-only — it reports at the end of each turn and cannot use the team tools.', team, who);
    case 'context-lost':
      return vscode.l10n.t('Team {0}: {1} lost its conversation and was briefed again; its work is kept.', team, who);
    case 'suspended':
      return vscode.l10n.t('Team {0} was suspended. Resume it from a lead session.', team);
    default:
      return vscode.l10n.t('Team {0} is idle.', team);
  }
}

/**
 * The status bar item, the notifications, the read marks and the take-over terminals' release
 * (§8.1, §3.10). Returned disposables end all of it.
 */
function registerTeamModeSurface(client: TeamClient, view: vscode.TreeView<TeamNode>): vscode.Disposable[] {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  status.command = 'claudeCodeOrchestrator.team.focus';
  const updateStatus = (): void => {
    const snap = client.teams().find((t) => t.live && t.believed && t.state.status === 'active');
    if (snap === undefined) {
      status.hide();
      return;
    }
    const blocked = snap.state.members.filter((m) => m.state === 'blocked').length;
    // CONTRACT-QUESTION: §8.1 does not say whose unread the status bar counts; the user's own
    // (what Mark Read clears) is shown — the Team row says the lead's.
    status.text = `$(organization) ${vscode.l10n.t(
      '{0}: {1} running · {2} blocked · {3} unread',
      noIcons(rowText(snap.state.name, 32)),
      runningCount(snap),
      blocked,
      snap.state.user.unread,
    )}`;
    status.tooltip = vscode.l10n.t('Team {0} — show the Team view', rowText(snap.state.name, 32));
    status.show();
  };
  updateStatus();
  const focusLabel = vscode.l10n.t('Show Team');
  return [
    status,
    client.onDidChange(updateStatus),
    client.onNotice((notice) => {
      void vscode.window.showInformationMessage(noIcons(noticeText(notice)), focusLabel).then(
        (choice) => {
          if (choice === focusLabel) {
            void vscode.commands.executeCommand('claudeCodeOrchestrator.team.focus');
          }
        },
        () => undefined,
      );
    }),
    client.onActivity((teamId, member, items) => {
      const channel = activityChannels.get(`${teamId}:${member}`);
      for (const item of items) {
        channel?.appendLine(activityLine(item));
      }
    }),
    view.onDidExpandElement((e) => {
      // §8.1: expanding Messages marks them read for the user.
      const node = teamModeNodeOf(e.element);
      const snap = node?.kind === 'messages' ? client.team(node.teamId) : undefined;
      if (snap !== undefined && snap.live && snap.state.user.unread > 0) {
        void client.call(snap.teamId, METHOD_TEAM.markRead, { teamId: snap.teamId, upToSeq: snap.state.seq });
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const grant = takeoverTerminals.get(terminal);
      if (grant !== undefined) {
        takeoverTerminals.delete(terminal);
        void grant.client.call(grant.teamId, METHOD_TEAM.release, { teamId: grant.teamId, lease: grant.lease });
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseContentProvider),
    {
      dispose: () => {
        for (const channel of activityChannels.values()) {
          channel.dispose();
        }
        activityChannels.clear();
      },
    },
  ];
}
