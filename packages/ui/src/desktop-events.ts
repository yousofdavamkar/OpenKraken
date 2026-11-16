import type { DesktopEvent, RepositoryEvent } from '@openkraken/ipc-contract';

// Keep one validated bridge delivery per event for the lifetime of the renderer.
const events = new EventTarget();
// The Git service owns one active watcher. Its events can arrive while the renderer
// is still laying out the opening snapshot and has no view for that repository.
let pendingRepository: RepositoryEvent | undefined;
window.openkraken.subscribe((detail) => {
  if (detail.type === 'repositoryChanged') {
    pendingRepository =
      pendingRepository?.repoId === detail.repoId
        ? { ...detail, domains: [...new Set([...pendingRepository.domains, ...detail.domains])] }
        : detail;
  }
  events.dispatchEvent(new CustomEvent('desktop', { detail }));
});

export function subscribeDesktopEvents(listener: (event: DesktopEvent) => void) {
  const receive = (event: Event) => listener((event as CustomEvent<DesktopEvent>).detail);
  events.addEventListener('desktop', receive);
  return () => events.removeEventListener('desktop', receive);
}

export function subscribeRepositoryChanges(
  repoId: string,
  listener: (event: RepositoryEvent) => void,
) {
  const receive = (event: DesktopEvent) => {
    if (event.type !== 'repositoryChanged' || event.repoId !== repoId) return;
    pendingRepository = undefined;
    listener(event);
  };
  const unsubscribe = subscribeDesktopEvents(receive);
  if (pendingRepository?.repoId === repoId) receive(pendingRepository);
  return unsubscribe;
}
