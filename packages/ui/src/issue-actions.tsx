import { useEffect, useRef, useState } from 'react';
import {
  providerWriteIssueSchema,
  type ProviderWriteIssue,
  type ProviderIssueActionPreview,
  type ProviderIssueWriteResult,
  type ProviderIssuePage,
  type ProviderIssueCommentsPage,
  type ProviderIssueDetails,
  type ProviderIssueOptions,
} from '@openkraken/ipc-contract';
export type IssueTarget = {
  accountId: string;
  origin: string;
  repository: ProviderIssueOptions['repository'];
};
type Intent =
  | { action: 'create' }
  | { action: 'comment'; number: number }
  | { action: 'state'; number: number; state: 'open' | 'closed' };
type Inspection =
  | { kind: 'issues'; page: ProviderIssuePage }
  | { kind: 'comments'; page: ProviderIssueCommentsPage }
  | { kind: 'state'; issue: ProviderIssueDetails };
function IssueActionDialog({
  target,
  intent,
  close,
}: {
  target: IssueTarget;
  intent: Intent;
  close: (changed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    request = useRef<string | undefined>(undefined);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState('');
  const [reason, setReason] = useState<'completed' | 'not_planned'>('completed');
  const [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [preview, setPreview] = useState<ProviderIssueActionPreview>();
  const [prepared, setPrepared] = useState<ProviderWriteIssue>();
  const [result, setResult] = useState<ProviderIssueWriteResult>();
  const [uncertain, setUncertain] = useState(false),
    [changed, setChanged] = useState(false);
  const [inspection, setInspection] = useState<Inspection>(),
    [inspectionPage, setInspectionPage] = useState(1);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (request.current) void window.openkraken.cancel(request.current);
    };
  }, []);
  const actionLabel =
    intent.action === 'create'
      ? 'Create issue'
      : intent.action === 'comment'
        ? `Comment on issue #${intent.number}`
        : `${intent.state === 'closed' ? 'Close' : 'Reopen'} issue #${intent.number}`;
  const draft = (revision: string) =>
    intent.action === 'create'
      ? { action: 'create', repository: target.repository, title, body }
      : intent.action === 'comment'
        ? {
            action: 'comment',
            repository: target.repository,
            number: intent.number,
            revision,
            body,
          }
        : {
            action: 'state',
            repository: target.repository,
            number: intent.number,
            revision,
            state: intent.state,
            reason: intent.state === 'open' ? 'reopened' : reason,
          };
  const valid = providerWriteIssueSchema.safeParse(draft('a'.repeat(64))).success;
  const review = async () => {
    if (request.current || !valid) return;
    setError('');
    setPrepared(undefined);
    setPreview(undefined);
    if (intent.action === 'create') {
      const parsed = providerWriteIssueSchema.safeParse(draft(''));
      if (parsed.success) {
        setPrepared(parsed.data);
        if (parsed.data.action === 'create') setTitle(parsed.data.title);
      }
      return;
    }
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerIssueActionPreview',
        accountId: target.accountId,
        options: { repository: target.repository, number: intent.number },
      });
      if (response.kind === 'providerIssueActionPreview') {
        setPreview(response.preview);
        if (intent.action === 'comment' && response.preview.issue.locked) {
          setError('The issue conversation is locked.');
          return;
        }
        if (intent.action === 'state' && response.preview.issue.state === intent.state) {
          setError(
            'The issue already has the requested state. Close this action to refresh details.',
          );
          return;
        }
        const parsed = providerWriteIssueSchema.safeParse(draft(response.preview.revision));
        if (parsed.success) setPrepared(parsed.data);
      } else if (response.kind === 'error') setError(response.message);
      else if (response.kind === 'cancelled') setError('Issue review cancelled.');
    } catch {
      setError('The issue review could not be loaded.');
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!prepared || request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError('');
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerWriteIssue',
        accountId: target.accountId,
        options: prepared,
      });
      if (response.kind === 'providerIssueWritten') {
        setResult(response.result);
        setChanged(true);
      } else if (response.kind === 'error') {
        setError(response.message);
        setPrepared(undefined);
        if (response.code === 'PROVIDER_WRITE_UNCERTAIN') {
          setUncertain(true);
          setChanged(true);
        }
      } else if (response.kind === 'cancelled') {
        setError('Issue action cancelled before submission.');
        setPrepared(undefined);
      }
    } catch {
      setError('The action result is unknown. Check existing results before trying again.');
      setPrepared(undefined);
      setUncertain(true);
      setChanged(true);
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const check = async (page = 1) => {
    if (request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setInspection(undefined);
    setError('');
    try {
      const response = await window.openkraken.request(
        intent.action === 'create'
          ? {
              id,
              method: 'providerIssues',
              accountId: target.accountId,
              options: { repository: target.repository, state: 'all', page },
            }
          : intent.action === 'comment'
            ? {
                id,
                method: 'providerIssueComments',
                accountId: target.accountId,
                options: { repository: target.repository, number: intent.number, page },
              }
            : {
                id,
                method: 'providerIssue',
                accountId: target.accountId,
                options: { repository: target.repository, number: intent.number },
              },
      );
      if (response.kind === 'providerIssues')
        setInspection({ kind: 'issues', page: response.page });
      else if (response.kind === 'providerIssueComments')
        setInspection({ kind: 'comments', page: response.page });
      else if (response.kind === 'providerIssue')
        setInspection({ kind: 'state', issue: response.issue });
      else if (response.kind === 'error') setError(response.message);
      else if (response.kind === 'cancelled') setError('Result inspection cancelled.');
      setInspectionPage(page);
    } catch {
      setError('Existing results could not be checked.');
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const reached =
    inspection?.kind === 'state' &&
    intent.action === 'state' &&
    inspection.issue.state === intent.state;
  const leave = () => {
    if (busy) return;
    if (dirty && !result) setDiscard(true);
    else close(changed);
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog issue-action-dialog"
      aria-label="Issue action"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
    >
      <h2>{actionLabel}</h2>
      <p>
        {target.origin}/{target.repository.owner}/{target.repository.name}
      </p>
      <fieldset disabled={busy || !!prepared || !!result || uncertain}>
        <legend>{intent.action === 'state' ? 'State change' : 'Draft'}</legend>
        {intent.action === 'create' && (
          <label>
            Issue title
            <input
              maxLength={256}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
            />
          </label>
        )}
        {intent.action !== 'state' && (
          <label>
            {intent.action === 'create' ? 'Description' : 'Comment'}
            <textarea
              rows={6}
              maxLength={65536}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setDirty(true);
              }}
            />
          </label>
        )}
        {intent.action === 'state' &&
          (intent.state === 'closed' ? (
            <label>
              Closing reason
              <select
                value={reason}
                onChange={(event) => {
                  if (event.target.value === 'completed' || event.target.value === 'not_planned')
                    setReason(event.target.value);
                }}
              >
                <option value="completed">Completed</option>
                <option value="not_planned">Not planned</option>
              </select>
            </label>
          ) : (
            <p>Reopen this issue.</p>
          ))}
      </fieldset>
      {prepared && !result && (
        <section aria-label="Confirm issue action">
          <h3>{actionLabel}</h3>
          {preview && (
            <>
              <p>
                Reviewing #{preview.issue.number}: {preview.issue.title} · {preview.issue.state}
              </p>
              <p>
                Updated {new Date(preview.issue.updatedAt).toLocaleString()} ·{' '}
                {preview.issue.comments} comments{preview.issue.locked ? ' · Locked' : ''}
              </p>
              <details>
                <summary>Current issue details</summary>
                <p>Labels: {preview.issue.labels.join(', ') || 'None'}</p>
                <p>Assignees: {preview.issue.assignees.join(', ') || 'Unassigned'}</p>
                <p>Milestone: {preview.issue.milestone ?? 'None'}</p>
                <pre>{preview.issue.body || 'No description'}</pre>
              </details>
            </>
          )}
          {prepared.action === 'create' && <h3>{prepared.title}</h3>}
          {prepared.action !== 'state' ? (
            <pre>{prepared.body || 'No description'}</pre>
          ) : (
            <p>
              New state: {prepared.state} · {prepared.reason}
            </p>
          )}
          <p>
            Confirmation sends this action to the provider and can notify repository participants.
          </p>
        </section>
      )}
      {busy && <p role="status">Waiting for provider…</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <p role="status">
          {result.kind === 'created'
            ? `Created issue #${result.issue.number}: ${result.issue.title}`
            : result.kind === 'updated'
              ? `Issue #${result.issue.number} is now ${result.issue.state}.`
              : `Posted comment #${result.comment.id}.`}
        </p>
      )}
      {uncertain && (
        <section aria-label="Uncertain issue action">
          <p>
            The result is uncertain. Check existing results to avoid submitting the same action
            twice.
          </p>
          <button disabled={busy} onClick={() => void check()}>
            Check existing results
          </button>
          {inspection && (
            <section aria-label="Existing results">
              {inspection.kind === 'state' ? (
                <p>
                  Provider now reports: {inspection.issue.state} ·{' '}
                  {inspection.issue.stateReason ?? 'No reason reported'}
                </p>
              ) : (
                <>
                  <p>
                    Page {inspectionPage}. This is a current observation, not proof that a missing
                    item was never created.
                  </p>
                  <div className="issue-action-results">
                    {inspection.kind === 'issues' ? (
                      <ul>
                        {inspection.page.issues.map((issue) => (
                          <li key={issue.number}>
                            #{issue.number} {issue.title} · {issue.state} ·{' '}
                            {issue.author ?? 'Deleted account'}
                            <p>{issue.url}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      inspection.page.comments.map((comment) => (
                        <details key={comment.id}>
                          <summary>
                            #{comment.id} · {comment.author ?? 'Deleted account'} ·{' '}
                            {new Date(comment.createdAt).toLocaleString()}
                          </summary>
                          <pre>{comment.body}</pre>
                        </details>
                      ))
                    )}
                  </div>
                  {inspection.page.limited && (
                    <p>Provider browsing limit reached. Check remaining results on the provider.</p>
                  )}
                  {inspectionPage > 1 && (
                    <button disabled={busy} onClick={() => void check(inspectionPage - 1)}>
                      Previous results
                    </button>
                  )}
                  {inspection.page.nextPage !== null && (
                    <button disabled={busy} onClick={() => void check(inspection.page.nextPage!)}>
                      Next results
                    </button>
                  )}
                </>
              )}
              {!reached && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setUncertain(false);
                    setInspection(undefined);
                    setPrepared(undefined);
                    setPreview(undefined);
                    setError('');
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
        <section aria-label="Discard issue draft">
          <p>Discard this unsent draft?</p>
          <button onClick={() => setDiscard(false)}>Keep draft</button>
          <button onClick={() => close(changed)}>Discard draft</button>
        </section>
      ) : (
        <div className="dialog-actions">
          <button disabled={busy} onClick={leave}>
            Close action
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
          {!result &&
            !uncertain &&
            (prepared ? (
              <>
                <button
                  disabled={busy}
                  onClick={() => {
                    setPrepared(undefined);
                    setPreview(undefined);
                  }}
                >
                  Edit action
                </button>
                <button disabled={busy} onClick={() => void submit()}>
                  Confirm issue action
                </button>
              </>
            ) : (
              <button disabled={busy || !valid} onClick={() => void review()}>
                Review issue action
              </button>
            ))}
        </div>
      )}
    </dialog>
  );
}
export function IssueAction({
  target,
  intent,
  finished,
}: {
  target: IssueTarget;
  intent: Intent;
  finished: (changed: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const label =
    intent.action === 'create'
      ? 'New issue'
      : intent.action === 'comment'
        ? 'Write issue comment'
        : intent.state === 'closed'
          ? 'Close issue'
          : 'Reopen issue';
  return (
    <>
      <button onClick={() => setOpened(true)}>{label}</button>
      {opened && (
        <IssueActionDialog
          target={target}
          intent={intent}
          close={(changed) => {
            setOpened(false);
            finished(changed);
          }}
        />
      )}
    </>
  );
}
