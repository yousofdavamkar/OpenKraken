import { useEffect, useRef, useState } from 'react';
import {
  providerRepositoryNameSchema,
  type ProviderAccount,
  type ProviderRepository,
} from '@openkraken/ipc-contract';

export function CreateRemoteRepository({
  account,
  disabled,
}: {
  account: ProviderAccount;
  disabled: boolean;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [readme, setReadme] = useState(false);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<ProviderRepository>();
  const [error, setError] = useState('');
  const active = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      const id = active.current;
      active.current = undefined;
      if (id) void window.openkraken.cancel(id);
    },
    [],
  );
  const validName = providerRepositoryNameSchema.safeParse(name).success;
  async function create() {
    if (active.current || !validName || disabled) return;
    const id = crypto.randomUUID();
    active.current = id;
    setPending(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id,
        method: 'providerCreateRepository',
        accountId: account.id,
        options: {
          owner: account.login,
          name,
          description,
          visibility: isPrivate ? 'private' : 'public',
          readme,
        },
      });
      if (active.current !== id) return;
      if (result.kind === 'providerRepositoryCreated') setCreated(result.repository);
      else if (result.kind === 'error') setError(result.message);
      else setError('Check your provider repositories to see whether creation completed.');
    } catch {
      if (active.current === id)
        setError('Check your provider repositories to see whether creation completed.');
    } finally {
      if (active.current === id) {
        active.current = undefined;
        setPending(false);
      }
    }
  }
  return (
    <details>
      <summary>Create repository</summary>
      {created ? (
        <section>
          <p role="status">
            Created {created.owner}/{created.name}.
          </p>
          <label>
            Clone URL
            <input readOnly value={created.cloneUrl} />
          </label>
          <button
            type="button"
            onClick={() => {
              setName('');
              setDescription('');
              setPrivate(true);
              setReadme(false);
              setCreated(undefined);
            }}
          >
            Create another repository
          </button>
        </section>
      ) : (
        <form
          aria-label="Create personal repository"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <fieldset disabled={disabled || pending}>
            <legend>
              {account.origin}/{account.login}
            </legend>
            <label>
              Repository name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {name && !validName && (
              <p>
                Use letters, numbers, dots, hyphens or underscores. A name cannot be just one or two
                dots.
              </p>
            )}
            <label>
              Description (optional)
              <input
                maxLength={350}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label>
              Visibility
              <select
                value={isPrivate ? 'private' : 'public'}
                onChange={(event) => setPrivate(event.target.value === 'private')}
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={readme}
                onChange={(event) => setReadme(event.target.checked)}
              />{' '}
              Initialize with a README
            </label>
            <button type="submit" disabled={!validName}>
              Create {isPrivate ? 'private' : 'public'} repository
            </button>
          </fieldset>
          {pending && <p role="status">Creating repository…</p>}
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </details>
  );
}
