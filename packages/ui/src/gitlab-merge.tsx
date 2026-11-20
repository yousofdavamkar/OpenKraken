import { useEffect, useRef, useState } from 'react';
import {
  providerMergeRequestMergeIntentSchema,
  type ProviderPullOptions,
  type ProviderMergeRequestMergeState,
  type ProviderMergeRequestMergeIntent,
  type ProviderMergeRequestMergePreview,
  type ProviderMergeRequestMerged,
  type ProviderMergeRequestDetails,
} from '@openkraken/ipc-contract';
type Target = ProviderPullOptions & { accountId: string; origin: string };
const methods = {
  merge: 'Merge commit',
  rebase_merge: 'Merge commit with semi-linear history',
  ff: 'Fast-forward merge',
};
function MergeState({ snapshot }: { snapshot: ProviderMergeRequestMergeState }) {
  return (
    <>
      <h3>
        !{snapshot.mergeRequest.number}: {snapshot.mergeRequest.title}
      </h3>
      <p>
        {snapshot.mergeRequest.source.branch} → {snapshot.mergeRequest.target.branch}
      </p>
      <p>
        Source commit: <code>{snapshot.head ?? 'Unavailable'}</code>
      </p>
      <p>
        Current target commit: <code>{snapshot.base}</code>
      </p>
      <p>
        Project strategy: {methods[snapshot.policy.method]} · Squash policy:{' '}
        {snapshot.policy.squash}
      </p>
      <p>
        Merge status: {snapshot.mergeRequest.mergeStatus} · Permission:{' '}
        {snapshot.canMerge === null ? 'Unavailable' : snapshot.canMerge ? 'Allowed' : 'Denied'}
      </p>
      <p>
        Required pipeline:{' '}
        {snapshot.policy.pipelineRequired === null
          ? 'Unavailable'
          : snapshot.policy.pipelineRequired
            ? 'Yes'
            : 'No'}{' '}
        · Resolved discussions required:{' '}
        {snapshot.policy.discussionsRequired === null
          ? 'Unavailable'
          : snapshot.policy.discussionsRequired
            ? 'Yes'
            : 'No'}
      </p>
      {snapshot.pipeline && (
        <p>
          Pipeline #{snapshot.pipeline.id}: {snapshot.pipeline.status} ·{' '}
          <code>{snapshot.pipeline.sha}</code>
        </p>
      )}
      {snapshot.mergeAfter && (
        <p>Earliest merge: {new Date(snapshot.mergeAfter).toLocaleString()}</p>
      )}
      {snapshot.policy.archived && <p>This repository is archived.</p>}
      {snapshot.mergeRequest.draft && <p>This merge request is a draft.</p>}
      {snapshot.autoMerge && <p>An automatic merge is already scheduled. Manage it on GitLab.</p>}
      {snapshot.forceRemoveSourceBranch && (
        <p>
          This merge request is configured to remove its source branch. Confirm removal or change
          that setting on GitLab.
        </p>
      )}
    </>
  );
}
function MergeDialog({ target, close }: { target: Target; close: (changed: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<ProviderMergeRequestMergeState>();
  const [preview, setPreview] = useState<ProviderMergeRequestMergePreview>();
  const [prepared, setPrepared] = useState<ProviderMergeRequestMergeIntent>();
  const [selectedSquash, setSelectedSquash] = useState<boolean>();
  const squash =
    snapshot?.policy.squash === 'always' ||
    (snapshot?.policy.squash !== 'never' && (selectedSquash ?? snapshot?.squash ?? false));
  const [removeSource, setRemoveSource] = useState(false);
  const [defaults, setDefaults] = useState(true);
  const [mergeMessage, setMergeMessage] = useState('');
  const [squashMessage, setSquashMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ProviderMergeRequestMerged>();
  const [uncertain, setUncertain] = useState(false);
  const [changed, setChanged] = useState(false);
  const [observed, setObserved] = useState<ProviderMergeRequestDetails>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (request.current) void window.openkraken.cancel(request.current);
    };
  }, []);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    request.current = id;
    setBusy(true);
    setError('');
    setSnapshot(undefined);
    setPreview(undefined);
    setPrepared(undefined);
    void window.openkraken
      .request({
        id,
        method: 'providerMergeRequestMergeState',
        accountId: target.accountId,
        options: { repository: target.repository, number: target.number },
      })
      .then((response) => {
        if (!alive) return;
        if (response.kind === 'providerMergeRequestMergeState') {
          setSnapshot(response.snapshot);
        } else
          setError(response.kind === 'error' ? response.message : 'Merge state loading cancelled.');
      })
      .catch(() => {
        if (alive) setError('The merge state could not be loaded.');
      })
      .finally(() => {
        if (alive) {
          request.current = undefined;
          setBusy(false);
        }
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target.accountId, target.repository, target.number, attempt]);
  const draft = providerMergeRequestMergeIntentSchema.safeParse({
    repository: target.repository,
    number: target.number,
    head: snapshot?.head,
    squash,
    removeSourceBranch: removeSource,
    ...(!defaults && snapshot?.policy.method !== 'ff' ? { mergeMessage } : {}),
    ...(!defaults && squash ? { squashMessage } : {}),
  });
  const run = async (kind: 'review' | 'merge' | 'inspect') => {
    if (
      request.current ||
      (kind === 'review' && !draft.success) ||
      (kind === 'merge' && (!prepared || !preview || uncertain))
    )
      return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError('');
    if (kind === 'review') {
      setPreview(undefined);
      setPrepared(undefined);
    }
    if (kind === 'inspect') setObserved(undefined);
    try {
      const response = await window.openkraken.request(
        kind === 'review' && draft.success
          ? {
              id,
              method: 'providerMergeRequestMergePreview',
              accountId: target.accountId,
              options: draft.data,
            }
          : kind === 'inspect'
            ? {
                id,
                method: 'providerMergeRequest',
                accountId: target.accountId,
                options: { repository: target.repository, number: target.number },
              }
            : {
                id,
                method: 'providerMergeRequestMerge',
                accountId: target.accountId,
                options: { intent: prepared!, revision: preview!.revision },
              },
      );
      if (
        kind === 'review' &&
        response.kind === 'providerMergeRequestMergePreview' &&
        draft.success
      ) {
        setSnapshot(response.preview.snapshot);
        setPreview(response.preview);
        setPrepared(draft.data);
      } else if (kind === 'merge' && response.kind === 'providerMergeRequestMerged') {
        setResult(response.result);
        setChanged(true);
      } else if (kind === 'inspect' && response.kind === 'providerMergeRequest')
        setObserved(response.mergeRequest);
      else if (response.kind === 'error') {
        setError(response.message);
        setPreview(undefined);
        setPrepared(undefined);
        if (response.code === 'PROVIDER_WRITE_UNCERTAIN') {
          setUncertain(true);
          setChanged(true);
        }
      } else if (response.kind === 'cancelled') {
        setError('Merge request cancelled before submission.');
        setPreview(undefined);
        setPrepared(undefined);
      } else throw new Error('Unexpected merge result');
    } catch {
      setPreview(undefined);
      setPrepared(undefined);
      if (kind === 'merge') {
        setUncertain(true);
        setChanged(true);
        setError('The merge result is unknown. Check the current status before trying again.');
      } else setError('The merge review or status could not be loaded.');
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const leave = () => {
    if (request.current) return;
    if (dirty && !result && observed?.state !== 'merged') setDiscard(true);
    else close(changed);
  };
  const locked = busy || !!prepared || !!result || uncertain;
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pr-merge-dialog"
      aria-label="Merge GitLab request"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
    >
      <h2>Merge GitLab request !{target.number}</h2>
      <p>
        {target.origin}/{target.repository.owner}/{target.repository.name}
      </p>
      {snapshot && (
        <section aria-label="GitLab merge state">
          <MergeState snapshot={snapshot} />
        </section>
      )}
      <fieldset disabled={locked || !snapshot}>
        <legend>Merge options</legend>
        <label>
          <input
            type="checkbox"
            checked={squash}
            disabled={snapshot?.policy.squash === 'always' || snapshot?.policy.squash === 'never'}
            onChange={(event) => {
              setSelectedSquash(event.target.checked);
              setDirty(true);
            }}
          />
          Squash commits
        </label>
        <label>
          <input
            type="checkbox"
            checked={removeSource}
            onChange={(event) => {
              setRemoveSource(event.target.checked);
              setDirty(true);
            }}
          />
          Remove source branch after merge
        </label>
        {snapshot?.sourceProtected && (
          <p>The source branch is protected; removal is unavailable.</p>
        )}
        {snapshot?.sourceDefault && (
          <p>The source is its project's default branch; removal is unavailable.</p>
        )}
        <label>
          <input
            type="checkbox"
            checked={defaults}
            onChange={(event) => {
              setDefaults(event.target.checked);
              setDirty(true);
            }}
          />
          Use GitLab commit messages
        </label>
        {!defaults && snapshot?.policy.method !== 'ff' && (
          <label>
            Merge commit message
            <textarea
              rows={4}
              maxLength={65536}
              value={mergeMessage}
              onChange={(event) => {
                setMergeMessage(event.target.value);
                setDirty(true);
              }}
            />
          </label>
        )}
        {!defaults && squash && (
          <label>
            Squash commit message
            <textarea
              rows={4}
              maxLength={65536}
              value={squashMessage}
              onChange={(event) => {
                setSquashMessage(event.target.value);
                setDirty(true);
              }}
            />
          </label>
        )}
      </fieldset>
      {prepared && preview && !result && !uncertain && (
        <section aria-label="Confirm GitLab merge">
          <h3>Confirm direct merge</h3>
          <MergeState snapshot={preview.snapshot} />
          <p>
            Squash commits: {prepared.squash ? 'Yes' : 'No'} · Request source branch removal:{' '}
            {prepared.removeSourceBranch ? 'Yes' : 'No'}
          </p>
          {prepared.mergeMessage !== undefined && (
            <>
              <h4>Merge commit message</h4>
              <pre>{prepared.mergeMessage}</pre>
            </>
          )}
          {prepared.squashMessage !== undefined && (
            <>
              <h4>Squash commit message</h4>
              <pre>{prepared.squashMessage}</pre>
            </>
          )}
          <p>
            Confirmation changes the target branch on GitLab and can notify participants. GitLab
            checks the reviewed source commit. The target can still change between the final check
            and merge.
          </p>
        </section>
      )}
      {busy && <p role="status">Waiting for GitLab…</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p role="status">Merged !{result.mergeRequest.number}.</p>
          {result.mergeCommit && (
            <p>
              Merge commit: <code>{result.mergeCommit}</code>
            </p>
          )}
          {result.squashCommit && (
            <p>
              Squash commit: <code>{result.squashCommit}</code>
            </p>
          )}
          <p>{result.mergeRequest.url}</p>
          {prepared?.removeSourceBranch && (
            <p>Source branch removal was requested; its completion has not been checked.</p>
          )}
        </>
      )}
      {uncertain && (
        <section aria-label="Uncertain GitLab merge">
          <h3>The merge result is uncertain</h3>
          <p>
            The request may have completed. Check the current state before considering another
            attempt.
          </p>
          <button disabled={busy} onClick={() => void run('inspect')}>
            Check current merge status
          </button>
          {observed && (
            <section aria-label="Observed merge status">
              <p>
                !{observed.number}: {observed.state}. This is the current state, not proof of which
                request caused it.
              </p>
              <p>{observed.url}</p>
              {observed.state === 'open' && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setUncertain(false);
                    setObserved(undefined);
                    setAttempt((value) => value + 1);
                  }}
                >
                  I checked; review again
                </button>
              )}
            </section>
          )}
        </section>
      )}
      {discard ? (
        <section aria-label="Discard merge messages">
          <p>Discard these unsent merge options and messages?</p>
          <button onClick={() => setDiscard(false)}>Keep editing</button>
          <button onClick={() => close(changed)}>Discard draft</button>
        </section>
      ) : (
        <div className="dialog-actions">
          <button disabled={busy} onClick={leave}>
            Close merge
          </button>
          {busy && (
            <button
              onClick={() => {
                if (request.current) void window.openkraken.cancel(request.current);
              }}
            >
              Cancel request
            </button>
          )}
          {!result && !uncertain && (
            <>
              <button
                disabled={busy || !!prepared}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Refresh merge state
              </button>
              {prepared ? (
                <>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setPrepared(undefined);
                      setPreview(undefined);
                    }}
                  >
                    Edit merge options
                  </button>
                  <button disabled={busy} onClick={() => void run('merge')}>
                    Confirm GitLab merge
                  </button>
                </>
              ) : (
                <button disabled={busy || !draft.success} onClick={() => void run('review')}>
                  Review merge options
                </button>
              )}
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
export function GitLabMerge({
  target,
  changed,
  disabled,
}: {
  target: Target;
  changed: () => void;
  disabled: boolean;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button disabled={disabled} onClick={() => setOpened(true)}>
        Review MR merge
      </button>
      {opened && (
        <MergeDialog
          target={target}
          close={(didChange) => {
            setOpened(false);
            if (didChange) changed();
          }}
        />
      )}
    </>
  );
}
