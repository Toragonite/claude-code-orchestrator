import { randomBytes } from 'crypto';

/**
 * Serialize a value for embedding inside an inline <script> block. JSON alone
 * is not safe there: a "</script>" sequence inside any string would end the
 * script element, and U+2028/U+2029 are literal line terminators in JS source.
 * Localized strings are user-visible text from translation bundles, so this
 * runs on every injected strings object.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * A fresh Content-Security-Policy nonce: 128 random bits, hex-encoded so it needs no escaping
 * in an HTML attribute or in the policy string. One per rendered document — a nonce that is
 * reused across renders is a constant an injected script could carry.
 */
export function makeNonce(): string {
  return randomBytes(16).toString('hex');
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for a webview's STATIC html — element content or a quoted attribute, single or
 * double. Localized strings are translation-bundle input and a resource URI is built from an
 * install path, so neither is trusted to be free of markup characters.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Bounds what a webview page can make its host do, however many messages it sends.
 *
 * A page is a document: whatever runs in it can post a message in a loop, and several kinds of
 * message have an effect outside the page — a terminal opens, a process is started, a modal
 * dialog takes over the window. So each such message is first put to `admit`, with the LANE it
 * belongs to (the caller's grouping: every terminal-opening message shares one lane, so the
 * bound is on terminals, not on one button):
 *
 *  - a lane admits one action per `intervalMs`; a message that arrives sooner is DROPPED — not
 *    queued, so a burst cannot be replayed later — and `admit` returns undefined;
 *  - an `exclusive` lane also admits nothing while its previous action is still running (its
 *    `finished` function not called yet): for actions that end in a dialog, so that dialogs
 *    cannot pile up behind the one that is open. An action that never reports back stops
 *    holding its lane after `EXCLUSIVE_HOLD_MAX_MS`.
 *
 * `onBurst` is called for the FIRST message a lane drops after one it admitted — once per
 * burst, not once per dropped message — which is where the caller tells the page.
 *
 * One limiter per panel. No timers and nothing to dispose.
 */
export interface PageActionLimiter {
  /**
   * Ask to carry out one action in `lane`. Undefined: drop it. Otherwise the function to call
   * when the action has finished (it matters only for an exclusive lane; calling it twice, or
   * not at all for a lane that is not exclusive, is harmless).
   */
  admit(lane: string, exclusive?: boolean): (() => void) | undefined;
}

/** The longest an unfinished action keeps an exclusive lane closed. */
const EXCLUSIVE_HOLD_MAX_MS = 2 * 60 * 1000;

export function createPageActionLimiter(options: {
  intervalMs: number;
  onBurst: (lane: string) => void;
  /** The clock, for a test. */
  now?: () => number;
}): PageActionLimiter {
  // Read through `Date` at each call, not captured: a clock replaced after the panel opened
  // (a test's) is the clock that counts.
  const now = options.now ?? (() => Date.now());
  const lanes = new Map<string, { admittedAt: number; running: object | undefined; noticed: boolean }>();
  return {
    admit(lane, exclusive = false) {
      const at = now();
      let state = lanes.get(lane);
      if (state !== undefined) {
        const since = at - state.admittedAt;
        // A clock that went backwards must not close a lane for good: `since < 0` admits.
        const tooSoon = since >= 0 && since < options.intervalMs;
        const held = state.running !== undefined && since >= 0 && since < EXCLUSIVE_HOLD_MAX_MS;
        if (tooSoon || held) {
          if (!state.noticed) {
            state.noticed = true;
            try {
              options.onBurst(lane);
            } catch {
              // telling the page is best-effort; the drop stands either way
            }
          }
          return undefined;
        }
      } else {
        state = { admittedAt: at, running: undefined, noticed: false };
        lanes.set(lane, state);
      }
      const run = {};
      const admitted = state;
      admitted.admittedAt = at;
      admitted.noticed = false;
      admitted.running = exclusive ? run : undefined;
      return () => {
        // Only the action that holds the lane releases it — a late call from one whose hold
        // already ran out must not release its successor's.
        if (admitted.running === run) {
          admitted.running = undefined;
        }
      };
    },
  };
}
