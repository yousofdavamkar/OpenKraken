import { z } from 'zod';
import {
  mergeDraftSchema,
  mergeDraftScopeSchema,
  type MergeDraftScope,
  type Request,
  type Result,
} from '@openkraken/ipc-contract';
import { ProtectedDraftFiles } from './protected-draft-files.js';
import type { SecretProtection } from './provider-vault.js';

export type MergeDraftRequest = Extract<
  Request,
  { method: 'mergeDraftRead' | 'mergeDraftSave' | 'mergeDraftList' }
>;
const record = z.object({ scope: mergeDraftScopeSchema, draft: mergeDraftSchema }).strict();
function identity({ accountId, repository, number }: MergeDraftScope) {
  return [accountId, repository.owner.toLowerCase(), repository.name.toLowerCase(), String(number)];
}
export class MergeDrafts {
  constructor(
    private profile: string,
    private protection: SecretProtection,
  ) {}
  async request(request: MergeDraftRequest): Promise<Result> {
    const files = new ProtectedDraftFiles(
      this.profile,
      'provider-merge-drafts',
      request.scope.accountId,
      this.protection,
      record,
      (entry) => identity(entry.scope),
    );
    if (request.method === 'mergeDraftList') {
      const entries: MergeDraftScope[] = [];
      let unreadable = false;
      for await (const entry of files.entries()) {
        if (entry) entries.push(entry.scope);
        else unreadable = true;
      }
      return { kind: 'mergeDraftList', entries, unreadable };
    }
    const key = identity(request.scope);
    if (request.method === 'mergeDraftRead') {
      const { record, revision } = await files.read(key);
      return { kind: 'mergeDraft', draft: record?.draft ?? null, revision };
    }
    const revision = await files.save(
      key,
      request.revision,
      request.draft && { scope: request.scope, draft: request.draft },
    );
    return { kind: 'mergeDraft', revision, draft: request.draft };
  }
}
