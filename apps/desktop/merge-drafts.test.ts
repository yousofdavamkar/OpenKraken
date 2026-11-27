import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { requestSchema, serviceRequestSchema, type MergeDraft } from '@openkraken/ipc-contract';
import { protection } from '../../tests/provider-protection.js';
import { MergeDrafts } from './src/merge-drafts.js';

const scope = {
  accountId: 'a'.repeat(64),
  repository: { owner: 'Group/Sub', name: 'Project' },
  number: 7,
};
const id = randomUUID();
const drafts: MergeDraft[] = [
  {
    provider: 'github',
    method: 'squash',
    defaults: false,
    title: 'Edited title',
    message: 'Private merge message',
    uncertain: true,
  },
  {
    provider: 'gitlab',
    selectedSquash: null,
    removeSource: false,
    defaults: false,
    mergeMessage: 'Private merge message',
    squashMessage: 'Squash text',
    uncertain: false,
  },
];

test.each(drafts)(
  'protected $provider merge drafts round-trip across restart and isolate requests',
  async (draft) => {
    const root = await mkdtemp(join(tmpdir(), 'ok-merge-draft-'));
    try {
      const key = protection();
      const store = new MergeDrafts(root, key);
      const save = { method: 'mergeDraftSave' as const, id, scope, draft, revision: null };
      const read = { method: 'mergeDraftRead' as const, id, scope };
      const list = { method: 'mergeDraftList' as const, id, scope: { accountId: scope.accountId } };
      for (const req of [save, read, list]) {
        expect(requestSchema.safeParse(req).success).toBe(true);
        expect(serviceRequestSchema.safeParse(req).success).toBe(false);
      }
      for (const req of [
        { ...save, draft: { ...draft, confirmed: true } },
        { ...save, scope: { ...scope, number: 0 } },
        {
          ...save,
          draft: {
            ...draft,
            [draft.provider === 'github' ? 'message' : 'mergeMessage']: 'x'.repeat(65537),
          },
        },
      ])
        expect(requestSchema.safeParse(req).success).toBe(false);
      const saved = await store.request(save);
      if (saved.kind !== 'mergeDraft' || !saved.revision) throw new Error('Missing revision');
      const dir = join(root, 'provider-merge-drafts', scope.accountId);
      expect(await readFile(join(dir, (await readdir(dir))[0]!), 'utf8')).not.toContain(
        'Private merge message',
      );
      expect(await new MergeDrafts(root, key).request(read)).toEqual(saved);
      for (const alternate of [
        { ...scope, number: 8 },
        { ...scope, accountId: 'b'.repeat(64) },
        { ...scope, repository: { owner: 'Elsewhere', name: 'Project' } },
      ])
        expect(await store.request({ ...read, scope: alternate })).toMatchObject({ draft: null });
      expect(await store.request(list)).toMatchObject({ entries: [scope], unreadable: false });
      await expect(store.request({ ...save, draft: null })).rejects.toThrow();
      expect(await new MergeDrafts(root, protection()).request(list)).toMatchObject({
        entries: [],
        unreadable: true,
      });
      await store.request({ ...save, draft: null, revision: saved.revision });
      expect(await store.request(list)).toMatchObject({ entries: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('both GitLab messages fit at their draft limits after JSON escaping and encryption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ok-merge-draft-limit-'));
  try {
    const store = new MergeDrafts(root, protection());
    const text = '\u0001'.repeat(65536);
    const draft = {
      provider: 'gitlab' as const,
      defaults: false,
      selectedSquash: true,
      removeSource: false,
      mergeMessage: text,
      squashMessage: text,
      uncertain: false,
    };
    const saved = await store.request({
      id,
      method: 'mergeDraftSave',
      scope,
      draft,
      revision: null,
    });
    expect(await store.request({ id, method: 'mergeDraftRead', scope })).toEqual(saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('merge drafts require their connected provider account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ok-merge-account-'));
  try {
    const origin = 'https://git.example.test';
    const account = {
      id: createHash('sha256')
        .update(JSON.stringify(['github', origin, '42']))
        .digest('hex'),
      provider: 'github',
      origin,
      providerUserId: '42',
      login: 'fixture',
    };
    const key = protection();
    const service = new ProviderService(root, new ProviderVault(root, key));
    const store = new MergeDrafts(root, key);
    const owned = { ...scope, accountId: account.id };
    const save = {
      id,
      method: 'mergeDraftSave' as const,
      scope: owned,
      revision: null,
      draft: drafts[0]!,
    };
    const manifest = join(root, 'provider-accounts.json');
    await writeFile(manifest, JSON.stringify([account]));
    await expect(service.mergeDraft(store, { ...save, draft: drafts[1]! })).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT',
    });
    await service.mergeDraft(store, save);
    await service.disconnect(account.id);
    for (const request of [
      save,
      { id, method: 'mergeDraftRead' as const, scope: owned },
      { id, method: 'mergeDraftList' as const, scope: { accountId: account.id } },
    ])
      await expect(service.mergeDraft(store, request)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT',
      });
    await writeFile(manifest, JSON.stringify([account]));
    expect(
      await service.mergeDraft(store, { id, method: 'mergeDraftRead', scope: owned }),
    ).toMatchObject({ draft: drafts[0] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
