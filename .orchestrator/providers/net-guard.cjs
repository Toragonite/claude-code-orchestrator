// net-guard.cjs — preloaded (NODE_OPTIONS=--require) into every Node process the providers
// harness starts: the dispatch server, the detach supervisor, `provider-cli.js`, the fakes.
//
// It exists because the Codex adapter's `quota()` calls the vendor's usage endpoint with the
// global `fetch`, authenticated with whatever bearer token it finds in `<CODEX_HOME>/auth.json`.
// A harness must never let that request leave the machine. So this file:
//
//   1. replaces the global `fetch` with a stub driven by the JSON file CCO_PROVIDERS_NET names
//      (re-read on every call, so a probe can change the answer between two calls):
//        fetch.mode "deny" (default) → rejects like a network failure ("fetch failed")
//        fetch.mode "snapshot"       → 200 with fetch.body as JSON
//        fetch.mode "http"           → fetch.status with fetch.body as JSON
//        fetch.mode "hang"           → never settles (rejects only when the caller aborts)
//      A URL on the loopback interface is passed to the real fetch untouched.
//   2. refuses every non-loopback TCP connection attempt (net.Socket.prototype.connect) with
//      ECONNREFUSED, whatever API it came from — the backstop for a request that does not go
//      through `fetch` at all.
//
// Every stubbed fetch and every refused connection is appended to the config's `logFile`.
// The Authorization header's VALUE is never logged — only whether one was sent and whether
// it matched `expectBearer` from the config.
//
// This is the `fetchFn` seam of the adapter, reached from outside: the bundle under test is
// not modified, it simply finds this `fetch` where it expected the global one.

'use strict';

const fs = require('fs');
const net = require('net');

const CONFIG_FILE = process.env.CCO_PROVIDERS_NET;

function readConfig() {
  if (typeof CONFIG_FILE !== 'string' || CONFIG_FILE === '') {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function log(record) {
  const cfg = readConfig();
  if (typeof cfg.logFile !== 'string') {
    return;
  }
  try {
    fs.appendFileSync(cfg.logFile, JSON.stringify({ ts: Date.now(), pid: process.pid, script: process.argv[1], ...record }) + '\n');
  } catch {
    // evidence only
  }
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') {
    return false;
  }
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function headerValue(headers, name) {
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }
  for (const [k, v] of Array.isArray(headers) ? headers : Object.entries(headers)) {
    if (String(k).toLowerCase() === name) {
      return String(v);
    }
  }
  return undefined;
}

const realFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

async function guardedFetch(input, init) {
  const url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input);
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = undefined;
  }
  if (isLoopbackHost(host) && realFetch) {
    return realFetch(input, init);
  }
  const cfg = readConfig();
  const stub = cfg.fetch && typeof cfg.fetch === 'object' ? cfg.fetch : {};
  const mode = typeof stub.mode === 'string' ? stub.mode : 'deny';
  const authorization = headerValue((init && init.headers) || (input && input.headers), 'authorization');
  const record = {
    kind: 'fetch',
    url,
    mode,
    authorization: authorization === undefined ? 'absent' : 'present',
    bearerMatches: typeof cfg.expectBearer === 'string' ? authorization === `Bearer ${cfg.expectBearer}` : undefined,
    accountIdHeader: headerValue((init && init.headers) || (input && input.headers), 'chatgpt-account-id') !== undefined,
  };
  log(record);
  const signal = init && init.signal;
  if (mode === 'snapshot' || mode === 'http') {
    const status = mode === 'snapshot' ? 200 : Number(stub.status) || 500;
    return new Response(JSON.stringify(stub.body === undefined ? {} : stub.body), { status, headers: { 'content-type': 'application/json' } });
  }
  if (mode === 'hang') {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
      if (signal && signal.aborted) {
        abort();
      } else if (signal) {
        signal.addEventListener('abort', abort, { once: true });
      }
    });
  }
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED — network access is disabled by the providers harness'), { code: 'ECONNREFUSED' });
  throw err;
}

globalThis.fetch = guardedFetch;

/* The target of a Socket#connect call, in any of its argument forms. */
function connectTarget(args) {
  let first = args[0];
  // The internal normalized form: [options, callback] passed as ONE array argument.
  if (Array.isArray(first)) {
    first = first[0];
  }
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') {
      return { path: first.path };
    }
    return { host: typeof first.host === 'string' ? first.host : 'localhost', port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return { path: first };
  }
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let target;
  try {
    target = connectTarget(args);
  } catch {
    target = { host: 'unknown' };
  }
  if (target.path !== undefined || isLoopbackHost(target.host)) {
    return realConnect.apply(this, args);
  }
  log({ kind: 'connect', host: target.host, port: target.port, outcome: 'refused' });
  const err = Object.assign(new Error(`connect ECONNREFUSED ${target.host}:${target.port} — network access is disabled by the providers harness`), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: target.host,
    port: target.port,
  });
  process.nextTick(() => this.destroy(err));
  return this;
};
