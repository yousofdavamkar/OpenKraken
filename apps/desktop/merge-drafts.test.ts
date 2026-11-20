import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
