import { useRef, useState } from 'react';
import type { MergeDraft, MergeDraftScope, Result } from '@openkraken/ipc-contract';
import { ProviderDraftEncryptionUnavailable, useProviderDraft } from './review-draft.js';

function result(reply: Result) {
  if (reply.kind === 'mergeDraft') return reply;
  if (reply.kind === 'error' && reply.code === 'DRAFT_ENCRYPTION_UNAVAILABLE')
    throw new ProviderDraftEncryptionUnavailable(reply.message);
  throw new Error(reply.kind === 'error' ? reply.message : 'Merge draft access was not confirmed.');
}

export function useMergeDraft<T extends MergeDraft>(
  scope: MergeDraftScope,
  accepts: (draft: MergeDraft) => draft is T,
  initial: NoInfer<T>,
) {
  const [fields, setFields] = useState<T>(initial);
  const latest = useRef(initial);
  const [dirty, setDirty] = useState(false);
  const [withoutRecovery, setWithoutRecovery] = useState(false);
  const protectedWrite = useRef(false);
  const replace = (next: T) => {
    latest.current = next;
    setFields(next);
  };
  const storage = useProviderDraft<T>(
    (saved) => {
      replace(saved);
      setDirty(true);
      protectedWrite.current = saved.uncertain;
    },
    async () => {
      const reply = result(
        await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'mergeDraftRead',
          scope,
        }),
      );
      if (reply.draft && !accepts(reply.draft))
        throw Error('The saved merge draft belongs to a different provider.');
      return { draft: reply.draft, revision: reply.revision };
    },
    async (draft, revision) =>
      result(
        await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'mergeDraftSave',
          scope,
          revision,
          draft,
        }),
      ),
  );
  return {
    fields,
    dirty,
    ready: storage.ready,
    status: storage.status,
    withoutRecovery,
    edit(patch: Partial<Omit<T, 'provider' | 'uncertain'>>) {
      const next = { ...latest.current, ...patch };
      replace(next);
      setDirty(true);
      setWithoutRecovery(false);
      storage.change(next);
    },
    async beforeMerge(reviewed = latest.current) {
      replace(reviewed);
      try {
        await storage.write({ ...reviewed, uncertain: true });
        protectedWrite.current = true;
        setWithoutRecovery(false);
        return true;
      } catch (error) {
        if (error instanceof ProviderDraftEncryptionUnavailable) {
          if (withoutRecovery) {
            setWithoutRecovery(false);
            return true;
          }
          setWithoutRecovery(true);
        } else setWithoutRecovery(false);
        return false;
      }
    },
    async finish(outcome: 'merged' | 'rejected' | 'uncertain') {
      if (outcome === 'uncertain') {
        replace({ ...latest.current, uncertain: true });
        setDirty(true);
        return;
      }
      setWithoutRecovery(false);
      if (protectedWrite.current || outcome === 'merged') {
        // The storage hook exposes cleanup failures separately from the remote result.
        await storage.write(outcome === 'merged' || !dirty ? null : latest.current).catch(() => {});
      }
      protectedWrite.current = false;
    },
    async resume() {
      const next = { ...latest.current, uncertain: false };
      if (protectedWrite.current) await storage.write(next);
      protectedWrite.current = false;
      setWithoutRecovery(false);
      replace(next);
    },
    save: () => storage.write(latest.current),
    discard: () => storage.write(null),
    resetConsent: () => setWithoutRecovery(false),
  };
}
