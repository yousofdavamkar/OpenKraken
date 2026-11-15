import { expect, test, vi } from 'vitest';
import type { DesktopEvent } from '@openkraken/ipc-contract';

test('mounted views share one desktop subscription and unsubscribe independently', async () => {
  let emit: ((event: DesktopEvent) => void) | undefined;
  const subscribe = vi.fn((listener: (event: DesktopEvent) => void) => {
    emit = listener;
    return () => {};
  });
  vi.stubGlobal('window', { openkraken: { subscribe } });
  try {
    const { subscribeDesktopEvents } = await import('./src/desktop-events.js');
    const received = vi.fn();
    const first = subscribeDesktopEvents(received);
    const second = subscribeDesktopEvents(received);
    expect(subscribe).toHaveBeenCalledTimes(1);

    const event: DesktopEvent = { type: 'activityChanged' };
    emit!(event);
    expect(received.mock.calls).toEqual([[event], [event]]);
    first();
    first();
    emit!(event);
    expect(received).toHaveBeenCalledTimes(3);
    second();
    emit!(event);
    expect(received).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
