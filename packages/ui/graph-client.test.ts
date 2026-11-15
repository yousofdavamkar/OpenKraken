import { expect, test, vi } from 'vitest';
import type { WorkerResponse } from '@openkraken/graph/layout-message';
import { GraphClient } from './src/graph-client.js';

const worker = vi.hoisted(() => ({
  onmessage: undefined as ((event: { data: WorkerResponse }) => void) | undefined,
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

test('a layout timeout rejects concurrent requests and closes that worker once', async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const client = new GraphClient();
  try {
    const append = client.request({ method: 'append', generation: 'a', offset: 3, commits: [] });
    await vi.advanceTimersByTimeAsync(1000);
    const query = client.request({ method: 'search', generation: 'a', query: 'commit' });
    await Promise.all([
      expect(append).rejects.toThrow('Graph worker timed out'),
      expect(query).rejects.toThrow('Graph worker timed out'),
      vi.advanceTimersByTimeAsync(29000),
    ]);
    expect(client.failed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.request({ method: 'search', generation: 'a', query: '' })).rejects.toThrow(
      'Graph worker timed out',
    );
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    client.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

test('a late search reply leaves the worker available for the next query', async () => {
  vi.useFakeTimers();
  const client = new GraphClient();
  try {
    const request = { method: 'search', generation: 'a', query: 'summary' } as const;
    await Promise.all([
      expect(client.request(request)).rejects.toThrow('Graph worker timed out'),
      vi.advanceTimersByTimeAsync(30000),
    ]);
    expect(client.failed).toBe(false);
    const next = client.request(request);
    const result: WorkerResponse = { kind: 'matches', generation: 'a', oids: ['new'], id: 2 };
    worker.onmessage!({ data: { kind: 'matches', generation: 'a', oids: ['old'], id: 1 } });
    worker.onmessage!({ data: result });
    await expect(next).resolves.toEqual(result);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});
