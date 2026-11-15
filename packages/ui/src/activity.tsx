import { useEffect, useRef, useState } from 'react';
import {
  activityActions,
  type ActivityAction,
  type ActivityCompletion,
  type ActivityEntry,
  type ActivityState,
} from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
const outcomes: Record<ActivityEntry['outcome'], string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  attention: 'Needs attention',
  unknown: 'Outcome unknown',
};
// These successes are already visible in the repository or staging panel.
const quietSuccesses = new Set<ActivityAction>([
  'open',
  'repositoryLinkOpen',
  'openWorktree',
  'openSubmodule',
  'files',
  'patch',
]);

export function ActivityToast() {
  const [notice, setNotice] = useState<ActivityCompletion>();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(
    () =>
      window.openkraken.subscribe((event) => {
        if (event.type !== 'activityChanged' || !event.completed) return;
        const completed = event.completed;
        if (
          completed.outcome === 'cancelled' ||
          (completed.outcome === 'succeeded' && quietSuccesses.has(completed.action))
        )
          return;
        setNotice(completed);
      }),
    [],
  );
  useEffect(() => {
    if (!notice || hovered || focused) return;
    const timer = window.setTimeout(() => setNotice(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [notice, hovered, focused]);

  return (
    <div
      className="operation-notifications"
      role="log"
      aria-label="Operation notifications"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {notice && (
        <div
          className="operation-toast"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <span key={notice.id}>
            {activityActions[notice.action]} · {outcomes[notice.outcome]}
          </span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onFocus={(event) => {
              previousFocus.current =
                event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
              setFocused(true);
            }}
            onBlur={() => setFocused(false)}
            onClick={(event) => {
              if (
                event.currentTarget === document.activeElement &&
                previousFocus.current?.isConnected
              )
                previousFocus.current.focus();
              setNotice(undefined);
              setHovered(false);
              setFocused(false);
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const [state, setState] = useState<ActivityState>();
  const [error, setError] = useState('');
  const [clearError, setClearError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [visible, setVisible] = useState(100);
  const load = async () => {
    const current = ++generation.current;
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'activityRead',
      });
      if (!mounted.current || current !== generation.current) return;
      if (result.kind !== 'activity') throw new Error('Activity could not be loaded. Retry.');
      setState(result.state);
      setError('');
    } catch {
      if (mounted.current && current === generation.current)
        setError('Activity could not be loaded. Retry.');
    }
  };
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    closeButton.current?.focus();
    const unsubscribe = window.openkraken.subscribe((event) => {
      if (event.type === 'activityChanged') void load();
    });
    void load();
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, []);
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    setClearError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'activityClear',
      });
      if (!mounted.current) return;
      if (result.kind !== 'activity')
        throw new Error('Activity could not be cleared. The saved history was retained.');
      generation.current++;
      setState(result.state);
    } catch {
      if (mounted.current)
        setClearError('Activity could not be cleared. The saved history was retained.');
    } finally {
      if (mounted.current) setClearing(false);
    }
  };
  useEffect(() => {
    if (!clearing && clearButton.current?.dataset.cleared === 'true') {
      closeButton.current?.focus();
      delete clearButton.current.dataset.cleared;
    }
  }, [clearing]);
  const entries =
    state?.entries.filter(
      (entry) =>
        (filter === 'all' || filter === entry.outcome) &&
        `${activityActions[entry.action]} ${outcomes[entry.outcome]}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <dialog
      ref={dialog}
      className="reference-dialog activity-dialog"
      aria-label="Activity"
      onCancel={(event) => {
        event.preventDefault();
        if (!clearing) close();
      }}
    >
      <h2>Activity</h2>
      <p>
        The latest 500 recorded operations on this device. Operation names, times and outcomes are
        saved locally; file contents, paths, URLs, messages and credentials are excluded.
      </p>
      <p>
        Failed or cancelled operations can leave partial changes. An unknown outcome means
        completion was not confirmed. Check the repository or provider before retrying. Background
        reads, automatic fetches and terminal commands are not recorded.
      </p>
      {state?.warning && (
        <p role="alert">
          {state.warning === 'unavailable'
            ? 'Saved history could not be loaded. Session activity is available, but cannot be saved. Check the activity file before restarting.'
            : 'Activity could not be saved. Session activity is available; recent entries may be missing after restart.'}
        </p>
      )}
      {error && (
        <p role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </p>
      )}
      {clearError && <p role="alert">{clearError}</p>}
      <div className="dialog-actions">
        <label>
          Find activity{' '}
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisible(100);
            }}
          />
        </label>
        <label>
          Outcome{' '}
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setVisible(100);
            }}
          >
            <option value="all">All outcomes</option>
            {Object.entries(outcomes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!state && !error && <p role="status">Loading activity…</p>}
      {state && !state.entries.length && <p>No recorded activity</p>}
      {!!state?.entries.length && !entries.length && <p>No matching activity</p>}
      <ol aria-label="Recent activity" className="activity-entries">
        {entries.slice(0, visible).map((entry) => (
          <li key={entry.id}>
            <strong>{activityActions[entry.action]}</strong> · {outcomes[entry.outcome]}
            <p>
              <time dateTime={new Date(entry.startedAt).toISOString()}>
                {new Date(entry.startedAt).toLocaleString()}
              </time>
              {entry.finishedAt !== null &&
                ` · ${Math.max(0, (entry.finishedAt - entry.startedAt) / 1000).toFixed(1)} s`}
            </p>
          </li>
        ))}
      </ol>
      {entries.length > visible && (
        <button onClick={() => setVisible((count) => count + 100)}>Show more activity</button>
      )}
      <div className="dialog-actions">
        <button
          ref={clearButton}
          disabled={clearing || !state?.entries.some((entry) => entry.outcome !== 'running')}
          onClick={(event) => {
            event.currentTarget.dataset.cleared = 'true';
            void clear();
          }}
        >
          Clear completed activity
        </button>
        <button ref={closeButton} disabled={clearing} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function Activity() {
  const [open, setOpen] = useState(false);
  const initiator = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <CommandButton
        command="app.activity"
        onClick={(event) => {
          initiator.current = event.currentTarget;
          setOpen(true);
        }}
      >
        Activity
      </CommandButton>
      {open && (
        <ActivityDialog
          close={() => {
            setOpen(false);
            queueMicrotask(() => initiator.current?.focus());
          }}
        />
      )}
    </>
  );
}
