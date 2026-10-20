import { flattenOneLine, sliceOneLine } from '../displayText';
import { parseProvider, PROVIDER_IDS, type ProviderStatus } from '../providers';
import {
  killVendorChildrenNow,
  MODELS_TIMEOUT_MS,
  providerModels,
  providerStatus,
  STATUS_TIMEOUT_DEFAULT_MS,
  type ProviderModelCatalog,
} from './provider-runner';

/**
 * provider-cli — the bundled helper the EXTENSION HOST runs to learn about a non-Claude worker
 * account:
 *
 *   node provider-cli.js status <provider> <configDir> [--quota] [--budget-ms=<n>]
 *   node provider-cli.js models <provider> <configDir> [--budget-ms=<n>]
 *
 * Each prints exactly ONE line of JSON. It exists because the vendor adapters may be imported
 * only from an esbuild bundle: the extension host is plain tsc output with no node_modules beside
 * it, so it forks this file instead of importing them. The dispatch server, which is itself a
 * bundle, calls the same `providerStatus` in-process and never runs this.
 *
 * `status` prints a `ProviderStatus` (src/providers.ts) and exits 0. A bad invocation prints one
 * line too — the same shape, with `error` saying what was wrong and every reading "unknown" — and
 * exits 2. It does NOT say `cliFound: false`: that field means the vendor CLI could not be
 * started, and nothing was tried. An internal failure exits 1 the same way.
 *
 * `--quota` is the caller's decision, never this file's: for some vendors a usage reading is a
 * network request made with the account's own login, and whether to make it is an operator
 * setting the caller holds.
 *
 * `models` prints a `ProviderModelCatalog` (provider-runner) — the ids a picker can offer for
 * that account, from the vendor CLI when it can list them and from the adapter's built-in
 * catalog otherwise — and ALWAYS exits 0: a wrong provider, a missing directory, an extra
 * argument and an internal failure are all the same shape with an empty list and an `error`. Its
 * caller is filling a list of suggestions, and has the same thing to do in every one of those
 * cases — show its own. The line is bounded by what it may hold (600 entries of at most 128 + 80
 * characters, which stays under 256 KiB — provider-runner's MODELS_MAX has the arithmetic).
 *
 * THE BUDGET. Each command answers within a budget counted from THIS PROCESS'S OWN START — not
 * from the moment its work begins, so a helper that was slow to load (a busy machine) still
 * answers by the time its caller expects. `models`: 25 s unless the caller names another;
 * `status`: 20 s. `--budget-ms=<n>` names it, in whole milliseconds: 1000 to 25000 for `models`,
 * 1000 to 20000 for `status`. It must be the LAST argument and may be given once; anything else
 * — not a whole number, out of range, twice, in another position — is a bad invocation of that
 * command, answered as such, and no vendor CLI is started. The vendor CLI is given less than the
 * budget (provider-runner keeps a margin back) so that the answer is printed inside it; the
 * caller waits a few seconds longer than the budget before it ends this process, so a helper that
 * is working in order always ends by itself first.
 *
 * NOTHING IT STARTED OUTLIVES IT. A vendor CLI is started in its own process group, so that it
 * can be stopped as a whole; that also means it does NOT die with this process. So, on every
 * way out that this process can act on, the groups of whatever it still has running are killed
 * first (provider-runner.killVendorChildrenNow): before the exit that follows the answer, and
 * when it is told to go — SIGTERM, SIGINT and SIGHUP are handled, kill synchronously, and exit
 * with 143, 130 and 129. A second signal while that is happening finds the same thing already
 * done. One way out cannot be acted on: a helper that is SIGKILLed runs no code, and what it
 * started is then left to its own deadline — which is why the caller ends an overdue helper
 * with SIGTERM first.
 *
 * An invocation that names neither command is answered as `status` answers a bad one.
 *
 * No token, e-mail address or vendor payload is ever written here: `providerStatus` returns
 * none, a catalog holds model ids and their display names, and the only other text printed is
 * composed from this file's literals and the flattened arguments.
 *
 * Must not import 'vscode'.
 */

const VENDORS = PROVIDER_IDS.filter((id) => id !== 'claude').join('|');
const USAGE = `usage: provider-cli status <${VENDORS}> <configDir> [--quota] [--budget-ms=<1000-${STATUS_TIMEOUT_DEFAULT_MS}>]`;
const MODELS_USAGE = `usage: provider-cli models <${VENDORS}> <configDir> [--budget-ms=<1000-${MODELS_TIMEOUT_MS}>]`;

/** The shortest budget a caller may name: below it there is no time to start anything. */
const BUDGET_MIN_MS = 1_000;
const BUDGET_FLAG = '--budget-ms';

/** Echo of a bad argument: one line, bounded — it came from a command line. */
function shown(raw: unknown): string {
  return JSON.stringify(sliceOneLine(flattenOneLine(raw), 60));
}

function refusal(error: string): ProviderStatus {
  return { cliFound: true, loggedIn: null, mode: null, quota: null, error: sliceOneLine(flattenOneLine(error), 200) };
}

/** A `models` answer with no catalog in it: the frozen shape, an empty list, why. */
function noCatalog(error: string): ProviderModelCatalog {
  return { models: [], source: 'static', error: sliceOneLine(flattenOneLine(error), 200) };
}

/**
 * Write the one line and leave only once it is flushed — stdout is a pipe, and its writes are
 * async. Whatever this process still has running is ended first: a check that was given up on
 * may be in the grace between its SIGTERM and its SIGKILL, and the timer that would send the
 * second dies with this process.
 */
function finish(line: ProviderStatus | ProviderModelCatalog, code: number): void {
  killVendorChildrenNow();
  process.stdout.write(`${JSON.stringify(line)}\n`, () => process.exit(code));
}

/** What is left of a budget counted from this process's start, in milliseconds (may be ≤ 0). */
function remainingOf(budgetMs: number): number {
  return budgetMs - Math.round(process.uptime() * 1000);
}

/**
 * The budget argument of one invocation: `args` are the command's arguments after the provider
 * and the directory. Returns the arguments without it and the budget it named (`fallback` when it
 * named none) — or what is wrong with it.
 *
 * It counts only as the LAST argument, once, and as `--budget-ms=<whole milliseconds>` within the
 * command's range. Every other appearance of the flag is refused rather than read some other
 * way: a budget is a promise to the caller about when this process answers, and one that was
 * guessed at is worse than none.
 */
function budgetOf(
  args: readonly string[],
  fallback: number,
  max: number,
): { ok: true; rest: string[]; budgetMs: number } | { ok: false; why: string } {
  const flagged = args.filter((arg) => arg.startsWith(BUDGET_FLAG));
  if (flagged.length === 0) {
    return { ok: true, rest: [...args], budgetMs: fallback };
  }
  const expected = `expected ${BUDGET_FLAG}=<whole milliseconds, ${BUDGET_MIN_MS} to ${max}> once, as the last argument`;
  const last = args[args.length - 1];
  if (flagged.length > 1 || !last.startsWith(BUDGET_FLAG)) {
    return { ok: false, why: `invalid ${BUDGET_FLAG} — ${expected}` };
  }
  const value = /^--budget-ms=([1-9][0-9]{0,8})$/.exec(last)?.[1];
  const budgetMs = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(budgetMs) || budgetMs < BUDGET_MIN_MS || budgetMs > max) {
    return { ok: false, why: `invalid ${BUDGET_FLAG} ${shown(last)} — ${expected}` };
  }
  return { ok: true, rest: args.slice(0, -1), budgetMs };
}

/** `models <provider> <configDir> [--budget-ms=<n>]`: the arguments are checked as `status` checks its own. */
async function modelCatalog(providerArg: unknown, configDir: unknown, args: readonly string[]): Promise<ProviderModelCatalog> {
  const provider = parseProvider(providerArg);
  if (provider === undefined || provider === 'claude') {
    return noCatalog(`unknown provider ${shown(providerArg ?? '')} — ${MODELS_USAGE}`);
  }
  if (typeof configDir !== 'string' || configDir.trim() === '' || configDir.startsWith('--')) {
    return noCatalog(`missing configDir — ${MODELS_USAGE}`);
  }
  const budget = budgetOf(args, MODELS_TIMEOUT_MS, MODELS_TIMEOUT_MS);
  if (!budget.ok) {
    return noCatalog(`${budget.why} — ${MODELS_USAGE}`);
  }
  if (budget.rest.length > 0) {
    return noCatalog(`unknown argument ${shown(budget.rest[0])} — ${MODELS_USAGE}`);
  }
  // What is left of the budget by now; providerModels takes no less than a second of it.
  return providerModels({ provider, configDir }, { timeoutMs: remainingOf(budget.budgetMs) });
}

async function main(argv: string[]): Promise<void> {
  const [command, providerArg, configDir, ...rest] = argv;
  if (command === 'models') {
    let catalog: ProviderModelCatalog;
    try {
      catalog = await modelCatalog(providerArg, configDir, rest);
    } catch (err) {
      // providerModels does not reject for anything its callees throw; this is for a failure
      // nobody planned for. Whatever was thrown, the answer is still the one line and exit 0 —
      // so even putting the thrown value into words is not allowed to fail.
      let why = 'no description';
      try {
        why = err instanceof Error ? err.message : String(err);
      } catch {
        // a value that cannot be described — the literal above stands
      }
      catalog = noCatalog(`the models helper failed: ${why}`);
    }
    finish(catalog, 0);
    return;
  }
  if (command !== 'status') {
    finish(refusal(`unknown command ${shown(command ?? '')} — ${USAGE}`), 2);
    return;
  }
  const provider = parseProvider(providerArg);
  if (provider === undefined || provider === 'claude') {
    finish(refusal(`unknown provider ${shown(providerArg ?? '')} — ${USAGE}`), 2);
    return;
  }
  if (typeof configDir !== 'string' || configDir.trim() === '' || configDir.startsWith('--')) {
    finish(refusal(`missing configDir — ${USAGE}`), 2);
    return;
  }
  const budget = budgetOf(rest, STATUS_TIMEOUT_DEFAULT_MS, STATUS_TIMEOUT_DEFAULT_MS);
  if (!budget.ok) {
    finish(refusal(`${budget.why} — ${USAGE}`), 2);
    return;
  }
  const unknown = budget.rest.find((arg) => arg !== '--quota');
  if (unknown !== undefined) {
    finish(refusal(`unknown argument ${shown(unknown)} — ${USAGE}`), 2);
    return;
  }
  finish(
    await providerStatus(
      { provider, configDir },
      { quota: budget.rest.includes('--quota'), timeoutMs: remainingOf(budget.budgetMs) },
    ),
    0,
  );
}

/**
 * Told to go: end what this process started, then go, with the exit code a shell gives a process
 * the signal ended (128 + its number). Installed before anything is started. Synchronous from
 * the first line to the last, so a second signal arriving meanwhile has nothing left to do; and
 * process.exit ends the process whatever is still pending — the caller has stopped listening.
 */
const EXIT_ON_SIGNAL: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
];
for (const [signal, code] of EXIT_ON_SIGNAL) {
  process.on(signal, () => {
    killVendorChildrenNow();
    process.exit(code);
  });
}

main(process.argv.slice(2)).catch((err: unknown) => {
  // providerStatus never rejects; this is for a failure nobody planned for.
  finish(refusal(`the status helper failed: ${err instanceof Error ? err.message : String(err)}`), 1);
});
