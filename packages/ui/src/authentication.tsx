import { subscribeDesktopEvents } from './desktop-events.js';
import { useEffect, useRef, useState } from 'react';
import type { AuthenticationEvent, DesktopEvent } from '@openkraken/ipc-contract';
import { useRepository } from './store.js';
type Prompt = Extract<AuthenticationEvent, { type: 'authenticationPrompt' }>;
function AuthenticationDialog({ prompt }: { prompt: Prompt }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const respond = async (value: string | null) => {
    if (pending) return;
    setPending(true);
    setAnswer('');
    try {
      if (value === null) await window.openkraken.cancel(prompt.id);
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'answerPrompt',
        requestId: prompt.id,
        promptId: prompt.promptId,
        answer: value,
      });
      if (result.kind === 'error') setError(result.message);
    } catch {
      setError('The authentication reply could not be delivered. Cancel and retry the operation.');
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog authentication-dialog"
      aria-label="Git authentication"
      onCancel={(event) => {
        event.preventDefault();
        void respond(null);
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void respond(answer);
        }}
      >
        <h2>{prompt.kind === 'confirm' ? 'Confirm SSH request' : 'Git authentication'}</h2>
        <p>{prompt.context}</p>
        <pre className="authentication-message">{prompt.message}</pre>
        {prompt.kind !== 'confirm' && (
          <label>
            {prompt.kind === 'username' ? 'Username' : 'Password or passphrase'}
            <input
              autoFocus
              type={prompt.kind === 'username' ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              disabled={pending}
            />
          </label>
        )}
        <p>
          Credentials are passed to Git or SSH. Your configured credential helper or agent controls
          whether they are saved.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={() => void respond(null)} disabled={pending}>
            Cancel operation
          </button>
          {prompt.kind === 'confirm' ? (
            <>
              <button type="button" onClick={() => void respond('no')} disabled={pending}>
                Decline
              </button>
              <button type="button" onClick={() => void respond('yes')} disabled={pending}>
                Confirm
              </button>
            </>
          ) : (
            <button disabled={pending}>Continue</button>
          )}
        </div>
      </form>
    </dialog>
  );
}
type TransportProblem = Extract<DesktopEvent, { type: 'transportProblem' }>;
function HostKeyProblem({ problem, close }: { problem: TransportProblem; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-label="SSH host key changed"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2>SSH host key changed</h2>
      <p>
        The connection was stopped. Verify the new fingerprint with your server administrator before
        updating your SSH known_hosts entry.
      </p>
      <pre className="authentication-message">{problem.message}</pre>
      <button onClick={close}>Close</button>
    </dialog>
  );
}
export function Authentication() {
  const busy = useRepository((state) => state.busy);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [problem, setProblem] = useState<TransportProblem>();
  useEffect(
    () =>
      subscribeDesktopEvents((event) => {
        if (event.type === 'transportProblem') setProblem(event);
        if (event.type === 'authenticationPrompt')
          setPrompts((current) => [
            ...current.filter((item) => item.promptId !== event.promptId),
            event,
          ]);
        if (event.type === 'authenticationClosed')
          setPrompts((current) => current.filter((item) => item.promptId !== event.promptId));
        if (event.type === 'gitRequestsInterrupted')
          setPrompts((current) => current.filter((item) => !event.requestIds.includes(item.id)));
      }),
    [],
  );
  const prompt = prompts.find((item) => item.id === busy);
  return (
    <>
      {prompt && <AuthenticationDialog key={prompt.promptId} prompt={prompt} />}
      {problem && (
        <HostKeyProblem key={problem.id} problem={problem} close={() => setProblem(undefined)} />
      )}
    </>
  );
}
