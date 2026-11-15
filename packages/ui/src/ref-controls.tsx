import type { GraphView, Ref } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';
import { soloRefView } from './history-model.js';

export function RefControls({ reference }: { reference: Ref }) {
  const { snapshot, busy: active, syncing, setView } = useRepository();
  const busy = syncing ? undefined : active;
  if (!snapshot || (reference.objectType !== 'commit' && reference.peeledType !== 'commit'))
    return null;
  const view = snapshot.view,
    name = reference.name;
  const hidden = view.hiddenRefs.includes(name),
    solo = view.soloRef === name,
    pinned = view.pinnedRef === name;
  const change = (next: GraphView) => void setView(next);
  return (
    <div className="ref-controls" aria-label={`View controls for ${reference.shortName}`}>
      <button
        disabled={!!busy}
        aria-label={`Hide ${reference.name}`}
        aria-pressed={hidden}
        onClick={() =>
          change({
            ...view,
            hiddenRefs: hidden
              ? view.hiddenRefs.filter((r) => r !== name)
              : [...view.hiddenRefs, name],
            soloRef: solo ? undefined : view.soloRef,
            pinnedRef: !hidden && pinned ? undefined : view.pinnedRef,
          })
        }
      >
        {hidden ? 'Show' : 'Hide'}
      </button>
      <button
        disabled={!!busy}
        aria-label={`Solo ${reference.name}`}
        aria-pressed={solo}
        onClick={() =>
          change(
            solo
              ? {
                  ...view,
                  soloRef: undefined,
                  hiddenRefs: view.hiddenRefs.filter((ref) => ref !== name),
                }
              : soloRefView(view, name),
          )
        }
      >
        Solo
      </button>
      {reference.kind !== 'stash' && (
        <button
          disabled={!!busy}
          aria-label={`Pin ${reference.name}`}
          aria-pressed={pinned}
          onClick={() =>
            change({
              ...view,
              pinnedRef: pinned ? undefined : name,
              hiddenRefs: view.hiddenRefs.filter((r) => r !== name),
              soloRef: view.soloRef && !solo ? undefined : view.soloRef,
            })
          }
        >
          Pin
        </button>
      )}
    </div>
  );
}
