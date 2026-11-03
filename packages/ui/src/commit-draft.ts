import { useEffect, useRef, useState } from 'react';
import type { CommitDraft } from '@openkraken/ipc-contract';

const empty: CommitDraft = {
  message: '',
  amendMessage: '',
  amend: false,
  amendHead: null,
  sign: 'default',
};
type Session = {
  draft: CommitDraft;
  revision: string | null;
  version: number;
  saved: number;
  initialized: boolean;
  running: boolean;
  live: boolean;
  timer?: ReturnType<typeof setTimeout>;
  flush: () => Promise<void>;
};

export function useCommitDraft(repoId: string | undefined) {
  const [draft, setDraft] = useState(empty);
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [status, setStatus] = useState('Loading draft…');
  const [error, setError] = useState<string>();
  const session = useRef<Session | null>(null);
  useEffect(() => {
    if (!repoId) return;
    const current: Session = {
      draft: empty,
      revision: null,
      version: 0,
      saved: 0,
      initialized: false,
      running: false,
      live: true,
      flush: async () => {},
    };
    session.current = current;
    current.flush = async () => {
      clearTimeout(current.timer);
      if (!current.initialized || current.running || current.saved === current.version) return;
      current.running = true;
      try {
        while (current.saved !== current.version) {
          const version = current.version;
          const result = await window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'commitDraftSave',
            repoId,
            revision: current.revision,
            draft: current.draft,
          });
          if (result.kind !== 'commitDraft')
            throw new Error(
              result.kind === 'error' ? result.message : 'Draft save was not confirmed.',
            );
          current.revision = result.state.revision;
          current.saved = version;
        }
        if (current.live) {
          setStatus('Draft saved locally');
          setError(undefined);
        }
      } catch (error) {
        if (current.live) {
          setStatus('Draft not saved');
          setError(error instanceof Error ? error.message : 'Draft save was not confirmed.');
        }
      } finally {
        current.running = false;
      }
    };
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'commitDraftRead', repoId })
      .then((result) => {
        if (!current.live) return;
        if (result.kind !== 'commitDraft')
          throw new Error(result.kind === 'error' ? result.message : 'Draft could not be loaded.');
        current.revision = result.state.revision;
        current.draft = result.state.draft ?? empty;
        current.initialized = true;
        setDraft(current.draft);
        setRestored(result.state.draft !== null);
        setStatus(result.state.draft ? 'Draft saved locally' : 'Draft is empty');
      })
      .catch((error: unknown) => {
        if (current.live) {
          setStatus('Draft not saved');
          setError(error instanceof Error ? error.message : 'Draft could not be loaded.');
        }
      })
      .finally(() => {
        if (current.live) setReady(true);
      });
    const flush = () => {
      void current.flush();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      current.live = false;
      window.removeEventListener('beforeunload', flush);
      void current.flush();
    };
  }, [repoId]);
  const change = (patch: Partial<CommitDraft>) => {
    const current = session.current;
    if (!current) return;
    current.draft = { ...current.draft, ...patch };
    current.version++;
    setDraft(current.draft);
    if (!current.initialized) return;
    setStatus('Saving draft…');
    clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      void current.flush();
    }, 250);
  };
  return { draft, ready, restored, status, error, change };
}
