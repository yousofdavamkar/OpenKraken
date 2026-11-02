import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderMergeApprovals,
  ProviderMergeApprovalState,
  ProviderMergeApprovalOptions,
  ProviderMergeApprovalPreview,
  ProviderPullOptions,
} from '@openkraken/ipc-contract';
import { useProviderPoll } from './provider-polling.js';

type Target = ProviderPullOptions & { accountId: string };
function ApprovalEntries({
  label,
  entries,
}: {
  label: string;
  entries: { id: string; label: string; detail: string }[];
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const id = useId();
  const [active, setActive] = useState(0);
  const virtual = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 56,
    overscan: 3,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(entries[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  return entries.length ? (
    <div
      ref={scroll}
      role="list"
      aria-label={label}
      className="provider-repositories"
      tabIndex={0}
      aria-describedby={entries[active] ? `${id}-${entries[active].id}` : undefined}
      onKeyDown={(event) => {
        let next: number;
        if (event.key === 'ArrowDown') next = active + 1;
        else if (event.key === 'ArrowUp') next = active - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = entries.length - 1;
        else return;
        event.preventDefault();
        const bounded = Math.max(0, Math.min(next, entries.length - 1));
        setActive(bounded);
        virtual.scrollToIndex(bounded);
      }}
    >
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => {
          const entry = entries[item.index]!;
          return (
            <div
              key={entry.id}
              id={`${id}-${entry.id}`}
              role="listitem"
              data-active={active === item.index}
              aria-posinset={item.index + 1}
              aria-setsize={entries.length}
              className="provider-repository"
              style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
            >
              <strong>{entry.label}</strong>
              <span>{entry.detail}</span>
            </div>
          );
        })}
      </div>
    </div>
  ) : (
    <p>No {label.toLocaleLowerCase()}.</p>
  );
}
function ApprovalStatus({ state }: { state: ProviderMergeApprovalState }) {
  return (
    <>
      <p>Provider approval status: {state.approved ? 'Approved' : 'Not approved'}</p>
      <p>Your approval: {state.hasApproved ? 'Recorded' : 'Not recorded'}</p>
      <p>Eligible to approve: {state.canApprove ? 'Yes' : 'No'}</p>
      <p>
        Required: {state.required ?? 'Unavailable'} · Remaining: {state.remaining ?? 'Unavailable'}
      </p>
      <p>Approving users may not satisfy every approval rule.</p>
      <ApprovalEntries
        label="Approving users"
        entries={state.approvedBy.map((user) => ({
          id: user.id,
          label: user.login,
          detail: user.approvedAt
            ? new Date(user.approvedAt).toLocaleString()
            : 'Approval date unavailable',
        }))}
      />
      {(
        [
          ['Unmet approval rules', state.rulesLeft],
          ['Invalid approval rules', state.invalidRules],
        ] as const
      ).map(([label, rules]) =>
        rules === null ? (
          <p key={label}>{label}: unavailable.</p>
        ) : (
          <details key={label}>
            <summary>
              {label} ({rules.length})
            </summary>
            <ApprovalEntries
              label={label}
              entries={rules.map((rule) => ({ id: rule.id, label: rule.name, detail: rule.type }))}
            />
          </details>
        ),
      )}
    </>
  );
}
function ApprovalAction({
  accountId,
  repository,
  number,
  origin,
  action,
  head,
  close,
}: Target &
  Pick<ProviderMergeApprovalOptions, 'action' | 'head'> & {
    origin: string;
    close: (changed: boolean) => void;
  }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<string | undefined>(undefined);
  const passwordId = useId();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<ProviderMergeApprovalPreview>();
  const [result, setResult] = useState<ProviderMergeApprovalState>();
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [inspection, setInspection] = useState<ProviderMergeApprovals>();
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (request.current) void window.openkraken.cancel(request.current);
    };
  }, []);
  const run = async (kind: 'review' | 'confirm' | 'inspect') => {
    if (request.current || (kind === 'confirm' && (!preview || uncertain))) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError('');
    const submittedPassword = password;
    setPassword('');
    if (kind === 'review') setPreview(undefined);
    if (kind === 'inspect') setInspection(undefined);
    try {
      const response = await window.openkraken.request(
        kind === 'review'
          ? {
              id,
              method: 'providerMergeApprovalPreview',
              accountId,
              options: { repository, number, action, head },
            }
          : kind === 'inspect'
            ? {
                id,
                method: 'providerMergeApprovals',
                accountId,
                options: { repository, number },
              }
            : {
                id,
                method: 'providerWriteMergeApproval',
                accountId,
                options: {
                  repository,
                  number,
                  action,
                  head,
                  revision: preview!.revision,
                  ...(action === 'approve' && submittedPassword
                    ? { password: submittedPassword }
                    : {}),
                },
              },
      );
      if (kind === 'review' && response.kind === 'providerMergeApprovalPreview')
        setPreview(response.preview);
      else if (kind === 'confirm' && response.kind === 'providerMergeApprovalWritten')
        setResult(response.state);
      else if (kind === 'inspect' && response.kind === 'providerMergeApprovals')
        setInspection(response.approvals);
      else if (response.kind === 'error') {
        setError(response.message);
        setPreview(undefined);
        if (response.code === 'PROVIDER_WRITE_UNCERTAIN') setUncertain(true);
      } else if (response.kind === 'cancelled') {
        setError('Approval request cancelled before submission.');
        setPreview(undefined);
      } else throw new Error('Unexpected approval response');
    } catch {
      setPreview(undefined);
      if (kind === 'confirm') {
        setUncertain(true);
        setError('The action result is unknown. Check existing approval before trying again.');
      } else setError('Approval status could not be loaded.');
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const leave = () => {
    if (!request.current) {
      setPassword('');
      close(!!result || uncertain);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog issue-action-dialog"
      aria-label="GitLab approval action"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
    >
      <h2>{action === 'approve' ? 'Approve merge request' : 'Remove my approval'}</h2>
      <p>
        {origin}/{repository.owner}/{repository.name} · !{number}
      </p>
      <p>
        Reviewed source commit: <code>{head}</code>
      </p>
      {action === 'approve' && (
        <>
          <label htmlFor={passwordId}>Approval password</label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            maxLength={4096}
            value={password}
            disabled={busy || !!result || uncertain}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p>
            {preview?.state.passwordRequired
              ? 'This project requires your password to approve.'
              : 'Enter your password only if this project requires re-authentication.'}{' '}
            SAML re-authentication must be completed on GitLab.
          </p>
        </>
      )}
      {preview && !result && !uncertain && (
        <section aria-label="Confirm approval action">
          <h3>
            Review !{preview.mergeRequest.number}: {preview.mergeRequest.title}
          </h3>
          <p>
            Source commit: <code>{preview.mergeRequest.source.sha}</code>
          </p>
          <ApprovalStatus state={preview.state} />
          <p>
            {action === 'approve'
              ? 'Record your approval for this commit.'
              : 'Remove only your own approval. GitLab does not provide a commit condition for removal.'}{' '}
            Confirmation sends this action to GitLab and can notify repository participants.
          </p>
        </section>
      )}
      {busy && <p role="status">Waiting for GitLab…</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p role="status">
            {action === 'approve' ? 'Approval recorded.' : 'Your approval removed.'}
          </p>
          <ApprovalStatus state={result} />
        </>
      )}
      {uncertain && (
        <section aria-label="Uncertain approval action">
          <h3>The result is uncertain</h3>
          <p>
            The request may have completed. Inspect the current state before considering another
            action.
          </p>
          <button disabled={busy} onClick={() => void run('inspect')}>
            Check existing approval
          </button>
          {inspection && (
            <section aria-label="Existing approval">
              <p>This is the current state, not proof of which request caused it.</p>
              <ApprovalStatus state={inspection.state} />
            </section>
          )}
        </section>
      )}
      <div className="dialog-actions">
        {!result &&
          !uncertain &&
          (preview ? (
            <>
              <button
                disabled={
                  busy ||
                  (action === 'approve' && preview.state.passwordRequired === true && !password)
                }
                onClick={() => void run('confirm')}
              >
                Confirm approval action
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setPreview(undefined);
                  setPassword('');
                }}
              >
                Review again
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={() => void run('review')}>
              Review approval action
            </button>
          ))}
        {busy && (
          <button
            onClick={() => {
              if (request.current) void window.openkraken.cancel(request.current);
            }}
          >
            Cancel request
          </button>
        )}
        <button disabled={busy} onClick={leave}>
          Close action
        </button>
      </div>
    </dialog>
  );
}
export function MergeApprovals({ accountId, repository, number }: Target) {
  const [snapshot, setSnapshot] = useState<ProviderMergeApprovals>();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [intent, setIntent] = useState<Pick<ProviderMergeApprovalOptions, 'action' | 'head'>>();
  const request = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    request.current = id;
    setPending(true);
    setError('');
    void window.openkraken
      .request({ id, method: 'providerMergeApprovals', accountId, options: { repository, number } })
      .then((response) => {
        if (!alive) return;
        if (response.kind === 'providerMergeApprovals') setSnapshot(response.approvals);
        else setError(response.kind === 'error' ? response.message : 'Approval loading cancelled.');
      })
      .catch(() => {
        if (alive) setError('Approval status could not be loaded.');
      })
      .finally(() => {
        if (alive) {
          request.current = undefined;
          setPending(false);
        }
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, repository, number, attempt]);
  useProviderPoll(pending || !!intent, `${number}/${attempt}`, async (read) => {
    const response = await read({
      method: 'providerMergeApprovals',
      accountId,
      options: { repository, number },
    });
    if (response.kind !== 'providerMergeApprovals')
      throw new Error('Approval status could not be refreshed.');
    return {
      commit: () => {
        setSnapshot(response.approvals);
        setError('');
      },
    };
  });
  const head = snapshot?.mergeRequest.source.sha;
  return (
    <section aria-label="Merge-request approvals">
      {pending && <p role="status">Loading approvals…</p>}
      {error && <p role="alert">{error}</p>}
      {snapshot && (
        <>
          <p>
            Source commit: <code>{head ?? 'Unavailable'}</code>
          </p>
          <ApprovalStatus state={snapshot.state} />
          <div className="dialog-actions">
            <button
              disabled={
                pending ||
                !!intent ||
                !head ||
                !snapshot.state.canApprove ||
                snapshot.state.hasApproved ||
                snapshot.mergeRequest.state !== 'open'
              }
              onClick={() => {
                if (head) setIntent({ action: 'approve', head });
              }}
            >
              Approve merge request
            </button>
            <button
              disabled={pending || !!intent || !head || !snapshot.state.hasApproved}
              onClick={() => {
                if (head) setIntent({ action: 'unapprove', head });
              }}
            >
              Remove my approval
            </button>
          </div>
        </>
      )}
      <button disabled={pending || !!intent} onClick={() => setAttempt((value) => value + 1)}>
        Refresh approvals
      </button>
      {pending && (
        <button
          onClick={() => {
            if (request.current) void window.openkraken.cancel(request.current);
          }}
        >
          Cancel loading approvals
        </button>
      )}
      {intent && (
        <ApprovalAction
          accountId={accountId}
          repository={repository}
          number={number}
          origin={new URL(snapshot!.mergeRequest.url).origin}
          {...intent}
          close={(changed) => {
            setIntent(undefined);
            if (changed) setAttempt((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}
