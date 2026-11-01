import { afterAll, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AvatarCache, avatarHash } from './src/avatars.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-avatar-'));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=',
  'base64',
);
afterAll(() => rm(root, { recursive: true, force: true }));
test('remote photos default off, normalize/deduplicate requests and survive offline restarts', async () => {
  const directory = join(root, 'persist'),
    fetcher = vi.fn(async (_hash: string, _signal: AbortSignal) => png);
  const cache = new AvatarCache(directory, fetcher);
  expect(await cache.appearance()).toBe(false);
  expect(await cache.images(['Alice@Example.test'])).toEqual({ 'alice@example.test': null });
  expect(fetcher).not.toHaveBeenCalled();
  await cache.appearance(true);
  const [a, b] = await Promise.all([
    cache.images([' Alice@Example.test ']),
    cache.images(['alice@example.test']),
  ]);
  expect(a).toEqual(b);
  expect(a['alice@example.test']).toContain('data:image/png;base64,');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(avatarHash('alice@example.test'));
  const offline = vi.fn(async () => {
    throw new Error('offline');
  });
  const reopened = new AvatarCache(directory, offline);
  expect(await reopened.appearance()).toBe(true);
  expect(await reopened.images(['alice@example.test'])).toEqual(a);
  expect(offline).not.toHaveBeenCalled();
  const file = (await readdir(join(directory, 'avatars')))[0]!;
  expect(file).toBe(`${avatarHash('alice@example.test')}.json`);
  expect(await readFile(join(directory, 'avatars', file), 'utf8')).not.toContain('alice@example');
  await reopened.appearance(false);
  expect(await reopened.images(['alice@example.test'])).toEqual({ 'alice@example.test': null });
});
test('negative caching, stale offline images, invalid images and disk limits are bounded', async () => {
  let now = 1000000000;
  const directory = join(root, 'expiry');
  const fetcher = vi
    .fn<(hash: string, signal: AbortSignal) => Promise<Buffer | null>>()
    .mockResolvedValue(png);
  const cache = new AvatarCache(directory, fetcher, () => now, 2);
  await cache.appearance(true);
  const original = await cache.images(['a@example.test']);
  now += 8 * 86400000;
  fetcher.mockRejectedValueOnce(new Error('offline'));
  expect(await cache.images(['a@example.test'])).toEqual(original);
  expect(await cache.images(['a@example.test'])).toEqual(original);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(null);
  expect(await cache.images(['missing@example.test'])).toEqual({ 'missing@example.test': null });
  await cache.images(['missing@example.test']);
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockResolvedValueOnce(Buffer.from('<svg>not a PNG</svg>'));
  expect(await cache.images(['bad@example.test'])).toEqual({ 'bad@example.test': null });
  await cache.images(['b@example.test', 'c@example.test', 'd@example.test']);
  expect(
    (await readdir(join(directory, 'avatars'))).filter((f) => f.endsWith('.json')).length,
  ).toBeLessThanOrEqual(2);
  await writeFile(
    join(directory, 'avatars', `${avatarHash('corrupt@example.test')}.json`),
    '{broken',
  );
  expect((await cache.images(['corrupt@example.test']))['corrupt@example.test']).toContain(
    'data:image/png',
  );
});
test('disabling avatars aborts downloads and queued work does not contact the provider', async () => {
  const directory = join(root, 'cancel');
  let aborts = 0;
  const fetcher = vi.fn(
    (_hash: string, signal: AbortSignal) =>
      new Promise<Buffer>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborts++;
          reject(new Error('aborted'));
        });
      }),
  );
  const cache = new AvatarCache(directory, fetcher);
  await cache.appearance(true);
  const pending = cache.images(Array.from({ length: 10 }, (_, i) => `${i}@example.test`));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  await cache.appearance(false);
  expect(Object.values(await pending).every((v) => v === null)).toBe(true);
  expect(aborts).toBe(4);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
