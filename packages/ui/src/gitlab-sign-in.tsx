import { useEffect, useRef, useState } from 'react';
import type { GitLabChallenge, ProviderAccounts, Request } from '@openkraken/ipc-contract';
type SignInRequest = Extract<
  Request,
  {
    method:
      'providerGitLabStart' | 'providerGitLabPoll' | 'providerGitLabOpen' | 'providerGitLabCancel';
  }
>;

export function GitLabSignIn({
  origin,
  enabled,
  onBusy,
  onConnected,
}: {
  origin: string;
  enabled: boolean;
  onBusy: (busy: boolean) => void;
  onConnected: (state: ProviderAccounts) => void;
}) {
  const [clientId, setClientId] = useState('');
  const [callbackPort, setCallbackPort] = useState('47653');
  const [challenge, setChallenge] = useState<GitLabChallenge>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true),
    epoch = useRef(0);
  const requests = useRef(new Set<string>());
  const current = useRef<GitLabChallenge | undefined>(undefined);
  const call = async (request: SignInRequest) => {
    requests.current.add(request.id);
    try {
      return await window.openkraken.request(request);
    } finally {
      requests.current.delete(request.id);
    }
  };
  const forget = (id: string) =>
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'providerGitLabCancel', challengeId: id })
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
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await call({
            id: crypto.randomUUID(),
            method: 'providerGitLabPoll',
            challengeId: challenge.id,
          });
          if (!alive.current || epoch.current !== generation) return;
          if (result.kind === 'providerGitLab') {
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
            setError('GitLab sign-in could not be completed. Start again to retry.');
          }
        }
      })();
    }, 1000);
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
        method: 'providerGitLabStart',
        options: { origin, clientId, callbackPort: Number(callbackPort) },
      });
      if (!alive.current || generation !== epoch.current) {
        if (result.kind === 'providerGitLab') forget(result.challenge.id);
        return;
      }
      if (result.kind === 'providerGitLab') {
        current.current = result.challenge;
        setChallenge(result.challenge);
      } else {
        onBusy(false);
        if (result.kind === 'error') setError(result.message);
      }
    } catch {
      if (alive.current && generation === epoch.current) {
        onBusy(false);
        setError('GitLab sign-in could not be started. Check the host and application settings.');
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
        method: 'providerGitLabOpen',
        challengeId: challenge.id,
      });
      if (alive.current && generation === epoch.current && result.kind === 'error')
        setError(result.message);
    } catch {
      if (alive.current && generation === epoch.current)
        setError('The browser could not be opened. Try again.');
    }
  };
  return (
    <section className="github-sign-in" aria-label="GitLab browser sign-in">
      <h3>GitLab browser sign-in</h3>
      {challenge ? (
        <>
          <p role="status">
            Waiting for authorization from {challenge.origin}. This sign-in expires at{' '}
            {new Date(challenge.expiresAt).toLocaleTimeString()}.
          </p>
          <button onClick={() => void openBrowser()}>Open GitLab authorization</button>
          <button onClick={cancel}>Cancel GitLab sign-in</button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label>
            GitLab application client ID
            <input
              required
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              pattern="[A-Za-z0-9_.\-]+"
              maxLength={255}
              disabled={!enabled || starting}
            />
          </label>
          <label>
            Local callback port
            <input
              type="number"
              required
              min={1024}
              max={65535}
              step={1}
              value={callbackPort}
              onChange={(event) => setCallbackPort(event.target.value)}
              disabled={!enabled || starting}
            />
          </label>
          <p>
            Register a GitLab application with Confidential turned off, the api scope, and this
            redirect URI: <code>http://127.0.0.1:{callbackPort}/callback</code>
          </p>
          <p>
            GitLab will ask you to authorize profile, API, and repository access in your browser.
          </p>
          <button disabled={!enabled || starting}>Sign in with GitLab</button>
          {starting && (
            <button type="button" onClick={cancel}>
              Cancel GitLab sign-in
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
