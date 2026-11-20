import { expect, test, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updates } from './src/updates.js';
import * as transfer from './src/update-transfer.js';

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

test.each([
  ['linux', 'deb'],
  ['linux', 'rpm'],
  ['darwin', 'dmg'],
  ['darwin', 'zip'],
  ['win32', 'msi'],
  ['linux', 'AppImage'],
])('exports the signed %s %s installer to a chosen file', async (platform, format) => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-export-'));
  const metadata = release();
  const name = 'OpenKraken-0.2.0.' + format;
  Object.assign(metadata.artifacts[0]!, { platform, format, name });
  const updater = new Updates(
    join(root, 'updates'),
    configuration,
    { ...runtime, platform },
    async (url) => new Response(String(url) === configuration.feed ? signed(metadata) : 'fixture'),
  );
  try {
    await updater.check();
    const verified = await updater.download(format);
    expect(verified.saveId).toBeTruthy();
    const path = join(root, name);
    await writeFile(path, 'old file');
    const choose = vi.fn(async () => path);
    await updater.save('stale', choose);
    expect(choose).not.toHaveBeenCalled();
    expect((await updater.save(verified.saveId!, async () => undefined)).phase).toBe('verified');
    expect((await updater.save(verified.saveId!, choose)).phase).toBe('saved');
    expect(choose).toHaveBeenCalledWith(name);
    expect(await readFile(path, 'utf8')).toBe('fixture');
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  'changed bytes',
  'expired release',
  'changed trust',
  'invalid destination',
  'replaced selection',
])('preserves the destination after %s during installer export', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-export-failure-'));
  const cache = join(root, 'updates');
  const destination = join(root, 'OpenKraken.AppImage');
  let clock = now;
  const updater = new Updates(
    cache,
    configuration,
    runtime,
    async (url) => new Response(String(url) === configuration.feed ? signed(release()) : 'fixture'),
    () => clock,
  );
  try {
    await writeFile(destination, 'keep');
    await updater.check();
    const { saveId } = await updater.download('AppImage');
    expect(saveId).toBeTruthy();
    const result = await updater.save(saveId!, async () => {
      if (scenario === 'changed bytes') await writeFile(join(cache, 'artifact.ready'), 'altered');
      if (scenario === 'expired release') clock = release().expiresAt + 1;
      if (scenario === 'changed trust') await writeFile(join(cache, 'trusted-release.json'), '{}');
      if (scenario === 'replaced selection') {
        const secondPicker = vi.fn(async () => destination);
        await updater.save(saveId!, secondPicker);
        expect(secondPicker).not.toHaveBeenCalled();
        await updater.check();
        await updater.download('AppImage');
      }
      if (scenario === 'invalid destination') return join(cache, 'installer.AppImage');
      return destination;
    });
    expect(await readFile(destination, 'utf8')).toBe('keep');
    expect((await readdir(root)).sort()).toEqual(['OpenKraken.AppImage', 'updates']);
    switch (scenario) {
      case 'changed bytes':
        expect(result.error).toBe('integrity');
        break;
      case 'changed trust':
        expect(result.error).toBe('storage');
        break;
      case 'expired release':
        expect(result.error).toBe('invalid-release');
        break;
      case 'replaced selection':
        expect(result.phase).toBe('verified');
        expect(result.saveId).not.toBe(saveId);
        break;
      case 'invalid destination':
        expect(result).toMatchObject({ phase: 'verified', error: 'save', saveId });
        expect((await updater.save(saveId!, async () => destination + '.txt')).error).toBe('save');
        expect((await updater.save(saveId!, async () => destination)).phase).toBe('saved');
        expect(await readFile(destination, 'utf8')).toBe('fixture');
        break;
    }
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['cancel', 'destination changed', 'release expired'])(
  'checks for %s before publishing the staged installer',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-export-publish-'));
    const destination = join(root, 'Installer.AppImage');
    const cache = join(root, 'updates');
    // The clock is consulted when the signed release is revalidated before publication.
    const updater = new Updates(
      cache,
      configuration,
      runtime,
      async (url) =>
        new Response(String(url) === configuration.feed ? signed(release()) : 'fixture'),
      () => {
        if (readdirSync(root).some((entry) => entry.startsWith('.openkraken-'))) {
          if (scenario === 'cancel') updater.cancel();
          if (scenario === 'destination changed')
            writeFileSync(destination, 'new external contents');
          if (scenario === 'release expired') return release().expiresAt;
        }
        return now;
      },
    );
    try {
      await writeFile(destination, 'existing');
      await updater.check();
      const { saveId } = await updater.download('AppImage');
      const result = await updater.save(saveId!, async () => destination);
      const expected = scenario === 'destination changed' ? 'new external contents' : 'existing';
      expect(await readFile(destination, 'utf8')).toBe(expected);
      expect((await readdir(root)).sort()).toEqual(['Installer.AppImage', 'updates']);
      if (scenario === 'release expired') expect(result.error).toBe('invalid-release');
      else
        expect(result).toMatchObject({
          phase: 'verified',
          saveId,
          error: scenario === 'cancel' ? 'cancelled' : 'save',
        });
    } finally {
      await updater.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test.each(['complete', 'partial', 'invalid outcome', 'already published', 'invalid published'])(
  'reopens a native rollback notice interrupted before publication (%s)',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-pending-rollback-'));
    const temporary = join(root, 'rollback-notice.tmp');
    const published = join(root, 'rollback-notice.json');
    const notice = JSON.stringify({ schemaVersion: 1, outcome: 'restored' });
    await writeFile(
      temporary,
      scenario === 'partial' ? notice.slice(0, -1) : scenario === 'invalid outcome' ? '{}' : notice,
      { mode: 0o600 },
    );
    if (scenario === 'already published')
      await writeFile(published, notice + '\n', { mode: 0o600 });
    if (scenario === 'invalid published') await writeFile(published, '{}', { mode: 0o600 });
    let updater = new Updates(root, configuration, runtime);
    try {
      const state = await updater.started();
      if (scenario === 'invalid published') {
        expect(state).toMatchObject({ error: 'storage', recovery: null });
        expect(await readFile(published, 'utf8')).toBe('{}');
        return;
      }
      if (scenario !== 'complete')
        await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
      if (scenario === 'partial' || scenario === 'invalid outcome') {
        expect(state).toMatchObject({ error: null, recovery: null });
        await expect(stat(published)).rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      expect(state).toMatchObject({ error: null, recovery: 'restored' });
      expect(await readFile(scenario === 'complete' ? temporary : published, 'utf8')).toBe(
        scenario === 'already published' ? notice + '\n' : notice,
      );
      await updater.close();
      updater = new Updates(root, configuration, runtime);
      expect((await updater.started()).recovery).toBe('restored');
      expect((await updater.dismissRecovery()).recovery).toBeNull();
      await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(published)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await updater.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(['restored', 'changed'])(
  'dismissal after native publication checks the %s notice',
  async (contents) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-rollback-dismissal-'));
    const temporary = join(root, 'rollback-notice.tmp');
    const published = join(root, 'rollback-notice.json');
    await writeFile(temporary, '{"schemaVersion":1,"outcome":"restored"}', { mode: 0o600 });
    const updater = new Updates(root, configuration, runtime);
    try {
      expect((await updater.started()).recovery).toBe('restored');
      await rename(temporary, published);
      if (contents === 'changed') {
        await writeFile(published, '{}');
        await expect(updater.dismissRecovery()).rejects.toThrow('Update recovery notice changed');
        expect(await readFile(published, 'utf8')).toBe('{}');
      } else {
        expect((await updater.dismissRecovery()).recovery).toBeNull();
        await expect(stat(published)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await updater.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test('shutdown finishes an admitted opt-out before restarting automatic update checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-opt-out-'));
  const send = vi.fn<typeof fetch>();
  let updater = new Updates(directory, configuration, runtime, send);
  try {
    await updater.started();
    const { automatic } = await updater.setAutomatic(true, null);
    const saving = updater.setAutomatic(false, automatic.revision);
    const closing = updater.close();
    const [saved] = await Promise.all([saving, closing]);
    expect(saved.automatic).toMatchObject({ enabled: false, nextCheckAt: null });
    await expect(updater.setAutomatic(true, saved.automatic.revision)).rejects.toThrow(
      'unavailable',
    );
    updater = new Updates(directory, configuration, runtime, send);
    expect((await updater.started()).automatic).toEqual(saved.automatic);
    expect(send).not.toHaveBeenCalled();
  } finally {
    await updater.close();
    await rm(directory, { recursive: true, force: true });
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
  const envelope = signed({ ...release(), expiresAt: now + 2 * 86_400_000 });
  const send = vi.fn<typeof fetch>(
    async (url) => new Response(String(url).endsWith('.json') ? envelope : 'fixture'),
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
    const { saveId } = await updater.read();
    await updater.save(saveId!, async () => join(root, 'Installer.AppImage'));
    await vi.advanceTimersByTimeAsync(36_000_000);
    await expect.poll(async () => (await updater.read()).phase).toBe('available');
    expect(send).toHaveBeenCalledTimes(3);
    await writeFile(join(directory, 'automatic-checks.json'), '{}', { mode: 0o600 });
    await vi.advanceTimersByTimeAsync(36_000_000);
    await expect
      .poll(async () => (await updater.read()).automatic)
      .toMatchObject({ enabled: false, warning: 'storage' });
    expect(send).toHaveBeenCalledTimes(3);
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

test('a signed release from the other channel cannot advance the saved sequence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-channel-'));
  const path = join(directory, 'trusted-release.json');
  let manifest = signed(release());
  const fetchRelease = async () => new Response(manifest);
  let updater = new Updates(directory, configuration, runtime, fetchRelease);
  try {
    expect((await updater.check()).phase).toBe('available');
    const watermark = await readFile(path, 'utf8');
    expect(JSON.parse(watermark).configuration).toBe(
      createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
    );
    await updater.close();
    updater = new Updates(
      directory,
      { ...configuration, channel: 'stable' },
      runtime,
      fetchRelease,
    );
    manifest = signed({ ...release(99, '0.3.0-beta.1'), channel: 'beta' });
    expect(await updater.check()).toMatchObject({
      phase: 'error',
      error: 'invalid-release',
      channel: 'stable',
    });
    expect(await readFile(path, 'utf8')).toBe(watermark);
    manifest = signed(release(8, '0.2.1'));
    expect(await updater.check()).toMatchObject({ phase: 'available', version: '0.2.1' });
  } finally {
    await updater.close();
    await rm(directory, { recursive: true, force: true });
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
      expect(updater.restartPlan()).toBeNull();
      expect((await updater.prepareInstall(crypto.randomUUID())).phase).toBe('verified');
      expect((await updater.prepareInstall(verified.installId!)).phase).toBe('restart-ready');
      expect(await readFile(target)).toEqual(oldImage);
      const plan = updater.restartPlan()!;
      expect(plan).toEqual({
        target,
        size: nextImage.length,
        sha256: metadata.artifacts[0]!.sha256,
        recovery: {
          previous: {
            size: oldImage.length,
            sha256: createHash('sha256').update(oldImage).digest('hex'),
          },
          journalSha256: createHash('sha256')
            .update(await readFile(target + '.openkraken-update/transaction.json'))
            .digest('hex'),
        },
      });
      plan.recovery.previous.sha256 = '0'.repeat(64);
      expect(updater.restartPlan()!.recovery.previous.sha256).not.toBe(
        plan.recovery.previous.sha256,
      );
      await updater.started(); // Renderer remount cannot clean an active install transaction.
      const [cancelled, concurrentCancel] = await Promise.all([
        updater.abandonInstall(),
        updater.abandonInstall(),
      ]);
      expect(concurrentCancel).toEqual(cancelled);
      expect(updater.restartPlan()).toBeNull();
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
function signed(value: unknown, key = keys.privateKey) {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: payload.toString('base64'),
    signature: sign(
      null,
      Buffer.concat([Buffer.from('OPENKRAKEN-UPDATE-V1\n'), payload]),
      key,
    ).toString('base64'),
  });
}

test.each([
  'matching file',
  'rejected check then retry',
  'changed bytes',
  'new release',
  'partial file',
])('restarts after a verified download with %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-restart-download-'));
  const directory = join(root, 'updates');
  let manifest = signed(release());
  const artifactRequests: string[] = [];
  const send: typeof fetch = async (url) => {
    if (String(url) === configuration.feed) return new Response(manifest);
    artifactRequests.push(String(url));
    return new Response('fixture');
  };
  let updater = new Updates(directory, configuration, runtime, send);
  try {
    await updater.check();
    const previous = await updater.download('AppImage');
    expect(previous.phase).toBe('verified');
    await updater.close();
    const ready = join(directory, 'artifact.ready');
    if (scenario === 'changed bytes') await writeFile(ready, 'changed');
    if (scenario === 'new release') manifest = signed(release(8, '0.3.0'));
    if (scenario === 'partial file') await rename(ready, join(directory, 'artifact.part'));
    updater = new Updates(directory, configuration, runtime, send);
    expect((await updater.started()).phase).toBe('idle');
    expect((await updater.download('AppImage')).phase).toBe('idle');
    const stalePicker = vi.fn();
    await updater.save(previous.saveId!, stalePicker);
    expect(stalePicker).not.toHaveBeenCalled();
    if (scenario === 'rejected check then retry') {
      manifest = signed(release(6));
      expect((await updater.check()).error).toBe('rollback');
      expect((await updater.download('AppImage')).phase).toBe('error');
      manifest = signed(release());
    }
    expect((await updater.check()).phase).toBe('available');
    const verified = await updater.download('AppImage');
    expect(verified).toMatchObject({ phase: 'verified', downloaded: 7 });
    expect(verified.saveId).not.toBe(previous.saveId);
    expect(artifactRequests).toHaveLength(
      ['matching file', 'rejected check then retry'].includes(scenario) ? 1 : 2,
    );
    const destination = join(root, 'recovered.AppImage');
    expect((await updater.save(verified.saveId!, async () => destination)).phase).toBe('saved');
    expect(await readFile(destination, 'utf8')).toBe('fixture');
  } finally {
    await updater.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['cancel', 'expire'])(
  'can %s a recovered installer during verification',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-recheck-'));
    const directory = join(root, 'updates');
    let clock = now;
    const send = vi.fn<typeof fetch>(
      async (url) =>
        new Response(String(url) === configuration.feed ? signed(release()) : 'fixture'),
    );
    let updater = new Updates(directory, configuration, runtime, send, () => clock);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await updater.check();
      await updater.download('AppImage');
      await updater.close();
      updater = new Updates(directory, configuration, runtime, send, () => clock);
      await updater.check();
      let reached!: () => void;
      const hashed = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const verify = transfer.verifyUpdateArtifact;
      vi.spyOn(transfer, 'verifyUpdateArtifact').mockImplementationOnce(async (...args) => {
        await verify(...args);
        reached();
        await gate;
      });
      const recovering = updater.download('AppImage');
      await hashed;
      expect(await updater.read()).toMatchObject({ phase: 'verifying', downloaded: 7 });
      if (scenario === 'cancel') updater.cancel();
      else clock = release().expiresAt + 1;
      finish();
      const result = await recovering;
      expect(result).toMatchObject({
        phase: 'error',
        error: scenario === 'cancel' ? 'cancelled' : 'invalid-release',
        installId: null,
      });
      expect(result.saveId).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(3);
      if (scenario === 'cancel') {
        expect((await updater.check()).phase).toBe('available');
        expect((await updater.download('AppImage')).phase).toBe('verified');
        expect(send).toHaveBeenCalledTimes(4);
      }
    } finally {
      finish();
      await updater.close();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test.each(['stable', 'beta'] as const)(
  'a trusted %s build moves the feed and verification key without resetting release history',
  async (channel) => {
    const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-migration-'));
    const old = { ...configuration, channel };
    const keysNext = generateKeyPairSync('ed25519');
    const next = {
      channel,
      feed: 'https://new.example.test/desktop/release.json',
      publicKey: keysNext.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    const current = {
      ...release(),
      channel,
      version: channel === 'beta' ? '0.2.0-beta.1' : '0.2.0',
    };
    let envelope = signed(current);
    const send = vi.fn(async (_url: string | URL | Request) => new Response(envelope));
    let updater = new Updates(directory, old, runtime, send);
    try {
      expect((await updater.check()).phase).toBe('available');
      const enabled = await updater.setAutomatic(true, null);
      await updater.close();
      const watermark = join(directory, 'trusted-release.json');
      const original = await readFile(watermark, 'utf8');
      const consent = join(directory, 'automatic-checks.json');
      const originalConsent = await readFile(consent, 'utf8');
      // The release builds predating migration hashed these exact JSON fields in order.
      const legacyBytes = JSON.stringify(
        channel === 'stable' ? configuration : { channel, ...configuration },
      );
      const legacyBinding = createHash('sha256').update(legacyBytes).digest('hex');
      expect(JSON.parse(original).configuration).toBe(legacyBinding);
      expect(JSON.parse(originalConsent).configuration).toBe(legacyBinding);
      send.mockClear();
      for (const config of [
        next,
        { ...next, migrateFrom: { ...configuration, feed: next.feed } },
        { ...next, channel: channel === 'beta' ? 'stable' : 'beta', migrateFrom: configuration },
      ]) {
        updater = new Updates(directory, config, runtime, send);
        expect((await updater.check()).error).toBe('storage');
        await updater.close();
        expect(await readFile(watermark, 'utf8')).toBe(original);
        expect(await readFile(consent, 'utf8')).toBe(originalConsent);
      }
      updater = new Updates(directory, { ...next, migrateFrom: configuration }, runtime, send);
      expect((await updater.started()).automatic).toMatchObject({
        host: 'new.example.test',
        enabled: false,
        revision: null,
        warning: null,
      });
      expect(send).not.toHaveBeenCalled();
      await expect(updater.setAutomatic(true, enabled.automatic.revision)).rejects.toThrow(
        'changed',
      );
      expect((await updater.check()).error).toBe('invalid-release');
      envelope = signed({ ...current, sequence: 6 }, keysNext.privateKey);
      expect((await updater.check()).error).toBe('rollback');
      envelope = signed({ ...current, expiresAt: current.expiresAt + 1 }, keysNext.privateKey);
      expect((await updater.check()).error).toBe('rollback');
      expect(await readFile(watermark, 'utf8')).toBe(original);
      envelope = signed(current, keysNext.privateKey);
      expect((await updater.check()).phase).toBe('available');
      const migrated = JSON.parse(await readFile(watermark, 'utf8'));
      expect(migrated).toMatchObject({ sequence: 7, digest: JSON.parse(original).digest });
      expect(migrated.configuration).not.toBe(JSON.parse(original).configuration);
      expect(send.mock.calls.every(([url]) => String(url) === next.feed)).toBe(true);
      await updater.close();
      updater = new Updates(directory, next, runtime, send);
      expect((await updater.started()).automatic).toMatchObject({ enabled: false, warning: null });
      envelope = signed({ ...current, sequence: 8 }, keysNext.privateKey);
      expect((await updater.check()).phase).toBe('available');
      expect((await updater.setAutomatic(true, null)).automatic.enabled).toBe(true);
      await updater.close();
      updater = new Updates(directory, old, runtime, send);
      expect((await updater.check()).error).toBe('storage');
      expect(JSON.parse(await readFile(watermark, 'utf8')).sequence).toBe(8);
    } finally {
      await updater.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('migrating a profile with only scheduling consent leaves fresh consent available without a release check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-update-migrate-consent-'));
  const send = vi.fn(async () => new Response(signed(release())));
  const next = { ...configuration, feed: 'https://new.example.test/desktop/release.json' };
  let updater = new Updates(directory, configuration, runtime, send);
  try {
    const previous = await updater.setAutomatic(true, null);
    await updater.close();
    updater = new Updates(directory, { ...next, migrateFrom: configuration }, runtime, send);
    expect((await updater.started()).automatic).toMatchObject({
      enabled: false,
      revision: null,
      warning: null,
    });
    await expect(updater.setAutomatic(true, previous.automatic.revision)).rejects.toThrow();
    await updater.close();
    updater = new Updates(directory, next, runtime, send);
    expect((await updater.started()).automatic).toMatchObject({
      enabled: false,
      revision: null,
      warning: null,
    });
    expect(send).not.toHaveBeenCalled();
    expect((await updater.setAutomatic(true, null)).automatic.enabled).toBe(true);
  } finally {
    await updater.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unusable scheduling storage preserves the preceding consent for a migration retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-migration-retry-'));
  const next = {
    ...configuration,
    feed: 'https://new.example.test/release.json',
    migrateFrom: configuration,
  };
  const send = vi.fn(async () => new Response(signed(release())));
  let updater = new Updates(directory, configuration, runtime, send);
  try {
    await updater.setAutomatic(true, null);
    await updater.close();
    const consent = join(directory, 'automatic-checks.json');
    const before = await readFile(consent);
    const temporary = join(directory, 'automatic-checks.tmp');
    await mkdir(temporary);
    updater = new Updates(directory, next, runtime, send);
    expect((await updater.started()).automatic).toMatchObject({
      enabled: false,
      warning: 'storage',
    });
    expect(await readFile(consent)).toEqual(before);
    await updater.close();
    await rm(temporary, { recursive: true });
    updater = new Updates(directory, next, runtime, send);
    expect((await updater.started()).automatic).toMatchObject({ enabled: false, warning: null });
    await expect(stat(consent)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(send).not.toHaveBeenCalled();
  } finally {
    await updater.close();
    await rm(directory, { recursive: true, force: true });
  }
});
