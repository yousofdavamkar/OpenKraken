import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { updateConfiguration, verifyUpdateRelease } from './src/update-protocol.js';

async function publisherFixture(directory: string) {
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
  const invoke = (output = 'release.json', nodeArgs: string[] = [], input = 'release-input.json') =>
    promisify(execFile)(
      process.execPath,
      [...nodeArgs, resolve('scripts/sign-update.mjs'), input, 'private.pem', output],
      { cwd: directory },
    );
  return { publicKey, descriptor, now, invoke };
}

test('the release publisher signs actual artifact bytes and refuses invalid or overwritten output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-publisher-'));
  try {
    const { publicKey, descriptor, now, invoke } = await publisherFixture(directory);
    const result = await invoke();
    expect(result.stdout + result.stderr).not.toContain('PRIVATE KEY');
    const signed = await readFile(join(directory, 'release.json'), 'utf8');
    const config = updateConfiguration({
      feed: 'https://updates.example.test/release.json',
      publicKey,
    })!;
    const { release } = verifyUpdateRelease(signed, config, now);
    expect(JSON.parse(result.stdout)).toEqual({
      publicKey,
      sequence: release.sequence,
      version: release.version,
      channel: release.channel,
      artifacts: release.artifacts,
    });
    expect(release.artifacts).toEqual([
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
    descriptor.channel = 'beta';
    await writeFile(join(directory, 'release-input.json'), JSON.stringify(descriptor));
    await invoke('beta.json');
    const signedBeta = await readFile(join(directory, 'beta.json'), 'utf8');
    expect(
      verifyUpdateRelease(signedBeta, { ...config, channel: 'beta' }, now).release.version,
    ).toBe(descriptor.version);
    expect(() => verifyUpdateRelease(signedBeta, config, now)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(['write failure', 'sync failure', 'process exit'])(
  'the final release name remains available for retry after %s',
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-interruption-'));
    try {
      const { publicKey, now, invoke } = await publisherFixture(directory);
      const hook = join(directory, 'interrupt.mjs');
      await writeFile(
        hook,
        `
        import { open } from 'node:fs/promises';
        const file = await open('release-input.json', 'r');
        const prototype = Object.getPrototypeOf(file);
        await file.close();
        const write = prototype.writeFile;
        prototype.writeFile = async function(data, ...args) {
          if (typeof data !== 'string' || !data.startsWith('{"payload":')) return write.call(this, data, ...args);
          if (${failure === 'sync failure'}) {
            await write.call(this, data, ...args);
            this.sync = async () => { throw new Error('simulated sync failure'); };
            return;
          }
          await write.call(this, data.slice(0, 12));
          ${failure === 'process exit' ? 'process.exit(17)' : 'throw new Error("simulated write failure")'};
        };
      `,
      );
      const before = (await readdir(directory)).sort();
      await expect(invoke('release.json', ['--import', './interrupt.mjs'])).rejects.toThrow();
      await expect(readFile(join(directory, 'release.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      if (failure !== 'process exit') expect((await readdir(directory)).sort()).toEqual(before);
      await invoke();
      const signed = await readFile(join(directory, 'release.json'), 'utf8');
      expect(
        verifyUpdateRelease(
          signed,
          { feed: 'https://updates.example.test/release.json', publicKey },
          now,
        ).release.sequence,
      ).toBe(7);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('concurrent signers publish exactly one complete release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-race-'));
  try {
    const { publicKey, descriptor, now, invoke } = await publisherFixture(directory);
    await writeFile(join(directory, 'other.json'), JSON.stringify({ ...descriptor, sequence: 8 }));
    const before = (await readdir(directory)).sort();
    const results = await Promise.allSettled([invoke(), invoke('release.json', [], 'other.json')]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const signed = await readFile(join(directory, 'release.json'), 'utf8');
    expect(
      verifyUpdateRelease(
        signed,
        { feed: 'https://updates.example.test/release.json', publicKey },
        now,
      ).release.sequence,
    ).toBe(JSON.parse(winners[0]!.value.stdout).sequence);
    expect((await readdir(directory)).sort()).toEqual([...before, 'release.json'].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
