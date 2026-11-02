import { useEffect, useRef, useState } from 'react';
import type { PullOptions, Result } from '@openkraken/ipc-contract';
import { ProviderGitAccount } from './provider-git-account.js';
import { GitProgress } from './git-progress.js';
import { useRepository, waitForBackground } from './store.js';
function PullDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preferenceKey = `openkraken.pull.${repoId}`;
  const [mode, setMode] = useState<PullOptions['mode']>(() => {
    try {
      const saved = localStorage.getItem(preferenceKey);
      if (saved === 'merge' || saved === 'rebase') return saved;
    } catch {}
    return 'ff-only';
  });
  const [accountId, setAccountId] = useState('');
  const [review, setReview] = useState<
    Extract<Result, { kind: 'providerPullPreview' }> & { options: PullOptions; branch: string }
  >();
  const [complete, setComplete] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const upstream = useRepository((state) => state.snapshot?.status.upstream);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
    setPending(true);
    setNotice('');
    setError('');
    let id: string | undefined;
    let integrating = false;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      let options = review?.options;
      if (!options) {
        const current = await window.openkraken.request({ id, method: 'workingState', repoId });
        if (current.kind === 'error') throw new Error(current.message);
        if (current.kind !== 'workingState') return;
        options = { mode, revision: current.state.revision };
        id = crypto.randomUUID();
        useRepository.setState({ busy: id });
        if (accountId) {
          const preview = await window.openkraken.request({
            id,
            method: 'providerPullPreview',
            repoId,
            options,
          });
          if (preview.kind === 'error') throw new Error(preview.message);
          if (preview.kind === 'providerPullPreview') {
            setReview({
              ...preview,
              options,
              branch: current.state.head.kind === 'branch' ? current.state.head.ref : '',
            });
          } else if (preview.kind === 'cancelled') setNotice('Review cancelled');
          return;
        }
      }
      integrating = true;
      const result = await window.openkraken.request(
        accountId && review
          ? {
              id,
              method: 'providerGit',
              accountId,
              operation: { method: 'pull', repoId, options, revision: review.target.token },
            }
          : { id, method: 'pull', repoId, options },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'workingState' && review) setComplete(true);
      setNotice(
        result.kind === 'cancelled'
          ? 'Pull cancelled. Review the refreshed branch and any active operation before retrying.'
          : 'Pull completed',
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (integrating && id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-label="Pull upstream"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Pull upstream</h2>
        <p>
          {accountId
            ? 'Review the current branch, upstream and HTTPS remote before fetching.'
            : upstream
              ? `Fetch and integrate ${upstream} into the current branch.`
              : 'Set an upstream for the current branch before pulling.'}
        </p>
        <ProviderGitAccount
          label="Pull authentication"
          value={accountId}
          onChange={setAccountId}
          disabled={pending || !!review}
        />
        <label>
          Pull policy
          <select
            value={mode}
            disabled={pending || !!review}
            onChange={(event) => {
              const value = event.target.value;
              if (value !== 'ff-only' && value !== 'merge' && value !== 'rebase') return;
              setMode(value);
              setNotice('');
              try {
                localStorage.setItem(preferenceKey, value);
              } catch {
                setError('The pull preference could not be saved.');
              }
            }}
          >
            <option value="ff-only">Fast-forward only</option>
            <option value="merge">Merge</option>
            <option value="rebase">Rebase</option>
          </select>
        </label>
        <p>
          {mode === 'ff-only'
            ? 'Refuse if both branches contain new commits.'
            : mode === 'merge'
              ? 'Create a merge commit when the branches have diverged.'
              : 'Replay local commits on top of the fetched branch. This changes their commit IDs.'}
        </p>
        <p>
          Commit or stash tracked edits first. Conflicts remain available to resolve or abort with
          Git.
        </p>
        {review && (
          <section aria-label="Reviewed pull">
            <p>
              Fetch {review.upstream} into {review.branch}.
            </p>
            <p>{review.target.url}</p>
            <p>Policy: {review.options.mode}</p>
          </section>
        )}
        <GitProgress />
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {pending && (
            <button type="button" onClick={() => void useRepository.getState().cancel()}>
              Cancel operation
            </button>
          )}
          <button type="button" disabled={pending} onClick={close}>
            Close
          </button>
          {review && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setReview(undefined);
                setComplete(false);
                setNotice('');
                setError('');
              }}
            >
              Review again
            </button>
          )}
          {!complete && (
            <button disabled={pending || (!accountId && !upstream)}>
              {accountId
                ? review
                  ? 'Fetch reviewed upstream'
                  : 'Review pull'
                : 'Fetch and integrate'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
export function Pull() {
  const { snapshot, busy, syncing } = useRepository();
  const [opened, setOpened] = useState(false);
  if (!snapshot) return null;
  return (
    <>
      <button disabled={!!busy && !syncing} onClick={() => setOpened(true)}>
        Pull
      </button>
      {opened && (
        <PullDialog
          key={snapshot.repository.id}
          repoId={snapshot.repository.id}
          close={() => setOpened(false)}
        />
      )}
    </>
  );
}
