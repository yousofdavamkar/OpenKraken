import { CommandButton } from './commands.js';
import { useEffect, useRef, useState } from 'react';
import type {
  InteractiveRebase,
  InteractiveRebasePreview,
  Snapshot,
} from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
import { GitProgress } from './git-progress.js';
type Step = InteractiveRebase['steps'][number];
function RebaseDialog({
  snapshot,
  selected,
  close,
}: {
  snapshot: Snapshot;
  selected?: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const choices = snapshot.refs.filter(
    (ref) => ref.objectType === 'commit' || ref.peeledType === 'commit',
  );
  const [base, setBase] = useState(selected ?? choices[0]?.peeled ?? choices[0]?.target ?? '');
  const [preview, setPreview] = useState<InteractiveRebasePreview>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const update = (index: number, change: Partial<Step>) =>
    setSteps((steps) =>
      steps.map((step, position) => (position === index ? { ...step, ...change } : step)),
    );
  const move = (from: number, to: number) =>
    setSteps((steps) => {
      if (from < 0 || to < 0 || to >= steps.length) return steps;
      const next = [...steps];
      const [step] = next.splice(from, 1);
      if (step) next.splice(to, 0, step);
      return next;
    });
  const first = steps.find((step) => step.action !== 'drop');
  const invalid =
    first && ['squash', 'fixup'].includes(first.action)
      ? 'The first retained commit must be Pick, Reword or Edit.'
      : steps.some((step) => ['reword', 'squash'].includes(step.action) && !step.newMessage?.trim())
        ? 'Enter a message for each Reword or Squash step.'
        : '';
  const execute = async (start: boolean) => {
    const repoId = snapshot.repository.id;
    setPending(true);
    setError('');
    let id: string | undefined;
    let success = false;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const result = await window.openkraken.request(
        start && preview
          ? {
              id,
              method: 'interactiveRebase',
              repoId,
              options: {
                base,
                token: preview.token,
                steps: steps.map((step) => ({
                  action: step.action,
                  oid: step.oid,
                  ...(['reword', 'squash'].includes(step.action)
                    ? { newMessage: step.newMessage }
                    : {}),
                })),
              },
            }
          : { id, method: 'interactiveRebasePreview', repoId, base },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled') setError('Rebase cancelled. Review the current Git state.');
      if (result.kind === 'interactiveRebasePreview') {
        setPreview(result.preview);
        setSteps(
          result.preview.commits.map((commit) => ({
            action: 'pick',
            oid: commit.oid,
            newMessage: commit.message,
          })),
        );
      }
      success = start && result.kind === 'workingState';
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (start && id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
      if (success) close();
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-label="Plan interactive rebase"
      className="reference-dialog rebase-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>Plan interactive rebase</h2>
      <p>
        Rewrite the commits after the selected base, from top to bottom. The reviewed actions can
        change commit IDs.
      </p>
      <label>
        Rebase base
        <select
          aria-label="Rebase base"
          value={base}
          disabled={pending}
          onChange={(event) => {
            setBase(event.target.value);
            setPreview(undefined);
            setSteps([]);
            setError('');
          }}
        >
          {selected && <option value={selected}>Selected commit · {selected.slice(0, 8)}</option>}
          {choices.map((ref) => (
            <option key={ref.name} value={ref.peeled ?? ref.target}>
              {ref.shortName}
            </option>
          ))}
        </select>
      </label>
      <button disabled={pending || !base} onClick={() => void execute(false)}>
        {preview ? 'Re-review commits' : 'Review commits'}
      </button>
      {preview && (
        <>
          <p>
            Reviewed HEAD: <code>{preview.head.oid}</code>
          </p>
          <p>
            Drag steps or use Move up / Move down. Squash uses the entered message for the combined
            commit; Fixup keeps the preceding message. Edit pauses for amendment.
          </p>
          <ol aria-label="Rebase steps" className="rebase-steps">
            {steps.map((step, index) => {
              const commit = preview.commits.find((commit) => commit.oid === step.oid)!;
              return (
                <li
                  key={step.oid}
                  data-testid="rebase-step"
                  draggable={!pending}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-openkraken-rebase-step', step.oid);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => {
                    if (
                      !pending &&
                      event.dataTransfer.types.includes('application/x-openkraken-rebase-step')
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (pending) return;
                    event.preventDefault();
                    move(
                      steps.findIndex(
                        (item) =>
                          item.oid ===
                          event.dataTransfer.getData('application/x-openkraken-rebase-step'),
                      ),
                      index,
                    );
                  }}
                >
                  <div className="rebase-step-heading">
                    <code>{step.oid.slice(0, 8)}</code>{' '}
                    <strong>{commit.message.split('\n')[0]}</strong>
                  </div>
                  <div className="dialog-actions">
                    <label>
                      Action
                      <select
                        aria-label="Action"
                        value={step.action}
                        disabled={pending}
                        onChange={(event) =>
                          update(index, { action: event.target.value as Step['action'] })
                        }
                      >
                        {(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'] as const).map(
                          (action) => (
                            <option key={action} value={action}>
                              {action[0]!.toUpperCase() + action.slice(1)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <button
                      disabled={pending || index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      Move up
                    </button>
                    <button
                      disabled={pending || index === steps.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      Move down
                    </button>
                  </div>
                  {['reword', 'squash'].includes(step.action) && (
                    <label>
                      Commit message
                      <textarea
                        aria-label="Commit message"
                        rows={3}
                        maxLength={65536}
                        disabled={pending}
                        value={step.newMessage ?? ''}
                        onChange={(event) => update(index, { newMessage: event.target.value })}
                      />
                    </label>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {invalid && <p role="status">{invalid}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <GitProgress />
      <div className="dialog-actions">
        <button disabled={pending} onClick={close}>
          Close
        </button>
        {pending && (
          <button onClick={() => void useRepository.getState().cancel()}>Cancel operation</button>
        )}
        <button
          className="primary"
          disabled={pending || !preview || !!invalid}
          onClick={() => void execute(true)}
        >
          Start reviewed rebase
        </button>
      </div>
    </dialog>
  );
}
export function InteractiveRebaseControl() {
  const { snapshot, workingState, detail, selection, busy, syncing } = useRepository();
  const [review, setReview] = useState<{ snapshot: Snapshot; selected?: string }>();
  if (!snapshot || snapshot.repository.isBare) return null;
  return (
    <>
      <CommandButton
        command="history.rebase"
        disabled={
          (!!busy && !syncing) ||
          !workingState?.head.oid ||
          (!!workingState.operation && workingState.operation.kind !== 'none')
        }
        onClick={() => {
          const selected = detail?.oid ?? selection.focus;
          setReview({
            snapshot,
            selected:
              selected && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selected) ? selected : undefined,
          });
        }}
      >
        Interactive rebase
      </CommandButton>
      {review && <RebaseDialog {...review} close={() => setReview(undefined)} />}
    </>
  );
}
