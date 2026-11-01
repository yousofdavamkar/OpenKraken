import { useEffect, useRef, useState } from 'react';
import { GitProgress } from './git-progress.js';
import { useRepository } from './store.js';
function CloneDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { run, cancel, error } = useRepository();
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [depth, setDepth] = useState('');
  const [filter, setFilter] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [directories, setDirectories] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
    setPending(true);
    const previous = useRepository.getState().snapshot;
    try {
      await run({
        id: crypto.randomUUID(),
        method: 'clone',
        options: {
          url,
          ...(branch ? { branch } : {}),
          ...(depth ? { depth: Number(depth) } : {}),
          ...(filter ? { filter: 'blob:none' } : {}),
          ...(sparse
            ? { sparse: directories.split(/\r?\n/).filter((path) => path.length > 0) }
            : {}),
        },
      });
      const current = useRepository.getState();
      if (!current.error && current.snapshot && current.snapshot !== previous) close();
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog clone-dialog"
      aria-label="Clone repository"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Clone repository</h2>
        <label>
          Repository URL or absolute path
          <input
            required
            autoFocus
            value={url}
            disabled={pending}
            maxLength={32768}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://host/owner/repository.git"
          />
        </label>
        <label>
          Branch or tag (optional)
          <input
            value={branch}
            disabled={pending}
            maxLength={1024}
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        <label>
          History depth (optional)
          <input
            type="number"
            min={1}
            max={1000000}
            step={1}
            value={depth}
            disabled={pending}
            onChange={(event) => setDepth(event.target.value)}
          />
        </label>
        <p>Leave depth blank for full history. A depth limit clones one branch by default.</p>
        <label>
          <input
            type="checkbox"
            checked={filter}
            disabled={pending}
            onChange={(event) => setFilter(event.target.checked)}
          />{' '}
          Download file contents on demand
        </label>
        <label>
          <input
            type="checkbox"
            checked={sparse}
            disabled={pending}
            onChange={(event) => setSparse(event.target.checked)}
          />{' '}
          Check out selected directories
        </label>
        {sparse && (
          <label>
            Directories (one per line)
            <textarea
              value={directories}
              rows={4}
              disabled={pending}
              onChange={(event) => setDirectories(event.target.value)}
            />
          </label>
        )}
        {sparse && (
          <p>
            Includes root files and the selected directories. Leave the list empty for root files
            only.
          </p>
        )}
        <p>
          Choose an empty destination folder. Use your credential helper or SSH agent for
          authentication.
        </p>
        <GitProgress />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={pending} onClick={close}>
            Close
          </button>
          {pending ? (
            <button type="button" onClick={() => void cancel()}>
              Cancel clone
            </button>
          ) : (
            <button disabled={!url.trim()}>Choose folder and clone</button>
          )}
        </div>
      </form>
    </dialog>
  );
}
export function Clone() {
  const { busy, syncing } = useRepository();
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button
        disabled={!!busy && !syncing}
        onClick={() => {
          useRepository.setState({ error: undefined });
          setOpened(true);
        }}
      >
        Clone
      </button>
      {opened && <CloneDialog close={() => setOpened(false)} />}
    </>
  );
}
