import type { DesktopEvent } from '@openkraken/ipc-contract';
import { afterEach, expect, test, vi } from 'vitest';

async function openObserver() {
  vi.useFakeTimers();
  vi.resetModules();
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', document);
  let emit!: (event: DesktopEvent) => void;
  const request = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const subscribe = (listener: typeof emit) => {
    emit = listener;
  };
  vi.stubGlobal('window', { openkraken: { request, cancel, subscribe } });
  const { observeSubmodules } = await import('./src/submodule-observer.js');
  const publish = vi.fn();
  const report = vi.fn();
  const stop = observeSubmodules('parent', publish, report);
  const changed = (repoId = 'parent') =>
    emit({ type: 'repositoryChanged', repoId, mode: 'native', domains: ['status'] });
  const hide = (hidden: boolean) => {
    document.hidden = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return { request, cancel, publish, report, stop, changed, hide };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('coalesces watcher changes during a read and cancels the trailing read on close', async () => {
  const { request, cancel, publish, report, stop, changed } = await openObserver();
  let finishRead!: (value: unknown) => void;
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  changed('other');
  await vi.advanceTimersByTimeAsync(1000);
  expect(request).not.toHaveBeenCalled();
  changed();
  changed();
  await vi.advanceTimersByTimeAsync(250);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    id: expect.any(String),
    method: 'submodules',
    repoId: 'parent',
  });
  changed();
  changed();
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(1);
  finishRead({ kind: 'submodules', state: { revision: 'first' } });
  await vi.advanceTimersByTimeAsync(250);
  expect(publish).toHaveBeenCalledExactlyOnceWith({ revision: 'first' });
  expect(request).toHaveBeenCalledTimes(2);
  stop();
  expect(cancel).toHaveBeenCalledExactlyOnceWith(request.mock.calls[1]![0].id);
  finishRead({ kind: 'submodules', state: { revision: 'late' } });
  changed();
  await vi.advanceTimersByTimeAsync(10000);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledExactlyOnceWith('');
  expect(request).toHaveBeenCalledTimes(2);
});

test('suspends checks while hidden and recovers after a failed visible read', async () => {
  const { request, publish, report, stop, hide, changed } = await openObserver();
  request.mockResolvedValueOnce({ kind: 'error', message: 'Index busy' });
  request.mockResolvedValueOnce({ kind: 'submodules', state: { revision: 'recovered' } });
  hide(true);
  changed();
  await vi.advanceTimersByTimeAsync(12000);
  expect(request).not.toHaveBeenCalled();
  hide(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(report).toHaveBeenCalledExactlyOnceWith('Index busy');
  await vi.advanceTimersByTimeAsync(5000);
  expect(publish).toHaveBeenCalledExactlyOnceWith({ revision: 'recovered' });
  expect(report).toHaveBeenLastCalledWith('');
  stop();
});
