import { useEffect, useState } from 'react';
import { useRepository } from './store.js';
const choices = [0, 5, 15, 30];
export function AutomaticFetch({ repoId }: { repoId: string }) {
  const key = `openkraken.autoFetch.${repoId}`;
  const [minutes, setMinutes] = useState(() => {
    try {
      const value = Number(localStorage.getItem(key));
      return choices.includes(value) ? value : 0;
    } catch {
      return 0;
    }
  });
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!minutes) return;
    let stopped = false;
    let requestId: string | undefined;
    const fetch = async () => {
      const state = useRepository.getState();
      if (
        stopped ||
        requestId ||
        state.busy ||
        state.paging ||
        state.searching ||
        state.snapshot?.repository.id !== repoId ||
        document.querySelector('dialog[open]')
      )
        return;
      try {
        requestId = crypto.randomUUID();
        useRepository.setState({ busy: requestId });
        setNotice('Fetching remotes automatically…');
        const remotes = await window.openkraken.request({
          id: requestId,
          method: 'remotes',
          repoId,
        });
        if (remotes.kind === 'error') throw new Error(remotes.message);
        if (remotes.kind !== 'remotes' || stopped) return;
        for (const remote of remotes.state.remotes) {
          if (stopped) return;
          requestId = crypto.randomUUID();
          useRepository.setState({ busy: requestId });
          const result = await window.openkraken.request({
            id: requestId,
            method: 'fetch',
            repoId,
            name: remote.name,
            background: true,
          });
          if (result.kind === 'error') throw new Error(result.message);
          if (result.kind === 'cancelled') {
            setNotice('Automatic fetch cancelled');
            return;
          }
        }
        if (!stopped) setNotice('Automatic fetch completed');
      } catch (error) {
        if (!stopped)
          setNotice(
            `Automatic fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
      } finally {
        if (useRepository.getState().busy === requestId)
          useRepository.setState({ busy: undefined });
        requestId = undefined;
        if (!stopped && useRepository.getState().snapshot?.repository.id === repoId)
          await useRepository
            .getState()
            .run({ id: crypto.randomUUID(), method: 'refresh', repoId }, true);
      }
    };
    const timer = setInterval(() => void fetch(), minutes * 60000);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (requestId) void window.openkraken.cancel(requestId);
    };
  }, [repoId, minutes]);
  return (
    <>
      <label>
        Automatic fetch{' '}
        <select
          value={minutes}
          onChange={(event) => {
            const value = Number(event.target.value);
            setMinutes(value);
            setNotice('');
            try {
              localStorage.setItem(key, String(value));
            } catch {
              /* Session setting still applies. */
            }
          }}
        >
          {choices.map((value) => (
            <option value={value} key={value}>
              {value ? `Every ${value} minutes` : 'Off'}
            </option>
          ))}
        </select>
      </label>
      {notice && <span role="status">{notice}</span>}
    </>
  );
}
