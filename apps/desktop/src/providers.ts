import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
  providerAccountSchema,
  providerAccountsSchema,
  providerConnectSchema,
  type ProviderAccount,
  type ProviderConnect,
} from '@openkraken/ipc-contract';
import { GitHubProvider, ProviderError, type ProviderDriver } from './github-provider.js';
import { ProviderCredentialError, ProviderVault } from './provider-vault.js';

function scope(account: Pick<ProviderAccount, 'provider' | 'origin' | 'providerUserId'>) {
  return JSON.stringify([account.provider, account.origin, account.providerUserId]);
}
function idFor(account: Pick<ProviderAccount, 'provider' | 'origin' | 'providerUserId'>) {
  return createHash('sha256').update(scope(account)).digest('hex');
}
/** Provider network and credentials remain in main; public results contain account metadata only. */
export class ProviderService {
  private queue: Promise<unknown> = Promise.resolve();
  private manifest: string;
  constructor(
    private directory: string,
    private vault: ProviderVault,
    private github: ProviderDriver = new GitHubProvider(),
  ) {
    this.manifest = join(directory, 'provider-accounts.json');
  }
  private run<T>(work: () => Promise<T>) {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async idle() {
    await this.queue;
  }
  private async load(): Promise<ProviderAccount[]> {
    let file;
    try {
      file = await open(this.manifest, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ProviderError('PROVIDER_SETTINGS', 'Provider account settings could not be read.');
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 256 * 1024) throw new Error('size');
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > 256 * 1024) throw new Error('size');
      const accounts = providerAccountsSchema.parse({
        keychainAvailable: false,
        accounts: JSON.parse(buffer.subarray(0, bytes).toString()),
      }).accounts;
      if (
        new Set(accounts.map((account) => account.id)).size !== accounts.length ||
        accounts.some((account) => idFor(account) !== account.id)
      )
        throw new Error('identity');
      return accounts;
    } catch {
      throw new ProviderError(
        'PROVIDER_SETTINGS',
        'Provider account settings are damaged. Restore them before reconnecting.',
      );
    } finally {
      await file.close();
    }
  }
  private async save(accounts: ProviderAccount[]) {
    const temporary = `${this.manifest}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(accounts), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.manifest);
    } catch {
      throw new ProviderError('PROVIDER_SETTINGS', 'Provider account settings could not be saved.');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  accounts() {
    return this.run(async () => ({
      keychainAvailable: await this.vault.available(),
      accounts: await this.load(),
    }));
  }
  connect(input: ProviderConnect, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerConnectSchema.parse(input);
      if (!(await this.vault.available()))
        throw new ProviderCredentialError('KEYCHAIN_UNAVAILABLE');
      signal?.throwIfAborted();
      const accounts = await this.load();
      const identity = await this.github.identity(options.origin, options.token, signal);
      const fields = {
        provider: options.provider,
        origin: options.origin,
        providerUserId: identity.id,
        login: identity.login,
      };
      const account = providerAccountSchema.parse({ ...fields, id: idFor(fields) });
      const existing = accounts.findIndex((item) => item.id === account.id);
      if (existing < 0 && accounts.length >= 50)
        throw new ProviderError('PROVIDER_LIMIT', 'Remove an account before connecting another.');
      signal?.throwIfAborted();
      await this.vault.write(scope(account), options.token);
      if (existing < 0) accounts.push(account);
      else accounts[existing] = account;
      try {
        await this.save(accounts);
      } catch (error) {
        if (existing < 0) await this.vault.remove(scope(account)).catch(() => {});
        throw error;
      }
      return { keychainAvailable: true, accounts };
    });
  }
  disconnect(id: string) {
    return this.run(async () => {
      const accounts = await this.load();
      const account = accounts.find((item) => item.id === id);
      if (!account)
        throw new ProviderError(
          'PROVIDER_ACCOUNT',
          'This provider account is no longer connected.',
        );
      await this.vault.remove(scope(account));
      const remaining = accounts.filter((item) => item.id !== id);
      await this.save(remaining);
      return { keychainAvailable: await this.vault.available(), accounts: remaining };
    });
  }
}
