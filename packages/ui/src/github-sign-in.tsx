import { useEffect, useRef, useState } from 'react';
import type { DeviceChallenge, ProviderAccounts, Request } from '@openkraken/ipc-contract';
type DeviceRequest = Extract<
  Request,
  {
    method:
      'providerDeviceStart' | 'providerDevicePoll' | 'providerDeviceCancel' | 'providerDeviceOpen';
  }
>;

export function GitHubSignIn({
  enabled,
  onBusy,
  onConnected,
}: {
  enabled: boolean;
  onBusy: (busy: boolean) => void;
  onConnected: (state: ProviderAccounts) => void;
}) {
  const [clientId, setClientId] = useState('');
  const [privateRepositories, setPrivateRepositories] = useState(false);
  const [challenge, setChallenge] = useState<DeviceChallenge>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true),
    epoch = useRef(0);
  const requests = useRef(new Set<string>());
  const current = useRef<DeviceChallenge | undefined>(undefined);
  const call = async (request: DeviceRequest) => {
    requests.current.add(request.id);
    try {
      return await window.openkraken.request(request);
    } finally {
      requests.current.delete(request.id);
    }
  };
  const forget = (id: string) =>
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'providerDeviceCancel', challengeId: id })
      .catch(() => {});
  const cancel = () => {
    epoch.current++;
    for (const id of requests.current) void window.openkraken.cancel(id);
    if (current.current) forget(current.current.id);
    current.current = undefined;
    setChallenge(undefined);
    setStarting(false);
    onBusy(false);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      for (const id of requests.current) void window.openkraken.cancel(id);
      if (current.current) forget(current.current.id);
    };
  }, []);
  useEffect(() => {
    if (!challenge) return;
    const generation = epoch.current;
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const result = await call({
              id: crypto.randomUUID(),
              method: 'providerDevicePoll',
              challengeId: challenge.id,
            });
            if (!alive.current || epoch.current !== generation) return;
            if (result.kind === 'providerDevice') {
              current.current = result.challenge;
              setChallenge(result.challenge);
            } else if (result.kind === 'providerAccounts') {
              current.current = undefined;
              setChallenge(undefined);
              onBusy(false);
              onConnected(result.state);
            } else {
              cancel();
              if (result.kind === 'error') setError(result.message);
            }
          } catch {
            if (alive.current && epoch.current === generation) {
              cancel();
              setError('GitHub sign-in could not be completed. Start again to retry.');
            }
          }
        })();
      },
      Math.max(0, Math.min(challenge.nextPollAt, challenge.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [challenge]);
  const start = async () => {
    const generation = ++epoch.current;
    setStarting(true);
    setError(undefined);
    onBusy(true);
    try {
      const result = await call({
        id: crypto.randomUUID(),
        method: 'providerDeviceStart',
        options: { clientId, privateRepositories },
      });
      if (!alive.current || generation !== epoch.current) {
        if (result.kind === 'providerDevice') forget(result.challenge.id);
        return;
      }
      if (result.kind === 'providerDevice') {
        current.current = result.challenge;
        setChallenge(result.challenge);
      } else {
        onBusy(false);
        if (result.kind === 'error') setError(result.message);
      }
    } catch {
      if (alive.current && generation === epoch.current) {
        onBusy(false);
        setError('GitHub sign-in could not be started.');
      }
    } finally {
      if (alive.current && generation === epoch.current) setStarting(false);
    }
  };
  const openBrowser = async () => {
    if (!challenge) return;
    const generation = epoch.current;
    try {
      const result = await call({
        id: crypto.randomUUID(),
        method: 'providerDeviceOpen',
        challengeId: challenge.id,
      });
      if (alive.current && generation === epoch.current && result.kind === 'error')
        setError(result.message);
    } catch {
      if (alive.current && generation === epoch.current)
        setError('The browser could not be opened. Enter the displayed address manually.');
    }
  };
  return (
    <section className="github-sign-in" aria-label="GitHub browser sign-in">
      <h3>GitHub browser sign-in</h3>
      {challenge ? (
        <>
          <p>Enter this code at {challenge.verificationUri}:</p>
          <p>
            <strong className="device-code">{challenge.userCode}</strong>
          </p>
          <p role="status">
            Waiting for authorization. This code expires at{' '}
            {new Date(challenge.expiresAt).toLocaleTimeString()}.
          </p>
          <button onClick={() => void openBrowser()}>Open GitHub authorization</button>
          <button onClick={cancel}>Cancel GitHub sign-in</button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label>
            GitHub application client ID
            <input
              required
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              pattern="[A-Za-z0-9_.\-]+"
              maxLength={255}
              disabled={!enabled || starting}
            />
          </label>
          <p>Use your GitHub application's client ID with device flow enabled.</p>
          <label>
            <input
              type="checkbox"
              checked={privateRepositories}
              onChange={(event) => setPrivateRepositories(event.target.checked)}
              disabled={!enabled || starting}
            />{' '}
            Access private repositories
          </label>
          <p>
            Requests your profile and {privateRepositories ? 'public and private' : 'public'}{' '}
            repository access. GitHub will ask you to authorize it in your browser.
          </p>
          <button disabled={!enabled || starting}>Sign in with GitHub</button>
          {starting && (
            <button type="button" onClick={cancel}>
              Cancel GitHub sign-in
            </button>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
