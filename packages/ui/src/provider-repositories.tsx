import { BitbucketWorkspaces } from './bitbucket-workspaces.js';
import { useEffect, useId, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type {
  ProviderBitbucketWorkspace,
  ProviderAccount,
  ProviderAccounts,
  ProviderRepository,
} from '@openkraken/ipc-contract';

function RepositoryPages({
  accountId,
  workspace,
  onSelect,
}: {
  accountId: string;
  workspace?: ProviderBitbucketWorkspace;
  onSelect: (repository: ProviderRepository) => void;
}) {
  const [repositories, setRepositories] = useState<ProviderRepository[]>([]);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    const id = crypto.randomUUID();
    let alive = true;
    setPending(true);
    setError('');
    void window.openkraken
      .request(
        workspace
          ? { id, method: 'providerBitbucketRepositories', accountId, options: { workspace, page } }
          : { id, method: 'providerRepositories', accountId, page },
      )
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'error') setError(result.message);
        else if (result.kind === 'providerRepositories') {
          setRepositories((current) => {
            const unique = new Map((page === 1 ? [] : current).map((repo) => [repo.id, repo]));
            for (const repo of result.page.repositories) unique.set(repo.id, repo);
            return [...unique.values()];
          });
          setNextPage(result.page.nextPage);
          setLimited(result.page.limited);
        }
      })
      .catch(() => {
        if (alive) setError('Repositories could not be loaded.');
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [accountId, workspace, page, attempt]);
  const search = query.trim().toLocaleLowerCase();
  const visible = repositories.filter((repo) =>
    `${repo.owner}/${repo.name} ${repo.description}`.toLocaleLowerCase().includes(search),
  );
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 56,
    overscan: 3,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(visible[active] ? [active] : [])])].sort(
        (a, b) => a - b,
      ),
  });
  const activate = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visible.length - 1));
    setActive(bounded);
    virtual.scrollToIndex(bounded);
  };
  return (
    <section aria-label="Provider repositories">
      <label>
        Search loaded repositories
        <input
          type="search"
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          value={query}
          maxLength={1000}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            scroll.current?.scrollTo(0, 0);
          }}
        />
      </label>
      <p role="status">
        {repositories.length} repositories loaded · {visible.length} match
        {pending ? ' · Loading…' : ''}
      </p>
      <div
        ref={scroll}
        className="provider-repositories"
        role="listbox"
        aria-label="Repositories"
        tabIndex={0}
        aria-activedescendant={visible[active] ? `${listId}-${visible[active].id}` : undefined}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') activate(active + 1);
          else if (event.key === 'ArrowUp') activate(active - 1);
          else if (event.key === 'Home') activate(0);
          else if (event.key === 'End') activate(visible.length - 1);
          else if (event.key === 'Enter' || event.key === ' ') {
            if (visible[active]) onSelect(visible[active]);
          } else return;
          event.preventDefault();
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const repo = visible[item.index]!;
            return (
              <div
                key={repo.id}
                id={`${listId}-${repo.id}`}
                role="option"
                aria-posinset={item.index + 1}
                aria-setsize={visible.length}
                aria-selected={item.index === active}
                aria-label={`Select ${repo.owner}/${repo.name}`}
                className="provider-repository"
                style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}
                onClick={() => onSelect(repo)}
              >
                <strong>
                  {repo.owner}/{repo.name}
                </strong>
                <span>
                  {repo.visibility === 'internal'
                    ? 'Internal'
                    : repo.private
                      ? 'Private'
                      : 'Public'}
                  {repo.archived ? ' · Archived' : ''}
                  {repo.description ? ` · ${repo.description}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {!pending && !error && visible.length === 0 && (
        <p>
          {repositories.length
            ? 'No loaded repositories match.'
            : 'No repositories available to this account.'}
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
            Retry repositories
          </button>
        </p>
      )}
      {nextPage !== null && !error && (
        <button type="button" disabled={pending} onClick={() => setPage(nextPage)}>
          Load more repositories
        </button>
      )}
      {limited && <p>Showing at most 10,000 repositories.</p>}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setRepositories([]);
          setNextPage(null);
          setPage(1);
          setAttempt((value) => value + 1);
          setActive(0);
          scroll.current?.scrollTo(0, 0);
        }}
      >
        Refresh repositories
      </button>
      <p>Search covers loaded repositories. Use arrow keys in the list and Enter to choose.</p>
    </section>
  );
}
function BitbucketRepositories({
  accountId,
  onSelect,
}: {
  accountId: string;
  onSelect: (repository: ProviderRepository) => void;
}) {
  const [workspace, setWorkspace] = useState<ProviderBitbucketWorkspace>();
  return workspace ? (
    <>
      <p>Workspace: {workspace.slug}</p>
      <button type="button" onClick={() => setWorkspace(undefined)}>
        Change workspace
      </button>
      <RepositoryPages
        key={`${workspace.id}/${workspace.slug}`}
        accountId={accountId}
        workspace={workspace}
        onSelect={onSelect}
      />
    </>
  ) : (
    <BitbucketWorkspaces accountId={accountId} onSelect={setWorkspace} />
  );
}
export function ProviderRepositoryPicker({
  onSelect,
  collaboration,
}: {
  onSelect: (
    url: string,
    accountId: string,
    repository: ProviderRepository,
    provider: ProviderAccount['provider'],
  ) => void;
  collaboration?: 'pulls' | 'issues';
}) {
  const [state, setState] = useState<ProviderAccounts>();
  const [unavailable, setUnavailable] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const id = crypto.randomUUID();
    setError('');
    void window.openkraken
      .request({ id, method: 'providerAccounts' })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerAccounts') {
          setUnavailable(
            collaboration === 'issues' &&
              result.state.accounts.some((account) => account.provider === 'bitbucket'),
          );
          const accounts = result.state.accounts.filter(
            (account) => collaboration !== 'issues' || account.provider !== 'bitbucket',
          );
          setState({ ...result.state, accounts });
          setAccountId(accounts[0]?.id ?? '');
        } else if (result.kind === 'error') setError(result.message);
      })
      .catch(() => {
        if (alive) setError('Provider accounts could not be loaded.');
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, [attempt, collaboration]);
  const Pages =
    state?.accounts.find((account) => account.id === accountId)?.provider === 'bitbucket'
      ? BitbucketRepositories
      : RepositoryPages;
  return (
    <section className="provider-picker" aria-label="Browse provider repositories">
      {unavailable && <p>Bitbucket issues are not available yet.</p>}
      {!state && !error && <p>Loading accounts…</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry accounts
          </button>
        </p>
      )}
      {state && !state.keychainAvailable && (
        <p>Unlock your operating-system keychain to browse repositories.</p>
      )}
      {state?.accounts.length === 0 && (
        <p>
          {collaboration === 'issues'
            ? 'Connect a GitHub or GitLab account in Provider accounts to browse collaboration.'
            : 'Connect an account in Provider accounts to browse its repositories.'}
        </p>
      )}
      {!!state?.accounts.length && (
        <label>
          Provider account
          <select
            aria-label="Provider account"
            value={accountId}
            disabled={!state.keychainAvailable}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {state.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.login} · {account.origin}
              </option>
            ))}
          </select>
        </label>
      )}
      {accountId && state?.keychainAvailable && (
        <Pages
          key={accountId}
          accountId={accountId}
          onSelect={(repository) => {
            const account = state.accounts.find((account) => account.id === accountId);
            if (account) onSelect(repository.cloneUrl, accountId, repository, account.provider);
          }}
        />
      )}
    </section>
  );
}
