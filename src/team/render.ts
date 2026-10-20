import * as path from 'path';
import { flattenOneLine, sliceOneLine } from '../displayText';
import { meshWorkspaceHash } from '../mesh/contract';
import {
  ageText,
  BOARD_RENDER_ORDER,
  boardLine,
  clockHHMM,
  clockHHMMSS,
  COMMAND_SPELLING,
  fenceCloseLine,
  fenceOpenLine,
  kTokens,
  quoteFenceLines,
  REASON_MAX_CHARS,
  STATUS_BODY_MAX_BYTES,
  TEAM_FOOTER_RESERVE_CHARS,
  TEAM_TEXT,
  TEAM_TOOL_TEXT,
  teamBranchOf,
  teamSlugOf,
  WORKTREES_DIR_NAME,
} from './contract';
import type {
  BoardAnswer,
  BoardTask,
  CreateAnswer,
  EndAnswer,
  FeedItem,
  MemberAnswer,
  MemberState,
  MsgPostedBody,
  SendAnswer,
  SendRecipient,
  TakeoverPlan,
  TeamListEntry,
  TeamState,
} from './contract';

/**
 * team/render — every text the team engine's SURFACE answers with (team contract §7.4, §5.4, §4.4,
 * §3.10; T5b). surface.ts decides WHAT to answer; this file decides how it READS. Pure: no file,
 * no clock (the caller passes `now`), no state — so a rendering can be checked against the
 * skeletons of §7.4 with a hand-made TeamState and nothing else.
 *
 * WHERE THE WORDS COME FROM. A sentence the contract spells is TEAM_TEXT / TEAM_TOOL_TEXT of
 * team/contract.ts and is called from there, never written again here. What remains here is the
 * glue the skeletons leave to the implementer (column layout, the order of the lines) and a few
 * lines the contract describes without words — each marked `T5b wording`.
 *
 * EVERY STRING OF A RECORD IS DATA (§8, uiTypes rule 1). Roles, titles, notes, reasons, account
 * labels and message heads were written by the lead, the user or a MEMBER — an agent that may
 * have read hostile repository text. A one-line field is flattened (displayText.flattenOneLine)
 * and capped before it is put on a line; a multi-line text a member wrote (a report, a message,
 * a note) is put between fence lines with every fence-like line quoted (quoteFenceLines, MD-26),
 * exactly as the lead's inbox does, so a body can never forge a line of the answer around it.
 */

/** A one-line value as an answer shows it: flattened, cut to `max` characters with `…`. Total. */
export function oneLine(raw: unknown, max = REASON_MAX_CHARS): string {
  const flat = flattenOneLine(raw);
  return flat.length > max ? `${sliceOneLine(flat, Math.max(1, max - 1))}…` : flat;
}

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes on a code-point boundary, and the byte count it
 * had. A body is cut by BYTES because its caps are byte caps (§5.4, §7.4); a cut must never leave
 * half a character behind (P90).
 */
export function cutUtf8(text: string, maxBytes: number): { text: string; bytes: number; cut: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) {
    return { text, bytes, cut: false };
  }
  let used = 0;
  let out = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    out += ch;
  }
  return { text: out, bytes, cut: true };
}

/* ------------------------------------------------------------------------- *
 * File checks (§7.3: an unknown key names it and the closest allowed key)
 * ------------------------------------------------------------------------- */

/** Levenshtein distance; both strings are short (keys are compared only up to KEY_COMPARE_MAX_CHARS). */
function editDistance(a: string, b: string): number {
  const row: number[] = [];
  for (let j = 0; j <= b.length; j++) {
    row.push(j);
  }
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** An unknown key longer than this is not compared (it is named, cut, with the allowed list). */
const KEY_COMPARE_MAX_CHARS = 64;

/**
 * The allowed key an unknown one most likely meant: `-` read as `_`, case ignored, the nearest by
 * edit distance (the first in `allowed` order on a tie). §7.3 says the refusal names "the closest
 * allowed key" — ALWAYS one, unlike cli.ts's task files, which name one only within distance 3:
 * a team file's keys are few, and the list of allowed keys follows anyway.
 */
export function closestKey(key: string, allowed: readonly string[]): string | undefined {
  if (allowed.length === 0) {
    return undefined;
  }
  const normalised = key.slice(0, KEY_COMPARE_MAX_CHARS).replace(/-/g, '_').toLowerCase();
  let best = allowed[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const distance = editDistance(normalised, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** The name `x` most likely meant among `names`, when it is within 3 edits (the "Did you mean" of an unknown member, §7.3). */
export function nearName(x: string, names: readonly string[]): string | undefined {
  const closest = closestKey(x, names);
  return closest !== undefined && editDistance(x.slice(0, KEY_COMPARE_MAX_CHARS).toLowerCase(), closest) <= 3 ? closest : undefined;
}

/** `<where>: unknown key `x` — did you mean `y`? The allowed keys are …` (the cli.ts task-file spelling, §15.3.2). */
export function unknownKeyText(where: string, key: string, allowed: readonly string[]): string {
  const closest = closestKey(key, allowed);
  return (
    `${where}: unknown key \`${oneLine(key, KEY_COMPARE_MAX_CHARS)}\`` +
    (closest !== undefined ? ` — did you mean \`${closest}\`?` : '') +
    ` The allowed keys are ${allowed.join(', ')}.`
  );
}
/** T5b wording: a value of the wrong JSON type in a lead's file or arguments. */
export function wrongTypeText(where: string, key: string, expected: string): string {
  return `${where}: \`${key}\` must be ${expected}.`;
}
/** T5b wording: a required part that is absent. */
export function missingKeyText(where: string, key: string, expected: string): string {
  return `${where} has no \`${key}\` — it must be ${expected}.`;
}
/** T5b wording: a file (or element) that is not a JSON object. */
export function notObjectText(where: string): string {
  return `${where} must be a JSON object.`;
}
/** T5b wording: team_member's flag rules (§7.2), the client's exit-21 sentences. */
export const MEMBER_OP_RULES_TEXT = {
  op: (op: string): string =>
    `team_member: \`${oneLine(op, 40)}\` is not an operation; use one of stop, restart, pause, unpause, interrupt, switch.`,
  now: (): string => 'team_member: --now goes only with --stop or --pause.',
  switchKeys: (): string => 'team_member: --provider, --worker and --model go only with --switch.',
  switchNeedsOne: (): string => 'team_member: --switch needs at least one of --provider, --worker, --model.',
  worker: (): string => 'team_member: --worker must be at most 200 characters with no control characters.',
} as const;
/** T5b wording: team_status takes at most one flag (§7.2). */
export function statusOneFlagText(): string {
  return 'team_status takes at most one of --all, --member, --task, --message.';
}
/** T5b wording: a flag value of the wrong shape (§7.2: MEMBER_NAME, BOARD_ID, MESSAGE_ID, TEAM_ID or TEAM_NAME). */
export function badFlagValueText(op: string, flag: string, value: unknown, shape: string): string {
  return `${op}: --${flag} \`${oneLine(value, 64)}\` is not ${shape}.`;
}

/* ------------------------------------------------------------------------- *
 * Small renderings shared below
 * ------------------------------------------------------------------------- */

/** `yes` / `no`. */
function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}
/** Pad to a width (display columns ≈ code units; names are ASCII by regex). */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}
/** The first 7 hex of a sha, or `-`. */
function sha7(sha: string | undefined): string {
  return typeof sha === 'string' && sha !== '' ? sha.slice(0, 7) : '-';
}

/** A member's state with its reason, as the roster and status show it: `blocked: <reason>`, `paused (quota-wait …, until 17:00)`. */
export function memberStateText(m: Pick<MemberState, 'state' | 'reason'>): string {
  if (m.reason === undefined) {
    return m.state;
  }
  const until = typeof m.reason.until === 'number' ? `, until ${clockHHMM(m.reason.until)}` : '';
  const text = oneLine(m.reason.text);
  return m.state === 'blocked' ? `blocked: ${text}${until}` : `${m.state} (${text}${until})`;
}

/** The notes a roster line carries after the fixed columns (§3.2, §6.2, §3.7). */
function memberNotes(m: MemberState): string[] {
  const notes: string[] = [];
  if (m.mailbox === 'turns-only') {
    notes.push(TEAM_TEXT.turnsOnlyNote(oneLine(m.mailboxReason ?? 'no team tools', 80)));
  }
  if (m.sharesLeadPlan) {
    notes.push(TEAM_TEXT.sharesLeadPlan());
  }
  if (m.billableOverage) {
    notes.push(TEAM_TEXT.billingOverage());
  }
  if (m.provider === 'cursor') {
    notes.push(TEAM_TEXT.cursorSlow());
  }
  return notes;
}

/** `cursor-force` → its setting's name, for TEAM_TEXT.elevatedNote. */
function elevatedSetting(e: MemberState['elevated']): 'teamCursorForce' | 'teamAgySkipPermissions' | undefined {
  return e === 'cursor-force' ? 'teamCursorForce' : e === 'agy-skip-permissions' ? 'teamAgySkipPermissions' : undefined;
}

/**
 * The roster of §7.4's team_create skeleton: one row per member, columns aligned —
 * `alice  claude · acct-2 · opus   starting   branch cco/<slug>/alice   runs commands: yes`.
 */
export function rosterLines(members: readonly MemberState[], teamName: string, teamId: string): string[] {
  const rows = members.map((m) => {
    const account = `${m.provider} · ${oneLine(m.accountLabel, 60)} · ${oneLine(m.model, 60) || '—'}`;
    const branch = m.worktree?.branch ? oneLine(m.worktree.branch, 120) : teamBranchOf(teamSlugOf(teamName, teamId), m.name);
    const tail = [`branch ${branch}`, `runs commands: ${yesNo(m.runsCommands)}`];
    const notes = memberNotes(m);
    return { name: m.name, account, state: memberStateText(m), rest: tail.join('   ') + (notes.length > 0 ? ` · ${notes.join(' · ')}` : '') };
  });
  const nameW = Math.max(0, ...rows.map((r) => r.name.length));
  const accountW = Math.max(0, ...rows.map((r) => r.account.length));
  const stateW = Math.max(0, ...rows.map((r) => r.state.length));
  return rows.map((r) => `  ${pad(r.name, nameW)}  ${pad(r.account, accountW)}   ${pad(r.state, stateW)}   ${r.rest}`);
}

/**
 * The repository hash of the worktrees line: read off a member's recorded worktree path
 * (`<data root>/worktrees/<repoHash>/<teamSlug>/<name>`, §2.1) when there is one, else computed as
 * the engine computes it (mesh/contract.meshWorkspaceHash of the repository root).
 */
function repoHashOf(state: TeamState, dataRoot: string): string {
  const base = path.join(dataRoot, WORKTREES_DIR_NAME) + path.sep;
  for (const m of state.members) {
    const p = m.worktree?.path;
    if (typeof p === 'string' && p.startsWith(base)) {
      const first = p.slice(base.length).split(path.sep)[0];
      if (first !== undefined && /^[0-9a-f]{1,64}$/.test(first)) {
        return first;
      }
    }
  }
  return meshWorkspaceHash(state.repoRoot);
}

/** `Board: <n> tasks (<k> claimed, <m> open).` */
function boardSummary(board: readonly BoardTask[]): string {
  return TEAM_TEXT.boardSummaryLine(
    board.length,
    board.filter((t) => t.state === 'claimed').length,
    board.filter((t) => t.state === 'open').length,
  );
}

/* ------------------------------------------------------------------------- *
 * §7.4 answers of the lead's operations
 * ------------------------------------------------------------------------- */

/**
 * team_create / team_add / team_resume (§7.4): the first line, the roster of the members this
 * call concerns, the worktrees line, the board summary, the two doorbell lines, then the
 * warnings and notes. `warnings` are the Result's lines (e.g. a §5.3 overlap warning).
 */
export function renderCreateAnswer(a: CreateAnswer, warnings: readonly string[], dataRoot: string): string {
  const st = a.state;
  const base = oneLine(a.baseRef, 120);
  const head = sha7(st.baseCommit);
  const lines: string[] = [];
  switch (a.outcome) {
    case 'created':
      lines.push(TEAM_TEXT.created(st.name, st.id, base, head));
      break;
    case 'added':
      // T5b wording: §7.4 renders team_add "as team_create".
      lines.push(`Team ${st.name} (${st.id}): added ${a.members.join(', ') || '(none)'} from ${base} at ${head}.`);
      break;
    case 'resumed':
      // T5b wording.
      lines.push(`Team ${st.name} (${st.id}) resumed; members continue from ${head} on their own branches.`);
      break;
    case 'exists':
      lines.push(TEAM_TEXT.teamExists(st.name));
      break;
    case 'already-led':
      // T5b wording (§7.3 "team_resume of the team this session already leads" is not a refusal).
      lines.push(`This session already leads team ${st.name} (${st.id}) — nothing to resume.`);
      break;
  }
  const wanted = new Set(a.members);
  const members = a.outcome === 'added' ? st.members.filter((m) => wanted.has(m.name)) : st.members;
  lines.push('Members:');
  lines.push(...(members.length > 0 ? rosterLines(members, st.name, st.id) : ['  (none)']));
  if (a.outcome === 'exists' && a.missing !== undefined && a.missing.length > 0) {
    // T5b wording: "the names the file has and the team lacks" (§7.3).
    lines.push(`In the file but not in the team: ${a.missing.join(', ')} — add them with ${COMMAND_SPELLING} team_add <file>.`);
  }
  if (a.outcome === 'resumed') {
    if (a.interrupted !== undefined && a.interrupted.length > 0) {
      lines.push(`Last turn interrupted: ${a.interrupted.join(', ')}.`);
    }
    if (a.reportLost !== undefined && a.reportLost.length > 0) {
      lines.push(`Report lost (the engine was restarted): ${a.reportLost.join(', ')}.`);
    }
  }
  if (a.outcome === 'created' || a.outcome === 'added') {
    lines.push(TEAM_TEXT.worktreesLine(repoHashOf(st, dataRoot), teamSlugOf(st.name, st.id)));
  }
  lines.push(boardSummary(st.board));
  lines.push(TEAM_TEXT.keepWaitLine());
  lines.push(TEAM_TEXT.statusEndLine());
  if (typeof a.dirtyFiles === 'number' && a.dirtyFiles > 0) {
    lines.push(TEAM_TEXT.dirtyWarning(head));
  }
  for (const m of members) {
    const setting = elevatedSetting(m.elevated);
    if (setting !== undefined) {
      lines.push(TEAM_TEXT.elevatedNote(m.name, setting));
    }
  }
  lines.push(...warnings.map((w) => oneLine(w, 600)));
  return lines.join('\n');
}

/** One recipient of §7.4's team_send line: `alice (idle — alice starts a turn now)`. */
function recipientText(r: SendRecipient, now: number): string {
  const to = r.to;
  switch (r.delivery) {
    case 'starts':
      return `${to} (idle — ${to} starts a turn now)`;
    case 'busy':
      return `${to} (busy; it waits for ${to}'s next team_inbox call or turn)`;
    case 'interrupts':
      // T5b wording: §4.3 urgent to a running member.
      return `${to} (running — its turn is interrupted now and the message goes first)`;
    case 'urgent-queued':
      return `${to} (${TEAM_TEXT.urgentQueued(to, Math.max(0, Math.round(r.secondsAgo ?? 0)))})`;
    case 'held': {
      const why = r.reason !== undefined ? ` (${oneLine(r.reason, 120)}${typeof r.until === 'number' ? ` until ${clockHHMM(r.until)}` : ''})` : '';
      return `${to} (${TEAM_TEXT.recordedFor(to, `${r.state}${why}`)})`;
    }
    case 'attached':
      return `${to} (${TEAM_TEXT.queuedAttached(r.since ?? now)})`;
    case 'inbox':
      return to;
  }
}

/** team_send (§7.4): `Sent m57 to alice (idle — …), bob (busy; …).` + the Result's warnings. */
export function renderSendAnswer(a: SendAnswer, warnings: readonly string[], now: number): string {
  const recipients = a.recipients.map((r) => recipientText(r, now));
  return [`Sent ${a.msgId} to ${recipients.join(', ') || '(nobody)'}.`, ...warnings.map((w) => oneLine(w, 600))].join('\n');
}

/** team_task: a heading (T5b wording), every task it changed as its §5.4 board line, then the warnings (§5.3 overlaps). */
export function renderBoardAnswer(op: string, a: BoardAnswer, warnings: readonly string[]): string {
  const tasks = a.tasks.length > 0 ? a.tasks : [a.task];
  const heading =
    op === 'add'
      ? `Added ${tasks.length} task${tasks.length === 1 ? '' : 's'} to the board:`
      : `${a.task.id} is now ${a.task.state}${a.task.assignee !== undefined ? ` (${a.task.assignee})` : ''}:`;
  return [heading, ...tasks.map((t) => `  ${boardTaskLine(t)}`), ...warnings.map((w) => oneLine(w, 600))].join('\n');
}

/** A board line with its title and paths made display-safe (§5.4). */
function boardTaskLine(t: BoardTask): string {
  return boardLine({
    id: t.id,
    state: t.state,
    assignee: t.assignee,
    title: oneLine(t.title, 120),
    paths: t.paths.map((p) => oneLine(p, 200)),
  });
}

/** team_member (§7.4): one line per effect (the core's words); a state line when the core gave none. */
export function renderMemberAnswer(a: MemberAnswer, warnings: readonly string[]): string {
  const lines = a.lines.length > 0 ? a.lines.map((l) => oneLine(l, 600)) : [`${a.member} is ${a.state}.`];
  return [...lines, ...warnings.map((w) => oneLine(w, 600))].join('\n');
}

/**
 * team_end (§7.4, §9.5): the effects, then every branch with ahead/dirty/merged and the review,
 * verify and merge commands; `git worktree remove` when the branch is merged (never --force); a
 * failed restore of the merged vendor MCP file is stated.
 */
export function renderEndAnswer(a: EndAnswer, repoRoot: string, warnings: readonly string[]): string {
  const lines: string[] = [
    // T5b wording.
    a.mode === 'now'
      ? `Team ${a.name} (${a.teamId}) ended; running turns were stopped, worktrees committed.`
      : `Team ${a.name} (${a.teamId}) ended; running turns were allowed to finish, worktrees committed.`,
    ...a.lines.map((l) => oneLine(l, 600)),
  ];
  if (a.branches.length > 0) {
    lines.push('Branches (kept — the engine never merges or deletes):');
  }
  for (const b of a.branches) {
    const facts = [`+${b.ahead ?? 0} commits`];
    if (b.dirty === true) {
      facts.push('dirty');
    }
    if (b.merged === true) {
      facts.push('merged');
    }
    lines.push(`  ${b.member}  ${oneLine(b.branch, 160)}  ${facts.join(', ')}`);
    lines.push(`    ${TEAM_TEXT.reviewLine(repoRoot, sha7(b.baseCommit), b.branch)}`);
    lines.push(`    ${TEAM_TEXT.verifyLine(b.worktree)}`);
    lines.push(`    ${TEAM_TEXT.mergeLine(repoRoot, b.branch)}`);
    if (b.merged === true) {
      lines.push(`    ${TEAM_TEXT.worktreeRemoveLine(b.worktree)}`);
    }
    if (b.restoreError !== undefined) {
      // T5b wording (§9.2: a failed restore is stated in the end answer).
      lines.push(`    note: the vendor MCP file could not be restored, it stays as the engine left it: ${oneLine(b.restoreError)}`);
    }
  }
  lines.push(...warnings.map((w) => oneLine(w, 600)));
  return lines.join('\n');
}

/** POSIX single-quoting for a line a human pastes into a shell. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * team_attach (§3.10 step 1): the lead's op only PRINTS the plan — for the user's own terminal —
 * and changes nothing. The line is one `cd … && env -u … K=V … <claude> --resume <id>`; then the
 * trust-prompt note (L15); then (T5b wording) what a printed plan does NOT do: the engine keeps
 * running the member's turns, so a real hand-over goes through the VS Code Team view, or the
 * member is paused first (P77: two writers on one conversation otherwise).
 */
export function renderAttachPlan(member: string, plan: TakeoverPlan): string {
  const env = [
    ...plan.env.unset.map((k) => `-u ${shellQuote(k)}`),
    ...Object.entries(plan.env.set).map(([k, v]) => shellQuote(`${k}=${v}`)),
  ];
  const command = [shellQuote(plan.command), ...plan.args.map(shellQuote)].join(' ');
  return [
    `Take-over command for ${member} (for a human's terminal; nothing was changed):`,
    `  cd ${shellQuote(plan.cwd)} && ${env.length > 0 ? `env ${env.join(' ')} ` : ''}${command}`,
    oneLine(plan.note, 600),
    `The team engine keeps running ${member}'s turns meanwhile: for a hand-over use Take Over in Terminal in VS Code's Team view, ` +
      `or pause ${member} first: ${COMMAND_SPELLING} team_member ${member} --pause --now`,
  ].join('\n');
}

/** team_wait's deadline (exit 23) — T5b wording. */
export function renderWaitTimedOut(teamName: string | undefined, seconds: number): string {
  return `No team message woke the lead within ${seconds} s${teamName !== undefined ? ` (team ${teamName})` : ''}; run team_wait again to keep waiting.`;
}

/* ------------------------------------------------------------------------- *
 * team_status (§7.4) and the board (§5.4)
 * ------------------------------------------------------------------------- */

/**
 * One member row of team_status (§7.4): `name · provider · account label · model (→ reported
 * model) · state[ (reason, until HH:MM)] · turn n · last activity <age> · tasks b1,b4 · pending k ·
 * mailbox … · runs commands yes|no · port base p · branch +a commits, f files[, dirty][, merged] ·
 * RSS <MB>`. CONTRACT-QUESTION: the skeleton's `(reason, since HH:MM)` — MemberState carries no
 * "since" time, only `reason.until`; the row shows `until HH:MM` when there is one.
 */
export function statusMemberRow(m: MemberState, now: number): string {
  const model =
    (oneLine(m.model, 60) || '—') +
    (m.modelUsed !== undefined && m.modelUsed !== '' && m.modelUsed !== m.model ? ` (→ ${oneLine(m.modelUsed, 60)})` : '');
  const parts = [m.name, m.provider, oneLine(m.accountLabel, 60), model, memberStateText(m)];
  parts.push(m.turn !== undefined ? `turn ${m.turn.n}` : `turns ${m.turns}`);
  parts.push(m.lastActivity !== undefined ? `last activity ${ageText(now - m.lastActivity.ts)}` : 'no activity yet');
  parts.push(`tasks ${m.tasks.length > 0 ? m.tasks.join(',') : '-'}`);
  parts.push(`pending ${m.pending}`);
  parts.push(`mailbox ${m.mailbox}${m.mailbox === 'turns-only' && m.mailboxReason ? ` (${oneLine(m.mailboxReason, 80)})` : ''}`);
  parts.push(`runs commands ${yesNo(m.runsCommands)}`);
  parts.push(`port base ${m.portBase}`);
  const wt = m.worktree;
  if (wt === undefined || !wt.ready) {
    parts.push('worktree not ready');
  } else {
    parts.push(
      `branch +${wt.ahead ?? 0} commits, ${wt.filesChanged ?? 0} files${wt.dirty === true ? ', dirty' : ''}${wt.merged === true ? ', merged' : ''}`,
    );
  }
  if (typeof m.rssMb === 'number') {
    parts.push(`RSS ${Math.round(m.rssMb)} MB`);
  }
  if (m.sharesLeadPlan) {
    parts.push(TEAM_TEXT.sharesLeadPlan());
  }
  if (m.billableOverage) {
    parts.push(TEAM_TEXT.billingOverage());
  }
  const setting = elevatedSetting(m.elevated);
  if (setting !== undefined) {
    parts.push(`runs every command without approval (setting ${setting})`);
  }
  if (m.attach !== undefined) {
    parts.push(`attached by ${oneLine(m.attach.client, 40)} since ${clockHHMM(m.attach.since)}`);
  }
  return parts.join(' · ');
}

/**
 * The board (§5.4): one line per task in the order open / claimed / blocked / review / done /
 * cancelled, then `--- bodies ---` with the body of every non-terminal task (`cancelled` is the
 * one terminal state, §5.2) cut to `bodyCapBytes` with `[body cut: n bytes]`. `bodyOf` yields a
 * task's body text (inline, or read from its file by the caller); undefined = none.
 */
export function renderBoard(
  board: readonly BoardTask[],
  bodyCapBytes: number,
  bodyOf: (task: BoardTask) => string | undefined,
): string[] {
  if (board.length === 0) {
    return ['Board: no tasks.'];
  }
  const lines: string[] = ['Board:'];
  for (const state of BOARD_RENDER_ORDER) {
    for (const t of board) {
      if (t.state === state) {
        lines.push(`  ${boardTaskLine(t)}`);
      }
    }
  }
  const bodies: string[] = [];
  for (const state of BOARD_RENDER_ORDER) {
    if (state === 'cancelled') {
      continue;
    }
    for (const t of board) {
      if (t.state !== state) {
        continue;
      }
      const body = bodyOf(t);
      if (body === undefined || body.trim() === '') {
        continue;
      }
      const cut = cutUtf8(body, bodyCapBytes);
      bodies.push(`[${t.id}] ${oneLine(t.title, 120)}`);
      bodies.push(cut.text + (cut.cut ? `\n${TEAM_TOOL_TEXT.bodyCut(cut.bytes)}` : ''));
    }
  }
  if (bodies.length > 0) {
    lines.push('--- bodies ---', ...bodies);
  }
  return lines;
}

/**
 * team_status without a flag (§7.4): the team line, one row per member, the board (§5.4, bodies
 * ≤ STATUS_BODY_MAX_BYTES each), then the warnings.
 */
export function renderStatus(st: TeamState, now: number, bodyOf: (task: BoardTask) => string | undefined): string {
  const cost = st.totals.costUsd !== null ? ` · cost $${st.totals.costUsd.toFixed(2)} (Claude only)` : '';
  const lines: string[] = [
    `Team ${st.name} (${st.id}) · ${st.status} · base ${sha7(st.baseCommit)} · turns ${st.totals.turns} · tokens ` +
      `${kTokens(st.totals.inputTokens)}/${kTokens(st.totals.outputTokens)}${cost} · lead inbox ${st.lead.unread} unread · ` +
      `waiter ${st.lead.waiter ? 'running' : 'none'} · lead wakes today ${st.lead.wakesToday}`,
  ];
  if (st.status === 'damaged' && st.damagedReason !== undefined) {
    lines.push(`damaged: ${oneLine(st.damagedReason, 600)}`);
  }
  lines.push('Members:');
  lines.push(...(st.members.length > 0 ? st.members.map((m) => `  ${statusMemberRow(m, now)}`) : ['  (none)']));
  lines.push(...renderBoard(st.board, STATUS_BODY_MAX_BYTES, bodyOf));
  for (const w of st.warnings) {
    lines.push(`warning (${w.kind}): ${oneLine(w.text, 600)}`);
  }
  return lines.join('\n');
}

/**
 * team_status --all (§7.4): `<teamId>  <name>  <state>  <members>  <owner session or ->`, and under
 * a team the engine gives a reason for (TeamCore.listTeams' `reason`: `host gone` for a team whose
 * host died, a damaged team's damage) a line `  reason: <text>` — flattened and capped like every
 * reason here, so whatever a damaged store said can never read as another team's line.
 *
 * CONTRACT-QUESTION: TeamListEntry (host-protocol) has no `reason`; the engine adds it as a
 * structurally compatible field (engine.ts listTeams), and it is read here as optional.
 */
export function renderStatusAll(teams: readonly (TeamListEntry & { reason?: unknown })[]): string {
  if (teams.length === 0) {
    // T5b wording.
    return 'No team in this repository.';
  }
  return teams
    .map((t) => {
      const line =
        `${t.teamId}  ${oneLine(t.name, 40)}  ${t.state}  ${t.members}  ` +
        (t.ownedHere ? 'this session' : t.owner !== undefined ? `session pid ${t.owner.pid}` : '-');
      const reason = oneLine(t.reason ?? '');
      // T5b wording.
      return reason !== '' ? `${line}\n  reason: ${reason}` : line;
    })
    .join('\n');
}

/** One feed item as a status line: `14:02:11 tool Edit — <detail>`. */
function feedLine(item: FeedItem): string {
  const what = item.k === 'tool' && item.tool !== undefined ? `tool ${oneLine(item.tool, 64)}` : item.k;
  const detail = oneLine(item.d ?? item.s ?? '', 200);
  return `  ${clockHHMMSS(item.ts)} ${what}${detail !== '' ? ` — ${detail}` : ''}`;
}

/** A message as one line (heads only; the whole text is `team_status --message <id>`). */
export interface MessageHead {
  id: string;
  ts: number;
  from: string;
  to: string;
  kind: string;
  text: string;
}

/**
 * team_status --member <name> (§7.4): its row, its worktree/branch/base/head, its last feed items,
 * its last messages (one line each — the whole text is `--message`), then the review, verify and
 * merge commands, and — while it runs — never merge.
 */
export function renderMemberStatus(
  st: TeamState,
  m: MemberState,
  now: number,
  feed: readonly FeedItem[],
  messages: readonly MessageHead[],
): string {
  const wt = m.worktree;
  const branch = wt?.branch ?? teamBranchOf(teamSlugOf(st.name, st.id), m.name);
  const base = wt?.baseCommit ?? st.baseCommit;
  const lines: string[] = [
    statusMemberRow(m, now),
    `Worktree: ${wt?.path ?? '-'} · branch ${branch} · base ${sha7(base)} · head ${sha7(wt?.headSha)}${wt?.ready === false ? ' · not ready yet' : ''}`,
    `Role: ${oneLine(m.role, 80)} · incarnation ${m.incarnation}${m.conversationShort !== undefined ? ` · conversation ${oneLine(m.conversationShort, 8)}` : ''}`,
  ];
  lines.push(feed.length > 0 ? `Last activity (${feed.length}, oldest first):` : 'Last activity: none yet.');
  lines.push(...feed.map(feedLine));
  lines.push(messages.length > 0 ? `Last messages (${messages.length}, oldest first):` : 'Last messages: none.');
  for (const msg of messages) {
    lines.push(`  [${msg.id}] ${msg.from} → ${msg.to} · ${msg.kind} · ${clockHHMMSS(msg.ts)}: ${oneLine(msg.text, 200)}`);
  }
  lines.push(TEAM_TEXT.reviewLine(st.repoRoot, sha7(base), branch));
  lines.push(TEAM_TEXT.verifyLine(wt?.path ?? '-'));
  lines.push(TEAM_TEXT.mergeLine(st.repoRoot, branch));
  if (m.state === 'running' || m.state === 'pausing') {
    lines.push(TEAM_TEXT.neverMergeWhileRunning());
  }
  return lines.join('\n');
}

/** A text between fresh fence lines, every fence-like line of it quoted (MD-26). */
function fenced(fence: string, text: string): string[] {
  return [fenceOpenLine(fence), quoteFenceLines(text), fenceCloseLine(fence)];
}

/**
 * team_status --task <id> (§7.4): the task's line and facts, its body (≤ STATUS_TASK_MAX_BYTES),
 * and its reports (each ≤ the same) — every multi-line text fenced, since notes and reports are
 * a MEMBER's words.
 */
export function renderTaskStatus(
  t: BoardTask,
  fence: string,
  capBytes: number,
  body: string | undefined,
  reports: ReadonlyArray<{ at: number; by: string; text: string | undefined }>,
): string {
  const lines: string[] = [
    boardTaskLine(t),
    `created by ${t.createdBy} at ${clockHHMM(t.createdAt)} · updated by ${oneLine(t.updatedBy, 40)} at ${clockHHMM(t.updatedAt)}` +
      ` · allow overlap ${yesNo(t.allowOverlap)} · ${t.commits.length} commits · ${t.turns.length} turns`,
  ];
  if (t.commits.length > 0) {
    lines.push(`commits: ${t.commits.map((c) => sha7(c)).join(', ')}`);
  }
  if (t.note !== undefined && t.note !== '') {
    lines.push('Note:', ...fenced(fence, t.note));
  }
  if (body !== undefined && body !== '') {
    const cut = cutUtf8(body, capBytes);
    lines.push('Body:', ...fenced(fence, cut.text + (cut.cut ? `\n${TEAM_TOOL_TEXT.bodyCut(cut.bytes)}` : '')));
  } else {
    lines.push('Body: (none)');
  }
  reports.forEach((r, i) => {
    lines.push(`Report ${i + 1} by ${oneLine(r.by, 40)} at ${clockHHMM(r.at)}:`);
    if (r.text === undefined) {
      lines.push('  (its file could not be read)');
    } else {
      const cut = cutUtf8(r.text, capBytes);
      lines.push(...fenced(fence, cut.text + (cut.cut ? `\n${TEAM_TOOL_TEXT.bodyCut(cut.bytes)}` : '')));
    }
  });
  lines.push(TEAM_TEXT.inboxNotInstructions());
  return lines.join('\n');
}

/** team_status --message <id> (§7.4): the whole message, fenced, with its header facts. */
export function renderMessageStatus(msgId: string, ts: number, posted: MsgPostedBody, text: string | undefined, fence: string): string {
  const facts = [`[${msgId}] ${oneLine(posted.from, 40)} → ${oneLine(posted.to, 40)}`, posted.kind];
  if (posted.urgent) {
    facts.push('urgent');
  }
  if (posted.task !== undefined) {
    facts.push(`task ${oneLine(posted.task, 12)}`);
  }
  if (posted.re !== undefined) {
    facts.push(`re ${oneLine(posted.re, 12)}`);
  }
  facts.push(clockHHMMSS(ts));
  return [
    facts.join(' · '),
    ...(text !== undefined ? fenced(fence, text) : ['(its body file could not be read)']),
    TEAM_TEXT.inboxNotInstructions(),
  ].join('\n');
}

/* ------------------------------------------------------------------------- *
 * The footer (§4.4 item 2, L9)
 * ------------------------------------------------------------------------- */

/**
 * The unread line within TEAM_FOOTER_RESERVE_CHARS (the share of FOOTER_RESERVE the client keeps
 * for it, L9): when the senders list would push the line past it, the senders are cut to the
 * first few and `+<k> more`. Undefined when nothing is unread.
 */
export function footerLine(counts: { unread: number; senders: readonly string[] } | undefined): string | undefined {
  if (counts === undefined || !(counts.unread > 0)) {
    return undefined;
  }
  const senders = counts.senders.map((s) => oneLine(s, 40));
  for (let keep = senders.length; keep >= 0; keep--) {
    const shown = keep === senders.length ? senders : [...senders.slice(0, keep), `+${senders.length - keep} more`];
    const line = TEAM_TEXT.footer(counts.unread, shown);
    if (line.length <= TEAM_FOOTER_RESERVE_CHARS) {
      return line;
    }
  }
  return TEAM_TEXT.footer(counts.unread, [`${senders.length} senders`]);
}

/** T5b wording: a team id that names no team of this repository (observer methods). */
export function unknownTeamText(teamId: string): string {
  return `No team ${oneLine(teamId, 40)} in this repository.`;
}
/** T5b wording: cco/team.turnText of a turn whose text file is not there. */
export function unknownTurnText(turnId: string): string {
  return `There is no text for turn ${oneLine(turnId, 140)} (its task file is not there).`;
}
/** T5b wording: an internal failure answered instead of a throw (TeamEngine.toolCall never rejects). */
export function internalErrorText(op: string, err: unknown): string {
  const message = err instanceof Error ? err.message : err;
  return `The team engine could not answer ${op}: ${oneLine(message, 300) || 'unknown error'}. Check team_status before you retry.`;
}
