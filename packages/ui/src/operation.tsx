import { useEffect, useRef, useState } from 'react';
import type { OperationAction, OperationState } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
import { GitProgress } from './git-progress.js';
const names = {
  none: '',
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  am: 'Mailbox apply',
  bisect: 'Bisect',
};
function Confirmation({
  state,
  action,
  pending,
  close,
  submit,
}: {
  state: OperationState;
  action: 'skip' | 'abort';
  pending: boolean;
  close: () => void;
  submit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = `${action === 'abort' ? 'Abort' : 'Skip'} ${state.kind}`;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className="reference-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>{title}</h2>
      <p>
        {action === 'abort'
          ? 'Return to the state before this operation. Git may discard conflict-resolution edits.'
          : 'Discard the current commit’s changes and conflict-resolution edits, then continue with the next commit.'}
      </p>
      {state.currentCommit && (
        <p>
          Current commit: <code>{state.currentCommit}</code>
        </p>
      )}
      <p>This action has no application Undo yet.</p>
      <div className="dialog-actions">
        <button disabled={pending} onClick={close}>
          Keep working
        </button>
        <button disabled={pending} onClick={submit}>
          {title}
        </button>
      </div>
    </dialog>
  );
}
export function OperationPanel() {
  const { snapshot, workingState, busy, syncing } = useRepository();
  const state = workingState?.operation;
  const [review, setReview] = useState<{ state: OperationState; action: 'skip' | 'abort' }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const repoId = snapshot?.repository.id;
  if (!repoId || !state || state.kind === 'none') return null;
  const submit = async (options: OperationAction) => {
    setPending(true);
    setError('');
    let id: string | undefined;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const result = await window.openkraken.request({
        id,
        method: 'operationAction',
        repoId,
        options,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled')
        setError('Operation cancelled. Review the refreshed Git state.');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setReview(undefined);
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  return (
    <section aria-label="Git operation" className="operation-panel">
      <h3>{names[state.kind]} in progress</h3>
      {state.progress && (
        <p>
          Step {state.progress.current} of {state.progress.total}
        </p>
      )}
      {state.conflicts > 0 && (
        <p>
          {state.conflicts} conflicted {state.conflicts === 1 ? 'file' : 'files'}. Resolve and stage
          each file before continuing.
        </p>
      )}
      {state.message && (
        <details>
          <summary>Prepared commit message</summary>
          <pre>{state.message}</pre>
        </details>
      )}
      {!state.actions.length && <p>Finish this operation with Git, then refresh the repository.</p>}
      <div className="dialog-actions">
        {state.actions.map((action) => (
          <button
            key={action}
            disabled={
              pending || (!!busy && !syncing) || (action === 'continue' && state.conflicts > 0)
            }
            onClick={() => {
              if (action === 'continue') void submit({ action, token: state.token });
              else setReview({ state, action });
            }}
          >
            {action === 'continue' ? 'Continue' : action === 'skip' ? 'Skip' : 'Abort'}
          </button>
        ))}
      </div>
      {pending && (
        <button onClick={() => void useRepository.getState().cancel()}>Cancel operation</button>
      )}
      <GitProgress />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {review && (
        <Confirmation
          {...review}
          pending={pending}
          close={() => setReview(undefined)}
          submit={() => void submit({ action: review.action, token: review.state.token })}
        />
      )}
    </section>
  );
}
