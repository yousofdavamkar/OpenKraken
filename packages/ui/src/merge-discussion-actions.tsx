import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  providerMergeDiscussionActionSchema,
  type ProviderMergeInlinePosition,
  type ProviderMergeDiscussionPreview,
  type ProviderWriteMergeDiscussion,
  type ProviderMergeDiscussionWritten,
  type ProviderMergeRequestDiscussion,
  type ProviderPullOptions,
  type Result,
} from '@openkraken/ipc-contract';

export type MergeDiscussionIntent =
  | { action: 'inline'; position: ProviderMergeInlinePosition; page: number }
  | { action: 'comment' }
  | { action: 'reply'; discussionId: string }
  | { action: 'resolve'; discussionId: string; resolved: boolean };
type Page = Extract<Result, { kind: 'providerMergeRequestDiscussions' }>['page'];
export function MergeDiscussionActionDialog({
  accountId,
  repository,
  number,
  origin,
  intent,
  close,
  renderDiscussion,
}: ProviderPullOptions & {
  accountId: string;
  origin: string;
  intent: MergeDiscussionIntent;
  close: (changed: boolean) => void;
  renderDiscussion: (discussion: ProviderMergeRequestDiscussion) => ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const bodyId = useId();
  const request = useRef<string | undefined>(undefined);
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ProviderMergeDiscussionPreview>();
  const [prepared, setPrepared] = useState<ProviderWriteMergeDiscussion>();
  const [result, setResult] = useState<ProviderMergeDiscussionWritten>();
  const [uncertain, setUncertain] = useState(false);
  const [changed, setChanged] = useState(false);
  const [inspection, setInspection] = useState<Page>();
  const [inspectionPage, setInspectionPage] = useState(1);
  const [inspectedId, setInspectedId] = useState<string>();
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (request.current) void window.openkraken.cancel(request.current);
    };
  }, []);
  const label =
    intent.action === 'inline'
      ? 'Inline discussion'
      : intent.action === 'comment'
        ? 'New discussion'
        : intent.action === 'reply'
          ? 'Reply to discussion'
          : intent.resolved
            ? 'Resolve discussion'
            : 'Reopen discussion';
  const draft = providerMergeDiscussionActionSchema.safeParse({
    repository,
    number,
    ...intent,
    ...(intent.action === 'resolve' ? {} : { body }),
  });
  const review = async () => {
    if (request.current || !draft.success) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError('');
    setPrepared(undefined);
    setPreview(undefined);
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerMergeDiscussionPreview',
        accountId,
        options: draft.data,
      });
      if (response.kind === 'providerMergeDiscussionPreview') {
        setPreview(response.preview);
        setPrepared({ intent: draft.data, revision: response.preview.revision });
      } else if (response.kind === 'error') setError(response.message);
      else setError('Discussion review cancelled or unavailable.');
    } catch {
      setError('The discussion review could not be loaded.');
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (request.current || !prepared) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError('');
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerWriteMergeDiscussion',
        accountId,
        options: prepared,
      });
      if (response.kind === 'providerMergeDiscussionWritten') {
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
        setError('Discussion action cancelled before submission.');
        setPrepared(undefined);
      } else throw new Error('Unknown result');
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
    setError('');
    setInspection(undefined);
    try {
      const response = await window.openkraken.request({
        id,
        method: 'providerMergeRequestDiscussions',
        accountId,
        options: { repository, number, page },
      });
      if (response.kind === 'providerMergeRequestDiscussions') {
        setInspection(response.page);
        setInspectionPage(page);
        setInspectedId(
          'discussionId' in intent &&
            response.page.discussions.some((discussion) => discussion.id === intent.discussionId)
            ? intent.discussionId
            : response.page.discussions[0]?.id,
        );
      } else if (response.kind === 'error') setError(response.message);
      else setError('Result inspection cancelled.');
    } catch {
      setError('Existing results could not be checked.');
    } finally {
      request.current = undefined;
      setBusy(false);
    }
  };
  const leave = () => {
    if (busy) return;
    if (dirty && !result) setDiscard(true);
    else close(changed);
  };
  const inspected = inspection?.discussions.find((discussion) => discussion.id === inspectedId);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog issue-action-dialog"
      aria-label="GitLab discussion action"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
    >
      <h2>{label}</h2>
      <p>
        {origin}/{repository.owner}/{repository.name} · !{number}
      </p>
      {intent.action === 'inline' && (
        <InlineLocation position={intent.position} label="Selected inline location" />
      )}
      <fieldset disabled={busy || !!prepared || !!result || uncertain}>
        <legend>{intent.action === 'resolve' ? 'Resolution change' : 'Draft'}</legend>
        {intent.action === 'resolve' ? (
          <p>{intent.resolved ? 'Resolve' : 'Reopen'} the selected thread.</p>
        ) : (
          <>
            <label htmlFor={bodyId}>Comment</label>
            <textarea
              id={bodyId}
              rows={6}
              maxLength={65536}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setDirty(true);
              }}
            />
          </>
        )}
      </fieldset>
      {prepared && preview && !result && (
        <section aria-label="Confirm discussion action">
          <h3>{label}</h3>
          <p>
            Reviewing !{preview.mergeRequest.number}: {preview.mergeRequest.title} ·{' '}
            {preview.mergeRequest.state}
          </p>
          <p>Updated {new Date(preview.mergeRequest.updatedAt).toLocaleString()}</p>
          {preview.discussion && renderDiscussion(preview.discussion)}
          {preview.inline && (
            <InlineLocation
              position={preview.inline.position}
              text={preview.inline.text}
              label="Reviewed inline location"
            />
          )}
          {prepared.intent.action === 'resolve' ? (
            <p>New state: {prepared.intent.resolved ? 'Resolved' : 'Unresolved'}</p>
          ) : (
            <pre>{prepared.intent.body}</pre>
          )}
          <p>Confirmation sends this action to GitLab and can notify repository participants.</p>
        </section>
      )}
      {busy && <p role="status">Waiting for GitLab…</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <section aria-label="Discussion action result">
          <p role="status">
            {result.kind === 'commented'
              ? `Created discussion #${result.discussion.notes[0]!.id}.`
              : result.kind === 'replied'
                ? `Posted reply #${result.note.id}.`
                : intent.action === 'resolve' && intent.resolved
                  ? 'Discussion resolved.'
                  : 'Discussion reopened.'}
          </p>
          {result.kind === 'replied' ? (
            <pre>{result.note.body}</pre>
          ) : (
            renderDiscussion(result.discussion)
          )}
        </section>
      )}
      {uncertain && (
        <section aria-label="Uncertain discussion action">
          <p>
            The result is uncertain. Check existing results to avoid submitting the same action
            twice.
          </p>
          <button disabled={busy} onClick={() => void check()}>
            Check existing results
          </button>
          {inspection && (
            <section aria-label="Existing results">
              <p>
                Page {inspectionPage}. This is a current observation, not proof that a missing item
                was never created.
              </p>
              {inspection.discussions.length ? (
                <label>
                  Inspect discussion
                  <select
                    value={inspectedId ?? ''}
                    onChange={(event) => setInspectedId(event.target.value)}
                  >
                    {inspection.discussions.map((discussion) => (
                      <option key={discussion.id} value={discussion.id}>
                        #{discussion.notes[0]!.id} · {discussion.notes[0]!.body.slice(0, 100)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p>No discussions on this page.</p>
              )}
              {inspected && renderDiscussion(inspected)}
              {inspection.limited && (
                <p>Browsing limit reached. Check further results on GitLab.</p>
              )}
              {inspectionPage > 1 && (
                <button disabled={busy} onClick={() => void check(inspectionPage - 1)}>
                  Previous results
                </button>
              )}
              {inspection.nextPage !== null && (
                <button disabled={busy} onClick={() => void check(inspection.nextPage!)}>
                  Next results
                </button>
              )}
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
            </section>
          )}
        </section>
      )}
      {discard ? (
        <section aria-label="Discard discussion draft">
          <p>
            {uncertain
              ? 'Discard the local draft? This action may already have completed on GitLab.'
              : 'Discard this unsent draft?'}
          </p>
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
                  Confirm discussion action
                </button>
              </>
            ) : (
              <button disabled={busy || !draft.success} onClick={() => void review()}>
                Review discussion action
              </button>
            ))}
        </div>
      )}
    </dialog>
  );
}

function InlineLocation({
  position,
  text,
  label,
}: {
  position: ProviderMergeInlinePosition;
  text?: string;
  label: string;
}) {
  return (
    <section aria-label={label}>
      <p>
        {position.oldPath} → {position.newPath}
      </p>
      <p>
        {position.oldLine !== null && `Old line ${position.oldLine}`}
        {position.oldLine !== null && position.newLine !== null && ' · '}
        {position.newLine !== null && `New line ${position.newLine}`}
      </p>
      {text !== undefined && (
        <>
          <pre>{text}</pre>
          <details>
            <summary>Reviewed diff revisions</summary>
            <p>
              Merge base: <code>{position.revision.base}</code>
            </p>
            <p>
              Source tip: <code>{position.revision.head}</code>
            </p>
            <p>
              Target tip: <code>{position.revision.start}</code>
            </p>
          </details>
        </>
      )}
    </section>
  );
}
