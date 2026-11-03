import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { updateConfiguration, verifyUpdateRelease } from './src/update-protocol.js';

test('the release publisher signs actual artifact bytes and refuses invalid or overwritten output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-publisher-'));
  try {
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await writeFile(
      join(directory, 'private.pem'),
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, 'OpenKraken-0.2.0.AppImage'), 'fixture');
    const now = Date.now();
    const descriptor = {
      schemaVersion: 1,
      product: 'org.openkraken.desktop',
      channel: 'stable',
      sequence: 7,
      version: '0.2.0',
      issuedAt: now - 1000,
      expiresAt: now + 86400000,
      artifacts: [
        { platform: 'linux', arch: 'x64', format: 'AppImage', path: 'OpenKraken-0.2.0.AppImage' },
      ],
    };
    await writeFile(join(directory, 'release-input.json'), JSON.stringify(descriptor));
    const invoke = (output = 'release.json') =>
      promisify(execFile)(
        process.execPath,
        [resolve('scripts/sign-update.mjs'), 'release-input.json', 'private.pem', output],
        { cwd: directory },
      );
    const result = await invoke();
    expect(result.stdout).toContain(publicKey);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE KEY');
    const signed = await readFile(join(directory, 'release.json'), 'utf8');
    const config = updateConfiguration({
      feed: 'https://updates.example.test/release.json',
      publicKey,
    })!;
    expect(verifyUpdateRelease(signed, config, now).release.artifacts).toEqual([
      {
        platform: 'linux',
        arch: 'x64',
        format: 'AppImage',
        name: 'OpenKraken-0.2.0.AppImage',
        size: 7,
        sha256: 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
      },
    ]);
    await expect(invoke()).rejects.toThrow();
    expect(await readFile(join(directory, 'release.json'), 'utf8')).toBe(signed);
    descriptor.artifacts[0]!.path = 'missing.AppImage';
    await writeFile(join(directory, 'release-input.json'), JSON.stringify(descriptor));
    await expect(invoke('missing.json')).rejects.toThrow();
    await expect(readFile(join(directory, 'missing.json'))).rejects.toThrow();
    descriptor.artifacts[0]!.path = 'OpenKraken-0.2.0.AppImage';
    descriptor.version = '0.2.0-beta.1';
    await writeFile(join(directory, 'release-input.json'), JSON.stringify(descriptor));
    await expect(invoke('invalid.json')).rejects.toThrow();
    await expect(readFile(join(directory, 'invalid.json'))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
