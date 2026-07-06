import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { WorkerModel } from './models';
import { OAuthTokens, OAUTH_BETA, refreshTokens } from './oauth';

export type AccountRole = 'main' | 'worker';
export type AuthMethod = 'oauth' | 'apiKey';

export interface Account {
  id: string;
  name: string;
  role: AccountRole;
  auth: AuthMethod;
  /** Preferred model for worker accounts. The orchestrator may override per task. */
  model?: WorkerModel;
}

export type Credentials = OAuthTokens | { type: 'apiKey'; apiKey: string };

const ACCOUNTS_KEY = 'fableOrchestrator.accounts';
const secretKey = (id: string) => `fableOrchestrator.credentials.${id}`;

/** Refresh OAuth tokens this many ms before they actually expire. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Account metadata lives in globalState; credentials (OAuth token pairs or
 * API keys) live in SecretStorage only. OAuth access tokens are refreshed
 * transparently via the stored refresh token.
 */
export class AccountManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  /** Serializes token refreshes per account so parallel dispatches don't race. */
  private refreshing = new Map<string, Promise<Credentials>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Account[] {
    const stored = this.context.globalState.get<Account[]>(ACCOUNTS_KEY, []);
    // Accounts saved by older versions predate the auth field.
    return stored.map((a) => ({ ...a, auth: a.auth ?? 'apiKey' }));
  }

  main(): Account | undefined {
    return this.list().find((a) => a.role === 'main');
  }

  workers(): Account[] {
    return this.list().filter((a) => a.role === 'worker');
  }

  get(idOrName: string): Account | undefined {
    return this.list().find((a) => a.id === idOrName || a.name === idOrName);
  }

  async add(
    name: string,
    role: AccountRole,
    credentials: Credentials,
    model?: WorkerModel,
  ): Promise<Account> {
    const accounts = this.list();
    if (role === 'main' && accounts.some((a) => a.role === 'main')) {
      throw new Error('A main (Fable) account already exists. Remove it first.');
    }
    if (accounts.some((a) => a.name === name)) {
      throw new Error(`An account named "${name}" already exists.`);
    }
    const account: Account = {
      id: `acct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      role,
      auth: credentials.type === 'oauth' ? 'oauth' : 'apiKey',
      model,
    };
    await this.storeCredentials(account.id, credentials);
    await this.context.globalState.update(ACCOUNTS_KEY, [...accounts, account]);
    this._onDidChange.fire();
    return account;
  }

  async remove(id: string): Promise<void> {
    const accounts = this.list().filter((a) => a.id !== id);
    await this.context.secrets.delete(secretKey(id));
    await this.context.globalState.update(ACCOUNTS_KEY, accounts);
    this._onDidChange.fire();
  }

  async storeCredentials(id: string, credentials: Credentials): Promise<void> {
    await this.context.secrets.store(secretKey(id), JSON.stringify(credentials));
  }

  private async readCredentials(account: Account): Promise<Credentials> {
    const raw = await this.context.secrets.get(secretKey(account.id));
    if (!raw) {
      throw new Error(
        `No credentials stored for account "${account.name}". Sign in again (Fable Orchestrator: Re-authenticate Account).`,
      );
    }
    try {
      return JSON.parse(raw) as Credentials;
    } catch {
      // Older versions stored the raw API key string.
      return { type: 'apiKey', apiKey: raw };
    }
  }

  /** Valid credentials, refreshing the OAuth access token when near expiry. */
  private async freshCredentials(account: Account): Promise<Credentials> {
    const creds = await this.readCredentials(account);
    if (creds.type !== 'oauth' || Date.now() < creds.expiresAt - REFRESH_MARGIN_MS) {
      return creds;
    }
    const inFlight = this.refreshing.get(account.id);
    if (inFlight) {
      return inFlight;
    }
    const refresh = (async () => {
      try {
        const next = await refreshTokens(creds);
        await this.storeCredentials(account.id, next);
        return next as Credentials;
      } catch (err) {
        throw new Error(
          `Token refresh failed for "${account.name}" — sign in again ` +
            `(Fable Orchestrator: Re-authenticate Account). ${err instanceof Error ? err.message : err}`,
        );
      } finally {
        this.refreshing.delete(account.id);
      }
    })();
    this.refreshing.set(account.id, refresh);
    return refresh;
  }

  /**
   * A client bound to this account's current credentials. OAuth accounts use
   * a Bearer token plus the oauth beta header; call this per request so the
   * token is always fresh.
   */
  async client(account: Account): Promise<Anthropic> {
    const creds = await this.freshCredentials(account);
    if (creds.type === 'apiKey') {
      return new Anthropic({ apiKey: creds.apiKey });
    }
    return new Anthropic({
      apiKey: null,
      authToken: creds.accessToken,
      defaultHeaders: { 'anthropic-beta': OAUTH_BETA },
    });
  }
}
