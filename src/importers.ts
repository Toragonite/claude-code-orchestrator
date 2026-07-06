import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OAuthTokens } from './oauth';

/**
 * Discovery of Claude logins already stored on this machine, so accounts can
 * be imported instead of re-running the browser flow:
 *
 * - Claude Code credential files: $CLAUDE_CONFIG_DIR, ~/.claude, and any
 *   ~/.claude-* variant directories (the common multi-account pattern).
 * - `ant auth login --profile <name>` profiles under
 *   $ANTHROPIC_CONFIG_DIR/credentials (default ~/.config/anthropic).
 *
 * Note: on macOS, Claude Code may keep its tokens in the Keychain instead of
 * a credentials file — those logins won't be discovered here.
 */

export interface StoredLogin {
  /** e.g. "Claude Code (~/.claude)" or "ant profile: work" */
  label: string;
  /** File the tokens were read from. */
  source: string;
  tokens: OAuthTokens;
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values before ~2001 in ms terms are actually seconds.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function parseTokens(obj: unknown): OAuthTokens | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const record = obj as Record<string, unknown>;
  const accessToken = record.accessToken ?? record.access_token;
  const refreshToken = record.refreshToken ?? record.refresh_token;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    return undefined;
  }
  // expiresAt 0 → treated as already expired, so first use refreshes.
  const expiresAt = toEpochMs(record.expiresAt ?? record.expires_at) ?? 0;
  return { type: 'oauth', accessToken, refreshToken, expiresAt };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function discoverStoredLogins(): StoredLogin[] {
  const found: StoredLogin[] = [];
  const home = os.homedir();
  const tilde = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  // Claude Code config directories.
  const claudeDirs = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) {
    claudeDirs.add(process.env.CLAUDE_CONFIG_DIR);
  }
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.claude')) {
        claudeDirs.add(path.join(home, entry.name));
      }
    }
  } catch {
    // home unreadable — nothing to discover
  }
  for (const dir of claudeDirs) {
    const file = path.join(dir, '.credentials.json');
    const json = readJson(file) as Record<string, unknown> | undefined;
    const tokens = parseTokens(json?.claudeAiOauth ?? json);
    if (tokens) {
      found.push({ label: `Claude Code (${tilde(dir)})`, source: file, tokens });
    }
  }

  // ant CLI profiles.
  const antDir = process.env.ANTHROPIC_CONFIG_DIR ?? path.join(home, '.config', 'anthropic');
  const credDir = path.join(antDir, 'credentials');
  try {
    for (const name of fs.readdirSync(credDir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = path.join(credDir, name);
      const json = readJson(file) as Record<string, unknown> | undefined;
      const tokens = parseTokens(json?.claudeAiOauth ?? json?.oauth ?? json);
      if (tokens) {
        found.push({ label: `ant profile: ${name.replace(/\.json$/, '')}`, source: file, tokens });
      }
    }
  } catch {
    // no ant profiles
  }

  return found;
}
