import { expect, test, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
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

test('a native restoration notice survives restart until explicitly dismissed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-restored-notice-'));
  const file = join(root, 'rollback-notice.json');
  let updater = new Updates(root, configuration, runtime);
  try {
    await updater.read();
    await updater.close();
    await writeFile(file, JSON.stringify({ schemaVersion: 1, outcome: 'restored' }), {
      mode: 0o600,
    });
    updater = new Updates(root, configuration, runtime);
    expect((await updater.started()).recovery).toBe('restored');
    await updater.close();
    updater = new Updates(root, configuration, runtime);
    expect((await updater.started()).recovery).toBe('restored');
    expect((await updater.dismissRecovery()).recovery).toBeNull();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await updater.close();
    await writeFile(file, '{}', { mode: 0o600 });
    updater = new Updates(root, configuration, runtime);
    expect(await updater.read()).toMatchObject({ error: 'storage', recovery: null });
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('automatic checks require saved consent and stale preference changes cannot overwrite it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-preferences-'));
  const directory = join(root, 'updates');
  const send = vi.fn<typeof fetch>(async () => new Response(signed(release())));
  const updater = new Updates(directory, configuration, runtime, send);
  try {
    expect((await updater.started()).automatic).toMatchObject({ enabled: false, revision: null });
    const enabled = await updater.setAutomatic(true, null);
    expect(enabled.automatic).toMatchObject({ enabled: true, warning: null });
    expect(enabled.automatic.revision).toBeTruthy();
    await expect(updater.setAutomatic(false, null)).rejects.toThrow('changed');
    expect((await updater.read()).automatic.enabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await updater.close();
    const restarted = new Updates(directory, configuration, runtime, send);
    try {
      expect((await restarted.started()).automatic).toEqual(enabled.automatic);
      const disabled = await restarted.setAutomatic(false, enabled.automatic.revision);
      expect(disabled.automatic).toMatchObject({ enabled: false, nextCheckAt: null });
      expect(disabled.automatic.revision).not.toBe(enabled.automatic.revision);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await restarted.close();
    }
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('consented checks wait for startup, repeat every ten hours and retain their deadline across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-schedule-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(now);
  const send = vi.fn<typeof fetch>(async () => new Response(signed(release())));
  let updater = new Updates(join(root, 'updates'), configuration, runtime, send);
  try {
    await updater.started();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(send).not.toHaveBeenCalled();
    await updater.setAutomatic(true, null);
    await vi.advanceTimersByTimeAsync(29999);
    expect(send).not.toHaveBeenCalled();
    await updater.started(); // A renderer remount must not postpone the scheduled check.
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(async () => (await updater.read()).phase).toBe('available');
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(35999999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(() => send.mock.calls.length).toBe(2);
    const saved = (await updater.read()).automatic;
    await updater.close();
    updater = new Updates(join(root, 'updates'), configuration, runtime, send);
    await updater.started();
    await vi.advanceTimersByTimeAsync(30000);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await updater.read()).automatic).toEqual(saved);
    await updater.setAutomatic(false, saved.revision);
    await vi.advanceTimersByTimeAsync(36000000);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    await updater.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('background checks preserve verified downloads and changed consent stops automatic networking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-background-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(now);
  const directory = join(root, 'updates');
  const send = vi.fn<typeof fetch>(
    async (url) => new Response(String(url).endsWith('.json') ? signed(release()) : 'fixture'),
  );
  const updater = new Updates(directory, configuration, runtime, send);
  try {
    await updater.started();
    await updater.setAutomatic(true, null);
    await updater.check();
    await updater.download('AppImage');
    await vi.advanceTimersByTimeAsync(36_000_000);
    await expect
      .poll(async () => (await updater.read()).automatic.nextCheckAt)
      .toBe(now + 72_000_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await updater.read()).phase).toBe('verified');
    expect(await readFile(join(directory, 'artifact.ready'), 'utf8')).toBe('fixture');
    await writeFile(join(directory, 'automatic-checks.json'), '{}', { mode: 0o600 });
    await vi.advanceTimersByTimeAsync(36_000_000);
    await expect
      .poll(async () => (await updater.read()).automatic)
      .toMatchObject({ enabled: false, warning: 'storage' });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await updater.check()).phase).toBe('available');
    expect(await readFile(join(directory, 'automatic-checks.json'), 'utf8')).toBe('{}');
  } finally {
    await updater.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('opting out aborts a scheduled request but preserves a user-initiated transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-optout-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(now);
  let signal: AbortSignal | null | undefined;
  const getSignal = (): AbortSignal | null | undefined => signal;
  const send: typeof fetch = async (_url, options) => {
    signal = options?.signal;
    return new Promise((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
    );
  };
  const updater = new Updates(join(root, 'updates'), configuration, runtime, send);
  try {
    await updater.started();
    let enabled = await updater.setAutomatic(true, null);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect.poll(() => signal).toBeTruthy();
    const backgroundSignal = signal;
    let disabled = await updater.setAutomatic(false, enabled.automatic.revision);
    expect(backgroundSignal?.aborted).toBe(true);
    await expect.poll(async () => (await updater.read()).error).toBe('cancelled');
    enabled = await updater.setAutomatic(true, disabled.automatic.revision);
    signal = undefined;
    const manual = updater.check();
    await expect.poll(() => signal).toBeTruthy();
    disabled = await updater.setAutomatic(false, enabled.automatic.revision);
    expect(disabled.automatic.enabled).toBe(false);
    expect(getSignal()?.aborted).toBe(false);
    updater.cancel();
    expect((await manual).error).toBe('cancelled');
  } finally {
    await updater.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('unreadable automatic settings cannot authorize network checks after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-invalid-consent-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    for (const kind of ['corrupt', 'redirected']) {
      if (kind === 'redirected' && process.platform === 'win32') continue;
      vi.setSystemTime(now);
      const directory = join(root, kind);
      const send = vi.fn<typeof fetch>(async () => new Response(signed(release())));
      const initial = new Updates(directory, configuration, runtime, send);
      await initial.started();
      await initial.setAutomatic(true, null);
      await initial.close();
      const file = join(directory, 'automatic-checks.json');
      if (kind === 'corrupt') await writeFile(file, 'private-invalid-preference');
      else {
        await writeFile(join(root, 'outside'), await readFile(file));
        await rm(file);
        await symlink(join(root, 'outside'), file);
      }
      const restarted = new Updates(directory, configuration, runtime, send);
      try {
        expect((await restarted.started()).automatic).toMatchObject({
          enabled: false,
          warning: 'storage',
        });
        await vi.advanceTimersByTimeAsync(36_000_000);
        expect(send).not.toHaveBeenCalled();
        expect(JSON.stringify(await restarted.read())).not.toContain('private-invalid-preference');
        expect((await restarted.check()).phase).toBe('available');
      } finally {
        await restarted.close();
      }
    }
  } finally {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
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

test.skipIf(process.platform !== 'linux')(
  'install consent binds a verified download and replacement waits for accepted shutdown',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-install-flow-'));
    const target = join(root, 'OpenKraken.AppImage');
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    header.set([0x41, 0x49, 2], 8);
    header.writeUInt16LE(62, 18);
    const oldImage = Buffer.concat([header, Buffer.from('old')]);
    const nextImage = Buffer.concat([header, Buffer.from('new')]);
    const metadata = release();
    metadata.artifacts[0]!.size = nextImage.length;
    metadata.artifacts[0]!.sha256 = createHash('sha256').update(nextImage).digest('hex');
    let installClock = now;
    const updater = new Updates(
      join(root, 'updates'),
      configuration,
      { ...runtime, appImage: target },
      async (url) => new Response(String(url).endsWith('.json') ? signed(metadata) : nextImage),
      () => installClock,
    );
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await updater.started();
      await updater.check();
      let verified = await updater.download('AppImage');
      await writeFile(join(root, 'updates/artifact.ready'), 'tampered cache');
      expect((await updater.prepareInstall(verified.installId!)).error).toBe('installation');
      expect(await readFile(target)).toEqual(oldImage);
      await updater.check();
      verified = await updater.download('AppImage');
      expect(verified.installId).toBeTruthy();
      expect((await updater.prepareInstall(crypto.randomUUID())).phase).toBe('verified');
      expect((await updater.prepareInstall(verified.installId!)).phase).toBe('restart-ready');
      expect(await readFile(target)).toEqual(oldImage);
      await updater.started(); // Renderer remount cannot clean an active install transaction.
      const cancelled = await updater.abandonInstall();
      expect(cancelled.phase).toBe('verified');
      expect(cancelled.installId).not.toBe(verified.installId);
      expect((await updater.prepareInstall(verified.installId!)).phase).toBe('verified');
      expect((await updater.prepareInstall(cancelled.installId!)).phase).toBe('restart-ready');
      installClock = now + 2 * 86400000;
      expect(await updater.commitInstall()).toBeNull();
      expect(await readFile(target)).toEqual(oldImage);
      installClock = now;
      await updater.check();
      verified = await updater.download('AppImage');
      expect((await updater.prepareInstall(verified.installId!)).phase).toBe('restart-ready');
      expect(await updater.commitInstall()).toMatchObject({ target });
      expect(await readFile(target)).toEqual(nextImage);
      await updater.close();
      const restarted = new Updates(join(root, 'updates'), configuration, {
        ...runtime,
        version: '0.2.0',
        appImage: target,
      });
      await restarted.started();
      await expect(stat(target + '.openkraken-update')).rejects.toMatchObject({ code: 'ENOENT' });
      await restarted.close();
    } finally {
      await updater.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
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
    expect((await disabled.started()).automatic).toMatchObject({ enabled: false, host: null });
    await expect(disabled.setAutomatic(true, null)).rejects.toThrow('unavailable');
    await disabled.close();
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
