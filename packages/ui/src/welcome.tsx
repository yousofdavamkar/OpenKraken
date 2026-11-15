import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { messagesFor } from './messages.js';

function subscribeLanguageChange(notify: () => void) {
  window.addEventListener('languagechange', notify);
  return () => window.removeEventListener('languagechange', notify);
}
function preferredCatalog() {
  return messagesFor(navigator.languages);
}
const guideKey = 'openkraken.welcome.completed.v1';
function showGuide() {
  try {
    return localStorage.getItem(guideKey) !== '1';
  } catch {
    return true;
  }
}
export function completeWelcomeGuide() {
  try {
    localStorage.setItem(guideKey, '1');
  } catch {
    // The welcome actions still work when profile storage is unavailable.
  }
}
const choices = {
  open: { label: 'openChoice', help: 'openHelp', action: 'openRepository' },
  clone: { label: 'cloneChoice', help: 'cloneHelp', action: 'cloneRepository' },
  init: { label: 'initChoice', help: 'initHelp', action: 'initRepository' },
} as const;
type Choice = keyof typeof choices;

export function Welcome({ actions, busy }: { actions: Record<Choice, () => void>; busy: boolean }) {
  const { language, messages } = useSyncExternalStore(subscribeLanguageChange, preferredCatalog);
  const [guided, setGuided] = useState(showGuide);
  const [choice, setChoice] = useState<Choice>('open');
  const primary = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      (guided ? selected.current : primary.current)?.focus();
      restoreFocus.current = false;
    }
  }, [guided]);
  const current = guided ? choice : 'open';
  return (
    <main className="welcome" lang={language}>
      <div className="welcome-content">
        <h1>{messages.welcomeTitle}</h1>
        {guided ? (
          <>
            <fieldset className="welcome-choices" disabled={busy}>
              <legend>{messages.startChoice}</legend>
              {(['open', 'clone', 'init'] as const).map((id) => (
                <label key={id}>
                  <input
                    ref={id === choice ? selected : undefined}
                    type="radio"
                    name="start-choice"
                    checked={id === choice}
                    onChange={() => setChoice(id)}
                  />
                  {messages[choices[id].label]}
                </label>
              ))}
            </fieldset>
            <p id="welcome-help" aria-live="polite">
              {messages[choices[current].help]}
            </p>
          </>
        ) : (
          <p id="welcome-help">{messages.welcomeDescription}</p>
        )}
        <div className="welcome-actions">
          <button
            ref={primary}
            className="primary"
            aria-describedby="welcome-help"
            onClick={actions[current]}
            disabled={busy}
          >
            {messages[choices[current].action]}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (guided) completeWelcomeGuide();
              restoreFocus.current = true;
              setGuided(!guided);
            }}
          >
            {guided ? messages.skipGuide : messages.replayGuide}
          </button>
        </div>
        {current !== 'clone' && <small>{messages.localGit}</small>}
      </div>
    </main>
  );
}
