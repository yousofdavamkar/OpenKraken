import { useSyncExternalStore } from 'react';
import { messagesFor } from './messages.js';

function subscribeLanguageChange(notify: () => void) {
  window.addEventListener('languagechange', notify);
  return () => window.removeEventListener('languagechange', notify);
}
function preferredCatalog() {
  return messagesFor(navigator.languages);
}
export function Welcome({ open, busy }: { open: () => void; busy: boolean }) {
  const { language, messages } = useSyncExternalStore(subscribeLanguageChange, preferredCatalog);
  return (
    <main className="welcome" lang={language}>
      <div>
        <span className="welcome-icon" aria-hidden="true">
          ◈
        </span>
        <h1>{messages.welcomeTitle}</h1>
        <p>{messages.welcomeDescription}</p>
        <button className="primary" onClick={open} disabled={busy}>
          {messages.openRepository}
        </button>
        <small>{messages.localGit}</small>
      </div>
    </main>
  );
}
