import { useEffect, useRef, useState } from 'react';
import type { ProviderAccounts, Request } from '@openkraken/ipc-contract';
type ProviderRequest = Extract<
  Request,
  { method: 'providerAccounts' | 'providerConnect' | 'providerDisconnect' }
>;

function AccountsDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const token = useRef<HTMLInputElement>(null);
  const active = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const [state, setState] = useState<ProviderAccounts>();
  const [origin, setOrigin] = useState('https://github.com');
  const [pending, setPending] = useState(false);
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
      <p>Connect GitHub or GitHub Enterprise to your local app.</p>
      {state && !state.keychainAvailable && (
        <p role="status">Unlock or enable your operating-system keychain to connect a provider.</p>
      )}
      {state?.accounts.map((account) => (
        <section key={account.id} className="remote-entry">
          <strong>{account.login}</strong>
          <p>{account.origin}</p>
          <button
            disabled={pending}
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
        </section>
      ))}
      {state?.accounts.length === 0 && <p>No provider accounts connected.</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = token.current?.value ?? '';
          if (token.current) token.current.value = '';
          void perform({
            id: crypto.randomUUID(),
            method: 'providerConnect',
            options: { provider: 'github', origin, token: value },
          });
        }}
      >
        <label>
          Provider host
          <input
            type="url"
            required
            value={origin}
            maxLength={2048}
            disabled={pending}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </label>
        <label>
          Personal access token
          <input
            ref={token}
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={16384}
            disabled={pending || !state?.keychainAvailable}
          />
        </label>
        <p>
          Your token is sent only to the selected provider and stored using operating-system
          protection. Forgetting an account removes the local credential; revoke it at the provider
          if needed.
        </p>
        <button disabled={pending || !state?.keychainAvailable}>Connect account</button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          disabled={pending}
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
      <button onClick={() => setOpen(true)}>Provider accounts</button>
      {open && <AccountsDialog close={() => setOpen(false)} />}
    </>
  );
}
