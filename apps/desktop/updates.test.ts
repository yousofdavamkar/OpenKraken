import { expect, test, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updates } from './src/updates.js';

const keys = generateKeyPairSync('ed25519');
const configuration = {
  feed: 'https://updates.example.test/stable/release.json',
  publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
};
const runtime = { version: '0.1.0', platform: 'linux', arch: 'x64' };
const now = Date.now();
const release = (sequence = 7, version = '0.2.0') => ({
  schemaVersion: 1,
  product: 'org.openkraken.desktop',
  channel: 'stable',
  sequence,
  version,
  issuedAt: now - 1000,
  expiresAt: now + 86400000,
  artifacts: [
    {
      platform: 'linux',
      arch: 'x64',
      format: 'AppImage',
      name: 'OpenKraken.AppImage',
      size: 7,
      sha256: 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
    },
  ],
});

test('corrupt, truncated, oversized and expired downloads never become verified files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-integrity-'));
  let clock = now;
  let body = 'fixture';
  let length: string | undefined;
  let expire = false;
  const updater = new Updates(
    join(root, 'updates'),
    configuration,
    runtime,
    async (url) => {
      if (String(url).endsWith('.json')) return new Response(signed(release()));
      if (expire) clock = now + 2 * 86400000;
      return new Response(body, { headers: length ? { 'Content-Length': length } : undefined });
    },
    () => clock,
  );
  try {
    for (const invalid of ['fixturn', 'fix', 'fixture too long']) {
      body = invalid;
      expect((await updater.check()).phase).toBe('available');
      expect(await updater.download('AppImage')).toMatchObject({
        phase: 'error',
        error: 'integrity',
      });
      await expect(stat(join(root, 'updates/artifact.ready'))).rejects.toThrow();
      await expect(stat(join(root, 'updates/artifact.part'))).rejects.toThrow();
    }
    body = 'fixture';
    length = '100';
    await updater.check();
    expect((await updater.download('AppImage')).error).toBe('integrity');
    length = undefined;
    expire = true;
    await updater.check();
    expect((await updater.download('AppImage')).error).toBe('invalid-release');
    await expect(stat(join(root, 'updates/artifact.ready'))).rejects.toThrow();
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation stops a pending transfer, bounds concurrent operations and allows a fresh check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-cancel-'));
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const updater = new Updates(
    join(root, 'updates'),
    configuration,
    runtime,
    async (url, options) => {
      calls++;
      if (String(url).endsWith('.json')) return new Response(signed(release()));
      entered();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('fix'));
            options!.signal!.addEventListener(
              'abort',
              () => controller.error(options!.signal!.reason),
              { once: true },
            );
          },
        }),
      );
    },
  );
  try {
    await updater.check();
    const download = updater.download('AppImage');
    await started;
    expect((await updater.read()).phase).toBe('downloading');
    await updater.check();
    await updater.download('AppImage');
    expect(calls).toBe(2);
    updater.cancel();
    expect(await download).toMatchObject({ phase: 'error', error: 'cancelled' });
    await expect(stat(join(root, 'updates/artifact.part'))).rejects.toThrow();
    await expect(stat(join(root, 'updates/artifact.ready'))).rejects.toThrow();
    expect((await updater.check()).phase).toBe('available');
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('modified trust state blocks network access and unsupported or older releases cannot download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-storage-'));
  let manifest = signed(release());
  let calls = 0;
  const updater = new Updates(join(root, 'updates'), configuration, runtime, async () => {
    calls++;
    return new Response(manifest);
  });
  try {
    const unsupported = release();
    unsupported.artifacts[0]!.arch = 'arm64';
    manifest = signed(unsupported);
    expect((await updater.check()).phase).toBe('unsupported');
    await updater.download('AppImage');
    expect(calls).toBe(1);
    manifest = signed(release(8, '0.1.0'));
    expect((await updater.check()).phase).toBe('current');
    await updater.download('AppImage');
    expect(calls).toBe(2);
    await writeFile(join(root, 'updates/trusted-release.json'), '{}', { mode: 0o600 });
    expect((await updater.check()).error).toBe('storage');
    expect(calls).toBe(2);
    const restarted = new Updates(join(root, 'updates'), configuration, runtime, async () => {
      throw new Error('Should never reach network');
    });
    expect((await restarted.check()).error).toBe('storage');
    expect(await readFile(join(root, 'updates/trusted-release.json'), 'utf8')).toBe('{}');
    await restarted.close();
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'redirected scratch files are preserved and prevent update networking',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-update-links-'));
    try {
      const initial = new Updates(
        join(root, 'updates'),
        configuration,
        runtime,
        async () => new Response(signed(release())),
      );
      await initial.check();
      await initial.close();
      const outside = join(root, 'outside');
      await writeFile(outside, 'private');
      await symlink(outside, join(root, 'updates/artifact.part'));
      let calls = 0;
      const updater = new Updates(join(root, 'updates'), configuration, runtime, async () => {
        calls++;
        return new Response(signed(release()));
      });
      expect((await updater.check()).error).toBe('storage');
      expect(calls).toBe(0);
      expect(await readFile(outside, 'utf8')).toBe('private');
      await updater.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('a local destination failure releases an unread network response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-response-'));
  let transportSignal: AbortSignal | null | undefined;
  const updater = new Updates(
    join(root, 'updates'),
    configuration,
    runtime,
    async (url, options) => {
      if (String(url).endsWith('.json')) return new Response(signed(release()));
      transportSignal = options?.signal;
      await mkdir(join(root, 'updates/artifact.part'), { mode: 0o700 });
      return new Response(new ReadableStream());
    },
  );
  try {
    await updater.check();
    expect((await updater.download('AppImage')).error).toBe('storage');
    expect(transportSignal?.aborted).toBe(true);
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stalled metadata request has a deadline and reports no remote error details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-timeout-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const updater = new Updates(
    join(root, 'updates'),
    configuration,
    runtime,
    async (_url, options) => {
      entered();
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('PRIVATE-network-diagnostic')),
          { once: true },
        ),
      );
    },
  );
  try {
    const pending = updater.check();
    await started;
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ phase: 'error', error: 'timeout' });
    expect(JSON.stringify(await updater.read())).not.toContain('PRIVATE');
  } finally {
    vi.useRealTimers();
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});
function signed(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: payload.toString('base64'),
    signature: sign(
      null,
      Buffer.concat([Buffer.from('OPENKRAKEN-UPDATE-V1\n'), payload]),
      keys.privateKey,
    ).toString('base64'),
  });
}

test('signed downloads are verified and rollback protection survives an app restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-updates-'));
  const directory = join(root, 'updates');
  let manifest = signed(release());
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const send: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(String(url).endsWith('.json') ? manifest : 'fixture');
  };
  try {
    const disabled = new Updates(directory, null, runtime, send);
    expect((await disabled.check()).phase).toBe('disabled');
    await expect(stat(directory)).rejects.toThrow();
    expect(requests).toHaveLength(0);
    const updater = new Updates(directory, configuration, runtime, send);
    expect(await updater.check()).toMatchObject({
      phase: 'available',
      version: '0.2.0',
      error: null,
    });
    expect(await updater.download('AppImage')).toMatchObject({
      phase: 'verified',
      downloaded: 7,
      error: null,
    });
    expect(await readFile(join(directory, 'artifact.ready'), 'utf8')).toBe('fixture');
    expect(requests.map((request) => request.url)).toEqual([
      configuration.feed,
      'https://updates.example.test/stable/OpenKraken.AppImage',
    ]);
    for (const request of requests)
      expect(request.init).toMatchObject({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    await updater.close();
    const restarted = new Updates(directory, configuration, runtime, send);
    manifest = signed(release(6, '0.3.0'));
    expect(await restarted.check()).toMatchObject({
      phase: 'error',
      error: 'rollback',
      version: null,
    });
    manifest = signed(release(7, '0.3.0'));
    expect(await restarted.check()).toMatchObject({ phase: 'error', error: 'rollback' });
    manifest = signed(release(8, '0.3.0'));
    expect(await restarted.check()).toMatchObject({ phase: 'available', version: '0.3.0' });
    await restarted.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
