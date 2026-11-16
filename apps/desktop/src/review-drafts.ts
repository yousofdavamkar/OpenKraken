import { z } from 'zod';
import { join } from 'node:path';
import { LocalDraftFiles } from './local-draft-files.js';
import type { SecretProtection } from './provider-vault.js';
import {
  reviewDraftSchema,
  reviewDraftScopeSchema,
  reviewDraftTargetSchema,
  type Request,
  type Result,
  type ReviewDraftScope,
  type ProviderCommentTarget,
} from '@openkraken/ipc-contract';

export type ReviewDraftRequest = Extract<
  Request,
  { method: 'reviewDraftList' | 'reviewDraftRead' | 'reviewDraftSave' }
>;
const record = z
  .object({
    scope: reviewDraftScopeSchema,
    target: reviewDraftTargetSchema,
    draft: reviewDraftSchema,
  })
  .strict();

function scopeKey(scope: ReviewDraftScope) {
  return LocalDraftFiles.name([
    scope.accountId,
    scope.repository.owner.toLowerCase(),
    scope.repository.name.toLowerCase(),
    String(scope.number),
  ]);
}
function identity(scope: ReviewDraftScope, target: ProviderCommentTarget | null) {
  const key = scopeKey(scope);
  if (target === null) return [key, 'review'];
  if (target.kind === 'reply') return [key, 'reply', String(target.commentId)];
  return [key, 'line', target.path, target.side, String(target.line)];
}

// The provider service serializes requests with account connection and disconnection.
export class ReviewDrafts {
  constructor(
    private profile: string,
    private protection: SecretProtection,
  ) {}
  async request(request: ReviewDraftRequest): Promise<Result> {
    const files = new LocalDraftFiles(
      this.profile,
      join('provider-review-drafts', request.scope.accountId),
      z.string().base64(),
      1024 * 1024,
    );
    const decode = async (encoded: string, filename: string) => {
      const { result } = await this.protection.decrypt(Buffer.from(encoded, 'base64'));
      const value = record.parse(JSON.parse(result));
      if (
        value.scope.accountId !== request.scope.accountId ||
        LocalDraftFiles.name(identity(value.scope, value.target)) !== filename
      )
        throw new Error('Draft identity changed');
      return value;
    };
    if (request.method === 'reviewDraftList') {
      const entries = [];
      const key = 'repository' in request.scope ? scopeKey(request.scope) : undefined;
      let unreadable = false;
      for await (const entry of files.entries()) {
        try {
          if (entry.draft === null) throw new Error('Unreadable draft');
          const { scope, target } = await decode(entry.draft, entry.name);
          if (key === undefined || key === scopeKey(scope)) entries.push({ scope, target });
        } catch {
          unreadable = true;
        }
      }
      return { kind: 'reviewDraftList', entries, unreadable };
    }
    const id = identity(request.scope, request.target);
    if (request.method === 'reviewDraftRead') {
      const { draft, revision } = await files.read(id);
      return {
        kind: 'reviewDraft',
        revision,
        draft: draft === null ? null : (await decode(draft, LocalDraftFiles.name(id))).draft,
      };
    }
    const value =
      request.draft === null
        ? null
        : (
            await this.protection.encrypt(
              JSON.stringify({
                scope: request.scope,
                target: request.target,
                draft: request.draft,
              }),
            )
          ).toString('base64');
    const { revision } = await files.save(id, request.revision, value);
    return { kind: 'reviewDraft', revision, draft: request.draft };
  }
}
