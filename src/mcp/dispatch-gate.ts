/**
 * dispatch-gate — how many dispatched workers ONE server process runs at the same moment.
 *
 * WHY IT EXISTS. A dispatch is a process: a `claude -p` child, another vendor's CLI, or a detach
 * supervisor that starts one. `dispatch_tasks` starts every task of a batch at once and nothing
 * limits how many batches a client sends, so without a ceiling the number of agent CLIs alive at
 * the same time is whatever the client asked for — each of them a Node process of a few hundred
 * megabytes with its own model session, all billing at once. The ceiling is the operator's
 * (`Registry.maxConcurrentDispatches`); this module is the one place it is enforced, and a
 * dispatch that cannot get a slot here does not start.
 *
 * WHO TAKES A SLOT. Every one-shot dispatch — a Claude Code worker or another vendor's — for the
 * whole of its attempt loop, failover attempts included, and a detached dispatch for as long as
 * its supervisor's outcome is awaited. Session-worker (`--bg`) dispatches do NOT: they have their
 * own ceiling (`meshMaxLiveWorkers`), which refuses instead of queueing.
 *
 * WHAT IT IS. A counting semaphore with a FIFO queue, in module state — so "one gate per server
 * process" is a property of the module system, not of anyone's discipline. Nothing here reads a
 * file, starts a timer or logs: the caller says what the limit is and, when it has one, hands
 * over the signal that ends its wait.
 *
 * THE LIMIT TRAVELS WITH THE WAITER. Each caller passes the limit it read when it asked, and the
 * queue is served strictly from its head by THAT waiter's limit: the head is admitted when fewer
 * dispatches are running than its own limit allows, and nobody behind it is looked at until it
 * is. So a limit the operator lowers applies to every dispatch that asks from then on without
 * disturbing the ones already running, and one that is raised takes effect as soon as the
 * waiters that asked under the old value have been served — in the order they came.
 *
 * NO SLOT IS EVER LOST HERE. A slot is given back by its own `release`, once, however often that
 * is called; a waiter that is cancelled leaves the queue without ever having counted. What this
 * module cannot do is make a holder release: that is the holder's `finally`.
 */

/** One admitted dispatch's claim on the gate. */
export interface DispatchSlot {
  /** Give the slot back. Idempotent: the second and every later call frees nothing. */
  release(): void;
}

interface Waiter {
  /** The limit this waiter asked under — what it is admitted by when it reaches the head. */
  readonly limit: number;
  admit(slot: DispatchSlot): void;
}

/** Slots handed out and not yet released. */
let running = 0;
/** Dispatches waiting for one, oldest first. */
const waiting: Waiter[] = [];

/**
 * The limit as a count that can be enforced. A value that is not a whole number of at least 1 —
 * 0, a negative number, a fraction, NaN, an infinity, anything that is not a number — reads as 1:
 * the caller's own reader (registry.sanitizeDispatchConcurrency) never produces one, so reaching
 * here with one is a defect upstream, and the reading that cannot start a flood is the right one
 * for a defect. It is never read as "no limit".
 */
function enforceableLimit(limit: unknown): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? limit : 1;
}

function newSlot(): DispatchSlot {
  let released = false;
  return {
    release(): void {
      if (released) {
        return;
      }
      released = true;
      running--;
      admitFromHead();
    },
  };
}

/**
 * Admit waiters from the head for as long as the head's own limit allows. Called after every
 * change that could let one in: a new waiter, a released slot, a waiter that left the queue.
 */
function admitFromHead(): void {
  while (waiting.length > 0 && running < waiting[0].limit) {
    const next = waiting.shift() as Waiter;
    running++;
    next.admit(newSlot());
  }
}

/** The rejection of a wait that was cancelled: an Error named `AbortError`, as an aborted fetch is. */
function abortError(): Error {
  const err = new Error('the wait for a dispatch slot was cancelled');
  err.name = 'AbortError';
  return err;
}

/**
 * Wait for a slot. Resolves with it as soon as this caller is at the head of the queue and
 * fewer than `limit` dispatches are running — at once, when nobody is waiting and there is room.
 *
 * `signal` ends the wait: when it aborts, the promise rejects with an `Error` named
 * `AbortError`, the waiter is gone from the queue and no slot was ever counted for it. A signal
 * that has already aborted rejects the same way without queueing at all. Once the slot has been
 * handed over the signal is no longer listened to — the holder decides what a cancellation
 * means for work that has started, and releases the slot either way.
 *
 * The holder MUST release, on every path: `try { … } finally { slot.release(); }` around
 * everything between this call and the end of the dispatch.
 */
export function acquireDispatchSlot(opts: { limit: number; signal?: AbortSignal }): Promise<DispatchSlot> {
  const limit = enforceableLimit(opts?.limit);
  const signal = opts?.signal;
  if (signal?.aborted === true) {
    return Promise.reject(abortError());
  }
  return new Promise<DispatchSlot>((resolve, reject) => {
    const onAbort = (): void => {
      const at = waiting.indexOf(waiter);
      if (at === -1) {
        // Admitted already: the slot is the holder's, and so is what to do about the abort.
        return;
      }
      waiting.splice(at, 1);
      reject(abortError());
      // The waiter that left may have been the head, holding back one whose limit has room.
      admitFromHead();
    };
    const waiter: Waiter = {
      limit,
      admit: (slot) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(slot);
      },
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Always through the queue, even when there is room: a newcomer never overtakes a waiter.
    waiting.push(waiter);
    admitFromHead();
  });
}

/** How many dispatches hold a slot, and how many are waiting for one, in this process. */
export function dispatchGateStats(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}
