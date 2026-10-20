import { flattenOneLine, sliceOneLine } from '../displayText';
import { isFrontierModel, sameConfigDir } from '../platform';
import { normalizeProviderModel, providerModelHint, type ProviderId } from '../providers';
import type { WorkerProfile } from '../registry';
import {
  MACHINE_LOGIN_KEYS,
  MACHINE_LOGIN_LABELS,
  REASON_MAX_CHARS,
  TEAM_MAX_PER_ACCOUNT,
  TEAM_PROVIDERS,
  TEAM_TEXT,
} from './contract';

/**
 * team/routing — choosing an account for a team member (team contract §6, D9, S1-5), written as
 * pure decisions over the FACTS the engine hands it (RoutingFacts). It never reads a file, never
 * spawns, never files a verdict: the facts object is the only door to the registry, the usage
 * cache and the existing selection (`pickWorkerLive`), so the very same code runs at create time
 * on CACHED facts only (M15: "routing spawns nothing") and before a member's first turn on LIVE
 * ones — the facts' `pick` decides which by its `mode`.
 *
 * WHAT IS REUSED, NOT REWRITTEN. Selection among candidates is dispatch's own (§6.2 "pickWorker
 * reused"): every refusal text a member can be refused with is `pickWorker`'s, verbatim. What this
 * module adds is only what a TEAM needs on top of a one-shot dispatch: the per-identity cap
 * (TEAM_MAX_PER_ACCOUNT), the "spread" pass, the lead's own account kept out of automatic
 * choices (MD-48), the single machine login of Cursor and Antigravity (§6.2 step 4), the
 * same-login identities of wave 10 (step 5), `attempted` as the NAMES of every worker of a failed
 * identity (M3), and the model rule of step 6.
 *
 * NO CROSS-PROVIDER MOVE (S1-5). A failover (`provider` forced to the member's current one) never
 * looks at another vendor; the only provider-less path is the AUTO choice of a member whose spec
 * names neither a provider nor a worker, at creation.
 *
 * Every function is total: a refusal is a value (`RouteRefusal`), never a throw — `pick` is
 * contracted to answer a refusal instead of throwing, and a defect inside it is caught here.
 */

/** What routing needs to know, from the engine (which wires the registry, usage cache and pickWorkerLive). */
export interface RoutingFacts {
  /** The registry's USABLE workers, in registry order. */
  workers: readonly WorkerProfile[];
  /** platform.hostConfigDir() — the lead's own Claude account (MD-48). */
  leadConfigDir: string;
  /**
   * The wave-10 same-login hash of a worker's cached usage reading (usage.accountKeyOf) — two
   * registry entries signed in to one account answer the same key; undefined when unknown.
   */
  sameLoginKey(worker: WorkerProfile): string | undefined;
  /** The cached provider facts for AUTO routing (§6.2 step 3): `cliFound` / `loggedIn` as last read; undefined = unknown (kept). */
  providerCached(provider: ProviderId): { cliFound?: boolean; loggedIn?: boolean };
  /** 100 − the max usedPercent of the windows that apply; undefined when unknown (counts as 50). */
  headroom(worker: WorkerProfile): number | undefined;
  /** Whether the frontier billing guard blocks a Claude frontier model (registry.frontierWorkerDispatch !== 'allow'). */
  frontierGuardBlocks: boolean;
  /** Codex only: the default of the STORED model catalog of that worker's provider, when one is cached (M15). */
  storedCodexDefault(worker: WorkerProfile): string | undefined;
  /**
   * T11 E12 (§3.9, A27), Codex only: the path of the worker's `<configDir>/config.toml` when it
   * registers an `mcp_servers` entry that runs this product's `server.js` (a text check of at most
   * 1 MiB); undefined when it does not, or cannot be told. A Codex member on such an account could
   * dispatch (Codex filters its MCP children's environment, so the `CCO_TEAM_MEMBER` guard cannot
   * fire — RP-6), so routing refuses it with TEAM_TEXT.codexDispatchServer. Optional: absent = no
   * account registers it (the offline fakes).
   */
  codexDispatchServer?(worker: WorkerProfile): string | undefined;
  /**
   * dispatch's selection (pickWorker through pickWorkerLive): `named` = a worker the caller named
   * (then `candidates` is the whole registry, so the unknown-name refusal lists every name);
   * `attempted` = worker names excluded; `mode: 'cached'` must not probe or spawn anything (M15),
   * `'live'` may run the bounded live login re-check. Answers the refusal text instead of throwing.
   */
  pick(
    candidates: readonly WorkerProfile[],
    named: string | undefined,
    attempted: ReadonlySet<string>,
    model: string | undefined,
    mode: 'cached' | 'live',
  ): Promise<{ ok: true; worker: WorkerProfile; billableOverage: boolean } | { ok: false; text: string }>;
}

/** A member already in the team, as the cap and "spread" count it. */
export interface RoutedMember {
  name: string;
  provider: ProviderId;
  accountKey: string;
  /** Its worker's name (the same-login key is looked up through it). */
  worker: string;
}

/** What the engine asks routing for. */
export interface RouteRequest {
  /** The member being routed (it is not counted against itself). */
  member: string;
  /** The member's spec (untrusted values already shape-checked by the engine). */
  spec: { provider?: ProviderId; worker?: string; model?: string };
  /** The other members of the team that hold an account (not stopped/ended). */
  team: readonly RoutedMember[];
  /**
   * M3: the identity keys (accountKey / same-login key / machine key) that failed this member;
   * every registry name of them is passed to pickWorker as `attempted`.
   */
  failedIdentities?: ReadonlySet<string>;
  /** Failover / refresh / resume: stay on this provider and ignore the spec's worker (S1-5). */
  forceProvider?: ProviderId;
  /** `cached` at create (M15); `live` before a first turn and at every switch after a failed turn. */
  mode: 'cached' | 'live';
}

/** The routing of one incarnation (§2.1, `member.routed`). */
export interface RouteChoice {
  ok: true;
  provider: ProviderId;
  worker: WorkerProfile;
  /** §2.1: configDir verbatim (Claude/Codex) or MACHINE_LOGIN_KEYS (Cursor/Antigravity). */
  accountKey: string;
  /** '' = the CLI's default; for Codex '' means "resolve before the first turn" (`modelPending`). */
  model: string;
  modelSource: 'dispatch' | 'worker' | 'cli';
  /** Codex with no model yet: the engine resolves one before the first turn or blocks `cli` (§6.2 step 6). */
  modelPending: boolean;
  billableOverage: boolean;
  /** MD-48: the member runs on the lead's own account (only when the spec named that worker). */
  sharesLeadPlan: boolean;
  machineLogin: boolean;
  /** The account label every surface shows (§6.2 step 4). */
  accountLabel: string;
  /** `member.routed.reason`, ≤ REASON_MAX_CHARS. */
  reason: string;
  /** §6.2 step 4: a second member on one machine login — the roster line (TEAM_TEXT.sharesMachineLogin). */
  sharesMachineLoginWith?: string;
}

/**
 * Why no account was chosen. `text` is the refusal's own words (pickWorker's, or TEAM_TEXT's);
 * `kind` lets the engine pick the blocked code: `login` (every candidate is logged out), `quota`
 * (exhausted / cooling down), `removed` (a named worker is gone), `other`.
 */
export interface RouteRefusal {
  ok: false;
  kind: 'login' | 'quota' | 'removed' | 'model' | 'mismatch' | 'full' | 'other';
  text: string;
  /** AUTO routing: one line per provider tried (TEAM_TEXT.noAccount). */
  perProvider?: Array<{ provider: string; reason: string }>;
}

/** §2.1/§6.2 step 4: the account key of a worker — configDir verbatim, or the machine login's key. */
export function accountKeyOf(worker: Pick<WorkerProfile, 'configDir' | 'provider'>): string {
  const provider = worker.provider ?? 'claude';
  if (provider === 'cursor' || provider === 'gemini') {
    return MACHINE_LOGIN_KEYS[provider];
  }
  return worker.configDir;
}

/** The provider of a registry worker (absent = Claude Code, registry.workerProvider's rule). */
export function providerOfWorker(worker: Pick<WorkerProfile, 'provider'>): ProviderId {
  return worker.provider ?? 'claude';
}

/** §6.2 step 4: the account label — the worker's name, or `Cursor (machine login)` / `Antigravity (machine login)`. */
export function accountLabelOf(worker: Pick<WorkerProfile, 'name' | 'provider'>): string {
  const provider = providerOfWorker(worker);
  return provider === 'cursor' || provider === 'gemini' ? MACHINE_LOGIN_LABELS[provider] : worker.name;
}

/**
 * Every identity key of a worker (§6.2 steps 4–5, M3): its account key, and — for a Claude account
 * whose usage reading names who is signed in — `login:<hash>`, so two registry entries on one
 * claude.ai login are one identity. Two workers are one identity when any key is shared.
 */
export function identityKeysOf(worker: WorkerProfile, facts: Pick<RoutingFacts, 'sameLoginKey'>): string[] {
  const keys = [accountKeyOf(worker)];
  if (providerOfWorker(worker) === 'claude') {
    let login: string | undefined;
    try {
      login = facts.sameLoginKey(worker);
    } catch {
      login = undefined;
    }
    if (typeof login === 'string' && login !== '') {
      keys.push(`login:${login}`);
    }
  }
  return keys;
}

/** M3: the names of every registry worker sharing an identity key with `keys` (pickWorker filters by name). */
export function namesOfIdentities(keys: ReadonlySet<string>, facts: Pick<RoutingFacts, 'workers' | 'sameLoginKey'>): string[] {
  if (keys.size === 0) {
    return [];
  }
  return facts.workers.filter((w) => identityKeysOf(w, facts).some((k) => keys.has(k))).map((w) => w.name);
}

/** MD-48: whether a worker is the lead's own account (the host's config dir, or the same claude.ai login). */
export function isLeadAccount(worker: WorkerProfile, facts: Pick<RoutingFacts, 'workers' | 'leadConfigDir' | 'sameLoginKey'>): boolean {
  if (providerOfWorker(worker) !== 'claude') {
    return false;
  }
  try {
    if (sameConfigDir(worker.configDir, facts.leadConfigDir)) {
      return true;
    }
  } catch {
    // an unusable string is not the lead's directory
  }
  const login = identityKeysOf(worker, facts).find((k) => k.startsWith('login:'));
  if (login === undefined) {
    return false;
  }
  // The lead's own login key: of a registry entry on the lead's directory, when one exists.
  return facts.workers.some((w) => {
    try {
      return sameConfigDir(w.configDir, facts.leadConfigDir) && identityKeysOf(w, facts).includes(login);
    } catch {
      return false;
    }
  });
}

function oneLine(text: string): string {
  return sliceOneLine(flattenOneLine(text), REASON_MAX_CHARS);
}

/** How many members of the team share an identity with `worker`. */
function membersOn(worker: WorkerProfile, team: readonly RoutedMember[], facts: RoutingFacts): RoutedMember[] {
  const keys = new Set(identityKeysOf(worker, facts));
  return team.filter((m) => {
    if (keys.has(m.accountKey)) {
      return true;
    }
    const w = facts.workers.find((x) => x.name === m.worker);
    return w !== undefined && identityKeysOf(w, facts).some((k) => keys.has(k));
  });
}

/** §6.2 step 6: the model of the incarnation. */
function resolveModel(
  provider: ProviderId,
  worker: WorkerProfile,
  specModel: string | undefined,
  facts: RoutingFacts,
):
  | { ok: true; model: string; modelSource: 'dispatch' | 'worker' | 'cli'; modelPending: boolean }
  | { ok: false; text: string } {
  if (specModel !== undefined) {
    const model = normalizeProviderModel(provider, specModel);
    if (model === undefined) {
      return { ok: false, text: `model "${oneLine(specModel)}" is not a model id: use ${providerModelHint(provider)}` };
    }
    if (provider === 'claude' && facts.frontierGuardBlocks && isFrontierModel(model)) {
      return {
        ok: false,
        text:
          `model ${model} is on the frontier tier, which the frontier guard blocks ` +
          '("claudeCodeOrchestrator.frontierWorkerDispatch"); name a model off that tier',
      };
    }
    return { ok: true, model, modelSource: 'dispatch', modelPending: false };
  }
  const own = typeof worker.model === 'string' ? worker.model : '';
  if (own !== '') {
    return { ok: true, model: own, modelSource: 'worker', modelPending: false };
  }
  if (provider === 'codex') {
    let stored: string | undefined;
    try {
      stored = facts.storedCodexDefault(worker);
    } catch {
      stored = undefined;
    }
    if (typeof stored === 'string' && stored !== '') {
      return { ok: true, model: stored, modelSource: 'cli', modelPending: false };
    }
    // M15: never a live lookup here — the engine resolves it before the first turn.
    return { ok: true, model: '', modelSource: 'cli', modelPending: true };
  }
  return { ok: true, model: '', modelSource: 'cli', modelPending: false };
}

/** E12: the config.toml path that makes a Codex worker unusable as a member, else undefined (total). */
function dispatchServerOf(worker: WorkerProfile, facts: RoutingFacts): string | undefined {
  if (providerOfWorker(worker) !== 'codex' || facts.codexDispatchServer === undefined) {
    return undefined;
  }
  try {
    const found = facts.codexDispatchServer(worker);
    return typeof found === 'string' && found !== '' ? found : undefined;
  } catch {
    return undefined;
  }
}

async function safePick(
  facts: RoutingFacts,
  candidates: readonly WorkerProfile[],
  named: string | undefined,
  attempted: ReadonlySet<string>,
  model: string | undefined,
  mode: 'cached' | 'live',
): Promise<{ ok: true; worker: WorkerProfile; billableOverage: boolean } | { ok: false; text: string }> {
  try {
    return await facts.pick(candidates, named, attempted, model, mode);
  } catch (err) {
    return { ok: false, text: oneLine(err instanceof Error ? err.message : String(err)) };
  }
}

/** The refusal kind a pickWorker text reads as (only to choose a blocked code; the text is shown as it is). */
function refusalKind(text: string): RouteRefusal['kind'] {
  if (/logged out|login expired|re-login/i.test(text)) {
    return 'login';
  }
  if (/quota|cooling down|exhausted|limit/i.test(text)) {
    return 'quota';
  }
  if (/not found|unknown worker|no worker named|is not a registered/i.test(text)) {
    return 'removed';
  }
  return 'other';
}

function choice(
  provider: ProviderId,
  worker: WorkerProfile,
  model: { model: string; modelSource: 'dispatch' | 'worker' | 'cli'; modelPending: boolean },
  billableOverage: boolean,
  req: RouteRequest,
  facts: RoutingFacts,
  why: string,
): RouteChoice {
  const machineLogin = provider === 'cursor' || provider === 'gemini';
  const sharing = machineLogin ? req.team.find((m) => m.provider === provider && m.name !== req.member) : undefined;
  return {
    ok: true,
    provider,
    worker,
    accountKey: accountKeyOf(worker),
    model: model.model,
    modelSource: model.modelSource,
    modelPending: model.modelPending,
    billableOverage,
    sharesLeadPlan: isLeadAccount(worker, facts),
    machineLogin,
    accountLabel: accountLabelOf(worker),
    reason: oneLine(TEAM_TEXT.routedTo(provider, accountLabelOf(worker), why)),
    sharesMachineLoginWith: sharing?.name,
  };
}

/**
 * §6.2 step 2 for one provider: candidates of that provider minus the lead's own account minus
 * identities at the cap; pickWorker twice — first over the identities no member of the team uses
 * ("spread"), then over all of them. Cursor and Antigravity are ONE identity each (step 4), so a
 * failed machine login is never "failed over" to another entry of the same provider.
 */
async function routeWithinProvider(
  provider: ProviderId,
  req: RouteRequest,
  facts: RoutingFacts,
): Promise<RouteChoice | RouteRefusal> {
  const others = req.team.filter((m) => m.name !== req.member);
  const attempted = new Set(namesOfIdentities(req.failedIdentities ?? new Set(), facts));
  const registered = facts.workers.filter((w) => providerOfWorker(w) === provider);
  if (registered.length === 0) {
    return { ok: false, kind: 'other', text: `no ${provider} worker account is registered` };
  }
  // E12 (§3.9): a Codex account that registers this product's dispatch server is never a member's.
  const all = registered.filter((w) => dispatchServerOf(w, facts) === undefined);
  if (all.length === 0) {
    const first = registered[0];
    return { ok: false, kind: 'other', text: TEAM_TEXT.codexDispatchServer(first.name, dispatchServerOf(first, facts) ?? 'config.toml') };
  }
  const candidates = all.filter(
    (w) => !isLeadAccount(w, facts) && membersOn(w, others, facts).length < TEAM_MAX_PER_ACCOUNT,
  );
  if (candidates.length === 0) {
    const atCap = all.filter((w) => !isLeadAccount(w, facts));
    return atCap.length === 0
      ? { ok: false, kind: 'other', text: `the only ${provider} account is the lead's own; name it as "worker" to share the lead's plan` }
      : { ok: false, kind: 'full', text: TEAM_TEXT.accountFull(accountLabelOf(atCap[0])) };
  }
  // The model the selection judges exhaustion for: the spec's (normalized) when it gives one.
  const specModel = req.spec.model !== undefined ? normalizeProviderModel(provider, req.spec.model) : undefined;
  const spread = candidates.filter((w) => membersOn(w, others, facts).length === 0);
  let picked: { ok: true; worker: WorkerProfile; billableOverage: boolean } | { ok: false; text: string } = {
    ok: false,
    text: 'No eligible worker available.',
  };
  let why = '';
  if (spread.length > 0) {
    picked = await safePick(facts, spread, undefined, attempted, specModel, req.mode);
    why = `unused in this team`;
  }
  if (!picked.ok) {
    picked = await safePick(facts, candidates, undefined, attempted, specModel, req.mode);
    why = 'shared with a teammate';
  }
  if (!picked.ok) {
    return { ok: false, kind: refusalKind(picked.text), text: picked.text };
  }
  const model = resolveModel(provider, picked.worker, req.spec.model, facts);
  if (!model.ok) {
    return { ok: false, kind: 'model', text: model.text };
  }
  const head = facts.headroom(picked.worker);
  const headText = typeof head === 'number' && Number.isFinite(head) ? `, ${Math.round(head)}% headroom` : '';
  return choice(provider, picked.worker, model, picked.billableOverage, req, facts, `${why}${headText}`);
}

/**
 * Route one member (§6.2): a named worker (step 1), a named provider (step 2), or AUTO (step 3).
 * `forceProvider` (failover, refresh, resume) routes within that provider only, never by the
 * spec's worker (S1-5) — the failed identities are excluded through `attempted`. Total.
 */
export async function routeMember(req: RouteRequest, facts: RoutingFacts): Promise<RouteChoice | RouteRefusal> {
  try {
    const others = req.team.filter((m) => m.name !== req.member);
    if (req.forceProvider !== undefined) {
      return await routeWithinProvider(req.forceProvider, req, facts);
    }
    // Step 1: a named worker.
    if (req.spec.worker !== undefined) {
      const named = facts.workers.find((w) => w.name === req.spec.worker);
      if (named !== undefined) {
        const provider = providerOfWorker(named);
        if (req.spec.provider !== undefined && req.spec.provider !== provider) {
          return {
            ok: false,
            kind: 'mismatch',
            text: TEAM_TEXT.workerProviderMismatch(named.name, provider, req.spec.provider),
          };
        }
        if (membersOn(named, others, facts).length >= TEAM_MAX_PER_ACCOUNT) {
          return { ok: false, kind: 'full', text: TEAM_TEXT.accountFull(accountLabelOf(named)) };
        }
        const configPath = dispatchServerOf(named, facts);
        if (configPath !== undefined) {
          return { ok: false, kind: 'other', text: TEAM_TEXT.codexDispatchServer(named.name, configPath) };
        }
      }
      const attempted = new Set(namesOfIdentities(req.failedIdentities ?? new Set(), facts));
      const provider = named !== undefined ? providerOfWorker(named) : (req.spec.provider ?? 'claude');
      const specModel = req.spec.model !== undefined ? normalizeProviderModel(provider, req.spec.model) : undefined;
      const picked = await safePick(facts, facts.workers, req.spec.worker, attempted, specModel, req.mode);
      if (!picked.ok) {
        return { ok: false, kind: named === undefined ? 'removed' : refusalKind(picked.text), text: picked.text };
      }
      const model = resolveModel(provider, picked.worker, req.spec.model, facts);
      if (!model.ok) {
        return { ok: false, kind: 'model', text: model.text };
      }
      return choice(provider, picked.worker, model, picked.billableOverage, req, facts, 'named in the member spec');
    }
    // Step 2: a named provider.
    if (req.spec.provider !== undefined) {
      return await routeWithinProvider(req.spec.provider, req, facts);
    }
    // Step 3: AUTO over the providers whose CLI is there and whose login is not known to be gone.
    const usable = TEAM_PROVIDERS.filter((p) => {
      const cached = facts.providerCached(p);
      return cached.cliFound !== false && cached.loggedIn !== false;
    });
    const inTeam = new Set(others.map((m) => m.provider));
    const headOf = (p: ProviderId): number => {
      const heads = facts.workers
        .filter((w) => providerOfWorker(w) === p && !isLeadAccount(w, facts))
        .map((w) => facts.headroom(w))
        .map((h) => (typeof h === 'number' && Number.isFinite(h) ? h : 50));
      return heads.length === 0 ? -1 : Math.max(...heads);
    };
    const order = [...usable].sort((a, b) => {
      const unusedA = inTeam.has(a) ? 1 : 0;
      const unusedB = inTeam.has(b) ? 1 : 0;
      if (unusedA !== unusedB) {
        return unusedA - unusedB;
      }
      const hb = headOf(b) - headOf(a);
      if (hb !== 0) {
        return hb;
      }
      return TEAM_PROVIDERS.indexOf(a) - TEAM_PROVIDERS.indexOf(b);
    });
    const perProvider: Array<{ provider: string; reason: string }> = [];
    for (const p of order) {
      const routed = await routeWithinProvider(p, req, facts);
      if (routed.ok) {
        return routed;
      }
      perProvider.push({ provider: p, reason: oneLine(routed.text) });
    }
    for (const p of TEAM_PROVIDERS.filter((x) => !usable.includes(x))) {
      const cached = facts.providerCached(p);
      perProvider.push({ provider: p, reason: cached.cliFound === false ? 'its CLI is not installed' : 'logged out' });
    }
    return {
      ok: false,
      kind: perProvider.every((p) => /logged out|login/i.test(p.reason)) ? 'login' : 'other',
      text: TEAM_TEXT.noAccount(req.member, perProvider),
      perProvider,
    };
  } catch (err) {
    return { ok: false, kind: 'other', text: oneLine(err instanceof Error ? err.message : String(err)) };
  }
}
