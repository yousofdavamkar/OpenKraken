import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxRepositoryTabs } from '@openkraken/ipc-contract';
import { RepositoryTabStore, repositoryIdOf } from './src/repository-tabs.js';

let profile: string;
afterEach(async () => {
  if (profile) await rm(profile, { recursive: true, force: true });
});
const names = (state: Awaited<ReturnType<RepositoryTabStore['read']>>) =>
  state.tabs.map((tab) => tab.name);

test('repository tabs persist order and the active tab across store instances', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-repository-tabs-'));
  const first = new RepositoryTabStore(profile);
  expect(await first.read()).toEqual({ tabs: [], active: null, warning: null });
  await first.opened('/work/alpha');
  await first.opened('/work/beta');
  await first.opened('/work/alpha');
  await first.idle();
  const file = join(profile, 'repository-tabs.json');
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  const second = new RepositoryTabStore(profile);
  const restored = await second.read();
  expect(names(restored)).toEqual(['alpha', 'beta']);
  expect(restored.active).toBe(repositoryIdOf('/work/alpha'));
  expect(restored.tabs[1]).toEqual({
    repoId: repositoryIdOf('/work/beta'),
    name: 'beta',
    path: '/work/beta',
  });
  expect(await second.pathOf(repositoryIdOf('/work/beta'))).toBe('/work/beta');
  expect(await second.pathOf('f'.repeat(64))).toBeUndefined();
});

test('closing tabs moves the active tab to its neighbour and forgets the path', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-repository-tabs-close-'));
  const store = new RepositoryTabStore(profile);
  for (const name of ['a', 'b', 'c']) await store.opened(`/r/${name}`);
  await store.opened('/r/b');
  let state = await store.close(repositoryIdOf('/r/b'));
  expect(names(state)).toEqual(['a', 'c']);
  expect(state.active).toBe(repositoryIdOf('/r/c'));
  state = await store.close(repositoryIdOf('/r/a'));
  expect(state.active).toBe(repositoryIdOf('/r/c'));
  state = await store.close(repositoryIdOf('/r/c'));
  expect(state).toEqual({ tabs: [], active: null, warning: null });
  expect(await new RepositoryTabStore(profile).pathOf(repositoryIdOf('/r/a'))).toBeUndefined();
});

test('the tab list is bounded and keeps the active tab when full', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-repository-tabs-bound-'));
  const store = new RepositoryTabStore(profile);
  await store.opened('/r/0');
  for (let i = 1; i < maxRepositoryTabs; i++) await store.opened(`/r/${i}`);
  await store.opened('/r/0');
  const state = await store.opened('/r/new');
  expect(state.tabs).toHaveLength(maxRepositoryTabs);
  expect(names(state)).toContain('0');
  expect(names(state)).not.toContain('1');
  expect(state.active).toBe(repositoryIdOf('/r/new'));

  // With the last tab active, a new repository still evicts the oldest tab and is saved.
  const saved = await store.opened('/r/newer');
  expect(names(saved).at(-1)).toBe('newer');
  expect(names(saved)).not.toContain('0');
  const restored = await new RepositoryTabStore(profile).read();
  expect(restored.active).toBe(repositoryIdOf('/r/newer'));
  expect(restored.tabs).toHaveLength(maxRepositoryTabs);
});

test('damaged tab files are reported, preserved and replaced on the next change', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-repository-tabs-corrupt-'));
  const file = join(profile, 'repository-tabs.json');
  await writeFile(file, JSON.stringify({ version: 1, tabs: ['relative/path'], active: 0 }));
  const store = new RepositoryTabStore(profile);
  expect(await store.read()).toEqual({ tabs: [], active: null, warning: 'corrupt' });
  const state = await store.opened('/work/repo');
  expect(state.warning).toBeNull();
  expect(names(state)).toEqual(['repo']);
  const copies = (await readdir(profile)).filter((name) => name.includes('.corrupt-'));
  expect(copies).toHaveLength(1);
  expect(await readFile(join(profile, copies[0]!), 'utf8')).toContain('relative/path');
});

test('an external change is not overwritten and leaves session tabs usable', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-repository-tabs-external-'));
  const store = new RepositoryTabStore(profile);
  await store.opened('/work/one');
  const file = join(profile, 'repository-tabs.json');
  const external = JSON.stringify({ version: 1, tabs: ['/elsewhere'], active: null });
  await writeFile(file, external);
  const state = await store.opened('/work/two');
  expect(state.warning).toBe('unsaved');
  expect(names(state)).toEqual(['one', 'two']);
  expect(await readFile(file, 'utf8')).toBe(external);
});
