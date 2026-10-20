import * as net from 'net';
import * as path from 'path';
import { LINE_MAX_BYTES, METHOD, type AnyHelloParams, type HelloResult } from './host-protocol';

/**
 * mcp/host-client — the CLIENT side of a dispatch host's socket (contract-2.0-fixes.md §15.4,
 * team contract §7.6): connect, frame lines, say hello, send requests and match their answers,
 * hear notifications. Factored out of the `cco` command (mcp/cli.ts) so that the three clients of
 * a host speak the socket ONE way:
 *
 *   - `cco` itself, which uses the line layer (HostConnection) and keeps its own request ids
 *     (its one request is built — and measured — before it connects);
 *   - the team MCP server `cli.js --team-mcp` (team contract §3.7), a member connection that lives
 *     as long as its turn and forwards every tools/call (HostClient);
 *   - Gilde's sidecar, which VENDORS this file together with host-protocol.ts (team contract §8:
 *     two files, kept equal by a copy test in both repositories) for its read-only observer
 *     connection.
 *
 * Hence the rule for this file: Node built-ins and ./host-protocol only — not even a type from
 * anywhere else of this repository — and nothing here may throw into the event loop. Every
 * handler a caller passes is called from a socket event; a caller that cannot let an exception
 * escape wraps its handlers itself (cli.ts does, with its `guarded`).
 *
 * WHAT IT DOES NOT DO. It interprets no answer beyond the JSON-RPC envelope and the hello's
 * identity fields: what a result means is the caller's. It never retries and never reconnects —
 * the policies differ per client (cco starts a host; the team server reconnects once, §3.7;
 * Gilde re-reads the run directory) and live in the callers.
 */

/* ------------------------------------------------------------------------- *
 * The line layer
 * ------------------------------------------------------------------------- */

/**
 * How a connection ended, as its one onEnd call says it:
 *  - `closed`: the socket closed (either side, an end or a destroy);
 *  - `error`: the socket reported an error first — `code` its errno when it carries one;
 *  - `line-too-long`: the host sent a line longer than LINE_MAX_BYTES, which is a protocol
 *    failure of the host, not of the network.
 */
export type HostConnectionEnd =
  | { kind: 'closed' }
  | { kind: 'error'; code: string | undefined; error: unknown }
  | { kind: 'line-too-long' };

/** The errno code of a caught value (`ENOENT`, …), or undefined when it carries none. */
function errnoOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One connection to a host: newline-delimited JSON-RPC 2.0, UTF-8, one message per line. A line
 * is split on the newline BYTE (which never occurs inside a multi-byte UTF-8 sequence) before it
 * is decoded, and may be at most LINE_MAX_BYTES; a longer one ends the connection
 * (`line-too-long`). A line that is not one JSON object is skipped, as the host's own transport
 * skips one. Messages that arrive before anybody listens are dropped; an end that comes before
 * anybody listens is told to the first listener, on the next turn of the loop. onEnd is called
 * at most once.
 */
export class HostConnection {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private gone = false;
  /** How the connection ended, once it has — kept for a listener that comes late. */
  private ending: HostConnectionEnd | undefined;
  private endTold = false;
  private onMessage: (message: Record<string, unknown>) => void = () => undefined;
  private onEnd: ((end: HostConnectionEnd) => void) | undefined;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.take(chunk));
    socket.on('error', (err: Error) => this.end({ kind: 'error', code: errnoOf(err), error: err }));
    socket.on('close', () => this.end({ kind: 'closed' }));
  }

  /**
   * Connect to `socketPath`: the connection, or the errno of the failure — ENOENT and
   * ECONNREFUSED mean "nobody listens there"; ETIMEDOUT is `timeoutMs`'s own; ECANCELED is
   * `signal`'s. Never rejects.
   */
  static open(
    socketPath: string,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ connection: HostConnection } | { code: string }> {
    return new Promise((resolve) => {
      if (opts.signal?.aborted === true) {
        resolve({ code: 'ECANCELED' });
        return;
      }
      let settled = false;
      let socket: net.Socket;
      try {
        socket = net.createConnection({ path: socketPath });
      } catch (err) {
        resolve({ code: errnoOf(err) ?? 'ECONNREFUSED' });
        return;
      }
      const settle = (value: { connection: HostConnection } | { code: string }): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        socket.removeListener('error', onError);
        resolve(value);
      };
      const onAbort = (): void => {
        socket.destroy();
        settle({ code: 'ECANCELED' });
      };
      const onError = (err: Error): void => {
        socket.destroy();
        settle({ code: errnoOf(err) ?? 'ECONNREFUSED' });
      };
      const timer = setTimeout(() => {
        socket.destroy();
        settle({ code: 'ETIMEDOUT' });
      }, Math.max(1, opts.timeoutMs));
      opts.signal?.addEventListener('abort', onAbort);
      socket.on('error', onError);
      socket.once('connect', () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settle({ connection: new HostConnection(socket) });
      });
    });
  }

  /** Who hears what arrives from now on. An end that already happened is told on the next turn of the loop. */
  listen(onMessage: (message: Record<string, unknown>) => void, onEnd: (end: HostConnectionEnd) => void): void {
    this.onMessage = onMessage;
    this.onEnd = onEnd;
    if (this.ending !== undefined && !this.endTold) {
      const ending = this.ending;
      setImmediate(() => this.tellEnd(ending));
    }
  }

  /** Whether the connection has ended (or was closed by this side). */
  get closed(): boolean {
    return this.gone;
  }

  /**
   * One message as one line. A connection that is gone takes nothing. False when the message
   * cannot be written as JSON (a cycle, a BigInt) — nothing is sent then. Never throws.
   */
  write(message: Record<string, unknown>): boolean {
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      return false;
    }
    this.writeLine(line);
    return true;
  }

  /** One line, its newline included, as it is. A connection that is gone takes nothing. Never throws. */
  writeLine(line: string): void {
    if (this.gone) {
      return;
    }
    try {
      this.socket.write(line);
    } catch {
      // the 'error' / 'close' events say the rest
    }
  }

  /** Close it, from this side. No onEnd follows a close the caller made. Closing is never a cancel (§15.4). */
  close(): void {
    this.gone = true;
    this.endTold = true;
    try {
      this.socket.destroy();
    } catch {
      // gone already
    }
  }

  private end(ending: HostConnectionEnd): void {
    if (this.gone) {
      return;
    }
    this.gone = true;
    this.ending = ending;
    try {
      this.socket.destroy();
    } catch {
      // gone already
    }
    if (this.onEnd !== undefined) {
      this.tellEnd(ending);
    }
  }

  private tellEnd(ending: HostConnectionEnd): void {
    if (this.endTold || this.onEnd === undefined) {
      return;
    }
    this.endTold = true;
    this.onEnd(ending);
  }

  private take(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0 && !this.gone) {
      const newline = rest.indexOf(0x0a);
      if (newline === -1) {
        this.buffered += rest.length;
        if (this.buffered > LINE_MAX_BYTES) {
          this.end({ kind: 'line-too-long' });
          return;
        }
        this.chunks.push(rest);
        return;
      }
      const head = rest.subarray(0, newline);
      rest = rest.subarray(newline + 1);
      if (this.buffered + head.length > LINE_MAX_BYTES) {
        this.end({ kind: 'line-too-long' });
        return;
      }
      const line = this.chunks.length === 0 ? head : Buffer.concat([...this.chunks, head]);
      this.chunks = [];
      this.buffered = 0;
      this.deliver(line);
    }
  }

  private deliver(line: Buffer): void {
    const text = line.toString('utf8').trim();
    if (text === '') {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (isPlainObject(message)) {
      this.onMessage(message);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The hello's answer
 * ------------------------------------------------------------------------- */

/**
 * A hello result a client can use (§15.4), by value — or undefined. Its `protocol` is the
 * caller's to judge. `features` (team contract §7.6) is kept when it is an array: its strings,
 * at most 32 of 64 characters each; a host of an earlier build sends none, which reads as "no
 * features" (HelloResult.features). The other fields of an observer's or member's hello result
 * (TeamHostSide.hello's `result`) are the caller's to read from the raw result.
 */
export function helloResultOf(value: unknown): HelloResult | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const { protocol, hostPid, hostStartedAt, workspace, serverHash, dataRoot, features } = value;
  if (
    typeof protocol !== 'number' ||
    typeof hostPid !== 'number' ||
    !Number.isInteger(hostPid) ||
    hostPid <= 0 ||
    typeof hostStartedAt !== 'number' ||
    !Number.isFinite(hostStartedAt) ||
    typeof workspace !== 'string' ||
    !path.isAbsolute(workspace) ||
    typeof serverHash !== 'string' ||
    typeof dataRoot !== 'string' ||
    !path.isAbsolute(dataRoot)
  ) {
    return undefined;
  }
  const result: HelloResult = { protocol, hostPid, hostStartedAt, workspace, serverHash, dataRoot };
  if (Array.isArray(features)) {
    result.features = features
      .filter((f: unknown): f is string => typeof f === 'string' && f.length <= 64)
      .slice(0, 32);
  }
  return result;
}

/** The `{code, message}` of a JSON-RPC error member, by value (the message as the host wrote it). */
function rpcErrorOf(value: unknown): { code: number | undefined; message: string } {
  if (!isPlainObject(value)) {
    return { code: undefined, message: 'no description was given' };
  }
  const code = typeof value.code === 'number' ? value.code : undefined;
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? value.message : 'no description was given';
  return { code, message };
}

/* ------------------------------------------------------------------------- *
 * The request layer
 * ------------------------------------------------------------------------- */

/** What became of one request. */
export type HostAnswer =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; code: number | undefined; message: string }
  /** The connection ended before the answer came. */
  | { kind: 'gone'; end: HostConnectionEnd }
  /** No answer within the request's own `timeoutMs`. */
  | { kind: 'timeout' };

/**
 * Requests and their answers over one HostConnection: ids minted here (1, 2, …), each answer
 * matched to its request, every other message with a `method` handed to the notification
 * listener. A request whose connection ends is answered `gone`; one with a `timeoutMs` that
 * passes is answered `timeout` (and its late answer, if one comes, is dropped). Never throws.
 */
export class HostClient {
  private nextId = 1;
  private readonly pending = new Map<number, { settle: (answer: HostAnswer) => void }>();
  private ended: HostConnectionEnd | undefined;
  private onNotification: (method: string, params: unknown) => void = () => undefined;
  private onEnd: (end: HostConnectionEnd) => void = () => undefined;

  constructor(private readonly connection: HostConnection) {
    connection.listen(
      (message) => this.take(message),
      (end) => this.end(end),
    );
  }

  /** Who hears the host's notifications, and the end of the connection, from now on. */
  listen(onNotification: (method: string, params: unknown) => void, onEnd: (end: HostConnectionEnd) => void): void {
    this.onNotification = onNotification;
    this.onEnd = onEnd;
    if (this.ended !== undefined) {
      const ended = this.ended;
      setImmediate(() => onEnd(ended));
    }
  }

  /** Whether the connection has ended or been closed. */
  get closed(): boolean {
    return this.connection.closed;
  }

  /** Send one request; resolves with what became of it. Never rejects. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<HostAnswer> {
    return new Promise((resolve) => {
      if (this.ended !== undefined || this.connection.closed) {
        resolve({ kind: 'gone', end: this.ended ?? { kind: 'closed' } });
        return;
      }
      const id = this.nextId++;
      let timer: NodeJS.Timeout | undefined;
      const settle = (answer: HostAnswer): void => {
        if (!this.pending.delete(id)) {
          return;
        }
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(answer);
      };
      this.pending.set(id, { settle });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => settle({ kind: 'timeout' }), Math.max(1, timeoutMs));
      }
      if (!this.connection.write({ jsonrpc: '2.0', id, method, params })) {
        settle({ kind: 'error', code: undefined, message: 'the request could not be written as JSON' });
      }
    });
  }

  /** Close the connection; every request still waiting is answered `gone`. */
  close(): void {
    this.connection.close();
    this.end({ kind: 'closed' });
  }

  private take(message: Record<string, unknown>): void {
    const { id, method } = message;
    if (typeof method === 'string') {
      if (id === undefined) {
        this.onNotification(method, message.params);
      }
      // A request FROM the host is not part of this protocol; it is not answered.
      return;
    }
    if (typeof id !== 'number') {
      return;
    }
    const waiting = this.pending.get(id);
    if (waiting === undefined) {
      return;
    }
    if (message.error !== undefined && message.error !== null) {
      waiting.settle({ kind: 'error', ...rpcErrorOf(message.error) });
      return;
    }
    waiting.settle({ kind: 'result', result: message.result });
  }

  private end(end: HostConnectionEnd): void {
    if (this.ended !== undefined) {
      return;
    }
    this.ended = end;
    for (const waiting of [...this.pending.values()]) {
      waiting.settle({ kind: 'gone', end });
    }
    this.onEnd(end);
  }
}

/** What connecting and greeting found. */
export type HostHello =
  /** Greeted: the client, the host's identity, and the raw result (an observer's or member's hello adds fields of its own). */
  | { kind: 'ok'; client: HostClient; hello: HelloResult; raw: Record<string, unknown> }
  /** Nothing could be connected to — `code` is HostConnection.open's. */
  | { kind: 'unreachable'; code: string }
  /** The host answered the hello with a JSON-RPC error (-32010, -32011, -32012, -32013, …); the connection is closed. */
  | { kind: 'refused'; code: number | undefined; message: string }
  /** The connection ended, or nothing answered within `helloTimeoutMs`, or the answer was not a hello result. */
  | { kind: 'gone' }
  | { kind: 'timeout' }
  | { kind: 'invalid' };

/**
 * Connect to a host's socket and greet it with `params` (a session's, an observer's or a
 * member's hello — host-protocol AnyHelloParams). On anything but `ok` the connection is closed.
 * Never rejects.
 */
export async function connectHost(
  socketPath: string,
  params: AnyHelloParams,
  opts: { connectTimeoutMs: number; helloTimeoutMs: number; signal?: AbortSignal },
): Promise<HostHello> {
  const opened = await HostConnection.open(socketPath, { timeoutMs: opts.connectTimeoutMs, signal: opts.signal });
  if ('code' in opened) {
    return { kind: 'unreachable', code: opened.code };
  }
  const client = new HostClient(opened.connection);
  const answer = await client.request(METHOD.hello, params, opts.helloTimeoutMs);
  switch (answer.kind) {
    case 'result': {
      const hello = helloResultOf(answer.result);
      if (hello === undefined || !isPlainObject(answer.result)) {
        client.close();
        return { kind: 'invalid' };
      }
      return { kind: 'ok', client, hello, raw: answer.result };
    }
    case 'error':
      client.close();
      return { kind: 'refused', code: answer.code, message: answer.message };
    case 'timeout':
      client.close();
      return { kind: 'timeout' };
    case 'gone':
      client.close();
      return { kind: 'gone' };
  }
}
