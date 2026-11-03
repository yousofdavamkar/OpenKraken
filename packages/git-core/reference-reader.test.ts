import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { ReferenceReader } from './src/reference-reader.js';
import { RefsParser, REF_FORMAT } from './src/parsers.js';
import { locateGit, runGit } from './src/runner.js';

const root = mkdtempSync(join(tmpdir(), 'openkraken-ref-reader-'));
const git = await locateGit();
const version = git.version.split('.').map(Number);
const modern = version[0]! > 2 || (version[0] === 2 && version[1]! >= 51);
let repository: string;
beforeAll(() => {
  repository = createFixture(join(root, 'repo'), 'linear', 32);
  const commits = fixtureGit(repository, ['rev-list', '--max-count=32', 'HEAD']).split('\n');
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    Array.from(
      { length: 10000 },
      (_, index) =>
        `create refs/tags/topic-${String(index).padStart(5, '0')} ${commits[index % commits.length]}`,
    ).join('\n') + '\n',
  );
  fixtureGit(repository, ['tag', '-a', 'nested/猫', '-m', 'Unicode é subject', 'HEAD']);
  const blob = fixtureGit(repository, ['hash-object', '-w', '--stdin'], 'blob contents');
  fixtureGit(repository, ['tag', '-a', 'blob-tag', '-m', 'A non-commit tag', blob]);
  fixtureGit(repository, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  fixtureGit(repository, ['pack-refs', '--all']);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function nativeRefs() {
  const parser = new RefsParser();
  await runGit(git.path, ['for-each-ref', `--format=${REF_FORMAT}`], {
    cwd: repository,
    onStdout: (chunk) => parser.push(chunk),
  });
  return parser.finish();
}
const paged = (args: string[]) =>
  args.some((arg) => arg.startsWith('--start-after=')) && !args.includes('--count=1');

test.skipIf(!modern)(
  'large reference reads use bounded native pages with identical complete records',
  async () => {
    let active = 0;
    let peak = 0;
    let pages = 0;
    const reader = new ReferenceReader(async (args, options) => {
      if (!paged(args)) return runGit(git.path, args, options);
      pages++;
      peak = Math.max(peak, ++active);
      try {
        return await runGit(git.path, args, options);
      } finally {
        active--;
      }
    });
    expect(await reader.read(repository)).toEqual(await nativeRefs());
    expect(pages).toBe(3);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  },
);

test('older Git falls back once and retains complete native records', async () => {
  let probes = 0;
  let pages = 0;
  const reader = new ReferenceReader(async (args, options) => {
    if (args.includes('--start-after=') && args.includes('--count=1')) {
      probes++;
      return { stdout: Buffer.alloc(0), stderr: 'unknown option: start-after', exitCode: 129 };
    }
    if (paged(args)) pages++;
    return runGit(git.path, args, options);
  });
  const expected = await nativeRefs();
  expect(await reader.read(repository)).toEqual(expected);
  expect(await reader.read(repository)).toEqual(expected);
  expect(probes).toBe(1);
  expect(pages).toBe(0);
});

test('native capability detection preserves complete records across repeated reads', async () => {
  const probeResults: number[] = [];
  let pages = 0;
  let fullReads = 0;
  const reader = new ReferenceReader(async (args, options) => {
    if (paged(args)) pages++;
    if (args.includes(`--format=${REF_FORMAT}`) && !paged(args)) fullReads++;
    const result = await runGit(git.path, args, options);
    if (args.includes('--start-after=') && args.includes('--count=1'))
      probeResults.push(result.exitCode);
    return result;
  });
  const expected = await nativeRefs();
  expect(await reader.read(repository)).toEqual(expected);
  expect(await reader.read(repository)).toEqual(expected);
  expect(probeResults).toEqual([modern ? 0 : 129]);
  expect(pages).toBe(modern ? 6 : 0);
  expect(fullReads).toBe(modern ? 0 : 2);
});

test
  .skipIf(!modern)
  .each(['create', 'delete', 'move', 'head', 'upstream', 'tracking-tip'] as const)(
  'a concurrent %s invalidates native pages and falls back to one complete read',
  async (change) => {
    const name = 'refs/tags/topic-00000';
    const old = fixtureGit(repository, ['rev-parse', name]);
    const head = fixtureGit(repository, ['symbolic-ref', 'HEAD']);
    const remote = fixtureGit(repository, ['rev-parse', 'refs/remotes/origin/main']);
    const merge = fixtureGit(repository, ['config', '--get', 'branch.main.merge']);
    let changed = false;
    let fullReads = 0;
    const reader = new ReferenceReader(async (args, options) => {
      if (args.includes(`--format=${REF_FORMAT}`) && !paged(args)) fullReads++;
      const result = await runGit(git.path, args, options);
      if (paged(args) && !changed) {
        changed = true;
        if (change === 'create')
          fixtureGit(repository, ['update-ref', 'refs/tags/concurrent', 'HEAD']);
        if (change === 'delete') fixtureGit(repository, ['update-ref', '-d', name]);
        if (change === 'move') fixtureGit(repository, ['update-ref', name, 'HEAD~2']);
        if (change === 'tracking-tip')
          fixtureGit(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD~3']);
        if (change === 'head')
          fixtureGit(repository, ['symbolic-ref', 'HEAD', 'refs/heads/feature']);
        if (change === 'upstream')
          fixtureGit(repository, ['config', 'branch.main.merge', 'refs/heads/missing-upstream']);
      }
      return result;
    });
    try {
      expect(await reader.read(repository)).toEqual(await nativeRefs());
      expect(changed).toBe(true);
      expect(fullReads).toBe(1);
    } finally {
      fixtureGit(repository, ['update-ref', '-d', 'refs/tags/concurrent']);
      fixtureGit(repository, ['update-ref', name, old]);
      fixtureGit(repository, ['update-ref', 'refs/remotes/origin/main', remote]);
      fixtureGit(repository, ['symbolic-ref', 'HEAD', head]);
      fixtureGit(repository, ['config', 'branch.main.merge', merge]);
    }
  },
);

test.skipIf(!modern).each(['cancel', 'failure'] as const)(
  '%s drains every page before releasing the read',
  async (mode) => {
    const controller = new AbortController();
    let active = 0;
    let pages = 0;
    const reader = new ReferenceReader(async (args, options) => {
      if (!paged(args)) return runGit(git.path, args, options);
      pages++;
      active++;
      try {
        if (pages === 3 && mode === 'cancel') controller.abort();
        if (pages === 2 && mode === 'failure') throw new Error('Simulated native read failure');
        return await runGit(git.path, args, options);
      } finally {
        active--;
      }
    });
    if (mode === 'cancel')
      await expect(reader.read(repository, controller.signal)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
    else await expect(reader.read(repository)).rejects.toThrow('Simulated native read failure');
    expect(pages).toBe(3);
    expect(active).toBe(0);
  },
);

test.skipIf(!modern)('output limits apply to all native pages together', async () => {
  let metadataBytes = 0;
  await new ReferenceReader(async (args, options) => {
    const result = await runGit(git.path, args, options);
    if (!options.onStdout) metadataBytes = Math.max(metadataBytes, result.stdout.length);
    return result;
  }).read(repository);
  const full = await runGit(git.path, ['for-each-ref', `--format=${REF_FORMAT}`], {
    cwd: repository,
  });
  expect(metadataBytes).toBeLessThan(full.stdout.length);
  const limit = Math.ceil((metadataBytes + full.stdout.length) / 2);
  let active = 0;
  const reader = new ReferenceReader(
    async (args, options) => {
      if (!paged(args)) return runGit(git.path, args, options);
      active++;
      try {
        return await runGit(git.path, args, options);
      } finally {
        active--;
      }
    },
    { maxBytes: limit },
  );
  await expect(reader.read(repository)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  expect(active).toBe(0);
});

test.skipIf(process.platform === 'win32')(
  'non-UTF-8 reference names retain single-read behavior',
  async () => {
    const name = Buffer.concat([Buffer.from('refs/tags/non-utf8-'), Buffer.from([0xff])]);
    await runGit(git.path, ['update-ref', '--stdin'], {
      cwd: repository,
      readOnly: false,
      stdin: Buffer.concat([
        Buffer.from('create '),
        name,
        Buffer.from(` ${fixtureGit(repository, ['rev-parse', 'HEAD'])}\n`),
      ]),
    });
    let pages = 0;
    const reader = new ReferenceReader((args, options) => {
      if (paged(args)) pages++;
      return runGit(git.path, args, options);
    });
    try {
      expect(await reader.read(repository)).toEqual(await nativeRefs());
      expect(pages).toBe(0);
    } finally {
      await runGit(git.path, ['update-ref', '--stdin'], {
        cwd: repository,
        readOnly: false,
        stdin: Buffer.concat([Buffer.from('delete '), name, Buffer.from('\n')]),
      });
    }
  },
);
