/**
 * The per-task result token: how a result file proves it was written by the worker (or the
 * supervisor) the dispatcher started for THAT task, and not by a sibling task or by something
 * that merely knows the task id.
 *
 * What is kept where:
 *  - the TOKEN itself: in the dispatching server's memory; for a detached one-shot task in the
 *    supervisor's memory (its spec file is unlinked as soon as it is read); for a session
 *    worker in the first line of the task file inside that task's own io directory. NEVER on
 *    a command line (any local user can read `ps`) and never in the task log.
 *  - its SHA-256: on the task's RUNNING events in the task log, so a later server session can
 *    still check a result file it did not dispatch. Reading the log does not yield a token.
 *
 * What the gate does NOT defend: a process running as the same user that reads a session
 * worker's task file, or the memory of the server or supervisor. Nothing on disk can.
 *
 * Leaf module: Node built-ins only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Shape of a token: lowercase hex, 16–128 digits (new ones are 32). */
export const IO_TOKEN_PATTERN = /^[0-9a-f]{16,128}$/;

/** Shape of a recorded digest: SHA-256 as lowercase hex. */
export const IO_TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** A fresh token: 128 random bits as 32 hex digits. */
export function newIoToken(): string {
  return randomBytes(16).toString('hex');
}

/** The value to record in the task log for `token`. */
export function ioTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** What a task's history recorded for its token: the digest (current) or the token (legacy). */
export interface RecordedIoToken {
  /** `ioTokenSha256` / `detachIoTokenSha256` of the task's FIRST event that carries one. */
  sha256?: unknown;
  /** `ioToken` / `detachIoToken` of an event written before digests were recorded. */
  legacy?: unknown;
}

/** Did the history record anything this module can check a presented token against? */
export function hasRecordedIoToken(recorded: RecordedIoToken): boolean {
  return (
    (typeof recorded.sha256 === 'string' && IO_TOKEN_DIGEST_PATTERN.test(recorded.sha256)) ||
    (typeof recorded.legacy === 'string' && IO_TOKEN_PATTERN.test(recorded.legacy))
  );
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Does `presented` (the `token` member of a result file) prove ownership against what the
 * task's history recorded? False for anything that is not a well-formed token, and false when
 * nothing checkable was recorded — a caller that wants "no token recorded ⇒ judge by shape
 * alone" (a dispatch older than tokens) must ask `hasRecordedIoToken` first and decide that
 * itself; this function never says yes without a comparison.
 *
 * A well-formed digest wins over a legacy value: a history holding both was written by a build
 * that knew digests, and the plain field in it is then not ours.
 */
export function ioTokenProves(recorded: RecordedIoToken, presented: unknown): boolean {
  if (typeof presented !== 'string' || !IO_TOKEN_PATTERN.test(presented)) {
    return false;
  }
  if (typeof recorded.sha256 === 'string' && IO_TOKEN_DIGEST_PATTERN.test(recorded.sha256)) {
    return sameHex(ioTokenDigest(presented), recorded.sha256);
  }
  if (typeof recorded.legacy === 'string' && IO_TOKEN_PATTERN.test(recorded.legacy)) {
    return sameHex(presented, recorded.legacy);
  }
  return false;
}
