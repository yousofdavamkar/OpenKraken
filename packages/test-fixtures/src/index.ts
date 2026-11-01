import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
export type FixtureKind = 'linear' | 'merge' | 'octopus' | 'criss-cross' | 'orphan' | 'stash';
export const fixtureKinds: FixtureKind[] = [
  'linear',
  'merge',
  'octopus',
  'criss-cross',
  'orphan',
  'stash',
];
export function fixtureGit(path: string, args: string[], input?: string) {
  const result = spawnSync('git', args, {
    cwd: path,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'author@example.test',
      GIT_COMMITTER_NAME: 'Fixture Author',
      GIT_COMMITTER_EMAIL: 'author@example.test',
      GIT_AUTHOR_DATE: '1700000300 +0000',
      GIT_COMMITTER_DATE: '1700000300 +0000',
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Fixture git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
export function createFixture(directory: string, kind: FixtureKind = 'linear', count = 8): string {
  const path = resolve(directory);
  mkdirSync(path, { recursive: true });
  fixtureGit(path, ['init', '-b', 'main']);
  fixtureGit(path, ['config', 'core.autocrlf', 'false']);
  const parents: number[][] =
    kind === 'linear'
      ? Array.from({ length: count }, (_, i) => (i ? [i] : []))
      : kind === 'merge'
        ? [[], [1], [1], [2, 3]]
        : kind === 'octopus'
          ? [[], [1], [1], [1], [2, 3, 4]]
          : kind === 'criss-cross'
            ? [[], [1], [1], [2, 3], [3, 2], [4, 5]]
            : kind === 'orphan'
              ? [[], [1], [], [3]]
              : [[], [1], [2]];
  let stream = '';
  parents.forEach((p, i) => {
    const n = i + 1;
    const msg = `Commit ${n} — ${kind}\n`;
    stream += `commit refs/heads/main\nmark :${n}\nauthor Fixture Author <author@example.test> ${1700000000 + n} +0130\ncommitter Fixture Author <author@example.test> ${1700000000 + n} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}`;
    if (p.length)
      stream +=
        `from :${p[0]}\n` +
        p
          .slice(1)
          .map((id) => `merge :${id}\n`)
          .join('');
    else stream += `from ${'0'.repeat(40)}\n`;
    stream += 'M 100644 inline tracked.txt\ndata 5\nbase\n\n';
  });
  if (kind === 'orphan') stream += 'reset refs/heads/other\nfrom :2\n\n';
  stream += 'done\n';
  fixtureGit(path, ['fast-import', '--quiet'], stream);
  fixtureGit(path, ['reset', '--hard', 'HEAD']);
  fixtureGit(path, ['tag', 'v0.1.0']);
  fixtureGit(path, ['tag', '-a', 'annotated', '-m', 'Annotated fixture']);
  fixtureGit(path, ['update-ref', 'refs/remotes/origin/main', 'HEAD~1']);
  fixtureGit(path, ['config', 'remote.origin.url', '.']);
  fixtureGit(path, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  fixtureGit(path, ['config', 'branch.main.remote', 'origin']);
  fixtureGit(path, ['config', 'branch.main.merge', 'refs/heads/main']);
  if (kind === 'stash') {
    writeFileSync(resolve(path, 'tracked.txt'), 'stashed change\n');
    writeFileSync(resolve(path, 'untracked.txt'), 'stash me\n');
    fixtureGit(path, ['stash', 'push', '-u', '-m', 'Fixture stash']);
  }
  return path;
}
