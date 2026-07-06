import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { WorkerModel } from './models';

export type AccountRole = 'main' | 'worker';

export interface Account {
  id: string;
  name: string;
  role: AccountRole;
  /** Preferred model for worker accounts. The orchestrator may override per task. */
  model?: WorkerModel;
}

const ACCOUNTS_KEY = 'fableOrchestrator.accounts';
const secretKey = (id: string) => `fableOrchestrator.apiKey.${id}`;

/**
 * Account metadata lives in globalState; API keys live in SecretStorage only.
 */
export class AccountManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private clients = new Map<string, Anthropic>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Account[] {
    return this.context.globalState.get<Account[]>(ACCOUNTS_KEY, []);
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

  async add(name: string, role: AccountRole, apiKey: string, model?: WorkerModel): Promise<Account> {
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
      model,
    };
    await this.context.secrets.store(secretKey(account.id), apiKey);
    await this.context.globalState.update(ACCOUNTS_KEY, [...accounts, account]);
    this._onDidChange.fire();
    return account;
  }

  async remove(id: string): Promise<void> {
    const accounts = this.list().filter((a) => a.id !== id);
    await this.context.secrets.delete(secretKey(id));
    await this.context.globalState.update(ACCOUNTS_KEY, accounts);
    this.clients.delete(id);
    this._onDidChange.fire();
  }

  async client(account: Account): Promise<Anthropic> {
    const cached = this.clients.get(account.id);
    if (cached) {
      return cached;
    }
    const apiKey = await this.context.secrets.get(secretKey(account.id));
    if (!apiKey) {
      throw new Error(`No API key stored for account "${account.name}". Remove and re-add it.`);
    }
    const client = new Anthropic({ apiKey });
    this.clients.set(account.id, client);
    return client;
  }
}
