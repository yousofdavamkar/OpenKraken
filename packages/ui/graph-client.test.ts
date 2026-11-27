import { expect, test, vi } from 'vitest';
import type { WorkerResponse } from '@openkraken/graph/layout-message';
import { GraphClient } from './src/graph-client.js';

const worker = vi.hoisted(() => ({
  onmessage: undefined as ((event: { data: WorkerResponse }) => void) | undefined,
  onmessageerror: undefined as (() => void) | undefined,
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

test('a request that could not be sent leaves the current worker and other requests usable', async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const client = new GraphClient();
  try {
    const query = client.request({ method: 'search', generation: 'a', query: 'commit' });
    worker.postMessage.mockImplementationOnce(() => {
      throw new DOMException('Could not clone the refresh', 'DataCloneError');
    });
    await expect(
      client.request({
        method: 'refresh',
        generation: 'b',
        baseGeneration: 'a',
        offset: 0,
        commits: [],
      }),
    ).rejects.toThrow('Could not clone the refresh');
    const result: WorkerResponse = { kind: 'matches', generation: 'a', oids: [], id: 1 };
    worker.onmessage!({ data: result });
    await expect(query).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(30001);
    expect(client.failed).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

test('an unreadable worker message rejects pending requests immediately', async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const client = new GraphClient();
  try {
    const layout = client.request({ method: 'append', generation: 'a', offset: 5, commits: [] });
    const query = client.request({ method: 'search', generation: 'a', query: 'commit' });
    const settled = Promise.allSettled([layout, query]);
    worker.onmessageerror?.();
    expect(client.failed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    for (const result of await settled)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: new Error('Graph worker reply could not be read'),
      });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

test('an incomplete layout reply retires the worker and settles the layout and concurrent search', async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const client = new GraphClient();
  try {
    const layout = client.request({ method: 'append', generation: 'a', offset: 1, commits: [] });
    const query = client.request({ method: 'search', generation: 'a', query: 'needle' });
    const settled = Promise.allSettled([layout, query]);
    worker.onmessage!({
      data: {
        kind: 'packed-layout',
        id: 1,
        generation: 'a',
        offset: 1,
        ids: ['tip'],
        nodes: new Uint32Array([0, 0, 0]),
        edges: new Uint32Array(),
        passages: [],
        maxColumns: 1,
        reusedTail: 0,
        checkpointRows: [],
      },
    });
    expect(client.failed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    for (const result of await settled)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: new Error('Incomplete graph layout'),
      });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

const documents = ['first', 'second', 'third'].map((oid) => ({
  oid,
  parents: [],
  summary: oid,
  body: '',
  author: { name: '', email: '' },
}));

function pageReply(offset: number, ids: string[], reusedTail = 0) {
  return {
    kind: 'packed-layout' as const,
    id: 1,
    generation: 'g',
    offset,
    ids,
    nodes: Uint32Array.from(ids.flatMap((_, index) => [index, 0, 0, 0])),
    edges: new Uint32Array(),
    passages: [],
    maxColumns: 1,
    reusedTail,
    checkpointRows: [],
  };
}

test.each([
  ['a missing whole row', pageReply(6, ['first', 'second'])],
  ['a shifted page', pageReply(5, ['first', 'second', 'third'])],
  ['reordered commits', pageReply(6, ['first', 'third', 'second'])],
  ['a different generation', { ...pageReply(6, ['first', 'second', 'third']), generation: 'old' }],
  ['claimed append reuse', pageReply(6, ['first', 'second'], 1)],
] as const)('retires the worker when an append contains %s', async (_problem, reply) => {
  const client = new GraphClient();
  try {
    const result = client.request({
      method: 'append',
      generation: 'g',
      offset: 6,
      commits: documents,
    });
    worker.onmessage!({ data: reply });
    await expect(result).rejects.toThrow('Incomplete graph layout');
    expect(client.failed).toBe(true);
  } finally {
    client.close();
  }
});

test.each([
  [pageReply(1, ['second'], 1), true],
  [pageReply(3, []), true],
  [pageReply(1, ['second']), false],
  [pageReply(-1, [], 4), false],
  [pageReply(1.5, [], 1.5), false],
  [pageReply(1, ['first'], 1), false],
] as const)('checks the changed and reused ranges on refresh %#', async (reply, valid) => {
  const client = new GraphClient();
  try {
    const result = client.request({
      method: 'refresh',
      generation: 'g',
      baseGeneration: 'old',
      offset: 0,
      commits: documents,
    });
    worker.onmessage!({ data: reply });
    if (valid)
      await expect(result).resolves.toMatchObject({ kind: 'layout', offset: reply.offset });
    else await expect(result).rejects.toThrow('Incomplete graph layout');
  } finally {
    client.close();
  }
});

test('layout requests send the fields used by graph allocation and search', async () => {
  const client = new GraphClient();
  const author = { name: 'Jess', email: 'jess@example.test' };
  const document = {
    oid: 'stash',
    parents: ['head', 'index'],
    isStash: true,
    summary: 'saved changes',
    body: 'unfinished work',
    author,
  };
  const displayCommit = {
    ...document,
    kind: 'commit' as const,
    author: { ...author, timestamp: 42 },
    committer: { ...author, timestamp: 50 },
  };
  const response = client.request({
    method: 'reset',
    generation: 'g',
    offset: 0,
    commits: [displayCommit],
  });
  const settled = Promise.allSettled([response]);
  try {
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      id: 1,
      method: 'reset',
      generation: 'g',
      offset: 0,
      commits: [document],
    });
  } finally {
    client.close();
    await settled;
  }
});

test('a search document update must acknowledge the row sent to the worker', async () => {
  const client = new GraphClient();
  try {
    const document = {
      oid: 'wip:repo',
      summary: 'Dirty',
      body: 'new.txt',
      author: { name: 'Working tree', email: '' },
    };
    const request = { method: 'updateSearchDocument' as const, generation: 'active', document };
    const accepted = client.request(request);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ ...request, id: 1 });
    worker.onmessage!({
      data: { id: 1, generation: 'active', kind: 'documentUpdated', oid: document.oid },
    });
    await expect(accepted).resolves.toMatchObject({ oid: document.oid });
    const rejected = client.request(request);
    worker.onmessage!({
      data: { id: 2, generation: 'active', kind: 'documentUpdated', oid: 'different' },
    });
    await expect(rejected).rejects.toThrow('Incomplete graph layout');
    expect(client.failed).toBe(true);
  } finally {
    client.close();
  }
});
