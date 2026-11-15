import type { DesktopEvent } from '@openkraken/ipc-contract';

// Keep one validated bridge delivery per event for the lifetime of the renderer.
const events = new EventTarget();
window.openkraken.subscribe((detail) => {
  events.dispatchEvent(new CustomEvent('desktop', { detail }));
});

export function subscribeDesktopEvents(listener: (event: DesktopEvent) => void) {
  const receive = (event: Event) => listener((event as CustomEvent<DesktopEvent>).detail);
  events.addEventListener('desktop', receive);
  return () => events.removeEventListener('desktop', receive);
}
