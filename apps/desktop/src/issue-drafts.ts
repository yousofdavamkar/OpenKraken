import { z } from 'zod';
import {
  issueDraftSchema,
  issueDraftScopeSchema,
  type IssueDraftScope,
  type Request,
  type Result,
} from '@openkraken/ipc-contract';
import { ProtectedDraftFiles } from './protected-draft-files.js';
import type { SecretProtection } from './provider-vault.js';

export type IssueDraftRequest = Extract<
  Request,
  { method: 'issueDraftRead' | 'issueDraftSave' | 'issueDraftList' }
>;
const record = z.object({ scope: issueDraftScopeSchema, draft: issueDraftSchema }).strict();
function identity({ accountId, repository, intent }: IssueDraftScope) {
  const key = [
    accountId,
    repository.owner.toLowerCase(),
    repository.name.toLowerCase(),
    intent.action,
  ];
  if (intent.action !== 'create') key.push(String(intent.number));
  if (intent.action === 'state') key.push(intent.state);
  return key;
}
export class IssueDrafts {
  constructor(
    private profile: string,
    private protection: SecretProtection,
  ) {}
  async request(request: IssueDraftRequest): Promise<Result> {
    const files = new ProtectedDraftFiles(
      this.profile,
      'provider-issue-drafts',
      request.scope.accountId,
      this.protection,
      record,
      (entry) => identity(entry.scope),
    );
    if (request.method === 'issueDraftList') {
      const entries: IssueDraftScope[] = [];
      let unreadable = false;
      for await (const entry of files.entries()) {
        if (entry) entries.push(entry.scope);
        else unreadable = true;
      }
      return { kind: 'issueDraftList', entries, unreadable };
    }
    const key = identity(request.scope);
    if (request.method === 'issueDraftRead') {
      const { record, revision } = await files.read(key);
      return { kind: 'issueDraft', draft: record?.draft ?? null, revision };
    }
    const revision = await files.save(
      key,
      request.revision,
      request.draft && { scope: request.scope, draft: request.draft },
    );
    return { kind: 'issueDraft', revision, draft: request.draft };
  }
}
