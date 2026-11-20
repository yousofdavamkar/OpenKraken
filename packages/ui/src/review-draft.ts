import { useEffect, useState } from 'react';
import type {
  PullDraft,
  PullDraftScope,
  IssueDraft,
  IssueDraftScope,
  Result,
  ProviderCommentTarget,
  ReviewDraft,
  ReviewDraftScope,
} from '@openkraken/ipc-contract';

export function useReviewDraft(
  scope: ReviewDraftScope,
  target: ProviderCommentTarget | null,
  restore: (draft: ReviewDraft) => void,
) {
  return useProviderDraft<ReviewDraft>(
    restore,
    () =>
      window.openkraken
        .request({ id: crypto.randomUUID(), method: 'reviewDraftRead', scope, target })
        .then(reviewResult),
    (draft, revision) =>
      window.openkraken
        .request({
          id: crypto.randomUUID(),
          method: 'reviewDraftSave',
          scope,
          target,
          draft,
          revision,
        })
        .then(reviewResult),
  );
}
function reviewResult(res: Result) {
  if (res.kind !== 'reviewDraft')
    throw new Error(res.kind === 'error' ? res.message : 'Draft access was not confirmed.');
  return res;
}
export class ProviderDraftEncryptionUnavailable extends Error {}
function issueResult(res: Result) {
  if (res.kind === 'error' && res.code === 'DRAFT_ENCRYPTION_UNAVAILABLE')
    throw new ProviderDraftEncryptionUnavailable(res.message);
  if (res.kind !== 'issueDraft')
    throw new Error(res.kind === 'error' ? res.message : 'Draft access was not confirmed.');
  return res;
}
export function useIssueDraft(scope: IssueDraftScope, restore: (draft: IssueDraft) => void) {
  return useProviderDraft<IssueDraft>(
    restore,
    () =>
      window.openkraken
        .request({ id: crypto.randomUUID(), method: 'issueDraftRead', scope })
        .then(issueResult),
    (draft, revision) =>
      window.openkraken
        .request({ id: crypto.randomUUID(), method: 'issueDraftSave', scope, draft, revision })
        .then(issueResult),
  );
}
function pullResult(res: Result) {
  if (res.kind === 'error' && res.code === 'DRAFT_ENCRYPTION_UNAVAILABLE')
    throw new ProviderDraftEncryptionUnavailable(res.message);
  if (res.kind !== 'pullDraft')
    throw new Error(res.kind === 'error' ? res.message : 'Draft access was not confirmed.');
  return res;
}
export function usePullDraft(scope: PullDraftScope, restore: (draft: PullDraft) => void) {
  return useProviderDraft<PullDraft>(
    restore,
    () =>
      window.openkraken
        .request({ id: crypto.randomUUID(), method: 'pullDraftRead', scope })
        .then(pullResult),
    (draft, revision) =>
      window.openkraken
        .request({ id: crypto.randomUUID(), method: 'pullDraftSave', scope, draft, revision })
        .then(pullResult),
  );
}
function useProviderDraft<T>(
  restore: (draft: T) => void,
  read: () => Promise<{ draft: T | null; revision: string | null }>,
  save: (draft: T | null, revision: string | null) => Promise<{ revision: string | null }>,
) {
  const [session] = useState(() => ({
    read,
    save,
    restore,
    revision: null as string | null,
    initialized: false,
    live: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    pending: undefined as T | null | undefined,
    writes: Promise.resolve(),
    version: 0,
  }));
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('');
  const flush = () => {
    clearTimeout(session.timer);
    const draft = session.pending;
    if (draft === undefined) return session.writes;
    session.pending = undefined;
    const edit = session.version;
    const write = session.writes
      .catch(() => {})
      .then(async () => {
        if (!session.initialized)
          throw new Error('The original draft could not be read. Reopen the composer to retry.');
        const res = await session.save(draft, session.revision);
        session.revision = res.revision;
        if (session.live && edit === session.version) setStatus(draft ? 'Draft saved locally' : '');
      });
    session.writes = write;
    void write.catch((error) => {
      if (session.live && edit === session.version)
        setStatus(error instanceof Error ? error.message : 'The draft could not be saved.');
    });
    return write;
  };
  useEffect(() => {
    session.live = true;
    let active = true;
    void session
      .read()
      .then((res) => {
        if (!active) return;
        session.revision = res.revision;
        session.initialized = true;
        if (res.draft) {
          session.restore(res.draft);
          setStatus('Recovered local draft');
        }
      })
      .catch((error) => {
        if (active)
          setStatus(error instanceof Error ? error.message : 'The draft could not be read.');
      })
      .finally(() => {
        if (active) setReady(true);
      });
    const unload = () => {
      void flush().catch(() => {});
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      session.live = false;
      active = false;
      window.removeEventListener('beforeunload', unload);
      unload();
    };
  }, [session]);
  const queue = (draft: T | null) => {
    clearTimeout(session.timer);
    session.version++;
    session.pending = draft;
    if (session.live) setStatus('Saving draft…');
  };
  return {
    ready,
    status,
    change(draft: T | null) {
      queue(draft);
      session.timer = setTimeout(() => {
        void flush().catch(() => {});
      }, 250);
    },
    write(draft: T | null) {
      queue(draft);
      return flush();
    },
    flush,
  };
}
