import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  requestSchema,
  serviceRequestSchema,
  type PullDraft,
  type PullDraftScope,
} from '@openkraken/ipc-contract';
import { protection } from '../../tests/provider-protection.js';
import { PullDrafts } from './src/pull-drafts.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const id = randomUUID();
const scope: PullDraftScope = {
  accountId: 'a'.repeat(64),
  repository: { owner: 'group/subgroup', name: 'project' },
};
const draft: PullDraft = {
  owner: 'group/subgroup',
  repo: 'fork',
  head: 'feature/nested',
  base: 'main',
  title: 'Recover request',
  body: 'Private description kept across restart',
  draft: true,
  maintainerCanModify: false,
  uncertain: true,
};
const save = { id, method: 'pullDraftSave' as const, scope, revision: null, draft };
const read = { id, method: 'pullDraftRead' as const, scope };
const list = { id, method: 'pullDraftList' as const, scope: { accountId: scope.accountId } };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ok-pull-drafts-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

test('only main receives scoped and bounded local creation drafts', () => {
  for (const request of [list, read, save]) {
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  }
  for (const invalid of [
    { ...save, draft: { ...draft, body: 'x'.repeat(65537) } },
    { ...read, scope: { ...scope, repository: { owner: '../outside', name: 'project' } } },
    { ...save, revision: 'old' },
    { ...save, draft: { ...draft, head: 'x'.repeat(1025) } },
    { ...save, draft: { ...draft, owner: 'x'.repeat(2201) } },
    { ...save, draft: { ...draft, token: 'never stored' } },
  ])
    expect(requestSchema.safeParse(invalid).success).toBe(false);
});
test('keeps protected creation drafts separate by account and target repository', async () => {
  const key = protection();
  const store = new PullDrafts(root, key);
  const saved = await store.request(save);
  if (saved.kind !== 'pullDraft' || !saved.revision) throw Error('Missing saved revision');
  const dir = join(root, 'provider-pull-drafts', scope.accountId);
  const file = join(dir, (await readdir(dir))[0]!);
  expect(await readFile(file, 'utf8')).not.toContain(draft.body);
  expect(await new PullDrafts(root, key).request(read)).toEqual(saved);
  for (const other of [
    { ...scope, accountId: 'b'.repeat(64) },
    { ...scope, repository: { ...scope.repository, owner: 'other' } },
  ]) {
    expect(await store.request({ ...read, scope: other })).toMatchObject({ draft: null });
    await store.request({ ...save, scope: other });
  }
  const inventory = await store.request(list);
  if (inventory.kind !== 'pullDraftList') throw Error('Missing inventory');
  expect(inventory.entries).toHaveLength(2);
  expect(inventory.unreadable).toBe(false);
  await expect(store.request({ ...save, draft: null })).rejects.toThrow();
  const inaccessible = new PullDrafts(root, protection());
  expect(await inaccessible.request(list)).toMatchObject({ entries: [], unreadable: true });
  expect(await store.request(read)).toEqual(saved);
  await store.request({ ...save, draft: null, revision: saved.revision });
  expect(await store.request(read)).toMatchObject({ draft: null });
});
test.each(['github', 'gitlab'])(
  'disconnected %s account cannot list or change its retained draft',
  async (provider) => {
    const origin = 'https://example.test';
    const account = {
      provider,
      origin,
      login: 'fixture',
      providerUserId: '321',
      id: createHash('sha256')
        .update(JSON.stringify([provider, origin, '321']))
        .digest('hex'),
    };
    const key = protection();
    const service = new ProviderService(root, new ProviderVault(root, key));
    const store = new PullDrafts(root, key);
    const owned = { ...scope, accountId: account.id };
    const manifest = join(root, 'provider-accounts.json');
    await writeFile(manifest, JSON.stringify([account]));
    await service.pullDraft(store, { ...save, scope: owned });
    await service.disconnect(account.id);
    for (const req of [
      { ...list, scope: { accountId: account.id } },
      { ...read, scope: owned },
      { ...save, scope: owned },
    ])
      await expect(service.pullDraft(store, req)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT',
      });
    await writeFile(manifest, JSON.stringify([account]));
    expect(await service.pullDraft(store, { ...read, scope: owned })).toMatchObject({ draft });
  },
);
