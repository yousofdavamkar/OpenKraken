import { afterEach, expect, test, vi } from 'vitest';
import { watchAppImageStartup } from './src/appimage-startup.js';

afterEach(() => vi.useRealTimers());

test('a waiting replacement can finish while its slow-start dialog is open', async () => {
  vi.useFakeTimers();
  let answer!: (value: boolean) => void;
  const choice = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const ask = vi.fn((_signal: AbortSignal) => choice);
  const quit = vi.fn();
  const pending = vi.fn(async () => true);
  const done = watchAppImageStartup(pending, ask, quit);
  await vi.advanceTimersByTimeAsync(59999);
  expect(pending).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(ask).toHaveBeenCalledOnce();
  const [signal] = ask.mock.calls[0]!;
  done();
  expect(signal.aborted).toBe(true);
  answer(true);
  await vi.advanceTimersByTimeAsync(120000);
  expect(quit).not.toHaveBeenCalled();
  expect(ask).toHaveBeenCalledOnce();
});

test('keep waiting rearms the prompt and only an explicit close exits the replacement', async () => {
  vi.useFakeTimers();
  const ask = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const quit = vi.fn();
  const done = watchAppImageStartup(async () => true, ask, quit);
  await vi.advanceTimersByTimeAsync(60000);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60000);
  expect(quit).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(ask).toHaveBeenCalledTimes(2);
  done();
});

test('finished startup and an absent transaction leave the desktop alone', async () => {
  vi.useFakeTimers();
  const ask = vi.fn();
  const pending = vi.fn(async () => false);
  const quit = vi.fn();
  watchAppImageStartup(pending, ask, quit)();
  await vi.advanceTimersByTimeAsync(60000);
  expect(pending).not.toHaveBeenCalled();
  watchAppImageStartup(pending, ask, quit);
  await vi.advanceTimersByTimeAsync(180000);
  expect(pending).toHaveBeenCalledOnce();
  expect(ask).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});

test('a transaction that disappears while the prompt is open prevents closing', async () => {
  vi.useFakeTimers();
  const pending = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const close = vi.fn();
  watchAppImageStartup(pending, async () => true, close);
  await vi.advanceTimersByTimeAsync(60000);
  expect(pending).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
});
