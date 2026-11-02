import { afterAll, expect, test } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ProviderVault,
  electronSecretProtection,
  type SecretProtection,
} from './src/provider-vault.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-provider-vault-'));
afterAll(() => rm(root, { recursive: true, force: true }));

// The operating-system boundary is replaced by authenticated encryption for fixture tests.
// This does not establish availability of a real desktop keychain.
function protection(): SecretProtection {
  const key = randomBytes(32);
  return {
    available: async () => true,
    encrypt: async (text) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decrypt: async (value) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(),
        shouldReEncrypt: false,
      };
    },
  };
}

test('provider credentials survive restart as protected bytes and can be replaced and forgotten', async () => {
  const directory = join(root, 'persist');
  const codec = protection();
  const vault = new ProviderVault(directory, codec);
  const account = 'github:https://github.com:fixture-user';
  expect(await vault.read(account)).toBeUndefined();
  await vault.write(account, 'fixture-secret-token');
  const files = await readdir(join(directory, 'provider-secrets'));
  expect(files).toHaveLength(1);
  const path = join(directory, 'provider-secrets', files[0]!);
  const bytes = await readFile(path);
  expect(bytes.includes(Buffer.from('fixture-secret-token'))).toBe(false);
  expect(bytes.includes(Buffer.from(account))).toBe(false);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  const reopened = new ProviderVault(directory, codec);
  expect(await reopened.read(account)).toBe('fixture-secret-token');
  await Promise.all([
    reopened.write(account, 'replacement-token'),
    reopened.write('gitlab:https://gitlab.com:fixture-user', 'other-host-token'),
  ]);
  expect(await reopened.read(account)).toBe('replacement-token');
  await reopened.remove(account);
  expect(await reopened.read(account)).toBeUndefined();
  expect(await reopened.read('gitlab:https://gitlab.com:fixture-user')).toBe('other-host-token');
});

test('Linux plaintext or unknown storage and unavailable OS encryption cannot persist credentials', async () => {
  const directory = join(root, 'unavailable');
  const codec = protection();
  let backend: ReturnType<Electron.SafeStorage['getSelectedStorageBackend']> = 'basic_text';
  let available = true;
  const os = {
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: codec.encrypt,
    decryptStringAsync: codec.decrypt,
  };
  const vault = new ProviderVault(directory, electronSecretProtection(os, 'linux'));
  for (const value of ['basic_text', 'unknown'] as const) {
    backend = value;
    expect(await vault.available()).toBe(false);
    await expect(vault.write('account', 'never-plaintext')).rejects.toMatchObject({
      code: 'KEYCHAIN_UNAVAILABLE',
    });
  }
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  backend = 'gnome_libsecret';
  expect(await vault.available()).toBe(true);
  await vault.write('account', 'protected-token');
  available = false;
  await expect(vault.read('account')).rejects.toMatchObject({ code: 'KEYCHAIN_UNAVAILABLE' });
  // Forgetting a credential must still work while its keychain is locked.
  await vault.remove('account');
  expect(await readdir(join(directory, 'provider-secrets'))).toEqual([]);
});

test('corrupt, swapped and oversized credential files are refused without exposing tokens', async () => {
  const directory = join(root, 'corrupt');
  const vault = new ProviderVault(directory, protection());
  await vault.write('first-account', 'first-secret');
  const first = (await readdir(join(directory, 'provider-secrets')))[0]!;
  await vault.write('second-account', 'second-secret');
  const second = (await readdir(join(directory, 'provider-secrets'))).find(
    (name) => name !== first,
  )!;
  const firstPath = join(directory, 'provider-secrets', first);
  const secondPath = join(directory, 'provider-secrets', second);
  await copyFile(firstPath, secondPath);
  await expect(vault.read('second-account')).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  await writeFile(firstPath, Buffer.alloc(128 * 1024 + 1));
  await expect(vault.read('first-account')).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  await writeFile(firstPath, 'first-secret');
  await expect(vault.read('first-account')).rejects.toThrow(
    'The saved provider credential could not be read. Reconnect the account.',
  );
  await expect(vault.write('first-account', 'x'.repeat(16385))).rejects.toMatchObject({
    code: 'CREDENTIAL_INVALID',
  });
  await vault.write('first-account', 'reconnected-secret');
  expect(await vault.read('first-account')).toBe('reconnected-secret');
});

test('OS key rotation refreshes ciphertext; an encryption failure preserves the previous credential', async () => {
  const directory = join(root, 'rotation');
  const codec = protection();
  const vault = new ProviderVault(directory, codec);
  await vault.write('account', 'retained-secret');
  const path = join(
    directory,
    'provider-secrets',
    (await readdir(join(directory, 'provider-secrets')))[0]!,
  );
  const previous = await readFile(path);
  const rotated = new ProviderVault(directory, {
    ...codec,
    decrypt: async (bytes) => ({ ...(await codec.decrypt(bytes)), shouldReEncrypt: true }),
  });
  expect(await rotated.read('account')).toBe('retained-secret');
  expect((await readFile(path)).equals(previous)).toBe(false);
  expect(await vault.read('account')).toBe('retained-secret');
  const failing = new ProviderVault(directory, {
    ...codec,
    encrypt: async (text) => {
      throw new Error(`OS failure with ${text}`);
    },
  });
  await expect(failing.write('account', 'must-not-leak')).rejects.toThrow(
    'The provider credential could not be stored or removed.',
  );
  expect(await vault.read('account')).toBe('retained-secret');
  expect(await readdir(join(directory, 'provider-secrets'))).toHaveLength(1);
});
