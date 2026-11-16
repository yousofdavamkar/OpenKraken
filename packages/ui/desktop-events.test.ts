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

test('watcher startup coalesces domains for the current repository until its view subscribes', async () => {
  vi.resetModules();
  let emit!: (event: DesktopEvent) => void;
  vi.stubGlobal('window', {
    openkraken: {
      subscribe: (listener: typeof emit) => {
        emit = listener;
      },
    },
  });
  try {
    const { subscribeRepositoryChanges } = await import('./src/desktop-events.js');
    const receive = vi.fn();
    const old = subscribeRepositoryChanges('old', receive);
    emit({ type: 'repositoryChanged', repoId: 'new', mode: 'native', domains: ['refs'] });
    emit({
      type: 'repositoryChanged',
      repoId: 'new',
      mode: 'polling',
      domains: ['refs', 'status'],
    });
    emit({ type: 'activityChanged' });
    expect(receive).not.toHaveBeenCalled();
    old();
    const current = subscribeRepositoryChanges('new', receive);
    expect(receive.mock.calls).toEqual([
      [{ type: 'repositoryChanged', repoId: 'new', mode: 'polling', domains: ['refs', 'status'] }],
    ]);
    emit({ type: 'repositoryChanged', repoId: 'new', mode: 'native', domains: [] });
    expect(receive).toHaveBeenCalledTimes(2);
    current();
    const again = subscribeRepositoryChanges('new', receive);
    expect(receive).toHaveBeenCalledTimes(2);
    again();
  } finally {
    vi.unstubAllGlobals();
  }
});
