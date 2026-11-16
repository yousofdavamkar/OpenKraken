import { useEffect, useState } from 'react';
import type {
  ProviderCommentTarget,
  ReviewDraft,
  ReviewDraftScope,
} from '@openkraken/ipc-contract';

export function useReviewDraft(
  scope: ReviewDraftScope,
  target: ProviderCommentTarget | null,
  restore: (draft: ReviewDraft) => void,
) {
  const [session] = useState(() => ({
    scope,
    target,
    restore,
    revision: null as string | null,
    initialized: false,
    live: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    pending: undefined as ReviewDraft | null | undefined,
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
        const res = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'reviewDraftSave',
          scope: session.scope,
          target: session.target,
          revision: session.revision,
          draft,
        });
        if (res.kind !== 'reviewDraft')
          throw new Error(
            res.kind === 'error' ? res.message : 'Saving the draft was not confirmed.',
          );
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
    void window.openkraken
      .request({
        id: crypto.randomUUID(),
        method: 'reviewDraftRead',
        scope: session.scope,
        target: session.target,
      })
      .then((res) => {
        if (!active) return;
        if (res.kind !== 'reviewDraft')
          throw new Error(res.kind === 'error' ? res.message : 'The draft could not be read.');
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
  const queue = (draft: ReviewDraft | null) => {
    clearTimeout(session.timer);
    session.version++;
    session.pending = draft;
    if (session.live) setStatus('Saving draft…');
  };
  return {
    ready,
    status,
    change(draft: ReviewDraft | null) {
      queue(draft);
      session.timer = setTimeout(() => {
        void flush().catch(() => {});
      }, 250);
    },
    write(draft: ReviewDraft | null) {
      queue(draft);
      return flush();
    },
    flush,
  };
}
