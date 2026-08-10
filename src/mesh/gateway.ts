import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import {
  GATEWAY_ALLOWED_TOOLS,
  GATEWAY_READY_TIMEOUT_MS,
  GATEWAY_RESTART_BACKOFF_MS,
  GatewayDeps,
  GatewayState,
  IGatewayManager,
  INBOUND_BUFFER_MAX,
  InboundMeshMessage,
  RELAY_TIMEOUT_MS,
  RelayRequest,
  RelayResult,
  buildRelayLine,
  newGatewayNonce,
  parseInboundLines,
  gatewayStandingPrompt,
  meshError,
  meshGatewayName,
  parseRelayResult,
} from './contract';

/**
 * mesh/gateway — the server's own first-class mesh identity (spike P9).
 *
 * The VS Code panel session cannot join the cross-session mesh (it registers without a
 * messaging socket — spike P7/#82313), so the MCP dispatch server hosts a long-lived
 * `claude -p` child in stream-json mode as its proxy. Outbound: we write a RELAY line to
 * the child's stdin and read the RELAY_RESULT it prints back. Inbound: cross-session
 * messages arrive as new `user` turns in the child's stdout stream, which we parse and
 * buffer for mesh_receive. The child's OWN prose is never surfaced to callers — only the
 * three machine signals matter (READY, RELAY_RESULT, `<cross-session-message>` blocks).
 *
 * This file implements IGatewayManager from ./contract. It must stay vscode-free and
 * depend on nothing beyond the node18 stdlib and the contract module.
 */

/** How many trailing stderr lines to retain for field diagnostics. */
const STDERR_RING_MAX = 20;
/**
 * Hard cap on a single unterminated stdout/stderr line (review L2). A child that streams a
 * huge run of bytes with no newline would otherwise grow the partial-line buffer without
 * bound; past this many bytes we drop the buffered partial and note it once on the stderr
 * ring rather than let host memory track the child's output.
 */
const MAX_LINE_BYTES = 1_000_000;
/** SIGTERM → (grace) SIGKILL window on stop(); mirrors the dispatch runner's shape. */
const STOP_KILL_GRACE_MS = 5_000;
/**
 * Last-resort settle after SIGKILL on stop(): even a killed process can be slow to be
 * reaped if a grandchild inherited a pipe. Armed after SIGKILL; when it fires we destroy
 * the stdio streams and unref the child so stop() always resolves and never leaves the
 * Node event loop (and therefore the MCP server) alive on a zombie.
 */
const STOP_REAP_GRACE_MS = 2_000;

/** A `user`-turn stdin frame — the only shape the child's stream-json input accepts. */
function userTurnLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

/** True for a stream-json turn-terminating `result` event. */
function isResultEvent(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as Record<string, unknown>).type === 'result';
}

/**
 * Text blocks of an `assistant` event. Assistant content is always an array of blocks in
 * stream-json, but we defend against a string/absent shape rather than trust it — a
 * malformed event must never throw inside the stdout loop and kill the reader.
 */
function assistantTexts(event: unknown): string[] {
  if (typeof event !== 'object' || event === null) {
    return [];
  }
  const ev = event as Record<string, unknown>;
  if (ev.type !== 'assistant') {
    return [];
  }
  const content = (ev.message as Record<string, unknown> | undefined)?.content;
  const out: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && b.type === 'text' && typeof b.text === 'string') {
        out.push(b.text);
      }
    }
  }
  return out;
}

/**
 * READY marker: the standing prompt asks for the single word READY, but we accept it as a
 * standalone word anywhere in the reply (the model may pad it). `\b` boundaries keep it
 * from firing on substrings like "ALREADY".
 */
function assistantHasReady(event: unknown): boolean {
  return assistantTexts(event).some((t) => /\bREADY\b/.test(t));
}

/** One in-flight relay, keyed by its id in the pending map. */
interface PendingSend {
  resolve: (result: RelayResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** One parked receive() long-poll, resolved by the inbound push path or its own deadline. */
interface Waiter {
  resolve: (messages: InboundMeshMessage[]) => void;
  maxMessages: number;
  timer: NodeJS.Timeout;
}

/** Whether a bring-up attempt is the caller's start() or an automatic crash-restart. */
type AttemptKind = 'initial' | 'restart';

const NOOP = (): void => {
  /* placeholder for the child-gone hook when no stop() is waiting */
};

/**
 * IGatewayManager over a single `claude -p --output-format stream-json` child.
 *
 * State machine: down → starting → ready, with crashes routing ready → down and an
 * automatic restart back to starting. Exactly one child exists at a time; every async
 * handler is closed over its own `child` object and bails when `child !== this.child`, so
 * a superseded child's late events (a slow exit after we already killed it, a data chunk
 * flushed post-kill) can never mutate the live attempt.
 */
export class GatewayManager implements IGatewayManager {
  readonly name: string;

  private readonly deps: GatewayDeps;
  private _state: GatewayState = 'down';

  /**
   * Per-session control-line secret (review H3). Generated ONCE for the life of this
   * manager and reused across every (re)launch: the nonce identifies this host<->gateway
   * channel, not a single child, so restarts re-send the standing prompt carrying the SAME
   * nonce. The host accepts a RELAY_RESULT/INBOUND line only when it carries this nonce, so
   * untrusted text the gateway echoes from a worker's message cannot forge a control line.
   */
  private readonly nonce = newGatewayNonce();

  /** The live child, or undefined between attempts / after stop. */
  private child?: ChildProcess;

  /** FIFO inbound ring, capped at INBOUND_BUFFER_MAX; PRESERVED across restarts. */
  private readonly inbound: InboundMeshMessage[] = [];
  /** Parked receive() long-polls awaiting the next inbound message. */
  private readonly waiters: Waiter[] = [];
  /** In-flight relays keyed by their generated id. */
  private readonly pending = new Map<string, PendingSend>();
  /** Trailing stderr lines, folded into capability_failed / gateway_down error text. */
  private readonly stderrRing: string[] = [];

  /** Ready-detection timeout for the current attempt. */
  private readyTimer?: NodeJS.Timeout;
  /** Pending crash-restart timer (the backoff wait between attempts). */
  private restartTimer?: NodeJS.Timeout;
  /** Index into GATEWAY_RESTART_BACKOFF_MS; reset to 0 whenever an attempt reaches READY. */
  private restartIndex = 0;
  /** Last assistant text seen during the current bring-up, for the no-READY failure detail. */
  private startAssistantTail = '';

  /** Deferred settlement of the caller's start() promise (initial attempt only). */
  private startPromise?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (err: Error) => void;

  /** Memoized stop() promise — makes stop() idempotent. */
  private stopPromise?: Promise<void>;
  /** Invoked by the exit handler once the child is confirmed gone during stop(). */
  private onChildGone: () => void = NOOP;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.name = meshGatewayName(deps.cwd);
  }

  get state(): GatewayState {
    return this._state;
  }

  peekBufferSize(): number {
    return this.inbound.length;
  }

  /**
   * Bring the gateway up and resolve once the child replies READY. Rejects with
   * capability_failed when the first turn ends without a READY reply — either the child is
   * killed after GATEWAY_READY_TIMEOUT_MS, or its turn-1 `result` event arrives carrying no
   * READY text (an unauthenticated or off-script session). Idempotent-ish: a second call
   * while already ready resolves immediately, while starting returns the same pending
   * promise, and after stop() it rejects.
   */
  start(): Promise<void> {
    if (this._state === 'ready') {
      return Promise.resolve();
    }
    if (this._state === 'stopped') {
      return Promise.reject(
        new Error(meshError('gateway_down', 'gateway was stopped; construct a new GatewayManager to start again')),
      );
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    // Capture the promise locally: launch() can settle the attempt synchronously (a failed
    // initial stdin write), and onAttemptFailure clears this.startPromise, so reading the
    // field after launch() could return undefined.
    const promise = (this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    }));
    this.launch('initial');
    return promise;
  }

  /**
   * Terminate the gateway permanently. Clears every timer, rejects pending sends and
   * releases receive() waiters, then ends stdin and SIGTERMs the child (SIGKILL after
   * STOP_KILL_GRACE_MS). Resolves once the child is gone. Idempotent — repeat calls return
   * the same promise.
   */
  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.doStop();
    }
    return this.stopPromise;
  }

  /**
   * Relay one message through the gateway. Assigns a fresh id, writes a RELAY line, and
   * resolves with the matching RELAY_RESULT parsed off the child's stream. `delivered:false`
   * is a NORMAL resolution carrying the upstream transport error. Rejects immediately with
   * gateway_down when not ready, and with relay_timeout after RELAY_TIMEOUT_MS. Concurrent
   * sends are independent — each waits on its own id.
   */
  send(req: Omit<RelayRequest, 'id'>): Promise<RelayResult> {
    if (this._state !== 'ready') {
      return Promise.reject(
        new Error(meshError('gateway_down', this.decorate(`gateway is '${this._state}', cannot relay`))),
      );
    }
    const id = crypto.randomUUID();
    const line = buildRelayLine({ id, to: req.to, summary: req.summary, message: req.message });
    return new Promise<RelayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(meshError('relay_timeout', `no RELAY_RESULT for relay ${id} within ${RELAY_TIMEOUT_MS}ms`)),
        );
      }, RELAY_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.writeUserTurn(line)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(meshError('gateway_down', this.decorate('failed to write relay to gateway stdin'))));
      }
    });
  }

  /**
   * Long-poll the inbound buffer. Returns up to maxMessages immediately when the buffer is
   * non-empty; otherwise parks a waiter resolved by the next inbound push, or by the
   * maxWaitMs deadline (then []). No polling loop — the inbound push path wakes waiters.
   */
  receive(maxWaitMs: number, maxMessages: number): Promise<InboundMeshMessage[]> {
    if (this.inbound.length > 0) {
      return Promise.resolve(this.takeInbound(maxMessages));
    }
    if (maxWaitMs <= 0) {
      return Promise.resolve([]);
    }
    return new Promise<InboundMeshMessage[]>((resolve) => {
      const waiter: Waiter = {
        resolve,
        maxMessages,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) {
            this.waiters.splice(i, 1);
          }
          resolve([]);
        }, maxWaitMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /* ----------------------------------------------------------------------- *
   * Lifecycle — spawn, ready detection, crash/restart
   * ----------------------------------------------------------------------- */

  /**
   * Spawn a child and drive one bring-up attempt to READY. Everything here is closed over
   * this attempt's `child` and its `settleAttempt` gate; the `child !== this.child` guard
   * on every handler is what keeps a superseded child inert.
   */
  private launch(kind: AttemptKind): void {
    this._setState('starting');
    this.startAssistantTail = '';

    // Child args are passed as an argv array with NO shell: allowedTools is a single entry
    // and untrusted values (cwd-derived name, model) never touch a command line, so there
    // is nothing to quote or inject.
    const child = spawn(
      this.deps.claudePath,
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        this.deps.model,
        '--name',
        this.name,
        // NEVER add `--bare` here. On Claude Code 2.1.226 it also skips credential loading,
        // so the session comes up unauthenticated ("Not logged in · Please run /login") and
        // never runs a tool — mesh_send then dies with relay_timeout while status still reads
        // ready (D-matrix probe, 2026-08-10, both npm-global and extension binaries). Slimness
        // comes from the haiku model and the tiny standing prompt instead.
        '--allowedTools',
        GATEWAY_ALLOWED_TOOLS,
      ],
      {
        cwd: this.deps.cwd,
        env: { ...process.env, ...(this.deps.configDir ? { CLAUDE_CONFIG_DIR: this.deps.configDir } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;

    // Partial-line buffers are LOCAL to this attempt: one child owns one contiguous stdout
    // stream, and a fresh child starts a fresh buffer. stdout chunks split mid-line
    // arbitrarily, so we accumulate and only parse up to each newline; the tail (an
    // incomplete line) stays buffered for the next chunk.
    let stdoutBuf = '';
    let stderrBuf = '';

    let attemptSettled = false;
    const settleAttempt = (ok: boolean, detail: string): void => {
      if (attemptSettled) {
        return;
      }
      attemptSettled = true;
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      }
      if (ok) {
        this.onAttemptSuccess();
      } else {
        this.onAttemptFailure(kind, detail);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (child !== this.child) {
        return;
      }
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) {
          continue;
        }
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          // Not JSON — the gateway's own stray prose or a log line. Silently skip.
          continue;
        }
        this.handleEvent(event, settleAttempt);
      }
      // After consuming every complete line, stdoutBuf holds only an unterminated tail. Cap
      // it: a child streaming a huge line with no newline must not grow host memory (L2).
      if (stdoutBuf.length > MAX_LINE_BYTES) {
        stdoutBuf = '';
        this.pushStderr('dropped an over-long stream line (> 1MB, no newline)');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (child !== this.child) {
        return;
      }
      stderrBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        this.pushStderr(stderrBuf.slice(0, nl).replace(/\r$/, ''));
        stderrBuf = stderrBuf.slice(nl + 1);
      }
      if (stderrBuf.length > MAX_LINE_BYTES) {
        stderrBuf = '';
        this.pushStderr('dropped an over-long stream line (> 1MB, no newline)');
      }
    });

    // 'exit' (not 'close') is the authoritative "process is gone" signal: a grandchild
    // holding the stdout pipe can defer 'close' forever, but 'exit' fires on process death
    // regardless. The identity guard makes a superseded child's exit a no-op.
    child.on('exit', (code, signal) => {
      if (child !== this.child) {
        return;
      }
      if (stderrBuf.trim()) {
        this.pushStderr(stderrBuf.trim());
        stderrBuf = '';
      }
      const detail = `gateway process exited (code=${code}, signal=${signal})`;
      if (this._state === 'stopped') {
        // Expected teardown — hand off to the stop() waiter.
        this.child = undefined;
        this.onChildGone();
      } else if (!attemptSettled) {
        // Died before READY: counts as this attempt failing.
        settleAttempt(false, detail);
      } else {
        // A ready gateway crashed. (A FAILED attempt would have cleared this.child, so
        // reaching here with attemptSettled true means the attempt had succeeded.)
        this.handleCrash(detail);
      }
    });

    child.on('error', (err) => {
      if (child !== this.child) {
        return;
      }
      const detail = `failed to spawn gateway (${err.message})`;
      if (this._state === 'stopped') {
        this.child = undefined;
        this.onChildGone();
      } else if (!attemptSettled) {
        settleAttempt(false, detail);
      } else {
        this.handleCrash(detail);
      }
    });

    // Ready deadline. unref()'d so a wedged startup can never be the sole reason the host
    // process stays alive; the child's own pipes keep the loop live meanwhile.
    this.readyTimer = setTimeout(() => {
      settleAttempt(false, `no READY within ${GATEWAY_READY_TIMEOUT_MS}ms`);
    }, GATEWAY_READY_TIMEOUT_MS);
    this.readyTimer.unref?.();

    // stdout parsing is wired above BEFORE we write anything, so the very first turn's
    // output cannot be missed. The standing prompt is turn 1; stdin is then held open for
    // the child's whole life (that open pipe is what keeps the session running).
    if (!this.writeUserTurn(gatewayStandingPrompt(this.name, this.nonce))) {
      settleAttempt(false, 'failed to write standing prompt to gateway stdin');
    }
  }

  /**
   * Process one parsed stream-json event: run STRICT READY detection while starting, resolve
   * any pending relay whose RELAY_RESULT this assistant text carries, and buffer inbound
   * cross-session messages. Kept total (never throws) so a hostile event cannot kill the
   * stdout loop.
   */
  private handleEvent(event: unknown, settle: (ok: boolean, detail: string) => void): void {
    if (this._state === 'starting') {
      const texts = assistantTexts(event);
      if (texts.length > 0) {
        this.startAssistantTail = texts[texts.length - 1];
      }
      if (assistantHasReady(event)) {
        // READY is the ONLY success signal — the standing prompt's single-word reply.
        settle(true, 'ready');
      } else if (isResultEvent(event)) {
        // The first turn terminated with no READY. This is how an unauthenticated or
        // off-script session presents (e.g. "Not logged in · Please run /login"): it must
        // fail the capability probe loudly, never be masked as ready (the old result-event
        // fallback did exactly that — scenario-B, 2026-08-10). settle(false) routes through
        // onAttemptFailure, which kills the child and either rejects start() (initial) or
        // advances the restart backoff exactly like a crash-before-ready.
        settle(
          false,
          `gateway first turn completed without READY — last assistant text: ${JSON.stringify(
            this.startAssistantTail,
          )}`,
        );
      }
    }
    // Both RELAY_RESULT (relay outcomes) and INBOUND (echoed received messages) arrive
    // as lines in the gateway model's ASSISTANT text — a `-p` stream never emits inbound
    // cross-session messages as `user` events (verified 2026-08-10; see contract
    // INBOUND_PREFIX). So both are parsed from the same assistant-text stream.
    for (const text of assistantTexts(event)) {
      const result = parseRelayResult(text, this.nonce);
      if (result) {
        this.resolvePending(result);
      }
      const inbound = parseInboundLines(text, this.nonce);
      if (inbound.length > 0) {
        const receivedAt = Date.now();
        for (const msg of inbound) {
          this.pushInbound({ ...msg, receivedAt });
        }
      }
    }
  }

  /** An attempt reached READY: clear the backoff, go ready, and unblock start() if waiting. */
  private onAttemptSuccess(): void {
    this.restartIndex = 0;
    this._setState('ready');
    const resolve = this.startResolve;
    this.startPromise = undefined;
    this.startResolve = undefined;
    this.startReject = undefined;
    resolve?.();
  }

  /**
   * An attempt failed to reach READY (timeout, early exit, spawn error, or a failed initial
   * write). The initial attempt rejects the caller's start() with capability_failed and
   * stops there — bring-up is the caller's to own. A restart attempt advances the backoff.
   * Either way the dead child is force-killed first so nothing is left running.
   */
  private onAttemptFailure(kind: AttemptKind, detail: string): void {
    this.killChild();
    if (kind === 'initial') {
      this._setState('down');
      const reject = this.startReject;
      this.startPromise = undefined;
      this.startResolve = undefined;
      this.startReject = undefined;
      reject?.(new Error(meshError('capability_failed', this.decorate(detail))));
      return;
    }
    this.rejectAllPending(meshError('gateway_down', this.decorate(detail)));
    this.scheduleRestart();
  }

  /** A previously-ready child died. Fail in-flight relays and begin the restart backoff. */
  private handleCrash(detail: string): void {
    this.child = undefined;
    this._setState('down');
    this.rejectAllPending(meshError('gateway_down', this.decorate(detail)));
    this.scheduleRestart();
  }

  /**
   * Schedule the next restart per GATEWAY_RESTART_BACKOFF_MS (1s, 5s, 15s). After the last
   * entry the gateway stays 'down' permanently until stop(). restartIndex is reset to 0 by
   * a successful attempt, so a fresh crash always restarts from the shortest delay. The
   * timer is unref()'d — a pending restart must never hold the host process open on its own.
   */
  private scheduleRestart(): void {
    if (this._state === 'stopped') {
      return;
    }
    this._setState('down');
    if (this.restartIndex >= GATEWAY_RESTART_BACKOFF_MS.length) {
      // Exhausted the schedule — stay down until stop() (or a new instance) intervenes.
      return;
    }
    const delay = GATEWAY_RESTART_BACKOFF_MS[this.restartIndex];
    this.restartIndex++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this._state === 'stopped') {
        return;
      }
      this.launch('restart');
    }, delay);
    this.restartTimer.unref?.();
  }

  /* ----------------------------------------------------------------------- *
   * Inbound buffer + waiter wakeups
   * ----------------------------------------------------------------------- */

  private pushInbound(msg: InboundMeshMessage): void {
    this.inbound.push(msg);
    if (this.inbound.length > INBOUND_BUFFER_MAX) {
      // Drop oldest to honor the cap.
      this.inbound.splice(0, this.inbound.length - INBOUND_BUFFER_MAX);
    }
    // Wake parked receivers FIFO, each taking up to its own maxMessages.
    while (this.waiters.length > 0 && this.inbound.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(this.takeInbound(waiter.maxMessages));
    }
  }

  /** Remove and return up to `max` messages from the front of the buffer (FIFO). */
  private takeInbound(max: number): InboundMeshMessage[] {
    return this.inbound.splice(0, Math.max(0, max));
  }

  private releaseAllWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
  }

  /* ----------------------------------------------------------------------- *
   * Pending relay bookkeeping
   * ----------------------------------------------------------------------- */

  private resolvePending(result: RelayResult): void {
    const pending = this.pending.get(result.id);
    if (!pending) {
      return;
    }
    this.pending.delete(result.id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private rejectAllPending(message: string): void {
    if (this.pending.size === 0) {
      return;
    }
    const err = new Error(message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /* ----------------------------------------------------------------------- *
   * stop() internals
   * ----------------------------------------------------------------------- */

  private doStop(): Promise<void> {
    this._setState('stopped');
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    // A start() in flight can never complete now.
    if (this.startReject) {
      const reject = this.startReject;
      this.startPromise = undefined;
      this.startResolve = undefined;
      this.startReject = undefined;
      reject(new Error(meshError('gateway_down', 'gateway stopped during startup')));
    }
    this.rejectAllPending(meshError('gateway_down', 'gateway stopped'));
    this.releaseAllWaiters();

    const child = this.child;
    if (!child) {
      this.onChildGone = NOOP;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      let reapTimer: NodeJS.Timeout | undefined;
      let done = false;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (reapTimer) {
          clearTimeout(reapTimer);
        }
        this.onChildGone = NOOP;
        // Force any grandchild-held pipe closed so the event loop is not pinned on a
        // process we have already declared gone.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        try {
          child.unref();
        } catch {
          // already reaped — nothing to unref
        }
        this.child = undefined;
        resolve();
      };
      // The exit handler (state === 'stopped' branch) calls this once the child is gone.
      this.onChildGone = finish;

      try {
        child.stdin?.end();
      } catch {
        // stdin already closed
      }
      // The child may already have exited between the buffer check and here.
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead — the exit handler (if any) or the reap timer settles us
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // gone between SIGTERM and now
        }
        reapTimer = setTimeout(finish, STOP_REAP_GRACE_MS);
        reapTimer.unref?.();
      }, STOP_KILL_GRACE_MS);
      killTimer.unref?.();
    });
  }

  /* ----------------------------------------------------------------------- *
   * Small shared helpers
   * ----------------------------------------------------------------------- */

  /** Write one user turn to the child's stdin. Returns false when the pipe is unwritable. */
  private writeUserTurn(content: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) {
      return false;
    }
    try {
      return stdin.write(userTurnLine(content));
    } catch {
      return false;
    }
  }

  /**
   * Force-kill and forget the current child. Used on failed attempts (where a graceful
   * teardown buys nothing); stop() runs its own SIGTERM→SIGKILL sequence instead. Clearing
   * this.child first means the killed child's eventual 'exit' is ignored by the identity
   * guard, so it can never re-enter the crash/restart path.
   */
  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) {
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }

  private pushStderr(line: string): void {
    if (!line) {
      return;
    }
    this.stderrRing.push(line);
    if (this.stderrRing.length > STDERR_RING_MAX) {
      this.stderrRing.splice(0, this.stderrRing.length - STDERR_RING_MAX);
    }
  }

  /** Append the retained stderr tail to an error detail so field failures are diagnosable. */
  private decorate(detail: string): string {
    const tail = this.stderrRing.join('\n').trim();
    return tail ? `${detail}\n--- gateway stderr tail ---\n${tail}` : detail;
  }

  private _setState(state: GatewayState): void {
    if (this._state === state) {
      return;
    }
    this._state = state;
    try {
      this.deps.onStateChange?.(state);
    } catch {
      // A misbehaving observer must never break the gateway's own state machine.
    }
  }
}

/** Factory mirror of `new GatewayManager(deps)` for call sites that prefer it. */
export function createGateway(deps: GatewayDeps): IGatewayManager {
  return new GatewayManager(deps);
}
