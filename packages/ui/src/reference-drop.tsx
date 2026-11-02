import { useEffect, useRef, useState, type DragEvent } from 'react';
import { create } from 'zustand';
import type { Ref, Snapshot, WorkingState } from '@openkraken/ipc-contract';
import { IntegrationDialog } from './integration.js';
import { useRepository, waitForBackground } from './store.js';
const MIME = 'application/x-openkraken-reference';
type Drop = { repoId: string; source: Ref; target: Ref };
const useDrop = create<{ drop?: Drop; set: (drop?: Drop) => void }>((set) => ({
  set: (drop) => set({ drop }),
}));
const valid = (ref: Ref) =>
  ['local', 'remote', 'tag'].includes(ref.kind) &&
  (ref.objectType === 'commit' || ref.peeledType === 'commit');
export function referenceDragProps(reference: Ref, repoId: string, disabled: boolean) {
  return {
    draggable: !disabled && valid(reference),
    onDragStart: (event: DragEvent<HTMLDivElement>) => {
      if (disabled || !valid(reference)) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = 'link';
      event.dataTransfer.setData(
        MIME,
        JSON.stringify({ repoId, name: reference.name, oid: reference.target }),
      );
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!disabled && valid(reference) && event.dataTransfer.types.includes(MIME)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'link';
      }
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (disabled || !valid(reference)) return;
      event.preventDefault();
      event.stopPropagation();
      const raw = event.dataTransfer.getData(MIME);
      if (!raw || raw.length > 4096) return;
      try {
        const data: unknown = JSON.parse(raw);
        if (
          !data ||
          typeof data !== 'object' ||
          !('repoId' in data) ||
          !('name' in data) ||
          !('oid' in data)
        )
          return;
        const snapshot = useRepository.getState().snapshot;
        if (snapshot?.repository.id !== repoId || data.repoId !== repoId) return;
        const source = snapshot.refs.find(
          (ref) => ref.name === data.name && ref.target === data.oid,
        );
        const target = snapshot.refs.find(
          (ref) => ref.name === reference.name && ref.target === reference.target,
        );
        if (source && target && valid(source) && source.name !== target.name)
          useDrop.getState().set({ repoId, source, target });
      } catch {
        /* Ignore external or malformed drag payloads. */
      }
    },
  };
}
type Review = {
  snapshot: Snapshot;
  state: WorkingState;
  selected: string;
  initialKind: 'merge' | 'rebase';
};
function DropDialog({
  drop,
  close,
  review,
}: {
  drop: Drop;
  close: () => void;
  review: (value: Review) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const prepare = async (kind: 'merge' | 'rebase') => {
    setPending(true);
    setError('');
    let id: string | undefined;
    let switched = false;
    let state: WorkingState | undefined;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      const snapshot = useRepository.getState().snapshot;
      if (snapshot?.repository.id !== drop.repoId) return;
      for (const ref of [drop.source, drop.target])
        if (
          !snapshot.refs.some(
            (current) => current.name === ref.name && current.target === ref.target,
          )
        )
          throw new Error('A reference changed. Drag it again to review its current tip.');
      const branch = kind === 'merge' ? drop.target : drop.source;
      if (branch.kind !== 'local') throw new Error('The branch being changed must be local');
      const head = snapshot.repository.head;
      switched = head.kind !== 'branch' || head.ref !== branch.name;
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const result = await window.openkraken.request(
        switched
          ? {
              id,
              method: 'reference',
              repoId: drop.repoId,
              options: {
                action: 'checkoutBranch',
                name: branch.shortName,
                expected: branch.target,
              },
            }
          : { id, method: 'workingState', repoId: drop.repoId },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind !== 'workingState') return;
      if (result.state.operation && result.state.operation.kind !== 'none')
        throw new Error('Finish or abort the active operation before integrating another branch.');
      if (
        result.state.head.kind !== 'branch' ||
        result.state.head.ref !== branch.name ||
        result.state.head.oid !== branch.target
      )
        throw new Error('The current branch changed. Refresh and drag again.');
      state = result.state;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (switched && id && useRepository.getState().snapshot?.repository.id === drop.repoId)
        await useRepository
          .getState()
          .run({ id: crypto.randomUUID(), method: 'refresh', repoId: drop.repoId });
      setPending(false);
    }
    const snapshot = useRepository.getState().snapshot;
    if (state && snapshot?.repository.id === drop.repoId) {
      const target = kind === 'merge' ? drop.source : drop.target;
      review({ snapshot, state, selected: target.peeled ?? target.target, initialKind: kind });
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-label="Dropped reference actions"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <h2>
        {drop.source.shortName} → {drop.target.shortName}
      </h2>
      <p>
        Choose an action. The app switches to the branch being changed if needed, then opens a
        commit review before integration.
      </p>
      <p>
        Source: <code>{drop.source.peeled ?? drop.source.target}</code>
      </p>
      <p>
        Target: <code>{drop.target.peeled ?? drop.target.target}</code>
      </p>
      <button
        disabled={pending || drop.target.kind !== 'local'}
        onClick={() => void prepare('merge')}
      >
        Merge {drop.source.shortName} into {drop.target.shortName}
      </button>
      <button
        disabled={pending || drop.source.kind !== 'local'}
        onClick={() => void prepare('rebase')}
      >
        Rebase {drop.source.shortName} onto {drop.target.shortName}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {pending && (
          <button onClick={() => void useRepository.getState().cancel()}>Cancel operation</button>
        )}
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function ReferenceDropActions() {
  const { drop, set } = useDrop();
  const [review, setReview] = useState<Review>();
  const repoId = useRepository((state) => state.snapshot?.repository.id);
  if (!drop || drop.repoId !== repoId) return null;
  const close = () => {
    setReview(undefined);
    set();
  };
  return review ? (
    <IntegrationDialog {...review} close={close} />
  ) : (
    <DropDialog drop={drop} close={close} review={setReview} />
  );
}
