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
  const [pendingAction, setPendingAction] = useState<'create' | 'inspect'>();
  const pending = pendingAction !== undefined;
  const [receipt, setReceipt] = useState<{ repository: ProviderRepository; inspected: boolean }>();
  const [uncertain, setUncertain] = useState(false);
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
  async function submit(action: 'create' | 'inspect') {
    const inspect = action === 'inspect';
    if (active.current || !validName || disabled || (uncertain && !inspect)) return;
    const id = crypto.randomUUID();
    active.current = id;
    setPendingAction(action);
    setError('');
    try {
      const result = await window.openkraken.request(
        inspect
          ? {
              id,
              method: 'providerInspectRepository',
              accountId: account.id,
              target: { owner: account.login, name },
            }
          : {
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
            },
      );
      if (active.current !== id) return;
      if (result.kind === (inspect ? 'providerRepositoryFound' : 'providerRepositoryCreated')) {
        setReceipt({ repository: result.repository, inspected: inspect });
      } else if (result.kind === 'error') {
        if (!inspect && result.code === 'PROVIDER_WRITE_UNCERTAIN') setUncertain(true);
        setError(result.message);
      } else throw new Error('Unexpected repository result');
    } catch {
      if (active.current === id) {
        if (!inspect) setUncertain(true);
        setError(
          inspect
            ? 'The repository lookup could not be completed.'
            : 'The provider may have created the repository. Check its current state.',
        );
      }
    } finally {
      if (active.current === id) {
        active.current = undefined;
        setPendingAction(undefined);
      }
    }
  }
  return (
    <details>
      <summary>Create repository</summary>
      {receipt ? (
        <section>
          <p role="status">
            {receipt.inspected ? 'Found' : 'Created'} {receipt.repository.owner}/
            {receipt.repository.name}. Visibility:{' '}
            {receipt.repository.visibility ?? (receipt.repository.private ? 'private' : 'public')}.
          </p>
          <label>
            Clone URL
            <input readOnly value={receipt.repository.cloneUrl} />
          </label>
          <button
            type="button"
            onClick={() => {
              setName('');
              setDescription('');
              setPrivate(true);
              setReadme(false);
              setReceipt(undefined);
              setUncertain(false);
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
            void submit(uncertain ? 'inspect' : 'create');
          }}
        >
          <fieldset disabled={disabled || pending || uncertain}>
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
            {!uncertain && (
              <>
                <button type="submit" disabled={!validName}>
                  Create {isPrivate ? 'private' : 'public'} repository
                </button>
                <button type="button" disabled={!validName} onClick={() => void submit('inspect')}>
                  Check existing repository
                </button>
              </>
            )}
          </fieldset>
          {uncertain && (
            <>
              <button type="submit" disabled={pending || disabled}>
                Check {account.login}/{name}
              </button>
              <button
                type="button"
                disabled={pending || disabled}
                onClick={() => {
                  setUncertain(false);
                  setError('');
                }}
              >
                Edit repository request
              </button>
            </>
          )}
          {pending && (
            <p role="status">
              {pendingAction === 'inspect' ? 'Checking repository…' : 'Creating repository…'}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </details>
  );
}
