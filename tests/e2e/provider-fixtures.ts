import type { ElectronApplication } from '@playwright/test';

export async function fixtureProtection(app: ElectronApplication, offline = false) {
  await app.evaluate(async ({ safeStorage, session }, offline) => {
    // Only the external OS/network boundaries are replaced; IPC, validation and profile IO are real.
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(19),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
    safeStorage.encryptStringAsync = async (text) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return Buffer.concat([
        iv,
        Buffer.from(
          await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)),
        ),
      ]);
    };
    safeStorage.decryptStringAsync = async (bytes) => ({
      result: new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(bytes.subarray(0, 12)) },
          key,
          new Uint8Array(bytes.subarray(12)),
        ),
      ),
      shouldReEncrypt: false,
    });
    session.fromPartition('openkraken-providers').fetch = async (input, init) => {
      if (offline) throw new Error('offline');
      if (
        String(input) !== 'https://api.github.com/user' ||
        init?.redirect !== 'error' ||
        init?.credentials !== 'omit'
      )
        throw new Error('Unexpected provider request');
      const auth = new Headers(init.headers).get('authorization');
      return new Response(
        JSON.stringify(
          auth === 'token fixture-pat'
            ? { id: 321, login: 'fixture-user' }
            : { message: `Rejected ${auth}` },
        ),
        {
          status: auth === 'token fixture-pat' ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
  }, offline);
}
