import { ProviderVault } from './src/provider-vault.js';
import { ProviderService } from './src/providers.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ReviewDrafts } from './src/review-drafts.js';
import { protection } from '../../tests/provider-protection.js';
import { requestSchema, serviceRequestSchema, type ReviewDraft } from '@openkraken/ipc-contract';

const scope = {
  accountId: 'a'.repeat(64),
  repository: { owner: 'Team', name: 'Project' },
  number: 3,
};
const draft: ReviewDraft = {
  body: 'Private review body',
  event: 'REQUEST_CHANGES',
  source: { head: '1'.repeat(40), base: '2'.repeat(40) },
  uncertain: true,
};
const base = { id: randomUUID(), scope, target: null };
const read = { ...base, method: 'reviewDraftRead' as const };
const write = { ...base, method: 'reviewDraftSave' as const, draft, revision: null };
const list = { id: base.id, scope, method: 'reviewDraftList' as const };
let root: string, store: ReviewDrafts;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ok-provider-draft-'));
  store = new ReviewDrafts(root, protection());
});
afterEach(() => rm(root, { recursive: true, force: true }));
test('review IPC only accepts bounded drafts, scoped GitHub targets and reviewed revisions in main', () => {
  for (const req of [list, read, write]) {
    expect(requestSchema.safeParse(req).success).toBe(true);
    expect(serviceRequestSchema.safeParse(req).success).toBe(false);
    expect(requestSchema.safeParse({ ...req, token: 'secret' }).success).toBe(false);
  }
  for (const bad of [
    { draft: { ...draft, body: 'a'.repeat(65537) } },
    { target: { kind: 'reply', commentId: 0 } },
    { revision: 'bad' },
  ])
    expect(requestSchema.safeParse({ ...write, ...bad }).success).toBe(false);
});
test('encrypted review records bind account, repository, PR and anchor, and clear only the reviewed version', async () => {
  const saved = await store.request(write);
  if (saved.kind !== 'reviewDraft' || !saved.revision) throw new Error('missing revision');
  const folder = join(root, 'provider-review-drafts');
  const directory = join(folder, (await readdir(folder))[0]!);
  const file = join(directory, (await readdir(directory))[0]!);
  expect(await readFile(file, 'utf8')).not.toContain(draft.body);
  expect(
    await store.request({
      ...read,
      scope: { ...scope, repository: { owner: 'team', name: 'project' } },
    }),
  ).toEqual(saved);
  for (const other of [
    { ...scope, accountId: 'b'.repeat(64) },
    { ...scope, number: 4 },
    { ...scope, repository: { owner: 'other', name: 'project' } },
  ])
    expect(await store.request({ ...read, scope: other })).toMatchObject({
      kind: 'reviewDraft',
      draft: null,
    });
  const target = { kind: 'line' as const, path: 'path/file.txt', line: 1, side: 'LEFT' as const };
  await store.request({ ...write, target });
  expect(await store.request(list)).toMatchObject({
    entries: expect.arrayContaining([
      { scope, target: null },
      { scope, target },
    ]),
    unreadable: false,
  });
  await expect(store.request({ ...write, draft: null })).rejects.toThrow();
  const otherScope = { ...scope, number: 4 };
  await store.request({ ...write, scope: otherScope });
  const all = await store.request({ ...list, scope: { accountId: scope.accountId } });
  expect(all).toMatchObject({
    entries: expect.arrayContaining([
      { scope: otherScope, target: null },
      { scope, target: null },
      { scope, target },
    ]),
  });
  const unrelated = await store.request({ ...read, scope: otherScope });
  if (unrelated.kind !== 'reviewDraft') throw Error('Missing draft');
  await store.request({ ...write, scope: otherScope, draft: null, revision: unrelated.revision });
  const otherFile = (await readdir(directory))
    .map((n) => join(directory, n))
    .find((n) => n !== file)!;
  await copyFile(file, otherFile);
  await expect(store.request({ ...read, target })).rejects.toThrow();
  expect(await store.request(list)).toMatchObject({
    entries: [{ scope, target: null }],
    unreadable: true,
  });
  await store.request({ ...write, draft: null, revision: saved.revision });
  expect(await store.request(read)).toMatchObject({ draft: null });
});

test('disconnected accounts cannot read, list or change retained review drafts until the same identity reconnects', async () => {
  const service = new ProviderService(root, new ProviderVault(root, protection()));
  const account = {
    provider: 'github',
    origin: 'https://github.com',
    providerUserId: '321',
    login: 'tester',
    id: createHash('sha256')
      .update(JSON.stringify(['github', 'https://github.com', '321']))
      .digest('hex'),
  };
  const owned = { ...scope, accountId: account.id };
  const manifest = join(root, 'provider-accounts.json');
  await writeFile(manifest, JSON.stringify([account]));
  await service.reviewDraft(store, { ...write, scope: owned });
  await service.disconnect(account.id);
  for (const req of [
    { ...list, scope: { accountId: account.id } },
    { ...read, scope: owned },
    { ...write, scope: owned },
  ]) {
    await expect(service.reviewDraft(store, req)).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT',
    });
  }
  await writeFile(manifest, JSON.stringify([account]));
  expect(await service.reviewDraft(store, { ...read, scope: owned })).toMatchObject({ draft });
});
