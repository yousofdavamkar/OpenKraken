import type { SubmoduleState } from '@openkraken/ipc-contract';
import { subscribeDesktopEvents } from './desktop-events.js';

// The parent watcher reports a dirty gitlink once. Further edits within an already
// dirty child need a fresh recursive inventory even if the parent's status is identical.
export function observeSubmodules(
  repoId: string,
  publish: (state: SubmoduleState) => void,
  report: (error: string) => void,
) {
  let stopped = false;
  let request: string | undefined;
  let changed = false;
  let timer: ReturnType<typeof setTimeout>;
  function schedule(delay: number) {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(read, delay);
  }
  async function read() {
    if (stopped || document.hidden || request) return;
    changed = false;
    request = crypto.randomUUID();
    try {
      const result = await window.openkraken.request({ id: request, method: 'submodules', repoId });
      if (stopped) return;
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'submodules') {
        publish(result.state);
        report('');
      }
    } catch (error) {
      if (!stopped) report(error instanceof Error ? error.message : String(error));
    } finally {
      request = undefined;
      schedule(changed ? 250 : 5000);
    }
  }
  function notify() {
    if (changed) return;
    changed = true;
    if (!request) schedule(250);
  }
  function visibility() {
    if (document.hidden) clearTimeout(timer);
    else if (request) changed = true;
    else schedule(0);
  }
  const unsubscribe = subscribeDesktopEvents((event) => {
    if (event.type === 'repositoryChanged' && event.repoId === repoId && event.domains.length)
      notify();
  });
  document.addEventListener('visibilitychange', visibility);
  schedule(5000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    document.removeEventListener('visibilitychange', visibility);
    if (request) void window.openkraken.cancel(request).catch(() => {});
  };
}
