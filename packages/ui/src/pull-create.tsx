import { useEffect, useRef, useState } from 'react';
import {
  providerCreatePullSchema,
  type ProviderPullSource,
  type ProviderPullRevision,
  type ProviderPullSummary,
  type ProviderPullTemplates,
  type Request as BridgeRequest,
} from '@openkraken/ipc-contract';
type Target = { origin: string; accountId: string; repository: ProviderPullSource['repository'] };
function Composer({
  target,
  close,
  created,
}: {
  target: Target;
  close: () => void;
  created: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requests = useRef(new Set<string>());
  const [owner, setOwner] = useState(target.repository.owner),
    [repo, setRepo] = useState(target.repository.name);
  const [head, setHead] = useState(''),
    [base, setBase] = useState('');
  const [title, setTitle] = useState(''),
    [body, setBody] = useState('');
  const [draft, setDraft] = useState(false),
    [maintainerCanModify, setMaintainerCanModify] = useState(false);
  const [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [revision, setRevision] = useState<ProviderPullRevision>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [result, setResult] = useState<ProviderPullSummary>();
  const [uncertain, setUncertain] = useState(false),
    [checked, setChecked] = useState(false);
  const [existing, setExisting] = useState<ProviderPullSummary[]>([]),
    [next, setNext] = useState<number | null>(null);
  const [templates, setTemplates] = useState<ProviderPullTemplates>();
  const [templateError, setTemplateError] = useState(''),
    [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateAttempt, setTemplateAttempt] = useState(0),
    [templatePath, setTemplatePath] = useState('');
  const [templateBody, setTemplateBody] = useState<string>();
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
      for (const id of pending) void window.openkraken.cancel(id);
    };
  }, []);
  useEffect(() => {
    const id = crypto.randomUUID();
    const pending = requests.current;
    pending.add(id);
    let alive = true;
    setLoadingTemplates(true);
    setTemplateError('');
    void window.openkraken
      .request({
        id,
        method: 'providerPullTemplates',
        accountId: target.accountId,
        options: { repository: target.repository },
      })
      .then((response) => {
        if (!alive) return;
        if (response.kind === 'providerPullTemplates') {
          setTemplates(response.templates);
          setBase((current) => current || response.templates.defaultBranch);
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
  }, [target.accountId, target.repository, templateAttempt]);
  const source = { repository: target.repository, source: { owner, name: repo }, head, base };
  const valid = providerCreatePullSchema
    .omit({ revision: true })
    .safeParse({ ...source, title, body, draft, maintainerCanModify }).success;
  const locked = busy || !!revision || !!result || uncertain;
  const leave = () => {
    if (busy) return;
    if (dirty && !result) setDiscard(true);
    else close();
  };
  const prepare = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await perform({
        id: crypto.randomUUID(),
        method: 'providerPreviewPull',
        accountId: target.accountId,
        options: source,
      });
      if (response.kind === 'providerPullCreationPreview') setRevision(response.revision);
      else if (response.kind === 'error') setError(response.message);
      else if (response.kind === 'cancelled') setError('Preview cancelled.');
    } catch {
      setError('The branch preview could not be loaded.');
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!revision) return;
    setBusy(true);
    setError('');
    try {
      const response = await perform({
        id: crypto.randomUUID(),
        method: 'providerCreatePull',
        accountId: target.accountId,
        options: { ...source, revision, title, body, draft, maintainerCanModify },
      });
      if (response.kind === 'providerPullCreated') {
        setResult(response.pullRequest);
        created();
      } else if (response.kind === 'error') {
        setError(response.message);
        setUncertain(response.code === 'PROVIDER_WRITE_UNCERTAIN');
        setRevision(undefined);
      } else if (response.kind === 'cancelled') {
        setError('Creation cancelled before submission.');
        setRevision(undefined);
      }
    } catch {
      setError('The creation result is unknown. Check existing pull requests before trying again.');
      setUncertain(true);
      setRevision(undefined);
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
        method: 'providerPullTemplate',
        accountId: target.accountId,
        options: {
          repository: target.repository,
          revision: templates.revision,
          path: templatePath,
        },
      });
      if (response.kind === 'providerPullTemplate') setTemplateBody(response.template.body);
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
      setError('Existing pull requests could not be loaded.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog pr-create-dialog"
      aria-label="Create pull request"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
    >
      <h2>Create pull request</h2>
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
              value={owner}
              maxLength={100}
              onChange={(event) => {
                setOwner(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label>
            Source repository
            <input
              value={repo}
              maxLength={100}
              onChange={(event) => {
                setRepo(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label>
            Source branch
            <input
              value={head}
              maxLength={1024}
              onChange={(event) => {
                setHead(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label>
            Target branch
            <input
              value={base}
              maxLength={1024}
              onChange={(event) => {
                setBase(event.target.value);
                setDirty(true);
              }}
            />
          </label>
        </div>
        <label>
          PR title
          <input
            value={title}
            maxLength={256}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label>
          Description
          <textarea
            rows={7}
            maxLength={65536}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft}
            onChange={(event) => {
              setDraft(event.target.checked);
              setDirty(true);
            }}
          />
          Create as draft
        </label>
        <label>
          <input
            type="checkbox"
            checked={maintainerCanModify}
            onChange={(event) => {
              setMaintainerCanModify(event.target.checked);
              setDirty(true);
            }}
          />
          Allow maintainers to edit the source branch
        </label>
      </fieldset>
      {!result && !uncertain && !revision && (
        <section aria-label="Pull-request templates">
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
                Templates from {templates.defaultBranch} at <code>{templates.revision}</code>.
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
                          disabled={template.size > 65536}
                        >
                          {template.path}
                          {template.size > 65536 ? ' (too large)' : ''}
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
                  setBody(templateBody);
                  setDirty(true);
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
        <section aria-label="Confirm PR creation">
          <h3>{title}</h3>
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
            {draft ? 'Draft pull request' : 'Ready for review'} · Maintainer edits{' '}
            {maintainerCanModify ? 'allowed' : 'not allowed'}
          </p>
          <pre>{body || 'No description.'}</pre>
          <p>
            Creation sends this pull request to the provider and can notify repository participants.
          </p>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <p role="status">
          Created #{result.number}: {result.title}
          <br />
          {result.url}
        </p>
      )}
      {uncertain && (
        <section aria-label="Check PR creation result">
          <button disabled={busy} onClick={() => void checkExisting()}>
            Check existing pull requests
          </button>
          {checked && (
            <>
              <p>
                Check the returned PRs before creating another. This does not automatically detect
                duplicates.
              </p>
              <ul className="pr-existing">
                {existing.map((pull) => (
                  <li key={pull.number}>
                    #{pull.number} {pull.title} · {pull.state}
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
              <button
                disabled={busy}
                onClick={() => {
                  setUncertain(false);
                  setChecked(false);
                  setError('');
                }}
              >
                I checked; return to draft
              </button>
            </>
          )}
        </section>
      )}
      {discard ? (
        <section aria-label="Discard PR draft">
          <p>Discard this unsent pull-request draft?</p>
          <button onClick={() => setDiscard(false)}>Keep editing</button>
          <button className="danger" onClick={close}>
            Discard draft
          </button>
        </section>
      ) : (
        <div className="dialog-actions">
          <button disabled={busy} onClick={leave}>
            Close creation
          </button>
          {busy && (
            <button
              onClick={() => {
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
                  Create confirmed PR
                </button>
              </>
            ) : (
              <button disabled={busy || !valid} onClick={() => void prepare()}>
                Preview PR
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
      <button onClick={() => setOpened(true)}>New pull request</button>
      {opened && <Composer target={target} created={created} close={() => setOpened(false)} />}
    </>
  );
}
