import { ProviderDraftEncryptionUnavailable, usePullDraft } from './review-draft.js';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  providerCreatePullSchema,
  type PullDraft,
  type ProviderPullSource,
  type ProviderPullRevision,
  type ProviderPullSummary,
  type ProviderMergeCreationPreview,
  type ProviderAccount,
  type Request as BridgeRequest,
} from '@openkraken/ipc-contract';
type Target = {
  provider: ProviderAccount['provider'];
  origin: string;
  accountId: string;
  repository: ProviderPullSource['repository'];
};
type Templates = {
  defaultBranch: string | null;
  revision: string;
  templates: { path: string; label: string; size?: number }[];
  limited: boolean;
};
export function PullCreationDialog({
  target,
  close,
  created,
}: {
  target: Target;
  close: () => void;
  created?: () => void;
}) {
  const gitlab = target.provider === 'gitlab';
  const noun = gitlab ? 'merge' : 'pull';
  const abbreviation = gitlab ? 'MR' : 'PR';
  const prefix = gitlab ? '!' : '#';
  const dialog = useRef<HTMLDialogElement>(null);
  const requests = useRef(new Set<string>());
  const cancelled = useRef(false);
  const protectedSubmission = useRef(false);
  const [fields, setFields] = useState<Omit<PullDraft, 'uncertain'>>({
    owner: target.repository.owner,
    repo: target.repository.name,
    head: '',
    base: '',
    title: '',
    body: '',
    draft: false,
    maintainerCanModify: false,
  });
  const { owner, repo, head, base, title, body, draft, maintainerCanModify } = fields;
  const [recovered, setRecovered] = useState(false);
  const [unprotected, setUnprotected] = useState(false);
  const [closeFailed, setCloseFailed] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [revision, setRevision] = useState<ProviderPullRevision | ProviderMergeCreationPreview>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [result, setResult] = useState<ProviderPullSummary>();
  const [uncertain, setUncertain] = useState(false),
    [checked, setChecked] = useState(false);
  const [existing, setExisting] = useState<ProviderPullSummary[]>([]),
    [next, setNext] = useState<number | null>(null);
  const [templates, setTemplates] = useState<Templates>();
  const [templateError, setTemplateError] = useState(''),
    [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateAttempt, setTemplateAttempt] = useState(0),
    [templatePath, setTemplatePath] = useState('');
  const [templateBody, setTemplateBody] = useState<string>();
  // A provider reply and an input event can both arrive before React paints either edit.
  const draftState = useRef({ fields, dirty: false, baseEdited: false });
  const replaceFields = (next: typeof fields) => {
    draftState.current.fields = next;
    setFields(next);
  };
  const storage = usePullDraft(
    { accountId: target.accountId, repository: target.repository },
    ({ uncertain, ...saved }) => {
      draftState.current.baseEdited = true;
      replaceFields(saved);
      setRecovered(true);
      draftState.current.dirty = true;
      setUncertain(uncertain);
      protectedSubmission.current = uncertain;
    },
  );
  const edit = (patch: Partial<typeof fields>) => {
    const next = { ...draftState.current.fields, ...patch };
    if (patch.base !== undefined) draftState.current.baseEdited = true;
    replaceFields(next);
    draftState.current.dirty = true;
    storage.change({ ...next, uncertain: false });
  };
  const applyDefaultBase = useEffectEvent((branch: string | null) => {
    const current = draftState.current;
    if (!branch || current.fields.base || current.baseEdited) return;
    const next = { ...current.fields, base: branch };
    replaceFields(next);
    if (current.dirty) storage.change({ ...next, uncertain: false });
  });
  const perform = async (request: BridgeRequest) => {
    requests.current.add(request.id);
    try {
      return await window.openkraken.request(request);
    } finally {
      requests.current.delete(request.id);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    const pending = requests.current;
    return () => {
      cancelled.current = true;
      for (const id of pending) void window.openkraken.cancel(id);
    };
  }, []);
  useEffect(() => {
    if (!storage.ready || (recovered && templateAttempt === 0)) {
      setLoadingTemplates(false);
      return;
    }
    const id = crypto.randomUUID();
    const pending = requests.current;
    pending.add(id);
    let alive = true;
    setLoadingTemplates(true);
    setTemplateError('');
    void window.openkraken
      .request({
        id,
        method: gitlab ? 'providerMergeTemplates' : 'providerPullTemplates',
        accountId: target.accountId,
        options: { repository: target.repository },
      })
      .then((response) => {
        if (!alive) return;
        if (
          response.kind === 'providerPullTemplates' ||
          response.kind === 'providerMergeTemplates'
        ) {
          const entries =
            response.kind === 'providerMergeTemplates'
              ? response.templates.templates.map((item) => ({ path: item.key, label: item.name }))
              : response.templates.templates.map((item) => ({
                  path: item.path,
                  label: item.path,
                  size: item.size,
                }));
          setTemplates({ ...response.templates, templates: entries });
          applyDefaultBase(response.templates.defaultBranch);
        } else if (response.kind === 'error') setTemplateError(response.message);
      })
      .catch(() => {
        if (alive)
          setTemplateError('Templates could not be loaded. You can still write a description.');
      })
      .finally(() => {
        pending.delete(id);
        if (alive) setLoadingTemplates(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [target.accountId, target.repository, templateAttempt, gitlab, storage.ready, recovered]);
  const source = { repository: target.repository, source: { owner, name: repo }, head, base };
  const valid = providerCreatePullSchema
    .omit({ revision: true })
    .safeParse({ ...source, title, body, draft, maintainerCanModify }).success;
  const locked = busy || !!revision || !!result || !storage.ready;
  const leave = () => {
    if (busy || !storage.ready) return;
    if (draftState.current.dirty && !result) setDiscard(true);
    else close();
  };
  const prepare = async () => {
    if (busy || !storage.ready) return;
    setUnprotected(false);
    setBusy(true);
    setError('');
    try {
      const response = await perform({
        id: crypto.randomUUID(),
        accountId: target.accountId,
        ...(gitlab
          ? {
              method: 'providerPreviewMergeCreation',
              options: { ...source, title, body, draft, maintainerCanModify },
            }
          : { method: 'providerPreviewPull', options: source }),
      });
      if (response.kind === 'providerPullCreationPreview') setRevision(response.revision);
      else if (response.kind === 'providerMergeCreationPreview') setRevision(response.preview);
      else if (response.kind === 'error') setError(response.message);
      else if (response.kind === 'cancelled') setError('Preview cancelled.');
    } catch {
      setError('The branch preview could not be loaded.');
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!revision || busy || !storage.ready) return;
    cancelled.current = false;
    setBusy(true);
    setError('');
    try {
      protectedSubmission.current = false;
      try {
        await storage.write({ ...fields, uncertain: true });
        protectedSubmission.current = true;
      } catch (error) {
        if (!cancelled.current && !(error instanceof ProviderDraftEncryptionUnavailable)) {
          setUnprotected(false);
          setRevision(undefined);
          setError(
            'The saved draft could not be verified. Copy your changes and reopen creation to review the current draft.',
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
          await storage.write({ ...fields, uncertain: false }).catch(() => {});
        setRevision(undefined);
        setError('Creation cancelled before submission.');
        return;
      }
      const response = await perform({
        id: crypto.randomUUID(),
        accountId: target.accountId,
        ...('revision' in revision
          ? {
              method: 'providerCreateMergeRequest',
              options: {
                intent: { ...source, title, body, draft, maintainerCanModify },
                revision: revision.revision,
              },
            }
          : {
              method: 'providerCreatePull',
              options: { ...source, revision, title, body, draft, maintainerCanModify },
            }),
      });
      if (response.kind === 'providerPullCreated' || response.kind === 'providerMergeCreated') {
        setResult(
          response.kind === 'providerMergeCreated' ? response.mergeRequest : response.pullRequest,
        );
        created?.();
        await storage
          .write(null)
          .catch(() =>
            setError(
              'The provider confirmed creation. The local recovery copy could not be cleared.',
            ),
          );
      } else if (response.kind === 'error') {
        setError(response.message);
        const unknown = response.code === 'PROVIDER_WRITE_UNCERTAIN';
        setUncertain(unknown);
        if (!unknown && protectedSubmission.current)
          await storage.write({ ...fields, uncertain: false }).catch(() => {});
        setRevision(undefined);
      } else if (response.kind === 'cancelled') {
        if (protectedSubmission.current)
          await storage.write({ ...fields, uncertain: false }).catch(() => {});
        setError('Creation cancelled before submission.');
        setRevision(undefined);
      } else throw new Error('Unknown creation result');
    } catch {
      setError(
        `The creation result is unknown. Check existing ${noun} requests before trying again.`,
      );
      setUncertain(true);
      setRevision(undefined);
    } finally {
      setBusy(false);
    }
  };
  const closeDraft = async (keep: boolean) => {
    if (busy || !storage.ready) return;
    setBusy(true);
    setError('');
    try {
      await storage.write(keep ? { ...draftState.current.fields, uncertain } : null);
      close();
    } catch {
      setCloseFailed(true);
      setError(
        'The local draft could not be saved or discarded. Copy your changes before closing.',
      );
    } finally {
      setBusy(false);
    }
  };
  const reviewAgain = async () => {
    setBusy(true);
    setError('');
    try {
      if (protectedSubmission.current) await storage.write({ ...fields, uncertain: false });
      protectedSubmission.current = false;
      setUncertain(false);
      setChecked(false);
      draftState.current.dirty = true;
    } catch {
      setError(
        'The submission marker could not be cleared. Reopen the saved copy before reviewing again.',
      );
    } finally {
      setBusy(false);
    }
  };
  const loadTemplate = async () => {
    if (!templates || !templatePath) return;
    setBusy(true);
    setError('');
    setTemplateBody(undefined);
    try {
      const response = await perform({
        id: crypto.randomUUID(),
        accountId: target.accountId,
        ...(gitlab
          ? {
              method: 'providerMergeTemplate',
              options: {
                repository: target.repository,
                revision: templates.revision,
                key: templatePath,
              },
            }
          : {
              method: 'providerPullTemplate',
              options: {
                repository: target.repository,
                revision: templates.revision,
                path: templatePath,
              },
            }),
      });
      if (response.kind === 'providerPullTemplate' || response.kind === 'providerMergeTemplate')
        setTemplateBody(response.template.body);
      else if (response.kind === 'error') setError(response.message);
    } catch {
      setError('The selected template could not be loaded.');
    } finally {
      setBusy(false);
    }
  };
  const checkExisting = async (page = 1) => {
    setBusy(true);
    try {
      const response = await perform({
        id: crypto.randomUUID(),
        method: 'providerPullRequests',
        accountId: target.accountId,
        options: { repository: target.repository, state: 'all', page },
      });
      if (response.kind === 'providerPullRequests') {
        setExisting(response.page.pullRequests);
        setNext(response.page.nextPage);
        setChecked(true);
      } else if (response.kind === 'error') setError(response.message);
    } catch {
      setError(`Existing ${noun} requests could not be loaded.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pr-create-dialog"
      aria-label={`Create ${noun} request`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
    >
      <h2>Create {noun} request</h2>
      <p>
        Target repository: {target.origin}/{target.repository.owner}/{target.repository.name}
      </p>
      <p>Push the source branch first. Preview checks the remote commits before creation.</p>
      <fieldset disabled={locked}>
        <legend>Branches and description</legend>
        <div className="pr-create-branches">
          <label>
            Source owner
            <input
              readOnly={uncertain}
              value={owner}
              maxLength={gitlab ? 2200 : 100}
              onChange={(event) => {
                edit({ owner: event.target.value });
              }}
            />
          </label>
          <label>
            Source repository
            <input
              readOnly={uncertain}
              value={repo}
              maxLength={100}
              onChange={(event) => {
                edit({ repo: event.target.value });
              }}
            />
          </label>
          <label>
            Source branch
            <input
              readOnly={uncertain}
              value={head}
              maxLength={1024}
              onChange={(event) => {
                edit({ head: event.target.value });
              }}
            />
          </label>
          <label>
            Target branch
            <input
              readOnly={uncertain}
              value={base}
              maxLength={1024}
              onChange={(event) => {
                edit({ base: event.target.value });
              }}
            />
          </label>
        </div>
        <label>
          {abbreviation} title
          <input
            readOnly={uncertain}
            value={title}
            maxLength={256}
            onChange={(event) => {
              edit({ title: event.target.value });
            }}
          />
        </label>
        <label>
          Description
          <textarea
            rows={7}
            maxLength={65536}
            readOnly={uncertain}
            value={body}
            onChange={(event) => {
              edit({ body: event.target.value });
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            disabled={uncertain}
            checked={draft}
            onChange={(event) => {
              edit({ draft: event.target.checked });
            }}
          />
          Create as draft
        </label>
        <label>
          <input
            type="checkbox"
            disabled={uncertain}
            checked={maintainerCanModify}
            onChange={(event) => {
              edit({ maintainerCanModify: event.target.checked });
            }}
          />
          Allow maintainers to edit the source branch
        </label>
      </fieldset>
      {!result && !uncertain && !revision && (
        <section aria-label={gitlab ? 'Merge-request templates' : 'Pull-request templates'}>
          {recovered && !templates && !loadingTemplates && !templateError && (
            <button disabled={busy} onClick={() => setTemplateAttempt((n) => n + 1)}>
              Load templates
            </button>
          )}
          {loadingTemplates && <p role="status">Loading templates…</p>}
          {templateError && (
            <p role="alert">
              {templateError}{' '}
              <button
                disabled={loadingTemplates || busy}
                onClick={() => setTemplateAttempt((value) => value + 1)}
              >
                Retry templates
              </button>
            </p>
          )}
          {templates && (
            <>
              <p>
                {gitlab ? (
                  'Project and inherited templates. Preview loads the current template content.'
                ) : (
                  <>
                    Templates from {templates.defaultBranch} at <code>{templates.revision}</code>.
                  </>
                )}
              </p>
              {templates.templates.length ? (
                <>
                  <label>
                    Template
                    <select
                      disabled={busy}
                      value={templatePath}
                      onChange={(event) => {
                        setTemplatePath(event.target.value);
                        setTemplateBody(undefined);
                      }}
                    >
                      <option value="">Choose a template</option>
                      {templates.templates.map((template) => (
                        <option
                          key={template.path}
                          value={template.path}
                          disabled={(template.size ?? 0) > 65536}
                        >
                          {template.label}
                          {(template.size ?? 0) > 65536 ? ' (too large)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button disabled={busy || !templatePath} onClick={() => void loadTemplate()}>
                    Preview template
                  </button>
                </>
              ) : (
                <p>No repository templates found.</p>
              )}
              {templates.limited && (
                <p>The template listing is incomplete or limited to 50 files.</p>
              )}
            </>
          )}
          {templateBody !== undefined && (
            <section aria-label="Template preview">
              <pre>{templateBody || 'Empty template.'}</pre>
              <button
                disabled={busy}
                onClick={() => {
                  edit({ body: templateBody });
                  setTemplateBody(undefined);
                }}
              >
                Replace description with template
              </button>
            </section>
          )}
        </section>
      )}
      {revision && !result && (
        <section aria-label={`Confirm ${abbreviation} creation`}>
          <h3>{'title' in revision ? revision.title : title}</h3>
          <p>
            {owner}/{repo}:{head} → {target.repository.owner}/{target.repository.name}:{base}
          </p>
          <p>
            Source commit: <code>{revision.head}</code>
          </p>
          <p>
            Target commit: <code>{revision.base}</code>
          </p>
          <p>
            {draft ? `Draft ${noun} request` : 'Ready for review'} · Maintainer edits{' '}
            {maintainerCanModify ? 'allowed' : 'not allowed'}
          </p>
          <pre>{body || 'No description.'}</pre>
          <p>
            Creation sends this {noun} request to the provider and can notify repository
            participants.
          </p>
        </section>
      )}
      {storage.status && <p aria-live="polite">{storage.status}</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <p role="status">
          Created {prefix}
          {result.number}: {result.title}
          <br />
          {result.url}
        </p>
      )}
      {uncertain && (
        <section aria-label={`Check ${abbreviation} creation result`}>
          {recovered && !checked && (
            <p>The provider may already have created this {noun} request.</p>
          )}
          <button disabled={busy} onClick={() => void checkExisting()}>
            Check existing {noun} requests
          </button>
          {checked && (
            <>
              <p>
                Check the returned {abbreviation}s before creating another. This does not
                automatically detect duplicates.
              </p>
              <ul className="pr-existing">
                {existing.map((pull) => (
                  <li key={pull.number}>
                    {prefix}
                    {pull.number} {pull.title} · {pull.state}
                    <br />
                    {pull.url}
                  </li>
                ))}
              </ul>
              {next !== null && (
                <button disabled={busy} onClick={() => void checkExisting(next)}>
                  Check next page
                </button>
              )}
              <button disabled={busy} onClick={() => void reviewAgain()}>
                I checked; return to draft
              </button>
            </>
          )}
        </section>
      )}
      {discard ? (
        <section aria-label={`Discard ${abbreviation} draft`}>
          <p>Save this {noun}-request draft locally or discard it?</p>
          <button disabled={busy} onClick={() => setDiscard(false)}>
            Keep editing
          </button>
          <button disabled={busy} onClick={() => void closeDraft(true)}>
            Save and close
          </button>
          <button disabled={busy} className="danger" onClick={() => void closeDraft(false)}>
            Discard draft
          </button>
          {closeFailed && (
            <button disabled={busy} onClick={close}>
              Close without saving
            </button>
          )}
        </section>
      ) : (
        <div className="dialog-actions">
          <button disabled={busy || !storage.ready} onClick={leave}>
            Close creation
          </button>
          {busy && (
            <button
              onClick={() => {
                cancelled.current = true;
                for (const id of requests.current) void window.openkraken.cancel(id);
              }}
            >
              Cancel request
            </button>
          )}
          {!result &&
            !uncertain &&
            (revision ? (
              <>
                <button disabled={busy} onClick={() => setRevision(undefined)}>
                  Edit draft
                </button>
                <button disabled={busy} onClick={() => void submit()}>
                  {unprotected
                    ? 'Submit without crash recovery'
                    : `Create confirmed ${abbreviation}`}
                </button>
              </>
            ) : (
              <button disabled={busy || !valid || !storage.ready} onClick={() => void prepare()}>
                Preview {abbreviation}
              </button>
            ))}
        </div>
      )}
    </dialog>
  );
}
export function CreatePullRequest({ target, created }: { target: Target; created: () => void }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button onClick={() => setOpened(true)}>
        New {target.provider === 'gitlab' ? 'merge' : 'pull'} request
      </button>
      {opened && (
        <PullCreationDialog
          key={JSON.stringify([target.accountId, target.repository])}
          target={target}
          created={created}
          close={() => setOpened(false)}
        />
      )}
    </>
  );
}
