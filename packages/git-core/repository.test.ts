import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit, fixtureKinds } from '../test-fixtures/src/index.js';
import { RepositoryService, locateGit, runProcess, RepositoryQueue } from './src/index.js';
const root = mkdtempSync(join(tmpdir(), 'openkraken-core-'));
let service: RepositoryService;
beforeAll(async () => {
  service = new RepositoryService((await locateGit()).path);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const kind of fixtureKinds)
  test(`reads ${kind} repository using real Git`, async () => {
    const path = createFixture(join(root, kind), kind);
    writeFileSync(join(path, 'tracked.txt'), 'modified\n');
    writeFileSync(join(path, 'space ü.txt'), 'new');
    const repo = await service.open(path);
    const snapshot = await service.snapshot(repo.id);
    expect(repo.head).toMatchObject({
      kind: 'branch',
      ref: 'refs/heads/main',
      oid: fixtureGit(path, ['rev-parse', 'HEAD']),
    });
    expect(snapshot.status.entries.map((e) => e.path).sort()).toEqual([
      'space ü.txt',
      'tracked.txt',
    ]);
    expect(snapshot.refs.find((r) => r.isHead)?.upstream?.ahead).toBeGreaterThan(0);
    expect(snapshot.refs.find((r) => r.name === 'refs/tags/annotated')?.peeled).toBe(repo.head.oid);
    expect(snapshot.commits.length).toBeGreaterThan(2);
    if (kind === 'stash') {
      expect(snapshot.commits.filter((c) => c.isStash)).toHaveLength(1);
      expect(snapshot.commits.find((c) => c.isStash)?.parents).toHaveLength(1);
    }
    const positions = new Map(snapshot.commits.map((c, i) => [c.oid, i]));
    snapshot.commits.forEach((c, i) =>
      c.parents.forEach((p) => {
        if (positions.has(p)) expect(positions.get(p)).toBeGreaterThan(i);
      }),
    );
  });
test('unborn, init, detached, bare, linked worktree and discovery', async () => {
  const unborn = join(root, 'unborn');
  mkdirSync(unborn);
  const repo = await service.init(unborn, 'trunk');
  expect(repo.head).toEqual({ kind: 'branch', ref: 'refs/heads/trunk' });
  expect((await service.snapshot(repo.id)).commits).toEqual([]);
  await expect(service.init(unborn)).rejects.toThrow('already');
  const path = createFixture(join(root, 'variants'));
  fixtureGit(path, ['checkout', '--detach']);
  expect((await service.open(path)).head.kind).toBe('detached');
  const bare = join(root, 'bare.git');
  fixtureGit(root, ['clone', '--bare', path, bare]);
  const bareRepo = await service.open(bare);
  expect(bareRepo.isBare).toBe(true);
  expect((await service.snapshot(bareRepo.id)).status.entries).toEqual([]);
  const worktree = join(root, 'linked');
  fixtureGit(path, ['worktree', 'add', '-b', 'linked', worktree]);
  const linked = await service.open(worktree);
  expect(linked.gitDir).not.toBe(linked.commonDir);
  const ignored = createFixture(join(root, 'node_modules', 'hidden'));
  const found = await service.discover(root);
  expect(found).toContain(worktree);
  expect(found).not.toContain(ignored);
});
test('first 2000 and hasMore from a 2200 commit fixture', async () => {
  const path = createFixture(join(root, 'large'), 'linear', 2200);
  const repo = await service.open(path);
  const snapshot = await service.snapshot(repo.id);
  expect(snapshot.commits).toHaveLength(2000);
  expect(snapshot.hasMore).toBe(true);
  console.log(`Git snapshot: ${snapshot.elapsedMs.toFixed(1)} ms, 2000 commits`);
});
test('bounded execution, parser failure, timeout and abort', async () => {
  await expect(
    runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
      maxBytes: 10,
    }),
  ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  await expect(
    runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }),
  ).rejects.toMatchObject({ code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(
    runProcess(process.execPath, ['-e', 'console.log("bad")'], {
      onStdout: () => {
        throw new Error('parser failure');
      },
    }),
  ).rejects.toThrow('parser failure');
  await expect(runProcess('openkraken-missing-executable', [])).rejects.toThrow();
});
test('read concurrency, writer fairness and queued cancellation', async () => {
  const q = new RepositoryQueue(2);
  const events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = q.run(false, async () => {
    events.push('read1');
    await held;
  });
  const writer = q.run(true, async () => {
    events.push('write');
  });
  const after = q.run(false, async () => {
    events.push('read2');
  });
  const controller = new AbortController();
  const cancelled = q.run(
    true,
    async () => {
      events.push('cancelled');
    },
    controller.signal,
  );
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
  release();
  await Promise.all([first, writer, after]);
  expect(events).toEqual(['read1', 'write', 'read2']);
});

test('stash base remains visible after its branch is removed', async () => {
  const path = createFixture(join(root, 'detached-stash'), 'stash');
  const base = fixtureGit(path, ['rev-parse', 'refs/stash^1']);
  fixtureGit(path, ['reset', '--hard', 'HEAD~1']);
  fixtureGit(path, ['tag', '-d', 'annotated', 'v0.1.0']);
  const snapshot = await service.snapshot((await service.open(path)).id);
  expect(snapshot.commits.some((c) => c.oid === base)).toBe(true);
  const secondary = fixtureGit(path, ['rev-parse', 'refs/stash^2']);
  expect(snapshot.commits.some((c) => c.oid === secondary)).toBe(false);
});

test('abort terminates a spawned descendant, not just the parent', async () => {
  const controller = new AbortController();
  let childPid = 0;
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`;
  const pending = runProcess(process.execPath, ['-e', script], {
    signal: controller.signal,
    onStdout: (b) => {
      childPid = Number(b.toString().trim());
      controller.abort();
    },
  });
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(childPid).toBeGreaterThan(0);
  // Process-group death can precede reaping; use Node's kill probe on non-Linux platforms.
  if (process.platform === 'linux') {
    const { readFile } = await import('node:fs/promises');
    await expect
      .poll(async () => {
        try {
          return /\) Z /.test(await readFile(`/proc/${childPid}/stat`, 'utf8'));
        } catch {
          return true;
        }
      })
      .toBe(true);
  } else
    await expect
      .poll(() => {
        try {
          process.kill(childPid, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
});

test('shallow, sparse, submodule and SHA-256 repositories', async () => {
  const source = createFixture(join(root, 'source-variants'));
  const shallow = join(root, 'shallow');
  const { pathToFileURL } = await import('node:url');
  fixtureGit(root, ['clone', '--depth=2', pathToFileURL(source).href, shallow]);
  const shallowRepo = await service.open(shallow);
  expect(shallowRepo.isShallow).toBe(true);
  expect((await service.snapshot(shallowRepo.id)).commits).toHaveLength(2);
  fixtureGit(source, ['sparse-checkout', 'init', '--cone']);
  expect((await service.open(source)).isSparse).toBe(true);
  const parent = createFixture(join(root, 'submodule-parent'));
  fixtureGit(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child']);
  const submodule = await service.open(join(parent, 'child'));
  expect(submodule.gitDir).toContain('modules');
  const sha = join(root, 'sha256');
  mkdirSync(sha);
  fixtureGit(sha, ['init', '-b', 'main', '--object-format=sha256']);
  fixtureGit(sha, ['commit', '--allow-empty', '-m', 'SHA-256 commit']);
  const shaRepo = await service.open(sha);
  expect(shaRepo.head.oid).toHaveLength(64);
  expect((await service.snapshot(shaRepo.id)).commits[0]?.oid).toHaveLength(64);
});
