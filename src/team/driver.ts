import { execFile } from 'child_process';
import * as fs from 'fs';
import type {
  Adapter,
  LineStreamFn,
  RunEvent,
  RunResult,
  RunTask,
  SpawnRequest,
  StreamEndMeta,
} from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude';
import { CodexAdapter } from '@toragonite/agent-mesh-codex';
import { createChat, CursorAdapter, execOverLineStream } from '@toragonite/agent-mesh-cursor';
import { GeminiAdapter } from '@toragonite/agent-mesh-gemini';
import { flattenOneLine, sliceOneLine } from '../displayText';
import {
  createTurnLineStream,
  isLoginFailureText,
  isQuotaError,
  reportedProviderModel,
  resolveProviderCli,
} from '../mcp/provider-runner';
import { CLAUDE_LOGIN_TRIGGER_TEXTS, ClaudeTurnLog, composeClaudeTurns } from '../mcp/task-runner';
import { claudeEnv, defaultConfigDir, SESSION_IDENTITY_ENV, vendorChildEnv } from '../platform';
import { TEAM_TURN_TEXT } from '../prompts';
import { adapterAccountDir, normalizeProviderPermissionMode, providerInfo, type ProviderId } from '../providers';
import { isOurWorker, processStartedAt, type WorkerProfile } from '../registry';
import { readTextSafe } from '../safeFs';
import { resolveProbeCommand } from '../usage';
import {
  CLAUDE_SESSION_ID_IN_USE_TEXT,
  CLAUDE_TEAM_ALLOWED_TOOLS,
  CLAUDE_TEAM_DISALLOWED_TOOLS,
  CLAUDE_TEAM_SETTING_SOURCES,
  DISPATCHED_TASK_ENV,
  FEED_COALESCE_MS,
  FEED_DETAIL_MAX_CHARS,
  FEED_TEXT_MAX_BYTES,
  FEED_TOOL_MAX_CHARS,
  fenceCloseLine,
  fenceOpenLine,
  isContextOverflowText,
  isResumeNotFoundText,
  clockHHMM,
  isoTime,
  memberFilesOf,
  newClaudeSessionId,
  newFenceId,
  NORMAL_KILL_LADDER,
  PROMPT_ARGV_MAX,
  quoteFenceLines,
  REASON_MAX_CHARS,
  START_SLACK_MS,
  STRAGGLER_KILL_LADDER,
  SUSPEND_KILL_LADDER,
  TEAM_FILE_MODE,
  TEAM_MCP_ARG,
  teamDirOf,
  teamTurnEnvMarkers,
  TERM_KILL_LADDER,
  type FeedEvent,
  type KillLadder,
  type MintConversation,
  type StartTurn,
  type TurnChildHandle,
  type TurnDeps,
  type TurnHandle,
  type TurnOutcome,
  type TurnSpec,
} from './contract';

/**
 * team/driver — ONE TURN of one member (contract-team-mode-v2 §3.1–§3.4, T0 A1/A2/A4/A6/A7/A8/A12):
 * the vendor CLI of the member's provider, run headless through its agent-mesh 0.1.3 adapter over
 * provider-runner's turn seam (createTurnLineStream, M2), and everything the engine needs to know
 * about how it ended. The engine (T5a) owns the turn's MEANING — the log, the task log, delivery,
 * the member's state; the driver owns the PROCESS and the facts.
 *
 * WHAT IT NEVER DOES. It never spells a vendor argument or parses a vendor line (the adapters do,
 * §3.3): what it hands an adapter is a RunTask. It never gives a member more power than a dispatch
 * worker on the same vendor (I14): Claude runs `registry.permissionMode` verbatim with
 * `--permission-prompts none` (a denial, never a grant) and the five team tools as its only extra
 * grant; Codex, Cursor and Antigravity run the worker's own permission mode; `elevated` reaches the
 * adapter ONLY for Cursor (`--force`) and Antigravity (`--dangerously-skip-permissions`) and only
 * when the engine's spec says the per-vendor setting is on. No account variable is added by an
 * adapter (M14): the environment is composed here and the seam spawns with it verbatim.
 *
 * WHO OWNS THE PROCESS. The handle is the engine's alone (H2, I7): nothing of a turn enters
 * server.ts's maps or provider-runner's runningVendorChildren. Signals reach the CLI only through
 * the seam's child handle (pid known at spawn, so no remembered pid is ever signalled here) — SIGINT
 * to the leader, the escalation to the group (A1).
 *
 * RESIDUALS, stated: a CLI that turns an outside SIGINT into an ordinary exit 1 (Claude, Codex,
 * agy) cannot be told from a failure — only a death by signal, or the 128+n exit codes of one
 * (130/137/143), reads as `cancelled`; the env-marker sweep finds stragglers only where a process
 * table with environments can be read (darwin `ps -E`, linux procfs) and states when it could not;
 * on darwin `ps -E` does not show the environment of Apple's own platform binaries (`/bin/sleep`,
 * `/bin/sh` — measured 2026-10-16, macOS 14), so a straggler that IS one is not found by the marker
 * (a `node`, `python` or `npm` one is).
 *
 * Must not import 'vscode'. Reachable only from the host bundle (server.js), which carries the
 * adapters.
 */

/* ------------------------------------------------------------------------- *
 * Tunables
 * ------------------------------------------------------------------------- */

/** §3.3 events: unconsumed feed items kept before the oldest are dropped. */
const FEED_QUEUE_MAX = 1_000;
/** The `ps` of the env-marker sweep and the A2 reap (RP-19 measured 70 ms on macOS 14). */
const PROCESS_SCAN_TIMEOUT_MS = 5_000;
/** The process table read is bounded: `ps -E` prints every process's whole environment. */
const PROCESS_SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** One procfs file read (linux cmdline / environ). */
const PROC_FILE_MAX_BYTES = 1024 * 1024;
/** How often a straggler is checked for its exit while its ladder waits. */
const STRAGGLER_POLL_MS = 100;
/** The composed brief read for a non-Claude first turn (BRIEF_MAX plus the protocol and principles). */
const BRIEF_READ_MAX_BYTES = 1024 * 1024;
/** Exit codes a CLI reports for a death by these signals when it handles them itself (128 + n). */
const SIGNAL_EXIT_CODES: Readonly<Record<number, NodeJS.Signals>> = { 130: 'SIGINT', 137: 'SIGKILL', 143: 'SIGTERM' };

/* ------------------------------------------------------------------------- *
 * The turn prompt (§3.6.1) — a pure helper for the engine
 * ------------------------------------------------------------------------- */

/** One message of a turn input, as the engine selected it (re-sent ones are labelled, H3). */
export interface TurnPromptMessage {
  /** `m<seq>`. */
  id: string;
  /** `lead`, `user` or a member name. */
  from: string;
  kind: string;
  /** Epoch ms of its `msg.posted`. */
  ts: number;
  task?: string;
  body: string;
  /** A message repeated because the attempt that carried it failed before the model saw it. */
  resent: boolean;
}

/** What one turn prompt is composed from (§3.6.1's template, top to bottom). */
export interface TurnPromptInput {
  team: string;
  member: string;
  role: string;
  n: number;
  now: number;
  /** Recap lines (TEAM_TURN_TEXT.recap…), in order; a re-brief's brief and packet follow them. */
  recaps: readonly string[];
  /** The bundle, at most TURN_INPUT_MAX_MESSAGES / TURN_INPUT_MAX_BYTES — the engine's selection. */
  messages: readonly TurnPromptMessage[];
  /** Messages that wait beyond the cap (0 = none). */
  more: number;
  turnsOnly: boolean;
  tasks: ReadonlyArray<{ id: string; title: string; state: string }>;
  /** The first turn's kickoff (TEAM_TURN_TEXT.kickoffTools / kickoffTurnsOnly, or the spec's `start`); absent later. */
  kickoff?: string;
  /** The bundle's fence (newFenceId) — given only to make a composition reproducible. */
  fence?: string;
}

/**
 * The text of one turn (§3.6.1), from prompts.ts's fixed pieces in the template's order: header,
 * recaps, the fenced messages (re-sent ones first, each then in the order given), the cap line, the
 * held tasks, the first turn's kickoff, the closing line. One random fence per bundle; every body
 * line that looks like a fence is quoted (quoteFenceLines), so a body cannot close the bundle.
 * Pure and total. File indirection above PROMPT_ARGV_MAX is startTurn's (MD-64).
 */
export function composeTurnPrompt(input: TurnPromptInput): string {
  const fence = input.fence ?? newFenceId();
  const lines: string[] = [TEAM_TURN_TEXT.header(input.team, input.member, input.role, input.n, isoTime(input.now))];
  lines.push(...input.recaps);
  const ordered = [...input.messages.filter((m) => m.resent), ...input.messages.filter((m) => !m.resent)];
  if (ordered.length > 0) {
    lines.push(TEAM_TURN_TEXT.messagesHeading(ordered.length), '');
    for (const m of ordered) {
      const header = TEAM_TURN_TEXT.messageFenceHeader(m.id, m.from, m.kind, clockHHMM(m.ts), {
        ...(m.task !== undefined ? { task: m.task } : {}),
        resent: m.resent,
      });
      lines.push(fenceOpenLine(fence, header), quoteFenceLines(m.body), fenceCloseLine(fence), '');
    }
  }
  if (input.more > 0) {
    lines.push(TEAM_TURN_TEXT.moreMessages(input.more, input.turnsOnly));
  }
  if (input.tasks.length > 0) {
    lines.push(TEAM_TURN_TEXT.yourTasks(input.tasks));
  }
  if (input.kickoff !== undefined && input.kickoff.trim() !== '') {
    lines.push(input.kickoff);
  }
  lines.push(TEAM_TURN_TEXT.finalAnswer());
  return lines.join('\n');
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

/** One line, at most `max` characters. */
function oneLine(raw: unknown, max: number): string {
  return sliceOneLine(flattenOneLine(raw), max);
}

/** The non-empty parts, each once, one per line. */
function joinParts(parts: ReadonlyArray<string | undefined>): string {
  const kept: string[] = [];
  for (const part of parts) {
    const text = (part ?? '').trim();
    if (text !== '' && !kept.includes(text)) {
      kept.push(text);
    }
  }
  return kept.join('\n');
}

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary. */
function cutBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= max ? text : bytes.subarray(0, max).toString('utf8').replace(/�$/, '');
}

function errnoOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? oneLine(err.message, 80) : 'EUNKNOWN';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-negative integer count, else 0. */
function count(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), Number.MAX_SAFE_INTEGER) : 0;
}

/** Whether a process is alive (kill 0; EPERM = alive, another user's). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * T11 A26 / E10: what a Claude `system/init` line says about the team server `name` — true when its
 * `mcp_servers[]` lists it `connected`, false when it lists it otherwise or not at all (the CLI was
 * given it and did not connect it); undefined when the line is not that event or carries no list.
 * CONTRACT-QUESTION: the agent-mesh 0.1.3 Claude adapter turns `system/init` into a `session` event
 * only (its RunEvent union has no MCP status; `RunResult.raw` is the `result` line), so the driver
 * reads this ONE line itself in its seam wrapper — the one exception to "the adapters parse vendor
 * lines", for a fact the adapter does not carry. A `pending` status counts as not connected (the
 * contract's "listed it otherwise"); a later successful team call still counts for the engine.
 */
function teamToolsOfInit(line: string, name: string): boolean | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.mcp_servers)) {
    return undefined;
  }
  const entry = event.mcp_servers.find((s): s is Record<string, unknown> => isRecord(s) && s.name === name);
  return entry !== undefined && entry.status === 'connected';
}

/**
 * LV-D1: a cursor-agent stream line that ends an assistant message and that the agent-mesh 0.1.3
 * Cursor adapter maps to no event — a `tool_call`, or an `assistant` event without `timestamp_ms`
 * (the whole-message repeat the adapter drops). The second exception, after teamToolsOfInit, to
 * "the adapters parse vendor lines": the adapter does not carry message boundaries. The cheap
 * substring test keeps JSON.parse off the fragment lines (they carry `timestamp_ms`).
 */
function cursorBoundary(line: string): boolean {
  if (!line.includes('"tool_call"') && (!line.includes('"assistant"') || line.includes('"timestamp_ms"'))) {
    return false;
  }
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }
  return isRecord(event) && (event.type === 'tool_call' || (event.type === 'assistant' && typeof event.timestamp_ms !== 'number'));
}

/**
 * The feed of one turn (§3.3 `events`): one consumer, never slows the turn — past FEED_QUEUE_MAX
 * unconsumed items the oldest are dropped. Ends when `end()` is called (the process is over).
 */
class FeedQueue implements AsyncIterable<FeedEvent> {
  private readonly items: FeedEvent[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(item: FeedEvent): void {
    if (this.closed) {
      return;
    }
    this.items.push(item);
    if (this.items.length > FEED_QUEUE_MAX) {
      this.items.shift();
    }
    this.wake();
  }

  end(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const resume = this.waiter;
    this.waiter = undefined;
    resume?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FeedEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The process table (RP-19 env-marker sweep, A2 MCP reap)
 * ------------------------------------------------------------------------- */

interface ProcessRow {
  pid: number;
  pgid: number;
  /** Command line, plus (darwin `ps -E`, linux environ) the environment, space-separated. */
  text: string;
}

/**
 * This user's processes with their command lines AND environments — or undefined when that
 * cannot be read here (win32, `ps` missing or timing out). darwin: `ps -E -ww -A -o
 * pid=,pgid=,uid=,command=` [probed RP-19, 70 ms]; linux: procfs (cmdline + environ of every pid
 * whose directory is this uid's). Never rejects.
 */
function processTable(): Promise<ProcessRow[] | undefined> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) {
    return Promise.resolve(undefined);
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      try {
        execFile(
          'ps',
          ['-E', '-ww', '-A', '-o', 'pid=,pgid=,uid=,command='],
          { encoding: 'utf8', timeout: PROCESS_SCAN_TIMEOUT_MS, maxBuffer: PROCESS_SCAN_MAX_BYTES },
          (err, stdout) => {
            if (err !== null || typeof stdout !== 'string') {
              resolve(undefined);
              return;
            }
            const rows: ProcessRow[] = [];
            for (const line of stdout.split('\n')) {
              const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
              if (m !== null && Number(m[3]) === uid) {
                rows.push({ pid: Number(m[1]), pgid: Number(m[2]), text: m[4] });
              }
            }
            resolve(rows);
          },
        );
      } catch {
        resolve(undefined);
      }
    });
  }
  if (process.platform === 'linux') {
    return Promise.resolve().then(() => {
      let entries: string[];
      try {
        entries = fs.readdirSync('/proc');
      } catch {
        return undefined;
      }
      const rows: ProcessRow[] = [];
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) {
          continue;
        }
        try {
          if (fs.statSync(`/proc/${entry}`).uid !== uid) {
            continue;
          }
          const read = (name: string): string => {
            const r = readTextSafe(`/proc/${entry}/${name}`, PROC_FILE_MAX_BYTES);
            return r.ok ? r.text.replace(/\0/g, ' ') : '';
          };
          const stat = read('stat');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          rows.push({ pid: Number(entry), pgid: Number(fields[2]), text: `${read('cmdline')} ${read('environ')}` });
        } catch {
          // gone meanwhile, or not readable: not a process of this sweep
        }
      }
      return rows;
    });
  }
  return Promise.resolve(undefined);
}

/**
 * Stop the processes `targets` with STRAGGLER_KILL_LADDER (SIGTERM, 3 s, SIGKILL): each one's own
 * group when it leads one (pgid = pid — signalWorker's rule: a group nobody identified is never
 * signalled), else the process alone. Before EVERY signal the identity is proved again: alive, and
 * its start time still the one read when it was found (within START_SLACK_MS) — a pid that changed
 * hands meanwhile is left alone. Returns how many were signalled. Never rejects.
 */
async function stopStragglers(targets: ReadonlyArray<{ pid: number; pgid: number; startedAt: number }>): Promise<number> {
  const same = (t: { pid: number; startedAt: number }): boolean => {
    if (!alive(t.pid)) {
      return false;
    }
    const now = processStartedAt(t.pid);
    return now !== undefined && Math.abs(now - t.startedAt) <= START_SLACK_MS;
  };
  const signal = (t: { pid: number; pgid: number }, sig: NodeJS.Signals): void => {
    try {
      process.kill(t.pgid === t.pid ? -t.pid : t.pid, sig);
    } catch {
      // gone between the proof and the signal
    }
  };
  let signalled = 0;
  const live = targets.filter(same);
  const [first, ...rest] = STRAGGLER_KILL_LADDER.stages;
  for (const t of live) {
    signal(t, first.signal);
    signalled++;
  }
  for (const stage of rest) {
    const until = Date.now() + first.waitMs;
    while (Date.now() < until && live.some((t) => alive(t.pid))) {
      await new Promise((r) => setTimeout(r, STRAGGLER_POLL_MS));
    }
    for (const t of live) {
      if (same(t)) {
        signal(t, stage.signal);
      }
    }
  }
  return signalled;
}

/* ------------------------------------------------------------------------- *
 * startTurn
 * ------------------------------------------------------------------------- */

/** What the seam reported about one spawned CLI, with the extra fields createTurnLineStream adds. */
type EndMeta = StreamEndMeta & { signal?: NodeJS.Signals | null; linesCut?: number; stdoutDropped?: boolean };

/** One spawn of the turn's CLI (A4 may make a second). */
interface Attempt {
  /** The run used `--session-id` (Claude first turn without a transcript). */
  usedSessionId: boolean;
  /** The run continued an existing conversation (`--resume`): its `total_cost_usd` includes earlier turns (RO3). */
  resumed?: boolean;
  child?: TurnChildHandle;
  spawnedAt?: number;
  meta?: EndMeta;
  /** The seam could not start the CLI. */
  spawnError?: unknown;
  /** Non-empty stdout lines received. */
  lines: number;
  /** The adapter's terminal event. */
  done?: RunResult;
  /** The turn's answer when it is not `done.text` (a run-together of every message, see answerOf). */
  answer?: string;
  /**
   * Claude: every `result` of the run, read off the seam. The adapter ends its stream at the FIRST
   * result and drains the rest, so a turn the CLI gave the session after its answer — a background
   * task the member started finishing or expiring — would be lost, and its cost with it.
   */
  claudeTurns?: ClaudeTurnLog;
  errorMessage?: string;
  /** stream() threw before anything ran (a request it refused). */
  refused?: string;
}

/** Thrown into the adapter by the driver's seam wrapper when a ladder was asked for before the spawn. */
class NotSpawned extends Error {}

/** Claude's transcript of conversation `id` for a cwd (A4, RP-18): `<configDir>/projects/<cwd, non-alphanumerics as '-'>/<id>.jsonl`. */
function claudeTranscriptExists(configDir: string, cwd: string, id: string): boolean {
  const dirs = new Set<string>([cwd]);
  try {
    dirs.add(fs.realpathSync(cwd));
  } catch {
    // the cwd as given
  }
  const root = configDir.trim() === '' ? defaultConfigDir() : configDir;
  for (const dir of dirs) {
    try {
      if (fs.statSync(`${root}/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`).isFile()) {
        return true;
      }
    } catch {
      // not there
    }
  }
  return false;
}

/**
 * Write a turn's prompt file (MD-64) 0600, refusing anything at the name that is not a regular
 * file of ours: no symlink is followed, a FIFO cannot block the open. Throws with the errno.
 */
function writePromptFile(file: string, text: string): void {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
    (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0);
  const fd = fs.openSync(file, flags, TEAM_FILE_MODE);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw Object.assign(new Error('not a regular file'), { code: 'EFTYPE' });
    }
    fs.fchmodSync(fd, TEAM_FILE_MODE);
    fs.writeFileSync(fd, text, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The turn's environment (§3.3, M14, M16): Claude — platform.claudeEnv(configDir) (CLAUDE_CONFIG_DIR
 * set, or UNSET for the default directory; another account's OAuth token stripped); the others —
 * vendorChildEnv() plus the provider's home variable when the account has its own home
 * (adapterAccountDir, the dispatch rule); then SESSION_IDENTITY_ENV removed and the three team
 * markers set (they win over anything inherited).
 */
function turnEnv(spec: TurnSpec, incarnationNumber: number): NodeJS.ProcessEnv {
  const provider = spec.incarnation.provider;
  const worker = spec.incarnation.worker;
  let env: NodeJS.ProcessEnv;
  if (provider === 'claude') {
    env = claudeEnv(worker.configDir);
  } else {
    env = vendorChildEnv();
    const home = providerInfo(provider).homeEnv;
    const dir = adapterAccountDir(provider, worker.configDir);
    if (home !== null && dir !== undefined) {
      env[home] = dir;
    }
  }
  for (const name of SESSION_IDENTITY_ENV) {
    delete env[name];
  }
  return { ...env, ...teamTurnEnvMarkers(spec.turnId, spec.teamId, spec.member, incarnationNumber, spec.index) };
}

/** The adapter of one attempt, wired to the driver's seam and environment (never an account). */
function adapterFor(provider: ProviderId, binary: string, lineStream: LineStreamFn, env: NodeJS.ProcessEnv): Adapter {
  switch (provider) {
    case 'claude':
      return new ClaudeAdapter({ binary, lineStream, env });
    case 'codex':
      return new CodexAdapter({ binary, lineStream, env, skipGitRepoCheck: true });
    case 'cursor':
      return new CursorAdapter({ binary, lineStream, env, trust: true });
    case 'gemini':
      return new GeminiAdapter({ binary, lineStream, env });
  }
}

/**
 * Start one turn — see StartTurn's doc in contract.ts, which this implements clause by clause.
 * Returns synchronously and never throws; the spawn happens on a later turn of the loop.
 */
export const startTurn: StartTurn = (spec: TurnSpec, deps: TurnDeps): TurnHandle => {
  const provider = spec.incarnation.provider;
  const worker: WorkerProfile = spec.incarnation.worker;
  const createdAt = Date.now();
  const feed = new FeedQueue();
  const notes: string[] = [];
  const attempts: Attempt[] = [];
  let current: Attempt | undefined;

  // ---- what the vendor said, across attempts ----
  let sawEvent = false;
  let lastAssistantAt = 0;
  let sawAssistant = false;
  let conversationIdSeen: string | undefined;
  let resolveConversation!: (id: string | undefined) => void;
  const conversationId = new Promise<string | undefined>((resolve) => {
    resolveConversation = resolve;
  });
  let tokens = { in: 0, out: 0 };
  /** A26: Claude's init verdict on the team server (the last attempt's init wins). */
  let teamToolsConnected: boolean | undefined;
  /** The assistant text seen so far — the answer of a turn that ended without a final one and with no lastMessage. */
  let allText = '';
  /**
   * Cursor's message boundaries. With `--stream-partial-output` cursor-agent sends every assistant
   * message as fragments (each an `assistant` event with `timestamp_ms`) and then, in the CLI
   * versions seen live, the complete message again as one more such event — the adapter drops the
   * repeat only when it lacks `timestamp_ms`, so it reaches the driver as one more `text` event. A
   * `text` equal to the fragments since the last boundary is that repeat: it closes the message and
   * is neither fed nor added again. The lines the adapter turns into no event close a message too —
   * a `tool_call`, and the whole message without `timestamp_ms` (the repeat the adapter drops) —
   * read off the seam, which runs before the adapter maps that line; so does the end of the stream.
   * Residual: a fragment that happens to equal everything before it in its message ("ab" then
   * "ab") is taken for the repeat — the feed loses it, and the answer when `result` is not used.
   */
  let cursorSegment = '';
  /**
   * The last complete assistant message: the turn's answer when the vendor gave none of its own.
   * Cursor's comes from the boundaries above; every Claude and Codex `text` event is a whole text
   * block or agent message; Antigravity's are deltas with no boundary, so it has none ('').
   */
  let lastMessage = '';
  const closeCursorMessage = (): void => {
    if (cursorSegment.trim() !== '') {
      lastMessage = cursorSegment;
    }
    cursorSegment = '';
  };
  /**
   * The answer of a turn when it is not `done.text`. Claude's `result`, Codex's last agent message
   * and Antigravity's response are the final message alone; cursor-agent's `result` is every
   * assistant message of the turn concatenated with no separator (seen live: "…진행합니다.CODEWORD
   * CHOSEN"), and so is the partial text of a timed-out Claude or Cursor turn (the adapter's
   * accumulation). So, the same for every vendor: the last complete message when that text is empty
   * or ends with that message after earlier ones. Claude's and Codex's successful answer stays
   * theirs (a Claude final message of several text blocks is their concatenation, rightly). An
   * error's text is the vendor's error and stays as it is (classification and block reasons read it).
   */
  const answerOf = (result: RunResult): string | undefined => {
    if (result.status === 'error' || (result.status === 'ok' && provider !== 'cursor') || lastMessage === '') {
      return undefined;
    }
    const said = result.text;
    return said.trim() === '' || (said.length > lastMessage.length && said.endsWith(lastMessage)) ? lastMessage : undefined;
  };

  // ---- text deltas coalesced over FEED_COALESCE_MS (§3.8) ----
  let textBuffer = '';
  let textTimer: NodeJS.Timeout | undefined;
  const flushText = (): void => {
    clearTimeout(textTimer);
    textTimer = undefined;
    if (textBuffer !== '') {
      feed.push({ ts: Date.now(), turn: spec.turnId, k: 'text', s: cutBytes(textBuffer, FEED_TEXT_MAX_BYTES) });
      textBuffer = '';
    }
  };
  const feedText = (text: string): void => {
    textBuffer += text;
    if (Buffer.byteLength(textBuffer) >= FEED_TEXT_MAX_BYTES) {
      flushText();
    } else if (textTimer === undefined) {
      textTimer = setTimeout(flushText, FEED_COALESCE_MS);
    }
  };
  const feedItem = (k: FeedEvent['k'], fields: { tool?: string; d?: string; s?: string } = {}): void => {
    flushText();
    feed.push({ ts: Date.now(), turn: spec.turnId, k, ...fields });
  };

  // ---- the ladders (A1; "a call during a ladder moves to the faster remaining schedule") ----
  let finished = false;
  let ladderRequested = false;
  /** When the first ENGINE signal actually went out (timeout vs. interrupted). */
  let ladderSignalledAt: number | undefined;
  const due = new Map<NodeJS.Signals, number>();
  const sentToCurrent = new Set<NodeJS.Signals>();
  let ladderTimer: NodeJS.Timeout | undefined;

  const runDue = (): void => {
    clearTimeout(ladderTimer);
    ladderTimer = undefined;
    const child = current?.child;
    if (finished || child === undefined || current?.meta !== undefined) {
      return;
    }
    const now = Date.now();
    for (const [sig, at] of [...due.entries()].sort((a, b) => a[1] - b[1])) {
      if (at > now) {
        break;
      }
      due.delete(sig);
      sentToCurrent.add(sig);
      ladderSignalledAt ??= now;
      child.signal(sig);
    }
    const next = Math.min(...due.values());
    if (Number.isFinite(next)) {
      ladderTimer = setTimeout(runDue, Math.max(0, next - Date.now()));
    }
  };
  const requestLadder = (ladder: KillLadder): void => {
    if (finished) {
      return;
    }
    ladderRequested = true;
    let at = Date.now();
    for (const stage of ladder.stages) {
      const planned = due.get(stage.signal);
      if (!sentToCurrent.has(stage.signal) && (planned === undefined || at < planned)) {
        due.set(stage.signal, at);
      }
      at += stage.waitMs;
    }
    runDue();
  };

  // ---- the seam, wrapped so the driver sees every spawn, line and end ----
  const deadlineAt = createdAt + spec.timeoutMs;
  const env = turnEnv(spec, deps.incarnationNumber);
  const wrappedSeam = (attempt: Attempt): LineStreamFn =>
    (req: SpawnRequest, onEnd?: (meta: StreamEndMeta) => void): AsyncIterable<string> =>
      (async function* lines(): AsyncGenerator<string> {
        if (ladderRequested) {
          throw new NotSpawned('the turn was stopped before its CLI was started');
        }
        const seam = createTurnLineStream({
          deadlineMs: deadlineAt,
          env,
          onChild: (h) => {
            attempt.child = h;
            attempt.spawnedAt = Date.now();
            let startedAt = attempt.spawnedAt;
            try {
              startedAt = processStartedAt(h.pid) ?? attempt.spawnedAt;
            } catch {
              // the spawn time stands
            }
            try {
              deps.onSpawn({ pid: h.pid, pgid: h.pgid, startedAt });
            } catch {
              // the engine's bookkeeping must not fail a turn that has started
            }
            runDue();
          },
        });
        try {
          for await (const line of seam(req, (meta) => {
            attempt.meta = meta as EndMeta;
            onEnd?.(meta);
          })) {
            if (line.trim() !== '') {
              attempt.lines++;
            }
            if (provider === 'cursor' && cursorBoundary(line)) {
              closeCursorMessage();
            }
            if (provider === 'claude') {
              try {
                (attempt.claudeTurns ??= new ClaudeTurnLog()).take(JSON.parse(line));
              } catch {
                // not an event
              }
            }
            if (provider === 'claude' && spec.mcp !== undefined && line.includes('"mcp_servers"')) {
              const said = teamToolsOfInit(line, spec.mcp.name);
              if (said !== undefined) {
                teamToolsConnected = said;
              }
            }
            yield line;
          }
        } catch (err) {
          attempt.spawnError = err;
          throw err;
        }
      })();

  // ---- one attempt: the adapter's stream, mapped to feed items and facts ----
  const runAttempt = async (attempt: Attempt, binary: string, task: RunTask): Promise<void> => {
    current = attempt;
    attempts.push(attempt);
    sentToCurrent.clear();
    cursorSegment = '';
    const adapter = adapterFor(provider, binary, wrappedSeam(attempt), env);
    let events: AsyncIterable<RunEvent>;
    try {
      if (adapter.stream === undefined) {
        throw new Error(`the ${provider} adapter cannot stream`);
      }
      events = adapter.stream(task, { lineStream: wrappedSeam(attempt), env, skipAuthCheck: true });
    } catch (err) {
      attempt.refused = oneLine(err instanceof Error ? err.message : String(err), REASON_MAX_CHARS);
      return;
    }
    try {
      for await (const event of events) {
        const vendorEvent = event.type !== 'error' && (event.type !== 'done' || attempt.lines > 0);
        if (vendorEvent && !sawEvent) {
          sawEvent = true;
          feedItem('turn');
        }
        switch (event.type) {
          case 'session':
            if (conversationIdSeen === undefined) {
              resolveConversation(event.conversationId);
            }
            conversationIdSeen = event.conversationId;
            break;
          case 'text':
            sawAssistant = true;
            lastAssistantAt = Date.now();
            if (provider === 'cursor') {
              if (cursorSegment !== '' && event.text === cursorSegment) {
                closeCursorMessage();
                break;
              }
              cursorSegment += event.text;
            } else if (provider !== 'gemini' && event.text.trim() !== '') {
              lastMessage = event.text;
            }
            allText += event.text;
            feedText(event.text);
            break;
          case 'tool':
            closeCursorMessage();
            sawAssistant = true;
            lastAssistantAt = Date.now();
            feedItem('tool', {
              tool: oneLine(event.name, FEED_TOOL_MAX_CHARS),
              ...(event.detail !== undefined ? { d: oneLine(JSON.stringify(event.detail) ?? '', FEED_DETAIL_MAX_CHARS) } : {}),
            });
            break;
          case 'usage':
            tokens = { in: count(event.usage.inputTokens), out: count(event.usage.outputTokens) };
            feedItem('usage', { d: `in ${tokens.in} · out ${tokens.out}` });
            break;
          case 'done':
            attempt.done = event.result;
            closeCursorMessage();
            attempt.answer = answerOf(event.result);
            if (event.result.usage !== undefined) {
              tokens = { in: count(event.result.usage.inputTokens), out: count(event.result.usage.outputTokens) };
            }
            feedItem('done', { d: oneLine(`${event.result.status} · ${attempt.answer ?? event.result.text}`, FEED_DETAIL_MAX_CHARS) });
            break;
          case 'error':
            attempt.errorMessage = event.message;
            feedItem('error', { d: oneLine(event.message, FEED_DETAIL_MAX_CHARS) });
            break;
        }
      }
    } catch (err) {
      // An adapter whose iteration throws (it should end with one `error` event instead).
      attempt.errorMessage ??= oneLine(err instanceof Error ? err.message : String(err), REASON_MAX_CHARS);
    }
    closeCursorMessage();
    flushText();
  };

  /** The vendor's ERROR CHANNEL of a failed attempt — what classification reads (never activity text). */
  const failureText = (attempt: Attempt): string => {
    const stderr = attempt.meta?.stderrTail ?? '';
    if (attempt.errorMessage !== undefined) {
      return joinParts([attempt.errorMessage, stderr]);
    }
    const text = attempt.done?.text ?? '';
    const note = attempt.done?.note ?? '';
    // Codex and Antigravity carry the vendor's error in the note; Claude and Cursor in the result text.
    return provider === 'codex' || provider === 'gemini'
      ? joinParts([note !== '' ? note : text, stderr])
      : joinParts([text !== '' ? text : note, stderr]);
  };

  const failedBeforeEvent = (attempt: Attempt): boolean =>
    !sawEvent && attempt.done?.status !== 'ok' && attempt.refused === undefined && !(attempt.spawnError instanceof NotSpawned);

  // ---- the process half of §3.4 step 4: (2) the group, (3) env-marker stragglers, A2 ----
  const marker = `${DISPATCHED_TASK_ENV}=${spec.turnId}`;
  /** This turn's marker in a process table row (the exact variable, not a longer value). */
  const carriesMarker = (text: string): boolean => {
    const at = text.indexOf(marker);
    return at !== -1 && /^(\s|$)/.test(text.slice(at + marker.length, at + marker.length + 1));
  };
  const sweepAfterExit = async (): Promise<void> => {
    const firstSpawn = attempts.find((a) => a.spawnedAt !== undefined)?.spawnedAt;
    if (firstSpawn === undefined) {
      return;
    }
    const groups =
      process.platform === 'win32'
        ? []
        : [...new Set(attempts.map((a) => a.child?.pgid).filter((g): g is number => g !== undefined))].filter((pgid) => {
            try {
              process.kill(-pgid, 0);
              return true;
            } catch {
              return false; // the group is empty
            }
          });
    let table = await processTable();
    // (2) Something of the turn's group survived its leader. T11 A31: once the group's last member
    // is gone its id can be reused by an unrelated process group, so the group is signalled only
    // after re-proving that a live process of this uid IN it carries this turn's marker and started
    // at or after the turn's first spawn (alive and the same start time, just before the signal) —
    // a group that still holds one such process cannot have been recycled. Residual, stated: a
    // survivor that hides its environment (macOS platform binaries, `ps -E`) proves nothing, so its
    // group is left alone and noted.
    if (groups.length > 0) {
      let signalled = false;
      for (const pgid of groups) {
        const proven =
          table !== undefined &&
          table.some((row) => {
            if (row.pgid !== pgid || !carriesMarker(row.text)) {
              return false;
            }
            const startedAt = processStartedAt(row.pid);
            if (startedAt === undefined || startedAt < firstSpawn - START_SLACK_MS || !alive(row.pid)) {
              return false;
            }
            const again = processStartedAt(row.pid);
            return again !== undefined && Math.abs(again - startedAt) <= START_SLACK_MS;
          });
        if (!proven) {
          notes.push(
            table === undefined
              ? 'group survivors: not signalled (the process table cannot be read here)'
              : "group survivors: not signalled (none proven this turn's)",
          );
          continue;
        }
        try {
          process.kill(-pgid, 'SIGTERM');
          signalled = true;
          notes.push('group survivors: SIGTERM');
        } catch {
          // gone between the proof and the signal
        }
      }
      if (signalled) {
        // What the SIGTERM did not end is the straggler sweep's (its ladder escalates).
        table = await processTable();
      }
    }
    if (table === undefined) {
      notes.push('env-marker sweep skipped: the process table cannot be read here');
      return;
    }
    // §3.4 step 4 (3): a marker-found straggler is fenced with isOurWorker — this turn's unique id
    // in the process's own environment, a start time at or after the turn's first spawn, AND a
    // command line of this vendor's headless CLI, re-proved (alive, same start time) before every
    // signal (stopStragglers). Residual, stated: isOurWorker recognises only a vendor CLI's own
    // command line (`claude … -p`, `codex exec`, …), so a dev server or test runner the turn left
    // behind carries the marker and is still left alone (noted as spared).
    const toolSpec = spec.mcp?.args[spec.mcp.args.length - 1];
    const strays: Array<{ pid: number; pgid: number; startedAt: number }> = [];
    const orphans: Array<{ pid: number; pgid: number; startedAt: number }> = [];
    let spared = 0;
    for (const row of table) {
      if (row.pid === process.pid || attempts.some((a) => a.child?.pid === row.pid)) {
        continue;
      }
      const hasMarker = carriesMarker(row.text);
      const isOrphanServer =
        toolSpec !== undefined && row.text.includes(` ${TEAM_MCP_ARG} `) && row.text.includes(toolSpec);
      if (!hasMarker && !isOrphanServer) {
        continue;
      }
      // Identity: started at or after this turn's first spawn (pid + start time, I7/A2).
      const startedAt = processStartedAt(row.pid);
      if (startedAt === undefined || startedAt < firstSpawn - START_SLACK_MS) {
        continue;
      }
      if (!isOrphanServer && !isOurWorker(row.pid, provider)) {
        spared += 1;
        continue;
      }
      (isOrphanServer ? orphans : strays).push({ pid: row.pid, pgid: row.pgid, startedAt });
    }
    if (spared > 0) {
      notes.push(`stragglers: spared ${spared} (not this vendor's CLI)`);
    }
    if (strays.length > 0) {
      const n = await stopStragglers(strays);
      notes.push(`stragglers: stopped ${n}`);
    }
    if (orphans.length > 0) {
      const n = await stopStragglers(orphans);
      deps.log(`mcp.orphan team=${spec.teamId} member=${spec.member} turn=${spec.turnId} reaped=${n}`);
      notes.push(`mcp.orphan: reaped ${n}`);
    }
  };

  // ---- classification (§3.3; on FAILURE text only) ----
  const classify = async (attempt: Attempt): Promise<Pick<TurnOutcome, 'outcome' | 'signalledBy'>> => {
    const meta = attempt.meta;
    // CONTRACT-QUESTION: M8 says "an exit by SIGINT/SIGTERM/SIGKILL it did not send"; a CLI that
    // handles the signal itself exits 128+n instead of dying by it, so those codes count too when
    // the vendor gave no clean answer. `TurnOutcome.signal` stays the signal the OS reported.
    const exitSignal: NodeJS.Signals | null =
      meta?.signal ??
      (attempt.done?.status !== 'ok' && typeof meta?.exitCode === 'number' ? SIGNAL_EXIT_CODES[meta.exitCode] ?? null : null);
    if (attempt.spawnError instanceof NotSpawned || (ladderRequested && attempt.child === undefined)) {
      return { outcome: 'interrupted', signalledBy: null };
    }
    if (ladderSignalledAt !== undefined && (!meta?.timedOut || ladderSignalledAt < deadlineAt)) {
      return { outcome: 'interrupted', signalledBy: 'engine' };
    }
    if (meta?.timedOut === true) {
      return { outcome: 'timeout', signalledBy: 'engine' };
    }
    if (attempt.refused !== undefined || attempt.spawnError !== undefined || attempt.child === undefined) {
      return { outcome: 'crashed', signalledBy: null };
    }
    if (exitSignal !== null) {
      return { outcome: 'cancelled', signalledBy: 'other' };
    }
    if (attempt.done?.status === 'ok') {
      return { outcome: 'ok', signalledBy: null };
    }
    const text = failureText(attempt);
    // provider-runner's order (failRun): a login statement before the quota search — the more
    // specific of the two; §3.3's prose lists quota first without ranking them.
    if (provider !== 'claude' && isLoginFailureText(text, provider)) {
      return { outcome: 'auth', signalledBy: null };
    }
    if (isQuotaError(text)) {
      return { outcome: 'quota', signalledBy: null };
    }
    if (provider === 'claude') {
      const lower = text.toLowerCase();
      if (CLAUDE_LOGIN_TRIGGER_TEXTS.some((t) => lower.includes(t.toLowerCase()))) {
        let verdict: boolean | undefined;
        try {
          verdict = await deps.claudeLoginProbe(worker);
        } catch {
          verdict = undefined;
        }
        if (verdict === false) {
          return { outcome: 'auth', signalledBy: null };
        }
        notes.push('login text seen; the live probe did not confirm a logout');
      }
    }
    const raw = attempt.done?.raw;
    const subtype = isRecord(raw) && typeof raw.subtype === 'string' ? raw.subtype : '';
    if (isContextOverflowText(provider, joinParts([text, subtype]))) {
      return { outcome: 'context', signalledBy: null };
    }
    // T11 A29: `resume-failed` (the engine throws the conversation away and re-briefs) ONLY on the
    // vendor's conversation-not-found texts (RP-9). A resumed turn that died before any event for
    // any other reason (a CLI that could not start, a keychain prompt, EMFILE) is `crashed` below —
    // the engine's one early retry on the SAME conversation, as for a first turn (MD-59).
    if (spec.kind === 'next' && failedBeforeEvent(attempt) && isResumeNotFoundText(provider, text)) {
      return { outcome: 'resume-failed', signalledBy: null };
    }
    // A parsed vendor answer that says error (or ended without one on a clean exit) → error;
    // a failed exit without one → crashed.
    if (attempt.done !== undefined || meta?.exitCode === 0) {
      return { outcome: 'error', signalledBy: null };
    }
    return { outcome: 'crashed', signalledBy: null };
  };

  // ---- the turn ----
  const run = async (): Promise<TurnOutcome> => {
    if (ladderRequested) {
      return outcomeOf({ usedSessionId: false, lines: 0, spawnError: new NotSpawned('stopped before the spawn') }, {
        outcome: 'interrupted',
        signalledBy: null,
      });
    }

    // Which binary (a CLI that cannot be resolved is never spawned).
    let binary: string;
    if (provider === 'claude') {
      binary = resolveProbeCommand();
    } else {
      const cli = resolveProviderCli(providerInfo(provider).cli);
      if (!cli.found) {
        notes.push(`cli-missing: ${providerInfo(provider).cli}`);
        return outcomeOf({ usedSessionId: false, lines: 0, refused: 'cli-missing' }, { outcome: 'crashed', signalledBy: null });
      }
      binary = cli.command;
    }

    // The vendor text: Claude gets the brief as its system prompt; the others get it on top of a
    // FIRST turn's prompt (a `next` turn carries what the engine composed, a re-brief included).
    let vendorText = spec.prompt;
    if (provider !== 'claude' && spec.kind === 'first') {
      const brief = readTextSafe(spec.briefFile, BRIEF_READ_MAX_BYTES);
      if (!brief.ok) {
        notes.push(`brief: ${brief.reason}`);
        return outcomeOf({ usedSessionId: false, lines: 0, refused: 'brief' }, { outcome: 'crashed', signalledBy: null });
      }
      vendorText = `${brief.text}\n\n---\n\n${spec.prompt}`;
    }
    // MD-64: over PROMPT_ARGV_MAX bytes the text goes by file.
    if (Buffer.byteLength(vendorText, 'utf8') > PROMPT_ARGV_MAX) {
      try {
        const file = memberFilesOf(teamDirOf(deps.dataRoot, spec.teamId), spec.member).turnPrompt(spec.n);
        writePromptFile(file, vendorText);
        vendorText = TEAM_TURN_TEXT.promptFile(file);
      } catch (err) {
        notes.push(`prompt-file: ${errnoOf(err)}`);
        return outcomeOf({ usedSessionId: false, lines: 0, refused: 'prompt-file' }, { outcome: 'crashed', signalledBy: null });
      }
    }

    const model = spec.incarnation.model.trim();
    const task: RunTask = {
      prompt: vendorText,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      ...(model !== '' ? { model } : {}),
    };
    const expected = spec.expectedConversationId;
    let usedSessionId = false;
    if (provider === 'claude') {
      task.permissionMode = deps.claudePermissionMode;
      task.unattended = true;
      task.appendSystemPromptFile = spec.briefFile;
      task.allowedTools = [...CLAUDE_TEAM_ALLOWED_TOOLS];
      task.disallowedTools = [...CLAUDE_TEAM_DISALLOWED_TOOLS];
      if (CLAUDE_TEAM_SETTING_SOURCES !== undefined) {
        task.settingSources = CLAUDE_TEAM_SETTING_SOURCES;
      }
      if (spec.mcp !== undefined) {
        task.mcp = {
          name: spec.mcp.name,
          command: spec.mcp.command,
          args: [...spec.mcp.args],
          configFile: spec.mcp.configFile,
          ...(spec.mcp.projectConfigFile !== undefined ? { projectConfigFile: spec.mcp.projectConfigFile } : {}),
        };
      }
      if (expected !== undefined) {
        // A4: `--session-id` only when no transcript of S exists yet; otherwise continue it.
        if (spec.kind === 'next' || claudeTranscriptExists(worker.configDir, spec.cwd, expected)) {
          task.resumeId = expected;
        } else {
          task.sessionId = expected;
          usedSessionId = true;
        }
      }
    } else {
      const mode = normalizeProviderPermissionMode(provider, worker.permissionMode);
      if (mode !== null) {
        task.permissionMode = mode;
      }
      if (spec.mcp !== undefined) {
        task.mcp = { name: spec.mcp.name, command: spec.mcp.command, args: [...spec.mcp.args], configFile: spec.mcp.configFile };
      }
      // I14: only these two vendors have an elevation, and only when the setting is on.
      if (spec.elevated && (provider === 'cursor' || provider === 'gemini')) {
        task.elevated = true;
      }
      // Cursor's FIRST turn already has its chat (create-chat); every vendor's next turn resumes.
      if (expected !== undefined && (spec.kind === 'next' || provider === 'cursor')) {
        task.resumeId = expected;
      }
    }

    const first: Attempt = { usedSessionId, lines: 0, resumed: task.resumeId !== undefined };
    await runAttempt(first, binary, task);
    let last = first;
    // A4: `Session ID S is already in use` before any event → once more, at once, with --resume S.
    if (
      provider === 'claude' &&
      first.usedSessionId &&
      !ladderRequested &&
      failedBeforeEvent(first) &&
      failureText(first).includes(CLAUDE_SESSION_ID_IN_USE_TEXT) &&
      expected !== undefined
    ) {
      notes.push('session id in use: resumed it (A4)');
      const retry: Attempt = { usedSessionId: false, lines: 0, resumed: true };
      const { sessionId: _unused, ...rest } = task;
      await runAttempt(retry, binary, { ...rest, resumeId: expected });
      last = retry;
    }
    const verdict = await classify(last);
    if (last.spawnError !== undefined && !(last.spawnError instanceof NotSpawned)) {
      const errno = errnoOf(last.spawnError);
      notes.push(errno === 'ENOENT' ? `cli-missing: ${binary}` : `spawn: ${errno}`);
    }
    if (last.refused !== undefined && last.refused !== 'cli-missing') {
      notes.push(`adapter refused the turn: ${last.refused}`);
    }
    return outcomeOf(last, verdict);
  };

  /** The TurnOutcome of the turn whose last attempt is `attempt` (the process sweep runs first). */
  const outcomeOf = (attempt: Attempt, verdict: Pick<TurnOutcome, 'outcome' | 'signalledBy'>): TurnOutcome => {
    const meta = attempt.meta;
    if ((meta?.linesCut ?? 0) > 0) {
      notes.push(`stdout lines over 1 MiB cut: ${meta?.linesCut}`);
    }
    if (meta?.stdoutDropped === true) {
      notes.push('stdout over 8 MiB: lines dropped');
    }
    const assistantAt = lastAssistantAt;
    const adapterNote = attempt.done?.note ?? '';
    // RO: a Claude run of several results reports by task-runner's rule — the answer to the
    // prompt, then what a turn started by a background task said — with tokens summed and the
    // run's total the last result's running total (RO2: `total_cost_usd` is cumulative; a sum
    // would count the first turn twice in the team's cost and the worker's stats). The turn's own
    // cost is that total less what its conversation had reported before (RO3, turnCostOf).
    const turns = attempt.claudeTurns !== undefined && attempt.claudeTurns.results.length > 1 ? composeClaudeTurns(attempt.claudeTurns.results) : undefined;
    if (turns?.costNote !== undefined) {
      notes.push(turns.costNote);
    }
    const raw = attempt.done?.raw;
    const total =
      turns !== undefined
        ? turns.costUsd
        : isRecord(raw) && typeof raw.total_cost_usd === 'number' && Number.isFinite(raw.total_cost_usd)
          ? raw.total_cost_usd
          : undefined;
    const expected = spec.expectedConversationId;
    const contextLost = expected !== undefined && conversationIdSeen !== undefined && conversationIdSeen !== expected;
    const firstTotal = turns !== undefined ? attempt.claudeTurns?.results[0]?.event.total_cost_usd : undefined;
    const priced = turnCostOf(total, attempt.resumed === true && !contextLost, spec.costBaselineUsd, firstTotal);
    if (priced.note !== undefined) {
      notes.push(priced.note);
    }
    const note = oneLine([adapterNote, ...notes].filter((n) => n !== '').join('; '), REASON_MAX_CHARS);
    const modelUsed = attempt.done !== undefined ? reportedProviderModel(spec.incarnation.model || undefined, attempt.done.model) : undefined;
    return {
      outcome: verdict.outcome,
      contextLost,
      ...(conversationIdSeen !== undefined ? { conversationIdSeen } : {}),
      sawAssistant,
      assistantAfter: (ts: number) => sawAssistant && assistantAt > ts,
      text: turns?.text ?? attempt.answer ?? attempt.done?.text ?? (lastMessage !== '' ? lastMessage : allText),
      tokens: turns !== undefined ? { in: count(turns.inputTokens), out: count(turns.outputTokens) } : tokens,
      ...(priced.costUsd !== undefined ? { costUsd: priced.costUsd } : {}),
      ...(total !== undefined ? { cumulativeCostUsd: total } : {}),
      ...(modelUsed !== undefined ? { modelUsed } : {}),
      exitCode: meta?.exitCode ?? null,
      signal: meta?.signal ?? null,
      signalledBy: verdict.signalledBy,
      sawEvent,
      ...(teamToolsConnected !== undefined ? { teamToolsConnected } : {}),
      ...(note !== '' ? { note } : {}),
      stderrTail: meta?.stderrTail ?? '',
    };
  };

  const result: Promise<TurnOutcome> = (async () => {
    // The handle is returned first: a ladder asked for before this turn of the loop means no spawn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    let outcome: TurnOutcome;
    try {
      outcome = await run();
    } catch (err) {
      notes.push(`driver: ${oneLine(err instanceof Error ? err.message : String(err), 120)}`);
      outcome = outcomeOf(current ?? { usedSessionId: false, lines: 0 }, { outcome: 'crashed', signalledBy: null });
    }
    clearTimeout(ladderTimer);
    finished = true;
    try {
      await sweepAfterExit();
    } catch {
      notes.push('process sweep failed');
    }
    // Notes the sweep added after the outcome was built are folded in.
    const adapterNote = current?.done?.note ?? '';
    const note = oneLine([adapterNote, ...notes].filter((n) => n !== '').join('; '), REASON_MAX_CHARS);
    if (note !== '') {
      outcome = { ...outcome, note };
    }
    flushText();
    resolveConversation(undefined);
    feed.end();
    return outcome;
  })();

  return {
    get pid(): number | undefined {
      return current?.child?.pid;
    },
    events: feed,
    conversationId,
    lastOutputAt: () => current?.child?.lastOutputAt() ?? createdAt,
    result,
    interrupt: () => requestLadder(NORMAL_KILL_LADDER),
    suspend: () => requestLadder(SUSPEND_KILL_LADDER),
    kill: () => requestLadder(TERM_KILL_LADDER),
  };
};

/**
 * RO3 — a turn's own cost from what its run reported. `total_cost_usd` is the running total of the
 * whole CONVERSATION, the turns of earlier processes included (measured on the real CLI,
 * 2026-10-19: four processes of one conversation reported 0.00518, 0.00978, 0.01017, 0.01056,
 * the last two costing about $0.0004 each). A member resumes its conversation every turn, so the
 * total is never the turn's cost once the conversation has history:
 *  - a run that did not resume (a fresh conversation, or one the vendor replaced — `resumed` false):
 *    the total;
 *  - a resumed run with a known baseline: the total less the baseline. A total BELOW the baseline
 *    means the conversation under that id is not the one the baseline counted (replaced underneath):
 *    the whole total is the turn's, and the note says so;
 *  - a resumed run with an unknown baseline (the conversation's last costed turn was recorded before
 *    RO3): the total less the run's FIRST result's total when the run had several results — only
 *    what followed the first answer, a lower bound — else no cost at all. Never the whole total:
 *    that would count every earlier turn again.
 * The run's total itself is the next turn's baseline (TurnOutcome.cumulativeCostUsd). Pure.
 */
function turnCostOf(
  total: number | undefined,
  resumed: boolean,
  baseline: number | undefined,
  firstTotal: unknown,
): { costUsd?: number; note?: string } {
  if (total === undefined || !resumed) {
    return total === undefined ? {} : { costUsd: total };
  }
  if (baseline !== undefined) {
    const own = total - baseline;
    return own >= 0
      ? { costUsd: own }
      : {
          costUsd: total,
          note: `cost: total_cost_usd ${total} is below the ${baseline} this conversation had reported — it was replaced underneath, so the whole total is this turn's`,
        };
  }
  if (typeof firstTotal === 'number' && Number.isFinite(firstTotal) && firstTotal >= 0 && firstTotal <= total) {
    return {
      costUsd: total - firstTotal,
      note: `cost: what this conversation had cost before is unknown (recorded before this build), so only what followed the run's first result is counted`,
    };
  }
  return { note: `cost: unknown — what this conversation had cost before was not recorded (before this build), and total_cost_usd ${total} counts every earlier turn` };
}

/* ------------------------------------------------------------------------- *
 * mintConversation
 * ------------------------------------------------------------------------- */

/**
 * A conversation id known before the spawn (§2.1) — see MintConversation's doc in contract.ts.
 * Cursor's `create-chat` runs through the same turn seam (its own group, no shell, the deadline),
 * with the vendor-child environment and no session identity; its failure is worded from what it
 * printed (first line) or how it ended.
 */
export const mintConversation: MintConversation = async (provider, worker, cwd, timeoutMs, deps) => {
  void worker;
  switch (provider) {
    case 'claude':
      return { ok: true, conversationId: newClaudeSessionId() };
    case 'codex':
    case 'gemini':
      return { ok: true, conversationId: undefined };
    case 'cursor':
      break;
  }
  try {
    const cli = resolveProviderCli(providerInfo('cursor').cli);
    if (!cli.found) {
      return { ok: false, text: `cursor-agent create-chat failed: cli-missing: ${providerInfo('cursor').cli}` };
    }
    const env = vendorChildEnv();
    for (const name of SESSION_IDENTITY_ENV) {
      delete env[name];
    }
    let said = '';
    const seam = createTurnLineStream({ deadlineMs: Date.now() + timeoutMs, env, onChild: () => {} });
    const id = await createChat({
      binary: cli.command,
      timeoutMs,
      cwd,
      env,
      exec: async (req) => {
        try {
          const r = await execOverLineStream(seam, req);
          said = r.timedOut
            ? `timed out after ${timeoutMs} ms`
            : joinParts([r.stderr.split('\n').find((l) => l.trim() !== ''), r.exitCode !== 0 ? `exit ${r.exitCode}` : undefined]);
          return r;
        } catch (err) {
          said = `could not start: ${errnoOf(err)}`;
          throw err;
        }
      },
    });
    if (id !== null && id !== '') {
      return { ok: true, conversationId: id };
    }
    const text = `cursor-agent create-chat failed: ${oneLine(said || 'no chat id printed', 200)}`;
    deps.log(text);
    return { ok: false, text };
  } catch (err) {
    return { ok: false, text: `cursor-agent create-chat failed: ${oneLine(err instanceof Error ? err.message : String(err), 200)}` };
  }
};
