import { expect, test, vi } from 'vitest';
import { GraphClient } from './src/graph-client.js';

const worker = vi.hoisted(() => ({
  onerror: undefined as ((error: { message: string }) => void) | undefined,
  postMessage: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('@openkraken/graph/worker?worker', () => ({
  default: class {
    constructor() {
      return worker;
    }
  },
}));

test('a worker that fails to start reports its error on the first layout request', async () => {
  vi.useFakeTimers();
  const client = new GraphClient();
  try {
    worker.onerror!({ message: 'Worker startup failed' });
    const result = client.request({ method: 'reset', generation: 'first', offset: 0, commits: [] });
    const rejected = expect(result).rejects.toThrow('Worker startup failed');
    await Promise.all([rejected, vi.runAllTimersAsync()]);
    expect(worker.postMessage).not.toHaveBeenCalled();
  } finally {
    client.close();
    vi.useRealTimers();
  }
});
