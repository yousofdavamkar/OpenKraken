import { CommandButton } from './commands.js';
import { ProviderGitAccount } from './provider-git-account.js';
import { GitProgress } from './git-progress.js';
import { useEffect, useRef, useState } from 'react';
import type { PushPlan, RemoteState } from '@openkraken/ipc-contract';
import { useRepository, waitForBackground } from './store.js';
function PushDialog({ repoId, close }: { repoId: string; close: () => void }) {
  const { snapshot } = useRepository();
  const refs = snapshot?.refs.filter((ref) => ref.kind === 'local' || ref.kind === 'tag') ?? [];
  const initial = refs.find((ref) => ref.isHead) ?? refs[0];
  const dialog = useRef<HTMLDialogElement>(null);
  const [remotes, setRemotes] = useState<RemoteState['remotes']>([]);
  const [accountId, setAccountId] = useState('');
  const [remoteRevision, setRemoteRevision] = useState('');
  const [reload, setReload] = useState(0);
  const [remote, setRemote] = useState('');
  const [source, setSource] = useState(initial?.name ?? '');
  const [destination, setDestination] = useState(initial?.shortName ?? '');
  const [upstream, setUpstream] = useState(false);
  const [force, setForce] = useState(false);
  const [plan, setPlan] = useState<PushPlan>();
  const [pending, setPending] = useState(true);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    let stopped = false;
    setPending(true);
    setRemoteRevision('');
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'remotes', repoId })
      .then((result) => {
        if (stopped) return;
        if (result.kind === 'error') setError(result.message);
        if (result.kind === 'remotes') {
          setRemotes(result.state.remotes);
          setRemoteRevision(result.state.token);
          setRemote(
            (current) =>
              result.state.remotes.find((r) => r.name === current)?.name ??
              result.state.remotes.find((r) => r.name === 'origin')?.name ??
              result.state.remotes[0]?.name ??
              '',
          );
        }
      })
      .catch((e: unknown) => {
        if (!stopped) setError(String(e));
      })
      .finally(() => {
        if (!stopped) setPending(false);
      });
    return () => {
      stopped = true;
    };
  }, [repoId, reload]);
  const submit = async () => {
    setPending(true);
    setError(undefined);
    setNotice('');
    let id: string | undefined;
    try {
      if (useRepository.getState().syncing) await waitForBackground();
      if (useRepository.getState().snapshot?.repository.id !== repoId) return;
      if (useRepository.getState().busy)
        throw new Error('Wait for the current operation to finish');
      id = crypto.randomUUID();
      useRepository.setState({ busy: id });
      const selection = {
        name: remote,
        source,
        destination: `${source.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/'}${destination}`,
      };
      const options = plan ? { plan, force, upstream } : undefined;
      const result = await window.openkraken.request(
        accountId
          ? {
              id,
              method: 'providerGit',
              accountId,
              operation: options
                ? { method: 'push', repoId, options }
                : { method: 'pushPreview', repoId, selection, revision: remoteRevision },
            }
          : options
            ? { id, method: 'push', repoId, options }
            : { id, method: 'pushPreview', repoId, selection },
      );
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'cancelled')
        setNotice(
          plan
            ? 'Push cancelled. Review the destination before retrying; the server may have received updates.'
            : 'Review cancelled',
        );
      if (result.kind === 'pushPreview') {
        setPlan(result.plan);
        setForce(false);
      }
      if (result.kind === 'pushed') {
        setComplete(true);
        setNotice(result.warning ?? 'Push completed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id && useRepository.getState().busy === id) useRepository.setState({ busy: undefined });
      if (plan && id && useRepository.getState().snapshot?.repository.id === repoId)
        await useRepository.getState().run({ id: crypto.randomUUID(), method: 'refresh', repoId });
      setPending(false);
    }
  };
  return (
    <dialog
      className="reference-dialog"
      ref={dialog}
      aria-label="Push to remote"
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
        <h2>Push to remote</h2>
        <GitProgress />
        <ProviderGitAccount
          label="Push authentication"
          value={accountId}
          onChange={setAccountId}
          disabled={pending || !!plan}
        />
        <label>
          Remote
          <select
            value={remote}
            disabled={pending || !!plan}
            onChange={(event) => setRemote(event.target.value)}
          >
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {!pending && !remotes.length && <p>Add a remote in Manage remotes first.</p>}
        <label>
          Local branch or tag
          <select
            value={source}
            disabled={pending || !!plan}
            onChange={(event) => {
              setSource(event.target.value);
              setDestination(event.target.value.replace(/^refs\/(heads|tags)\//, ''));
              setUpstream(false);
            }}
          >
            {refs.map((ref) => (
              <option key={ref.name} value={ref.name}>
                {ref.shortName} ({ref.kind === 'tag' ? 'tag' : 'branch'})
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination name
          <input
            value={destination}
            maxLength={1000}
            disabled={pending || !!plan}
            required
            onChange={(event) => setDestination(event.target.value)}
          />
        </label>
        {source.startsWith('refs/heads/') && (
          <label>
            <input
              type="checkbox"
              checked={upstream}
              disabled={pending || complete}
              onChange={(event) => setUpstream(event.target.checked)}
            />{' '}
            Set upstream after push
          </label>
        )}
        {plan && (
          <section aria-label="Reviewed push">
            <p>{plan.remoteOid ? `Update ${plan.destination}` : `Create ${plan.destination}`}</p>
            <p>{plan.url}</p>
            <p>
              Local tip: <code>{plan.sourceOid}</code>
            </p>
            <p>
              Remote tip: <code>{plan.remoteOid ?? 'Does not exist'}</code>
            </p>
            <label>
              <input
                type="checkbox"
                checked={force}
                disabled={pending || complete}
                onChange={(event) => setForce(event.target.checked)}
              />{' '}
              Replace remote history with force-with-lease
            </label>
            {force && (
              <p>
                This can replace other commits. Git will refuse if the remote tip changed since this
                review.
              </p>
            )}
          </section>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {pending && (
            <button type="button" onClick={() => void useRepository.getState().cancel()}>
              Cancel operation
            </button>
          )}
          <button type="button" disabled={pending} onClick={close}>
            Close
          </button>
          {plan && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setPlan(undefined);
                setForce(false);
                setComplete(false);
                setError(undefined);
                setNotice('');
                setReload((value) => value + 1);
              }}
            >
              Review again
            </button>
          )}
          {!plan && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(undefined);
                setReload((value) => value + 1);
              }}
            >
              Reload remotes
            </button>
          )}
          {!complete && (
            <button
              disabled={
                pending ||
                !remote ||
                !source ||
                !destination.trim() ||
                (!!accountId && !remoteRevision)
              }
              className={force ? 'danger' : undefined}
            >
              {plan ? 'Push reviewed tip' : 'Review push'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
export function Push() {
  const { snapshot, busy, syncing } = useRepository();
  const [opened, setOpened] = useState(false);
  if (!snapshot) return null;
  return (
    <>
      <CommandButton
        command="repository.push"
        disabled={!!busy && !syncing}
        onClick={() => setOpened(true)}
      >
        Push
      </CommandButton>
      {opened && (
        <PushDialog
          key={snapshot.repository.id}
          repoId={snapshot.repository.id}
          close={() => setOpened(false)}
        />
      )}
    </>
  );
}
