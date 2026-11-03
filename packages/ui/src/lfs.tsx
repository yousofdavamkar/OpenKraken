import { useEffect, useRef, useState } from 'react';
import type { LfsState, LfsPullPreview, LfsLocks } from '@openkraken/ipc-contract';
import { CommandButton } from './commands.js';
import { useRepository, waitForBackground } from './store.js';

function LfsDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const cancelReview = useRef<HTMLButtonElement>(null);
  const requestId = useRef<string | undefined>(undefined);
  const reviewed = useRef(false);
  const [review, setReview] = useState<LfsPullPreview>();
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remote, setRemote] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [state, setState] = useState<LfsState>();
  const [serverLocks, setServerLocks] = useState<LfsLocks>();
  const [checkingLocks, setCheckingLocks] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(200);
  const owners = new Map<string, string[]>();
  for (const lock of serverLocks?.locks ?? state?.locks ?? []) {
    const existing = owners.get(lock.path);
    if (existing) existing.push(lock.owner ?? 'Unknown owner');
    else owners.set(lock.path, [lock.owner ?? 'Unknown owner']);
  }
  useEffect(
    () =>
      window.openkraken.subscribe((event) => {
        if (event.type === 'gitProgress' && event.id === requestId.current) setProgress(event.text);
      }),
    [],
  );
  useEffect(() => {
    if (pending) return;
    if (review) cancelReview.current?.focus();
    else if (reviewed.current) reviewButton.current?.focus();
  }, [review, pending]);
  const load = async () => {
    setServerLocks(undefined);
    setReview(undefined);
    setNotice('');
    setPending(true);
    setError('');
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'lfsState',
        repoId,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'lfsState') setState(result.state);
      const configured = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'remotes',
        repoId,
      });
      if (configured.kind === 'error') throw new Error(configured.message);
      if (configured.kind === 'remotes') {
        const names = configured.state.remotes.map((item) => item.name);
        setRemotes(names);
        setRemote((current) =>
          names.includes(current)
            ? current
            : names.includes('origin')
              ? 'origin'
              : (names[0] ?? ''),
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, []);
  const prepare = async () => {
    setPending(true);
    setError('');
    setNotice('');
    setReview(undefined);
    reviewed.current = true;
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'lfsPullPreview',
        repoId,
        remote,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'lfsPullPreview') setReview(result.preview);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const pull = async () => {
    if (!review) return;
    setPending(true);
    setError('');
    setNotice('');
    setProgress('Downloading LFS objects…');
    setServerLocks(undefined);
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      const id = crypto.randomUUID();
      requestId.current = id;
      useRepository.setState({ busy: id });
      setDownloading(true);
      const result = await window.openkraken.request({
        id,
        method: 'lfsPull',
        repoId,
        token: review.token,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled') throw new Error('LFS download cancelled.');
      if (result.kind === 'lfsState') {
        setState(result.state);
        setNotice('LFS pull finished. Check any remaining pointer or missing entries.');
      }
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : String(error)} Some objects or files may already have changed. Refresh local state before retrying.`,
      );
    } finally {
      const id = requestId.current;
      requestId.current = undefined;
      setDownloading(false);
      setReview(undefined);
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  const refreshLocks = async () => {
    setPending(true);
    setCheckingLocks(true);
    setServerLocks(undefined);
    setError('');
    setNotice('');
    reviewed.current = false;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      const id = crypto.randomUUID();
      requestId.current = id;
      useRepository.setState({ busy: id });
      const result = await window.openkraken.request({ id, method: 'lfsLocks', repoId, remote });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled') throw new Error('Server lock refresh cancelled.');
      if (result.kind === 'lfsLocks') {
        setServerLocks(result.state);
        setState(
          (current) => current && { ...current, locks: result.state.locks, lockError: undefined },
        );
        setNotice('Server locks checked.');
      }
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : String(error)} Server lock state is unknown; cached locks may be stale.`,
      );
    } finally {
      const id = requestId.current;
      requestId.current = undefined;
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      setCheckingLocks(false);
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reference-dialog lfs-dialog"
      aria-label="Git LFS"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) {
          if (review) setReview(undefined);
          else close();
        }
      }}
    >
      <h2>Git LFS</h2>
      <p>
        Large files are stored as pointers in Git. Refresh local state reads files and cached locks.
        Review download before fetching objects and filling unchanged pointers or missing files.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && !downloading && !checkingLocks && !notice && !error && (
        <p role="status">Inspecting LFS state…</p>
      )}
      {checkingLocks && (
        <div>
          <p role="status">Checking server locks…</p>
          <button
            onClick={() => {
              if (requestId.current) void window.openkraken.cancel(requestId.current);
            }}
          >
            Cancel lock refresh
          </button>
        </div>
      )}
      {downloading && (
        <div>
          <p role="status">{progress}</p>
          <button
            onClick={() => {
              if (requestId.current) void window.openkraken.cancel(requestId.current);
            }}
          >
            Cancel download
          </button>
        </div>
      )}
      {review && (
        <fieldset disabled={pending}>
          <legend>Review LFS download</legend>
          <p>Remote: {review.remote}</p>
          <p className="lfs-endpoint">Endpoint: {review.endpoint}</p>
          <p>
            Download objects for the current checkout and fill unchanged pointers or missing files.
            Local edits are preserved. The server may supply separate object download URLs. A
            failure or cancellation can leave partial downloads or checkouts; there is no Undo.
          </p>
          <p>
            Configured download filters apply.
            {review.filters.length
              ? ` ${review.filters.join(' · ')}`
              : ' No include/exclude filters are reported.'}
          </p>
          <p>{review.files.length.toLocaleString()} known LFS files; filters may exclude some.</p>
          <ul aria-label="Reviewed LFS objects">
            {review.files.slice(0, visible).map((file) => (
              <li key={`${file.path}:${file.oid}`}>
                <h4>{file.path}</h4>
                <p>
                  {file.size.toLocaleString()} bytes · <code>{file.oid}</code>
                </p>
                <p>{file.downloaded ? 'Object available locally' : 'Object missing locally'}</p>
              </li>
            ))}
          </ul>
          {review.files.length > visible && (
            <button onClick={() => setVisible(visible + 200)}>Show more reviewed objects</button>
          )}
          <div className="dialog-actions">
            <button onClick={() => void pull()}>Download and check out</button>
            <button ref={cancelReview} onClick={() => setReview(undefined)}>
              Cancel review
            </button>
          </div>
        </fieldset>
      )}
      {state && !state.available && (
        <p>
          Git LFS is not available to OpenKraken. Install Git LFS, then restart OpenKraken and
          refresh. Pointer comparisons remain available.
        </p>
      )}
      {state?.available && (
        <>
          <p>{state.version}</p>
          <h3>Tracked files</h3>
          {!state.files.length && (
            <p>No LFS pointers were found in the current checkout’s index or HEAD.</p>
          )}
          <ul aria-label="LFS tracked files">
            {state.files.slice(0, visible).map((file) => (
              <li key={`${file.path}:${file.oid}`}>
                <h4>{file.path}</h4>
                <p>
                  {file.size.toLocaleString()} bytes · SHA-256 <code>{file.oid}</code>
                </p>
                <p>
                  {file.checkout ? 'Full content checked out' : 'Pointer or missing working file'} ·{' '}
                  {file.downloaded ? 'Object available locally' : 'Object missing locally'}
                </p>
                <p>
                  {serverLocks
                    ? owners.has(file.path)
                      ? `Lock reported at last check: ${owners.get(file.path)!.join(', ')}`
                      : 'No lock reported at last check'
                    : (owners.has(file.path)
                        ? `Cached lock: ${owners.get(file.path)!.join(', ')}`
                        : 'No cached lock') + ' · Server lock state unknown'}
                </p>
              </li>
            ))}
          </ul>
          {serverLocks && (
            <section aria-label="Server LFS locks">
              <h3>Server locks at last check</h3>
              <p>Remote: {serverLocks.remote}</p>
              <p className="lfs-endpoint">Endpoint: {serverLocks.endpoint}</p>
              <p>
                Checked{' '}
                <time dateTime={serverLocks.checkedAt}>
                  {new Date(serverLocks.checkedAt).toLocaleString()}
                </time>
                . Ownership can change after this check.
              </p>
              {!serverLocks.locks.length && (
                <p>No locks were reported by this server at the last check.</p>
              )}
              <ul aria-label="Server lock results">
                {serverLocks.locks.slice(0, visible).map((lock) => (
                  <li key={lock.id}>
                    <h4>{lock.path}</h4>
                    <p>
                      {lock.owner ?? 'Unknown owner'}
                      {lock.lockedAt ? ` · ${lock.lockedAt}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <h3>Cached locks</h3>
          <p>
            These are the last locks cached by Git LFS. Server ownership may have changed; an empty
            cache does not establish that files are unlocked.
          </p>
          {state.lockError && <p role="alert">Cached locks could not be read: {state.lockError}</p>}
          {!state.lockError && !state.locks.length && <p>No cached locks.</p>}
          <ul aria-label="Cached LFS locks">
            {state.locks.slice(0, visible).map((lock) => (
              <li key={lock.id}>
                <h4>{lock.path}</h4>
                <p>
                  {lock.owner ?? 'Unknown owner'}
                  {lock.lockedAt ? ` · ${lock.lockedAt}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {(state.files.length > visible ||
            state.locks.length > visible ||
            (serverLocks?.locks.length ?? 0) > visible) && (
            <button onClick={() => setVisible(visible + 200)}>Show more LFS entries</button>
          )}
        </>
      )}
      {state?.available && (
        <label>
          LFS remote{' '}
          <select
            aria-label="LFS remote"
            disabled={pending || !!review}
            value={remote}
            onChange={(event) => {
              setRemote(event.target.value);
              setServerLocks(undefined);
              setNotice('');
              setError('');
            }}
          >
            {remotes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="dialog-actions">
        <button
          disabled={pending || !!review || !state?.available || !remote}
          onClick={() => void refreshLocks()}
        >
          Refresh server locks
        </button>
        <button
          ref={reviewButton}
          disabled={pending || !!review || !state?.available || !state.files.length || !remote}
          onClick={() => void prepare()}
        >
          Review download
        </button>
        <button disabled={pending || !!review} onClick={() => void load()}>
          Refresh local state
        </button>
        <button disabled={pending} onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
export function LfsControl() {
  const { snapshot, busy } = useRepository();
  const [open, setOpen] = useState(false);
  return (
    <>
      <CommandButton
        command="repository.lfs"
        disabled={!snapshot || snapshot.repository.isBare || !!busy}
        onClick={() => setOpen(true)}
      >
        Git LFS
      </CommandButton>
      {open && snapshot && (
        <LfsDialog repoId={snapshot.repository.id} close={() => setOpen(false)} />
      )}
    </>
  );
}
