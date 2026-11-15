import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { hasRepeatedPackedTargets, ReferenceReader } from './src/reference-reader.js';
import { RefsParser, REF_FORMAT, REF_DIRECT_FORMAT } from './src/parsers.js';
import { GitError, locateGit, runGit } from './src/runner.js';

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

async function nativeRefs(cwd = repository) {
  const parser = new RefsParser();
  await runGit(git.path, ['for-each-ref', `--format=${REF_FORMAT}`], {
    cwd,
    onStdout: (chunk) => parser.push(chunk),
  });
  return parser.finish();
}
const paged = (args: string[]) =>
  args.some((arg) => arg.startsWith('--start-after=')) && !args.includes('--count=1');

async function withDenseRefs(run: () => Promise<void>) {
  const target = fixtureGit(repository, ['rev-parse', 'refs/tags/annotated']);
  const names = Array.from({ length: 520 }, (_, index) => `refs/tags/dense-${index}`);
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    names.map((name) => `create ${name} ${target}\n`).join(''),
  );
  fixtureGit(repository, ['pack-refs', '--all']);
  try {
    await run();
  } finally {
    fixtureGit(
      repository,
      ['update-ref', '--stdin'],
      names.map((name) => `delete ${name}\n`).join(''),
    );
  }
}

test('ordinary refs finish in one native read with every field preserved', async () => {
  const tags = ['refs/tags/annotated', 'refs/tags/blob-tag', 'refs/tags/nested/猫'];
  const targets = tags.map((name) => fixtureGit(repository, ['rev-parse', name]));
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    tags.map((name) => `delete ${name}\n`).join(''),
  );
  const calls: string[][] = [];
  try {
    const reader = new ReferenceReader((args, options) => {
      calls.push(args);
      return runGit(git.path, args, options);
    });
    const expected = await nativeRefs();
    expect(await reader.read(repository)).toEqual(expected);
    expect(calls).toEqual([['for-each-ref', `--format=${new RefsParser('direct').gitFormat}`]]);
    const legacy = new RefsParser();
    await runGit(git.path, ['for-each-ref', `--format=${REF_DIRECT_FORMAT}`], {
      cwd: repository,
      onStdout: (chunk) => legacy.push(chunk),
    });
    expect(legacy.finish()).toEqual(expected);
  } finally {
    fixtureGit(
      repository,
      ['update-ref', '--stdin'],
      tags.map((name, index) => `create ${name} ${targets[index]}\n`).join(''),
    );
    fixtureGit(repository, ['pack-refs', '--all']);
  }
});

test('a repository containing only one annotated ref retains its peeled metadata', async () => {
  const cwd = createFixture(join(root, 'single-tag'), 'linear', 2);
  const refs = await nativeRefs(cwd);
  fixtureGit(
    cwd,
    ['update-ref', '--stdin'],
    refs
      .filter((ref) => ref.name !== 'refs/tags/annotated')
      .map((ref) => `delete ${ref.name}\n`)
      .join(''),
  );
  const reader = new ReferenceReader((args, options) => runGit(git.path, args, options));
  const expected = await nativeRefs(cwd);
  expect(expected).toHaveLength(1);
  expect(expected[0]?.peeled).toBeDefined();
  expect(await reader.read(cwd)).toEqual(expected);
});

test.skipIf(!modern)(
  'large reference reads use bounded native pages with identical complete records',
  async () => {
    return withDenseRefs(async () => {
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
    });
  },
);

test('direct enumeration only reads tag bodies for actual annotated tags', async () => {
  const formats: string[] = [];
  const reader = new ReferenceReader(async (args, options) => {
    if (!args.includes('--')) formats.push(args.find((arg) => arg.startsWith('--format='))!);
    return runGit(git.path, args, options);
  });
  expect(await reader.read(repository)).toEqual(await nativeRefs());
  expect(formats).toHaveLength(2);
  for (const format of formats) {
    expect(format).not.toContain('*object');
    expect(format).not.toContain('subject');
  }
});

test('annotated tag reads use bounded batches and preserve non-commit tags', async () => {
  const target = fixtureGit(repository, ['rev-parse', 'refs/tags/blob-tag']);
  const names = Array.from({ length: 260 }, (_, index) => `refs/tags/annotated-${index}`);
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    names.map((name) => `create ${name} ${target}\n`).join(''),
  );
  const batches: string[][] = [];
  try {
    const reader = new ReferenceReader(async (args, options) => {
      if (args.includes('--')) batches.push(args.slice(args.indexOf('--') + 1));
      return runGit(git.path, args, options);
    });
    expect(await reader.read(repository)).toEqual(await nativeRefs());
    expect(batches).toHaveLength(3);
    expect(batches.flat()).toHaveLength(263);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(batch.join('\0')) + 1).toBeLessThanOrEqual(16384);
    }
  } finally {
    fixtureGit(
      repository,
      ['update-ref', '--stdin'],
      names.map((name) => `delete ${name}\n`).join(''),
    );
  }
});

test.skipIf(!modern)(
  'dense annotated tags use bounded full pages instead of repeated pattern scans',
  async () => {
    const target = fixtureGit(repository, ['rev-parse', 'refs/tags/annotated']);
    const names = Array.from({ length: 520 }, (_, index) => `refs/tags/dense-${index}`);
    fixtureGit(
      repository,
      ['update-ref', '--stdin'],
      names.map((name) => `create ${name} ${target}\n`).join(''),
    );
    fixtureGit(repository, ['pack-refs', '--all']);
    let pages = 0,
      batches = 0;
    try {
      const reader = new ReferenceReader((args, options) => {
        if (paged(args)) pages++;
        if (args.includes('--')) batches++;
        return runGit(git.path, args, options);
      });
      expect(await reader.read(repository)).toEqual(await nativeRefs());
      expect(pages).toBe(3);
      expect(batches).toBe(0);
    } finally {
      fixtureGit(
        repository,
        ['update-ref', '--stdin'],
        names.map((name) => `delete ${name}\n`).join(''),
      );
    }
  },
);

test.each(['before', 'after', 'delete'] as const)(
  'a tag changed %s its detail read returns a complete current enumeration',
  async (when) => {
    const name = 'refs/tags/nested/猫';
    const old = fixtureGit(repository, ['rev-parse', name]);
    let changed = false,
      fullReads = 0;
    const change = () => {
      changed = true;
      fixtureGit(
        repository,
        when === 'delete' ? ['update-ref', '-d', name] : ['update-ref', name, 'HEAD'],
      );
    };
    try {
      const reader = new ReferenceReader(async (args, options) => {
        if (args.includes(`--format=${REF_FORMAT}`) && !args.includes('--') && !paged(args))
          fullReads++;
        const details = args.includes('--') && !changed;
        if (details && when !== 'after') change();
        const result = await runGit(git.path, args, options);
        if (details && when === 'after') change();
        return result;
      });
      expect(await reader.read(repository)).toEqual(await nativeRefs());
      expect(changed).toBe(true);
      expect(fullReads).toBe(1);
    } finally {
      fixtureGit(repository, ['update-ref', name, old]);
      fixtureGit(repository, ['pack-refs', '--all']);
    }
  },
);

test.skipIf(!modern)(
  'mixed loose and packed refs cannot omit or duplicate page boundaries',
  async () => {
    return withDenseRefs(async () => {
      const name = 'refs/tags/a-loose-tag';
      fixtureGit(repository, ['update-ref', name, 'refs/tags/annotated']);
      const pages = new Map<string, string[]>();
      let fullReads = 0;
      try {
        const expected = await nativeRefs();
        const reader = new ReferenceReader(async (args, options) => {
          if (args.includes(`--format=${REF_FORMAT}`) && !args.includes('--') && !paged(args))
            fullReads++;
          if (!paged(args)) return runGit(git.path, args, options);
          const parser = new RefsParser();
          const result = await runGit(git.path, args, {
            ...options,
            onStdout: (chunk) => {
              parser.push(chunk);
              return options.onStdout?.(chunk);
            },
          });
          pages.set(
            args.find((arg) => arg.startsWith('--start-after='))!,
            parser.finish().map((ref) => ref.name),
          );
          return result;
        });
        expect(await reader.read(repository)).toEqual(expected);
        const nativeNames = [...pages]
          .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .flatMap(([, names]) => names);
        const complete =
          JSON.stringify(nativeNames) === JSON.stringify(expected.map((ref) => ref.name));
        expect(fullReads).toBe(complete ? 0 : 1);
      } finally {
        fixtureGit(repository, ['update-ref', '-d', name]);
        fixtureGit(repository, ['pack-refs', '--all']);
      }
    });
  },
);

test.each(['cancel', 'failure'] as const)(
  '%s during tag detail reads cannot return incomplete metadata',
  async (mode) => {
    const controller = new AbortController();
    const reader = new ReferenceReader(async (args, options) => {
      if (args.includes('--')) {
        if (mode === 'failure') throw new Error('Tag details failed');
        controller.abort();
      }
      return runGit(git.path, args, options);
    });
    if (mode === 'cancel')
      await expect(reader.read(repository, controller.signal)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
    else await expect(reader.read(repository)).rejects.toThrow('Tag details failed');
  },
);

test('older Git falls back once and retains complete native records', async () => {
  return withDenseRefs(async () => {
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
});

test('native capability detection preserves complete records across repeated reads', async () => {
  return withDenseRefs(async () => {
    const probeResults: number[] = [];
    let pages = 0;
    let fullReads = 0;
    const reader = new ReferenceReader(async (args, options) => {
      if (paged(args)) pages++;
      if (args.includes(`--format=${REF_FORMAT}`) && !paged(args) && !args.includes('--'))
        fullReads++;
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
});

for (const dense of [false, true]) {
  test
    .skipIf(dense && !modern)
    .each(['create', 'delete', 'move', 'head', 'upstream', 'tracking-tip'] as const)(
    `a concurrent %s invalidates ${dense ? 'paged' : 'selective'} reads and falls back to one complete read`,
    async (change) => {
      const check = async () => {
        const name = 'refs/tags/topic-00000';
        const old = fixtureGit(repository, ['rev-parse', name]);
        const head = fixtureGit(repository, ['symbolic-ref', 'HEAD']);
        const remote = fixtureGit(repository, ['rev-parse', 'refs/remotes/origin/main']);
        const merge = fixtureGit(repository, ['config', '--get', 'branch.main.merge']);
        let changed = false;
        let fullReads = 0;
        const reader = new ReferenceReader(async (args, options) => {
          if (args.includes(`--format=${REF_FORMAT}`) && !paged(args) && !args.includes('--'))
            fullReads++;
          const result = await runGit(git.path, args, options);
          if ((args.includes('--') || paged(args)) && !changed) {
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
              fixtureGit(repository, [
                'config',
                'branch.main.merge',
                'refs/heads/missing-upstream',
              ]);
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
      };
      return dense ? withDenseRefs(check) : check();
    },
  );
}

test.skipIf(!modern).each(['cancel', 'failure'] as const)(
  '%s drains every page before releasing the read',
  async (mode) => {
    return withDenseRefs(async () => {
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
    });
  },
);

test.skipIf(!modern)('output limits apply to all native pages together', async () => {
  return withDenseRefs(async () => {
    const direct = await runGit(
      git.path,
      ['for-each-ref', `--format=${new RefsParser('direct').gitFormat}`],
      {
        cwd: repository,
      },
    );
    const full = await runGit(git.path, ['for-each-ref', `--format=${REF_FORMAT}`], {
      cwd: repository,
    });
    const limit = Math.ceil(full.stdout.length * 1.5);
    expect(direct.stdout.length).toBeLessThan(limit);
    expect(full.stdout.length).toBeLessThan(limit);
    expect(direct.stdout.length + full.stdout.length).toBeGreaterThan(limit);
    let pages = 0;
    let active = 0;
    const reader = new ReferenceReader(
      async (args, options) => {
        if (!paged(args)) return runGit(git.path, args, options);
        pages++;
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
    expect(pages).toBe(3);
    expect(active).toBe(0);
  });
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

describe('repeated targets in a packed SHA-256 repository', () => {
  const cwd = join(root, 'grouped');
  const commonDir = join(cwd, '.git');
  const directFormat = new RefsParser('direct').gitFormat;
  let blob: string, tree: string, tagged: string, grouped: boolean;
  beforeAll(async () => {
    mkdirSync(cwd);
    fixtureGit(cwd, ['init', '-b', 'main', '--object-format=sha256']);
    fixtureGit(cwd, ['commit', '--allow-empty', '-m', 'First']);
    fixtureGit(cwd, ['branch', 'peer']);
    fixtureGit(cwd, ['branch', '--set-upstream-to=peer']);
    fixtureGit(cwd, ['commit', '--allow-empty', '-m', 'Ahead of peer']);
    fixtureGit(cwd, ['tag', '-a', 'annotated', '-m', 'Tag details', 'HEAD~1']);
    const head = fixtureGit(cwd, ['rev-parse', 'HEAD']);
    tagged = fixtureGit(cwd, ['rev-parse', 'refs/tags/annotated']);
    tree = fixtureGit(cwd, ['rev-parse', 'HEAD^{tree}']);
    blob = fixtureGit(cwd, ['hash-object', '-w', '--stdin'], 'grouped fixture');
    fixtureGit(
      cwd,
      ['update-ref', '--stdin'],
      [
        ...Array.from({ length: 7000 }, (_, i) => `create refs/heads/grouped-${i} ${head}`),
        `create refs/tags/猫-tree ${tree}`,
        `create refs/tags/blob ${blob}`,
      ].join('\n') + '\n',
    );
    fixtureGit(cwd, ['pack-refs', '--all']);
    grouped = await hasRepeatedPackedTargets(commonDir);
    expect(grouped).toBe(true);
  });

  test('resolves each object once and preserves native order, upstream, and peeled metadata', async () => {
    const expected = await nativeRefs(cwd);
    let queries = 0;
    const reader = new ReferenceReader((args, options) => {
      if (args.includes('cat-file')) {
        queries++;
        const ids = String(options.stdin).trimEnd().split('\n');
        expect(ids).toEqual([...new Set(expected.map((ref) => ref.target))]);
      }
      return runGit(git.path, args, options);
    });
    expect(await reader.read(cwd, undefined, grouped)).toEqual(expected);
    expect(queries).toBe(1);
  });

  test('reads per-worktree HEAD and upstream through the shared packed store', async () => {
    const linked = join(root, 'linked-grouped');
    fixtureGit(cwd, ['worktree', 'add', '-b', 'linked', linked, 'peer']);
    const expected = await nativeRefs(linked);
    expect(expected.find((ref) => ref.isHead)?.name).toBe('refs/heads/linked');
    const reader = new ReferenceReader((args, options) => runGit(git.path, args, options));
    expect(await reader.read(linked, undefined, grouped)).toEqual(expected);
  });

  test('rechecks annotated refs which move during the type lookup', async () => {
    let moved = false;
    const reader = new ReferenceReader((args, options) => {
      if (args.includes('cat-file')) {
        fixtureGit(cwd, ['update-ref', 'refs/tags/annotated', blob]);
        moved = true;
      }
      return runGit(git.path, args, options);
    });
    try {
      const refs = await reader.read(cwd, undefined, grouped);
      expect(moved).toBe(true);
      expect(refs).toEqual(await nativeRefs(cwd));
    } finally {
      fixtureGit(cwd, ['update-ref', 'refs/tags/annotated', tagged]);
    }
  });

  test('uses the authoritative direct read for replacement refs and incomplete batch replies', async () => {
    const calls: string[][] = [];
    const reader = new ReferenceReader((args, options) => {
      calls.push(args);
      if (args.includes('cat-file'))
        return Promise.resolve({
          stdout: Buffer.from(blob + ' missing\n'),
          stderr: '',
          exitCode: 0,
        });
      return runGit(git.path, args, options);
    });
    expect(await reader.read(cwd, undefined, grouped)).toEqual(await nativeRefs(cwd));
    expect(calls.some((args) => args.includes('cat-file'))).toBe(true);
    expect(calls.some((args) => args.includes('--format=' + directFormat))).toBe(true);
    calls.length = 0;
    fixtureGit(cwd, ['replace', '-f', blob, tree]);
    try {
      expect(await reader.read(cwd, undefined, grouped)).toEqual(await nativeRefs(cwd));
      expect(calls.some((args) => args.includes('cat-file'))).toBe(false);
      expect(calls.some((args) => args.includes('--format=' + directFormat))).toBe(true);
    } finally {
      fixtureGit(cwd, ['replace', '-d', blob]);
    }
  });

  test('retries the native direct query when the batch process fails', async () => {
    let attempted = false;
    const reader = new ReferenceReader((args, options) => {
      if (args.includes('cat-file')) {
        attempted = true;
        return Promise.reject(new GitError('GIT_FAILED', 'Cannot resolve the current object'));
      }
      return runGit(git.path, args, options);
    });
    expect(await reader.read(cwd, undefined, grouped)).toEqual(await nativeRefs(cwd));
    expect(attempted).toBe(true);
  });

  test('charges reconstructed type bytes and releases a cancelled lookup', async () => {
    const full = await runGit(git.path, ['for-each-ref', '--format=' + directFormat], { cwd });
    const calls: string[][] = [];
    const limit = new ReferenceReader(
      (args, options) => {
        calls.push(args);
        return runGit(git.path, args, options);
      },
      { maxBytes: full.stdout.length - 1 },
    );
    await expect(limit.read(cwd, undefined, grouped)).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('cat-file');
    const stop = new AbortController();
    const reader = new ReferenceReader((args, options) => {
      if (args.includes('cat-file')) stop.abort();
      return runGit(git.path, args, options);
    });
    await expect(reader.read(cwd, stop.signal, grouped)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(await reader.read(cwd, undefined, grouped)).toEqual(await nativeRefs(cwd));
  });
});
