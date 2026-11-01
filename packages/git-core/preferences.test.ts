import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { RepositoryPreferences } from './src/preferences.js';
import { createFixture } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-preferences-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('graph preferences survive service restarts and are isolated by canonical repository', async () => {
  const dataDir = join(root, 'profile'),
    path = createFixture(join(root, 'repo'), 'orphan');
  let service = new RepositoryService('git', { dataDir });
  const view = {
    hiddenRefs: ['refs/tags/annotated'],
    soloRef: 'refs/heads/other',
    pinnedRef: 'refs/heads/other',
  };
  try {
    const repo = await service.open(path);
    await service.snapshot(repo.id, undefined, true, view);
    await service.dispose();
    service = new RepositoryService('git', { dataDir });
    const snapshot = await service.snapshot((await service.open(path)).id);
    expect(snapshot.view).toEqual(view);
    expect(snapshot.commits).toHaveLength(2);
    expect(snapshot.pinnedOid).toBe(snapshot.commits[0]?.oid);
    const other = createFixture(join(root, 'other'));
    expect((await service.snapshot((await service.open(other)).id)).view).toEqual({
      hiddenRefs: [],
    });
    expect(JSON.parse(await readFile(join(dataDir, 'repos', `${repo.id}.json`), 'utf8'))).toEqual(
      view,
    );
    expect((await readdir(join(dataDir, 'repos'))).every((p) => p.endsWith('.json'))).toBe(true);
    await service.snapshot((await service.open(path)).id, undefined, true, { hiddenRefs: [] });
    expect(await new RepositoryPreferences(dataDir).load(repo.id)).toEqual({ hiddenRefs: [] });
  } finally {
    await service.dispose();
  }
});
test('invalid saved preferences recover to defaults and path-like keys are rejected', async () => {
  const store = new RepositoryPreferences(join(root, 'bad-profile')),
    id = 'a'.repeat(64);
  await store.save(id, { hiddenRefs: ['refs/heads/main'] });
  await writeFile(join(root, 'bad-profile', 'repos', `${id}.json`), '{broken');
  expect(await store.load(id)).toEqual({ hiddenRefs: [] });
  await writeFile(join(root, 'bad-profile', 'repos', `${id}.json`), '{"hiddenRefs":false}');
  expect(await store.load(id)).toEqual({ hiddenRefs: [] });
  await expect(store.load('../escape')).rejects.toThrow('Invalid repository preference key');
});
