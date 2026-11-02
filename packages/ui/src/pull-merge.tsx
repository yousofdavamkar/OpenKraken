import { useEffect, useRef, useState } from 'react';
import {
  providerMergePullSchema,
  type ProviderMergeMethod,
  type ProviderMergePreview,
  type ProviderPullDetails,
  type ProviderPullOptions,
} from '@openkraken/ipc-contract';
type Target = {
  accountId: string;
  origin: string;
  repository: ProviderPullOptions['repository'];
  number: number;
};
const methodNames: Record<ProviderMergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};
function MergeDialog({ target, close }: { target: Target; close: (changed: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    request = useRef<string | undefined>(undefined);
  const [preview, setPreview] = useState<ProviderMergePreview>();
  const [attempt, setAttempt] = useState(0),
    [method, setMethod] = useState<ProviderMergeMethod>('merge');
  const [defaults, setDefaults] = useState(true),
    [title, setTitle] = useState(''),
    [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(true),
    [confirmed, setConfirmed] = useState(false),
    [mustRefresh, setMustRefresh] = useState(false);
  const [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const [sha, setSha] = useState<string>();
  const [observed, setObserved] = useState<ProviderPullDetails>();
  const [changed, setChanged] = useState(false);
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
    setPreview(undefined);
    setConfirmed(false);
    setMustRefresh(false);
    void window.openkraken
      .request({
        id,
        method: 'providerMergePreview',
        accountId: target.accountId,
        options: { repository: target.repository, number: target.number },
      })
      .then((response) => {
        if (!alive) return;
        if (response.kind === 'providerMergePreview') {
          setPreview(response.preview);
          setMethod((current) =>
            response.preview.methods.includes(current)
              ? current
              : (response.preview.methods[0] ?? 'merge'),
          );
        } else if (response.kind === 'error') setError(response.message);
        else if (response.kind === 'cancelled') setError('Merge preview cancelled.');
      })
      .catch(() => {
        if (alive) setError('The merge preview could not be loaded.');
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
  const current = preview?.pullRequest;
  const revision = current
    ? {
        head: current.head.sha,
        base: current.base.sha,
        headRef: current.head.ref,
        baseRef: current.base.ref,
      }
    : undefined;
  const options = {
    repository: target.repository,
    number: target.number,
    revision,
    method,
    ...(method !== 'rebase' && !defaults ? { commitTitle: title, commitMessage: message } : {}),
  };
  const reason =
    !preview || !current
      ? ''
      : preview.archived
        ? 'This repository is archived.'
        : preview.canPush === false
          ? 'This account cannot push to the repository.'
          : current.state !== 'open' || current.merged
            ? 'This pull request is closed.'
            : current.draft
              ? 'Draft pull requests cannot be merged.'
              : !preview.methods.length
                ? 'No supported merge methods were advertised for this account.'
                : current.mergeable === null
                  ? 'The provider is still calculating mergeability. Refresh the preview.'
                  : !current.mergeable
                    ? 'Resolve merge conflicts before merging this pull request.'
                    : '';
  const ready =
    !!preview &&
    !reason &&
    preview.methods.includes(method) &&
    providerMergePullSchema.safeParse(options).success &&
    !mustRefresh;
  const leave = () => {
    if (busy) return;
    if (dirty && !sha && !observed?.merged) setDiscard(true);
    else close(changed);
  };
  const merge = async () => {
    const parsed = providerMergePullSchema.safeParse(options);
    if (!parsed.success || !ready) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError('');
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerMergePull',
        accountId: target.accountId,
        options: parsed.data,
      });
      if (response.kind === 'providerPullMerged') {
        setSha(response.merge.sha);
        setChanged(true);
      } else if (response.kind === 'error') {
        setError(response.message);
        setConfirmed(false);
        setMustRefresh(true);
        setUncertain(response.code === 'PROVIDER_WRITE_UNCERTAIN');
        if (response.code === 'PROVIDER_WRITE_UNCERTAIN') setChanged(true);
      } else if (response.kind === 'cancelled') {
        setError('Merge cancelled before submission.');
        setConfirmed(false);
        setMustRefresh(true);
      }
    } catch {
      setError('The merge result is unknown. Check the current merge status before trying again.');
      setUncertain(true);
      setConfirmed(false);
      setMustRefresh(true);
      setChanged(true);
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const check = async () => {
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setObserved(undefined);
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerPullRequest',
        accountId: target.accountId,
        options: { repository: target.repository, number: target.number },
      });
      if (response.kind === 'providerPullRequest') {
        setObserved(response.pullRequest);
        if (response.pullRequest.merged) setChanged(true);
      } else if (response.kind === 'error') setError(response.message);
    } catch {
      setError('The merge status could not be checked.');
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pr-merge-dialog"
      aria-label="Merge pull request"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
    >
      <h2>Merge pull request #{target.number}</h2>
      <p>
        {target.origin}/{target.repository.owner}/{target.repository.name}
      </p>
      {busy && <p role="status">Waiting for provider…</p>}
      {current && (
        <>
          <h3>{current.title}</h3>
          <p>
            {current.head.label} → {current.base.label}
          </p>
          <p>
            Reviewed head: <code>{current.head.sha}</code>
          </p>
          <p>
            Reviewed target: <code>{current.base.sha}</code>
          </p>
          <p>
            Provider mergeability: {current.mergeableState}. The provider will enforce required
            reviews, checks and branch rules.
          </p>
          {preview?.canPush === null && (
            <p>
              Account push permission was not reported. The provider will check it when merging.
            </p>
          )}
          {reason && <p role="alert">{reason}</p>}
          <fieldset disabled={busy || confirmed || !!sha || uncertain}>
            <legend>Merge method and message</legend>
            <label>
              Merge method
              <select
                value={method}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'merge' || value === 'squash' || value === 'rebase')
                    setMethod(value);
                }}
              >
                {preview?.methods.map((value) => (
                  <option key={value} value={value}>
                    {methodNames[value]}
                  </option>
                ))}
              </select>
            </label>
            {method === 'rebase' ? (
              <p>Rebase preserves the source commit messages.</p>
            ) : (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={defaults}
                    onChange={(event) => {
                      setDefaults(event.target.checked);
                      setDirty(true);
                    }}
                  />
                  Use provider default commit message
                </label>
                {!defaults && (
                  <>
                    <label>
                      Merge commit title
                      <input
                        maxLength={256}
                        value={title}
                        onChange={(event) => {
                          setTitle(event.target.value);
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label>
                      Merge commit message
                      <textarea
                        rows={5}
                        maxLength={65536}
                        value={message}
                        onChange={(event) => {
                          setMessage(event.target.value);
                          setDirty(true);
                        }}
                      />
                    </label>
                  </>
                )}
              </>
            )}
          </fieldset>
        </>
      )}
      {confirmed && !sha && (
        <section aria-label="Confirm remote PR merge">
          <p>
            {methodNames[method]} #{target.number} into {current?.base.label}.
          </p>
          <p>This updates the remote target branch. There is no Undo for this action here.</p>
          <p>
            {method === 'rebase'
              ? 'Keep the source commit messages.'
              : defaults
                ? 'Use the provider default commit message.'
                : title}
          </p>
          {method !== 'rebase' && !defaults && <pre>{message}</pre>}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {sha && (
        <p role="status">
          Merged. Resulting commit: <code>{sha}</code>
        </p>
      )}
      {uncertain && (
        <section aria-label="Uncertain merge result">
          <button disabled={busy} onClick={() => void check()}>
            Check merge status
          </button>
          {observed && (
            <>
              <p role="status">
                {observed.merged
                  ? 'The provider now reports this PR as merged.'
                  : observed.state === 'closed'
                    ? 'The provider reports this PR as closed without merging.'
                    : 'The provider still reports this PR as open.'}
              </p>
              <p>
                Current head: <code>{observed.head.sha}</code>
              </p>
              {!observed.merged && observed.state === 'open' && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setUncertain(false);
                    setObserved(undefined);
                    setAttempt((value) => value + 1);
                  }}
                >
                  I checked; load a fresh merge preview
                </button>
              )}
            </>
          )}
        </section>
      )}
      {discard ? (
        <section aria-label="Discard merge message">
          <p>Discard the unsent custom merge message?</p>
          <button onClick={() => setDiscard(false)}>Keep editing</button>
          <button onClick={() => close(changed)}>Discard message</button>
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
          {!sha && !uncertain && (
            <>
              <button disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
                Refresh merge preview
              </button>
              {confirmed ? (
                <>
                  <button disabled={busy} onClick={() => setConfirmed(false)}>
                    Edit merge
                  </button>
                  <button className="danger" disabled={busy || !ready} onClick={() => void merge()}>
                    Merge confirmed PR
                  </button>
                </>
              ) : (
                <button disabled={busy || !ready} onClick={() => setConfirmed(true)}>
                  Review selected merge
                </button>
              )}
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
export function MergePullRequest({
  target,
  detail,
  finished,
}: {
  target: Omit<Target, 'number'>;
  detail: ProviderPullDetails;
  finished: (changed: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button
        disabled={detail.state !== 'open' || detail.merged || detail.draft}
        onClick={() => setOpened(true)}
      >
        Review PR merge
      </button>
      {opened && (
        <MergeDialog
          target={{ ...target, number: detail.number }}
          close={(changed) => {
            setOpened(false);
            finished(changed);
          }}
        />
      )}
    </>
  );
}
