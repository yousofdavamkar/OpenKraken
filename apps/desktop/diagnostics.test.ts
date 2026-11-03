import { expect, test } from 'vitest';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  symlink,
  link,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Diagnostics } from './src/diagnostics.js';
const runtime = { version: '0.1.0', platform: 'linux', arch: 'x64' } as const;

test('local diagnostics retain useful outcomes while excluding native text, paths and credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-diagnostics-'));
  const log = new Diagnostics(root, runtime);
  try {
    const secret = 'https://private-user:private-password@example.test/repo?token=private-token';
    const result = await log.track({ id: crypto.randomUUID(), method: 'open' }, async () => ({
      kind: 'error',
      code: secret,
      message: secret,
    }));
    expect(result).toEqual({ kind: 'error', code: secret, message: secret });
    log.failure('renderer', secret);
    await log.close();
    const state = await log.read();
    expect(state.warning).toBeNull();
    expect(state.entries.map((entry) => entry.type)).toEqual([
      'started',
      'request',
      'process',
      'stopped',
    ]);
    expect(state.entries[1]).toMatchObject({ action: 'open', outcome: 'failed', code: 'OTHER' });
    expect(state.entries[2]).toMatchObject({ component: 'renderer', reason: 'unknown' });
    const files = await readdir(root);
    expect(files).toEqual(['diagnostics-0.json']);
    const raw = await readFile(join(root, files[0]!), 'utf8');
    expect(raw).not.toMatch(/private-|example.test|token=/);
    if (process.platform !== 'win32')
      expect((await stat(join(root, files[0]!))).mode & 0o777).toBe(0o600);
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostics rotate at the production limit, survive restart, and clear retained files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-diagnostic-rotation-'));
  const log = new Diagnostics(root, runtime);
  let reopened: Diagnostics | undefined;
  try {
    const first = (await log.read()).entries[0]!.id;
    for (let batch = 0; batch < 25; batch++) {
      for (let item = 0; item < 32; item++) log.failure('git', 'crashed');
      await log.idle();
    }
    await log.close();
    const state = await log.read();
    expect(state.warning).toBeNull();
    expect(state.dropped).toBe(0);
    expect(state.entries.length).toBeGreaterThan(512);
    expect(state.entries.length).toBeLessThanOrEqual(768);
    expect(state.entries.some((entry) => entry.id === first)).toBe(false);
    expect(new Set(state.entries.map((entry) => entry.id)).size).toBe(state.entries.length);
    expect(await readdir(root)).toEqual([
      'diagnostics-0.json',
      'diagnostics-1.json',
      'diagnostics-2.json',
    ]);
    for (const file of await readdir(root))
      expect((await stat(join(root, file))).size).toBeLessThanOrEqual(256 * 1024);
    reopened = new Diagnostics(root, runtime);
    expect((await reopened.read()).entries.slice(0, -1)).toEqual(state.entries);
    expect(await reopened.clear()).toEqual({ entries: [], warning: null, dropped: 0 });
    expect(await readdir(root)).toEqual([]);
    reopened.failure('renderer', 'oom');
    expect((await reopened.read()).entries).toEqual([
      expect.objectContaining({ type: 'process', reason: 'oom' }),
    ]);
  } finally {
    await reopened?.close();
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a diagnostic flood is bounded and accounts for omitted records without delaying operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-diagnostic-flood-'));
  const log = new Diagnostics(root, runtime);
  try {
    for (let index = 0; index < 300; index++) log.failure('renderer', 'crashed');
    const state = await log.read();
    // A drop notice may follow the read job; flush and inspect the completed batch.
    const settled = await log.read();
    expect(state.warning).toBeNull();
    expect(settled.dropped).toBeGreaterThan(0);
    expect(
      settled.entries.filter((entry) => entry.type === 'process').length + settled.dropped,
    ).toBe(300);
    expect(settled.entries).toContainEqual(
      expect.objectContaining({ type: 'dropped', count: settled.dropped }),
    );
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt or externally changed logs are retained and cannot break application operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-diagnostic-unavailable-'));
  const file = join(root, 'diagnostics-0.json');
  await writeFile(file, 'private external contents', { mode: 0o600 });
  const corrupt = new Diagnostics(root, runtime);
  let changed: Diagnostics | undefined;
  try {
    expect(
      await corrupt.track({ id: crypto.randomUUID(), method: 'open' }, async () => ({
        kind: 'cancelled',
      })),
    ).toEqual({ kind: 'cancelled' });
    expect((await corrupt.read()).warning).toBe('unavailable');
    await expect(corrupt.clear()).rejects.toThrow('could not be cleared');
    expect(await readFile(file, 'utf8')).toBe('private external contents');
    await corrupt.close();
    await rm(file);
    changed = new Diagnostics(root, runtime);
    await changed.idle();
    await writeFile(file, 'new external contents');
    changed.failure('renderer', 'crashed');
    expect((await changed.read()).warning).toBe('changed');
    expect(await readFile(file, 'utf8')).toBe('new external contents');
  } finally {
    await changed?.close();
    await corrupt.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'redirected diagnostic files and directories never modify their targets',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-diagnostic-links-'));
    try {
      const target = join(root, 'target');
      await writeFile(target, 'private target');
      for (const [makeLink, filename] of [
        [symlink, 'diagnostics-0.json'],
        [link, 'diagnostics-0.json'],
        [symlink, 'diagnostics-next.tmp'],
        [link, 'diagnostics-next.tmp'],
      ] as const) {
        const directory = await mkdtemp(join(root, 'logs-'));
        await makeLink(target, join(directory, filename));
        const log = new Diagnostics(directory, runtime);
        expect((await log.read()).warning).toBe('unavailable');
        await expect(log.clear()).rejects.toThrow();
        await log.close();
        expect(await readFile(target, 'utf8')).toBe('private target');
      }
      const directory = await mkdtemp(join(root, 'real-'));
      await symlink(directory, join(root, 'redirect'));
      const log = new Diagnostics(join(root, 'redirect'), runtime);
      expect((await log.read()).warning).toBe('unavailable');
      await log.close();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('restart discards only the bounded temporary write and preserves the last committed segment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-diagnostic-recovery-'));
  const original = new Diagnostics(root, runtime);
  let restarted: Diagnostics | undefined;
  try {
    original.failure('git', 'oom');
    await original.close();
    const committed = (await original.read()).entries;
    await writeFile(join(root, 'diagnostics-next.tmp'), '{"version":1,"entries":[', {
      mode: 0o600,
    });
    restarted = new Diagnostics(root, runtime);
    expect((await restarted.read()).entries.slice(0, -1)).toEqual(committed);
    expect(await readdir(root)).toEqual(['diagnostics-0.json']);
  } finally {
    await restarted?.close();
    await original.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'non-private storage is preserved rather than used for diagnostics',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-diagnostic-modes-'));
    try {
      const directory = join(root, 'logs');
      const first = new Diagnostics(directory, runtime);
      await first.close();
      const file = join(directory, 'diagnostics-0.json');
      const raw = await readFile(file, 'utf8');
      await chmod(file, 0o644);
      const publicFile = new Diagnostics(directory, runtime);
      expect((await publicFile.read()).warning).toBe('unavailable');
      await publicFile.close();
      expect(await readFile(file, 'utf8')).toBe(raw);
      await chmod(file, 0o600);
      await chmod(directory, 0o755);
      const publicDirectory = new Diagnostics(directory, runtime);
      expect((await publicDirectory.read()).warning).toBe('unavailable');
      await publicDirectory.close();
      expect(await readFile(file, 'utf8')).toBe(raw);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
