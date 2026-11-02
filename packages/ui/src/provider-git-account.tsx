import { useEffect, useState } from 'react';
import type { ProviderAccounts } from '@openkraken/ipc-contract';

export function ProviderGitAccount({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (accountId: string) => void;
  disabled: boolean;
  label: string;
}) {
  const [state, setState] = useState<ProviderAccounts>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const id = crypto.randomUUID();
    void window.openkraken
      .request({ id, method: 'providerAccounts' })
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'providerAccounts') setState(result.state);
        else if (result.kind === 'error') setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      void window.openkraken.cancel(id);
    };
  }, []);
  return (
    <section className="provider-git-account">
      <label>
        {label}
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Git credential helpers / SSH agent</option>
          {state?.accounts.map((account) => (
            <option key={account.id} value={account.id} disabled={!state.keychainAvailable}>
              {account.login} · {account.origin}
            </option>
          ))}
        </select>
      </label>
      {failed && <p>Saved accounts could not be loaded. Reopen this dialog to retry.</p>}
      {state && !state.keychainAvailable && !!state.accounts.length && (
        <p>Unlock your operating-system keychain to use a saved account.</p>
      )}
      {value && (
        <p>
          The saved account is used only for this HTTPS operation. Redirects and URL rewrites are
          refused.
        </p>
      )}
    </section>
  );
}
