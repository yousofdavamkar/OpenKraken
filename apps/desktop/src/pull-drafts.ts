import { z } from 'zod';
import {
  pullDraftSchema,
  pullDraftScopeSchema,
  type PullDraftScope,
  type Request,
  type Result,
} from '@openkraken/ipc-contract';
import { ProtectedDraftFiles } from './protected-draft-files.js';
import type { SecretProtection } from './provider-vault.js';

export type PullDraftRequest = Extract<
  Request,
  { method: 'pullDraftRead' | 'pullDraftSave' | 'pullDraftList' }
>;
const record = z.object({ scope: pullDraftScopeSchema, draft: pullDraftSchema }).strict();
function identity({ accountId, repository }: PullDraftScope) {
  return [accountId, repository.owner.toLowerCase(), repository.name.toLowerCase()];
}
export class PullDrafts {
  constructor(
    private profile: string,
    private protection: SecretProtection,
  ) {}
  async request(request: PullDraftRequest): Promise<Result> {
    const files = new ProtectedDraftFiles(
      this.profile,
      'provider-pull-drafts',
      request.scope.accountId,
      this.protection,
      record,
      (entry) => identity(entry.scope),
    );
    if (request.method === 'pullDraftList') {
      const entries: PullDraftScope[] = [];
      let unreadable = false;
      for await (const entry of files.entries()) {
        if (entry) entries.push(entry.scope);
        else unreadable = true;
      }
      return { kind: 'pullDraftList', entries, unreadable };
    }
    const key = identity(request.scope);
    if (request.method === 'pullDraftRead') {
      const { record, revision } = await files.read(key);
      return { kind: 'pullDraft', draft: record?.draft ?? null, revision };
    }
    const revision = await files.save(
      key,
      request.revision,
      request.draft && { scope: request.scope, draft: request.draft },
    );
    return { kind: 'pullDraft', revision, draft: request.draft };
  }
}
