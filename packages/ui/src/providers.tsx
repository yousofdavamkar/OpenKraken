import { SavedIssueDrafts } from './saved-issue-drafts.js';
import { SavedReviewDrafts } from './saved-review-drafts.js';
import { CommandButton } from './commands.js';
import { useEffect, useRef, useState } from 'react';
import type { ProviderAccounts, Request } from '@openkraken/ipc-contract';
import { GitLabSignIn } from './gitlab-sign-in.js';
import { GitHubSignIn } from './github-sign-in.js';
type ProviderRequest = Extract<
  Request,
  { method: 'providerAccounts' | 'providerConnect' | 'providerDisconnect' | 'providerVerify' }
>;

function AccountsDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const token = useRef<HTMLInputElement>(null);
  const active = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const [state, setState] = useState<ProviderAccounts>();
  const [provider, setProvider] = useState<'github' | 'gitlab' | 'bitbucket'>('github');
  const [origin, setOrigin] = useState('https://github.com');
  const [pending, setPending] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [error, setError] = useState<string>();
  const perform = async (request: ProviderRequest) => {
    active.current = request.id;
    setPending(true);
    setError(undefined);
    try {
      const result = await window.openkraken.request(request);
      if (!alive.current) return;
      if (result.kind === 'error') setError(result.message);
      else if (result.kind === 'providerAccounts') setState(result.state);
    } catch {
      if (alive.current) setError('The provider account request could not be completed.');
    } finally {
      active.current = undefined;
      if (alive.current) setPending(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void perform({ id: crypto.randomUUID(), method: 'providerAccounts' });
    return () => {
      alive.current = false;
      if (active.current) void window.openkraken.cancel(active.current);
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog provider-dialog"
      aria-label="Provider accounts"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2>Provider accounts</h2>
      <p>Connect GitHub, GitHub Enterprise, GitLab, or Bitbucket Cloud to your local app.</p>
      {state && !state.keychainAvailable && (
        <p role="status">Unlock or enable your operating-system keychain to connect a provider.</p>
      )}
      {state?.accounts.map((account) => (
        <section key={account.id} className="remote-entry">
          <strong>{account.login}</strong>
          <p>
            {account.provider === 'bitbucket'
              ? 'Bitbucket Cloud'
              : account.provider === 'gitlab'
                ? 'GitLab'
                : 'GitHub'}{' '}
            · {account.origin}
          </p>
          {account.provider !== 'bitbucket' && <SavedIssueDrafts account={account} />}
          {account.provider === 'github' && <SavedReviewDrafts scope={{ accountId: account.id }} />}
          <button
            disabled={pending || deviceBusy}
            onClick={() =>
              void perform({
                id: crypto.randomUUID(),
                method: 'providerDisconnect',
                accountId: account.id,
              })
            }
          >
            Forget {account.login}
          </button>
          <button
            disabled={pending || deviceBusy}
            onClick={() =>
              void perform({
                id: crypto.randomUUID(),
                method: 'providerVerify',
                accountId: account.id,
              })
            }
          >
            Verify {account.login}
          </button>
        </section>
      ))}
      {state?.accounts.length === 0 && <p>No provider accounts connected.</p>}
      <label>
        Provider type
        <select
          aria-label="Provider type"
          value={provider}
          disabled={pending || deviceBusy}
          onChange={(event) => {
            const selected =
              event.target.value === 'bitbucket'
                ? 'bitbucket'
                : event.target.value === 'gitlab'
                  ? 'gitlab'
                  : 'github';
            setProvider(selected);
            setOrigin(
              selected === 'bitbucket'
                ? 'https://bitbucket.org'
                : selected === 'gitlab'
                  ? 'https://gitlab.com'
                  : 'https://github.com',
            );
            if (token.current) token.current.value = '';
            setError(undefined);
          }}
        >
          <option value="github">GitHub / GitHub Enterprise</option>
          <option value="gitlab">GitLab / Self-Managed</option>
          <option value="bitbucket">Bitbucket Cloud</option>
        </select>
      </label>
      <label>
        Provider host
        <input
          type="url"
          form="provider-token-form"
          required
          value={origin}
          readOnly={provider === 'bitbucket'}
          maxLength={2048}
          disabled={pending || deviceBusy}
          onChange={(event) => setOrigin(event.target.value)}
        />
      </label>
      {provider === 'github' ? (
        <GitHubSignIn
          enabled={!!state?.keychainAvailable && !pending}
          onBusy={setDeviceBusy}
          onConnected={(state) => {
            setState(state);
            setError(undefined);
          }}
        />
      ) : provider === 'gitlab' ? (
        <GitLabSignIn
          origin={origin}
          enabled={!!state?.keychainAvailable && !pending}
          onBusy={setDeviceBusy}
          onConnected={(state) => {
            setState(state);
            setError(undefined);
          }}
        />
      ) : null}
      <form
        id="provider-token-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = token.current?.value ?? '';
          if (token.current) token.current.value = '';
          void perform({
            id: crypto.randomUUID(),
            method: 'providerConnect',
            options: { provider, origin, token: value },
          });
        }}
      >
        <label>
          {provider === 'bitbucket' ? 'API token' : 'Personal access token'}
          <input
            ref={token}
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={16384}
            disabled={pending || deviceBusy || !state?.keychainAvailable}
          />
        </label>
        {provider === 'bitbucket' && (
          <p>
            Use a scoped API token with read:user:bitbucket, read:workspace:bitbucket and
            read:repository:bitbucket. Pull-request browsing also requires
            read:pullrequest:bitbucket. Pushing also requires write:repository:bitbucket.
          </p>
        )}
        <p>
          Your token is sent only to the selected provider and stored using operating-system
          protection. Forgetting an account removes the local credential; revoke it at the provider
          if needed.
        </p>
        <button disabled={pending || deviceBusy || !state?.keychainAvailable}>
          Connect account
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          disabled={pending || deviceBusy}
          onClick={() => void perform({ id: crypto.randomUUID(), method: 'providerAccounts' })}
        >
          Refresh accounts
        </button>
        <button onClick={close}>Close accounts</button>
      </div>
    </dialog>
  );
}
export function ProviderAccountsControl() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CommandButton command="providers.accounts" onClick={() => setOpen(true)}>
        Provider accounts
      </CommandButton>
      {open && <AccountsDialog close={() => setOpen(false)} />}
    </>
  );
}
