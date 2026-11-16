import { IssueDraftEncryptionUnavailable, useIssueDraft } from './review-draft.js';
import { useEffect, useRef, useState } from 'react';
import {
  providerWriteIssueSchema,
  providerGitLabIssueIntentSchema,
  type ProviderGitLabIssueActionPreview,
  type ProviderWriteGitLabIssue,
  type ProviderAccount,
  type IssueDraft,
  type IssueDraftScope,
  type ProviderWriteIssue,
  type ProviderIssueActionPreview,
  type ProviderIssueWriteResult,
  type ProviderIssuePage,
  type ProviderIssueCommentsPage,
  type ProviderIssueDetails,
  type ProviderIssueOptions,
} from '@openkraken/ipc-contract';
export type IssueTarget = {
  provider: ProviderAccount['provider'];
  accountId: string;
  origin: string;
  repository: ProviderIssueOptions['repository'];
};
type Intent = IssueDraftScope['intent'];
export function issueActionLabel(intent: Intent) {
  return intent.action === 'create'
    ? 'Create issue'
    : intent.action === 'comment'
      ? `Comment on issue #${intent.number}`
      : `${intent.state === 'closed' ? 'Close' : 'Reopen'} issue #${intent.number}`;
}
type Inspection =
  | { kind: 'issues'; page: ProviderIssuePage }
  | { kind: 'comments'; page: ProviderIssueCommentsPage }
  | { kind: 'state'; issue: ProviderIssueDetails };
export function IssueActionDialog({
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
  const cancelled = useRef(false);
  const protectedSubmission = useRef(false);
  const [fields, setFields] = useState<Omit<IssueDraft, 'uncertain'>>({
    title: '',
    body: '',
    confidential: false,
    internal: false,
    reason: 'completed',
  });
  const { title, body, confidential, internal, reason } = fields;
  const gitlab = target.provider === 'gitlab';
  const [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [preview, setPreview] = useState<
    ProviderIssueActionPreview | ProviderGitLabIssueActionPreview
  >();
  const [prepared, setPrepared] = useState<ProviderWriteIssue | ProviderWriteGitLabIssue>();
  const [result, setResult] = useState<ProviderIssueWriteResult>();
  const [uncertain, setUncertain] = useState(false),
    [changed, setChanged] = useState(false);
  const [inspection, setInspection] = useState<Inspection>(),
    [inspectionPage, setInspectionPage] = useState(1);
  const [unprotected, setUnprotected] = useState(false);
  const [closeFailed, setCloseFailed] = useState(false);
  const storage = useIssueDraft(
    { accountId: target.accountId, repository: target.repository, intent },
    ({ uncertain, ...saved }) => {
      protectedSubmission.current = uncertain;
      setFields(saved);
      setDirty(true);
      setUncertain(uncertain);
      setChanged(uncertain);
    },
  );
  const edit = (patch: Partial<typeof fields>) => {
    const next = { ...fields, ...patch };
    setFields(next);
    setDirty(true);
    storage.change({ ...next, uncertain: false });
  };
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      cancelled.current = true;
      if (request.current) void window.openkraken.cancel(request.current);
    };
  }, []);
  const actionLabel = issueActionLabel(intent);
  const draft = (revision: string) =>
    gitlab
      ? intent.action === 'create'
        ? { action: 'create', repository: target.repository, title, body, confidential }
        : intent.action === 'comment'
          ? {
              action: 'comment',
              repository: target.repository,
              number: intent.number,
              body,
              internal,
            }
          : {
              action: 'state',
              repository: target.repository,
              number: intent.number,
              state: intent.state,
            }
      : intent.action === 'create'
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
  const valid = (gitlab ? providerGitLabIssueIntentSchema : providerWriteIssueSchema).safeParse(
    draft('a'.repeat(64)),
  ).success;
  const preparedIntent = prepared && ('intent' in prepared ? prepared.intent : prepared);
  const review = async () => {
    if (request.current || !valid || !storage.ready) return;
    setUnprotected(false);
    setError('');
    setPrepared(undefined);
    setPreview(undefined);
    if (intent.action === 'create' && !gitlab) {
      const parsed = providerWriteIssueSchema.safeParse(draft(''));
      if (parsed.success) {
        setPrepared(parsed.data);
        if (parsed.data.action === 'create') setFields({ ...fields, title: parsed.data.title });
      }
      return;
    }
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    try {
      if (gitlab) {
        const parsed = providerGitLabIssueIntentSchema.parse(draft(''));
        const response = await window.openkraken.request({
          id,
          method: 'providerGitLabIssueActionPreview',
          accountId: target.accountId,
          options: parsed,
        });
        if (response.kind === 'providerGitLabIssueActionPreview') {
          setPreview(response.preview);
          setPrepared({ intent: parsed, revision: response.preview.revision });
          if (parsed.action === 'create') setFields({ ...fields, title: parsed.title });
        } else if (response.kind === 'error') setError(response.message);
        else if (response.kind === 'cancelled') setError('Issue review cancelled.');
        return;
      }
      if (intent.action === 'create') return;
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
    cancelled.current = false;
    setBusy(true);
    setError('');
    try {
      protectedSubmission.current = false;
      try {
        await storage.write({ ...fields, uncertain: true });
        protectedSubmission.current = true;
      } catch (error) {
        if (!cancelled.current && !(error instanceof IssueDraftEncryptionUnavailable)) {
          setUnprotected(false);
          setPrepared(undefined);
          setDirty(true);
          setError(
            'The saved draft could not be verified. Copy your changes and reopen the action to review the current draft.',
          );
          return;
        }
        if (!unprotected && !cancelled.current) {
          setUnprotected(true);
          setError(
            'The submission could not be recorded locally. Copy your draft before submitting without crash recovery.',
          );
          return;
        }
      }
      setUnprotected(false);
      if (cancelled.current) {
        if (protectedSubmission.current)
          await storage.write(dirty ? { ...fields, uncertain: false } : null).catch(() => {});
        setPrepared(undefined);
        setError('Issue action cancelled before submission.');
        return;
      }
      const response = await window.openkraken.request(
        'intent' in prepared
          ? {
              id,
              method: 'providerWriteGitLabIssue',
              accountId: target.accountId,
              options: prepared,
            }
          : {
              id,
              method: 'providerWriteIssue',
              accountId: target.accountId,
              options: prepared,
            },
      );
      if (response.kind === 'providerIssueWritten') {
        setResult(response.result);
        setChanged(true);
        await storage
          .write(null)
          .catch(() =>
            setError(
              'The provider confirmed the action. The local recovery copy could not be cleared.',
            ),
          );
      } else if (response.kind === 'error') {
        setError(response.message);
        setPrepared(undefined);
        if (response.code === 'PROVIDER_WRITE_UNCERTAIN') {
          setUncertain(true);
          setChanged(true);
        } else if (protectedSubmission.current)
          await storage.write(dirty ? { ...fields, uncertain: false } : null).catch(() => {});
      } else if (response.kind === 'cancelled') {
        if (protectedSubmission.current)
          await storage.write(dirty ? { ...fields, uncertain: false } : null).catch(() => {});

        setError('Issue action cancelled before submission.');
        setPrepared(undefined);
      } else throw new Error('Unknown submission result');
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
  const reviewAgain = async () => {
    setBusy(true);
    try {
      if (protectedSubmission.current) await storage.write({ ...fields, uncertain: false });
      protectedSubmission.current = false;
      setDirty(true);
      setUncertain(false);
      setInspection(undefined);
      setPrepared(undefined);
      setPreview(undefined);
      setError('');
    } catch {
      setError('The recovery record could not be updated. Reopen the saved draft before retrying.');
    } finally {
      setBusy(false);
    }
  };
  const closeDraft = async (remove: boolean) => {
    setBusy(true);
    try {
      await storage.write(remove ? null : { ...fields, uncertain });
      close(changed);
    } catch {
      setCloseFailed(true);
      setError('The local draft could not be updated. Copy any changes you want to keep.');
    } finally {
      setBusy(false);
    }
  };
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
      <fieldset disabled={!storage.ready || busy || !!prepared || !!result}>
        <legend>{intent.action === 'state' ? 'State change' : 'Draft'}</legend>
        {intent.action === 'create' && (
          <label>
            Issue title
            <input
              readOnly={uncertain}
              maxLength={gitlab ? 255 : 256}
              value={title}
              onChange={(event) => {
                edit({ title: event.target.value });
              }}
            />
          </label>
        )}
        {intent.action !== 'state' && (
          <label>
            {intent.action === 'create' ? 'Description' : 'Comment'}
            <textarea
              rows={6}
              readOnly={uncertain}
              maxLength={65536}
              value={body}
              onChange={(event) => {
                edit({ body: event.target.value });
              }}
            />
          </label>
        )}
        {gitlab && intent.action === 'create' && (
          <label>
            <input
              disabled={uncertain}
              type="checkbox"
              checked={confidential}
              onChange={(event) => {
                edit({ confidential: event.target.checked });
              }}
            />{' '}
            Confidential issue
          </label>
        )}
        {gitlab && intent.action === 'comment' && (
          <label>
            <input
              disabled={uncertain}
              type="checkbox"
              checked={internal}
              onChange={(event) => {
                edit({ internal: event.target.checked });
              }}
            />{' '}
            Internal note
          </label>
        )}
        {intent.action === 'state' &&
          (gitlab ? (
            <p>{intent.state === 'closed' ? 'Close' : 'Reopen'} this issue.</p>
          ) : intent.state === 'closed' ? (
            <label>
              Closing reason
              <select
                disabled={uncertain}
                value={reason}
                onChange={(event) => {
                  if (event.target.value === 'completed' || event.target.value === 'not_planned')
                    edit({ reason: event.target.value });
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
      {preparedIntent && !result && (
        <section aria-label="Confirm issue action">
          <h3>{actionLabel}</h3>
          {preview?.issue && (
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
          {preview && 'project' in preview && (
            <p>
              Project #{preview.project.id} · Issue access:{' '}
              {preview.project.issuesAccessLevel ?? 'Not reported'}
            </p>
          )}
          {preparedIntent.action === 'create' && <h3>{preparedIntent.title}</h3>}
          {'confidential' in preparedIntent && (
            <p>{preparedIntent.confidential ? 'Confidential issue' : 'Non-confidential issue'}</p>
          )}
          {'internal' in preparedIntent && (
            <p>{preparedIntent.internal ? 'Internal note' : 'Ordinary note'}</p>
          )}
          {preview?.issue && 'provider' in preview.issue && (
            <p>
              {preview.issue.confidential ? 'Confidential issue' : 'Non-confidential issue'} ·{' '}
              {preview.issue.issueType}
            </p>
          )}
          {preparedIntent.action !== 'state' ? (
            <pre>{preparedIntent.body || 'No description'}</pre>
          ) : (
            <p>
              New state: {preparedIntent.state}
              {'reason' in preparedIntent ? ` · ${preparedIntent.reason}` : ''}
            </p>
          )}
          <p>
            Confirmation sends this action to the provider and can notify repository participants.
          </p>
        </section>
      )}
      {storage.status && <p aria-live="polite">{storage.status}</p>}
      {busy && !result && <p role="status">Working…</p>}
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
                          {'provider' in comment && (
                            <p>
                              {comment.system ? 'System activity' : 'User note'}
                              {comment.internal === true
                                ? ' · Internal note'
                                : comment.confidential === true
                                  ? ' · Confidential note'
                                  : ''}
                            </p>
                          )}
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
                <button disabled={busy} onClick={() => void reviewAgain()}>
                  I checked; review again
                </button>
              )}
            </section>
          )}
        </section>
      )}
      {discard ? (
        <section aria-label="Discard issue draft">
          <p>
            {uncertain
              ? 'The provider may have received this action. Keep or discard the local copy?'
              : 'Keep or discard this draft?'}
          </p>
          <button disabled={busy} onClick={() => setDiscard(false)}>
            Keep draft
          </button>
          <button disabled={busy} onClick={() => void closeDraft(false)}>
            Save and close
          </button>
          <button disabled={busy} onClick={() => void closeDraft(true)}>
            Discard draft
          </button>
          {closeFailed && (
            <button disabled={busy} onClick={() => close(changed)}>
              Close without saving changes
            </button>
          )}
        </section>
      ) : (
        <div className="dialog-actions">
          <button disabled={busy} onClick={leave}>
            Close action
          </button>
          {busy && request.current && (
            <button
              onClick={() => {
                cancelled.current = true;
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
                  {unprotected ? 'Submit without crash recovery' : 'Confirm issue action'}
                </button>
              </>
            ) : (
              <button disabled={!storage.ready || busy || !valid} onClick={() => void review()}>
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
          key={JSON.stringify([target.accountId, target.repository, intent])}
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
