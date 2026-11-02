import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SecretProtection {
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  decrypt(bytes: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
export function electronSecretProtection(
  storage: Pick<
    Electron.SafeStorage,
    | 'isAsyncEncryptionAvailable'
    | 'getSelectedStorageBackend'
    | 'encryptStringAsync'
    | 'decryptStringAsync'
  >,
  platform: NodeJS.Platform = process.platform,
): SecretProtection {
  const available = async () => {
    if (!(await storage.isAsyncEncryptionAvailable())) return false;
    return (
      platform !== 'linux' ||
      ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
        storage.getSelectedStorageBackend(),
      )
    );
  };
  const requireProtection = async () => {
    if (!(await available())) throw new ProviderCredentialError('KEYCHAIN_UNAVAILABLE');
  };
  return {
    available,
    encrypt: async (text) => {
      await requireProtection();
      return storage.encryptStringAsync(text);
    },
    decrypt: async (bytes) => {
      await requireProtection();
      return storage.decryptStringAsync(bytes);
    },
  };
}
export class ProviderCredentialError extends Error {
  constructor(
    public readonly code: 'KEYCHAIN_UNAVAILABLE' | 'CREDENTIAL_INVALID' | 'CREDENTIAL_IO',
  ) {
    super(
      code === 'KEYCHAIN_UNAVAILABLE'
        ? 'Unlock or enable your operating-system keychain to connect a provider.'
        : code === 'CREDENTIAL_INVALID'
          ? 'The saved provider credential could not be read. Reconnect the account.'
          : 'The provider credential could not be stored or removed.',
    );
  }
}
const MAX_BYTES = 128 * 1024;
function valid(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\0\r\n]/.test(value) &&
    Buffer.byteLength(value) <= limit
  );
}
/** Main-process only. Callers bind account IDs to a validated provider, origin and identity. */
export class ProviderVault {
  private queue: Promise<void> = Promise.resolve();
  private directory: string;
  constructor(
    profile: string,
    private protection: SecretProtection,
  ) {
    this.directory = join(profile, 'provider-secrets');
  }
  async available() {
    return this.protection.available().catch(() => false);
  }
  private run<T>(work: () => Promise<T>) {
    const pending = this.queue.then(work, work);
    // Keep only completion in the queue, never a returned plaintext credential.
    this.queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  private path(account: string) {
    if (!valid(account, 4096)) throw new ProviderCredentialError('CREDENTIAL_INVALID');
    return join(this.directory, createHash('sha256').update(account).digest('hex'));
  }
  private async requireProtection() {
    if (!(await this.available())) throw new ProviderCredentialError('KEYCHAIN_UNAVAILABLE');
  }
  private async save(account: string, token: string) {
    const path = this.path(account);
    if (!valid(token, 16384)) throw new ProviderCredentialError('CREDENTIAL_INVALID');
    await this.requireProtection();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const bytes = await this.protection.encrypt(JSON.stringify({ version: 1, account, token }));
      if (!bytes.length || bytes.length > MAX_BYTES)
        throw new ProviderCredentialError('CREDENTIAL_INVALID');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch {
      // Neither OS errors nor filesystem errors may echo credential material to IPC/logs.
      throw new ProviderCredentialError('CREDENTIAL_IO');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  write(account: string, token: string) {
    return this.run(() => this.save(account, token));
  }
  read(account: string): Promise<string | undefined> {
    return this.run(async () => {
      const path = this.path(account);
      await this.requireProtection();
      let file;
      try {
        file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new ProviderCredentialError('CREDENTIAL_INVALID');
      }
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_BYTES)
          throw new ProviderCredentialError('CREDENTIAL_INVALID');
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (!length || length > MAX_BYTES) throw new ProviderCredentialError('CREDENTIAL_INVALID');
        const decrypted = await this.protection.decrypt(bytes.subarray(0, length));
        const value = JSON.parse(decrypted.result);
        if (value?.version !== 1 || value?.account !== account || !valid(value?.token, 16384))
          throw new ProviderCredentialError('CREDENTIAL_INVALID');
        if (decrypted.shouldReEncrypt) await this.save(account, value.token);
        return value.token;
      } catch {
        throw new ProviderCredentialError('CREDENTIAL_INVALID');
      } finally {
        await file.close();
      }
    });
  }
  remove(account: string) {
    return this.run(async () => {
      const path = this.path(account);
      try {
        await rm(path, { force: true });
      } catch {
        throw new ProviderCredentialError('CREDENTIAL_IO');
      }
    });
  }
}
