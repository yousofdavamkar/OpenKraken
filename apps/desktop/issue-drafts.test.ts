import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  requestSchema,
  serviceRequestSchema,
  type IssueDraft,
  type IssueDraftScope,
} from '@openkraken/ipc-contract';
import { protection } from '../../tests/provider-protection.js';
import { IssueDrafts } from './src/issue-drafts.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const id = randomUUID();
const scope: IssueDraftScope = {
  accountId: 'a'.repeat(64),
  repository: { owner: 'group/subgroup', name: 'project' },
  intent: { action: 'comment', number: 31 },
};
const draft: IssueDraft = {
  title: '',
  body: 'Internal note kept across restart',
  confidential: false,
  internal: true,
  reason: 'completed',
  uncertain: true,
};
const save = { id, method: 'issueDraftSave' as const, scope, revision: null, draft };
const read = { id, method: 'issueDraftRead' as const, scope };
const list = { id, method: 'issueDraftList' as const, scope: { accountId: scope.accountId } };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ok-issue-drafts-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

test('only main receives scoped and bounded local issue drafts', () => {
  for (const request of [list, read, save]) {
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  }
  for (const invalid of [
    { ...save, draft: { ...draft, body: 'x'.repeat(65537) } },
    { ...read, scope: { ...scope, intent: { action: 'state', number: 0, state: 'closed' } } },
    { ...save, revision: 'old' },
    { ...save, draft: { ...draft, token: 'never stored' } },
  ])
    expect(requestSchema.safeParse(invalid).success).toBe(false);
});
test('keeps protected issue records separate by identity, intent, number and requested state', async () => {
  const key = protection();
  const store = new IssueDrafts(root, key);
  const saved = await store.request(save);
  if (saved.kind !== 'issueDraft' || !saved.revision) throw Error('Missing saved revision');
  const dir = join(root, 'provider-issue-drafts', scope.accountId);
  const file = join(dir, (await readdir(dir))[0]!);
  expect(await readFile(file, 'utf8')).not.toContain(draft.body);
  expect(await new IssueDrafts(root, key).request(read)).toEqual(saved);
  for (const other of [
    { ...scope, accountId: 'b'.repeat(64) },
    { ...scope, repository: { ...scope.repository, owner: 'other' } },
    { ...scope, intent: { action: 'comment', number: 32 } as const },
    { ...scope, intent: { action: 'create' } as const },
    ...(['open', 'closed'] as const).map((state) => ({
      ...scope,
      intent: { action: 'state' as const, number: 31, state },
    })),
  ]) {
    expect(await store.request({ ...read, scope: other })).toMatchObject({ draft: null });
    await store.request({ ...save, scope: other });
  }
  const inventory = await store.request(list);
  if (inventory.kind !== 'issueDraftList') throw Error('Missing inventory');
  expect(inventory.entries).toHaveLength(6);
  expect(inventory.unreadable).toBe(false);
  await expect(store.request({ ...save, draft: null })).rejects.toThrow();
  const inaccessible = new IssueDrafts(root, protection());
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
    const store = new IssueDrafts(root, key);
    const owned = { ...scope, accountId: account.id };
    const manifest = join(root, 'provider-accounts.json');
    await writeFile(manifest, JSON.stringify([account]));
    await service.issueDraft(store, { ...save, scope: owned });
    await service.disconnect(account.id);
    for (const req of [
      { ...list, scope: { accountId: account.id } },
      { ...read, scope: owned },
      { ...save, scope: owned },
    ])
      await expect(service.issueDraft(store, req)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT',
      });
    await writeFile(manifest, JSON.stringify([account]));
    expect(await service.issueDraft(store, { ...read, scope: owned })).toMatchObject({ draft });
  },
);
