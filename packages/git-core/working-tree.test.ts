import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { RepositoryService } from './src/repository.js';
import { WorkingTree } from './src/working-tree.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-working-'));
afterAll(() => rm(root, { recursive: true, force: true }));
async function setup(name: string) {
  const path = createFixture(join(root, name));
  const service = new RepositoryService('git');
  const repo = await service.open(path);
  const work = new WorkingTree('git', repo, join(root, 'profile'));
  return { path, repo, work };
}
const bytes = (path: string) => Buffer.from(path).toString('base64');
test('stage and unstage only literal selected files; persistent undo preserves later working edits', async () => {
  const { path, repo, work } = await setup('files');
  await writeFile(join(path, 'tracked.txt'), 'changed\n');
  await writeFile(join(path, ':special\nfile.txt'), 'new\n');
  await writeFile(join(path, 'other.txt'), 'leave alone\n');
  await work.files('stage', [bytes('tracked.txt'), bytes(':special\nfile.txt')]);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('changed');
  expect((await work.state()).status.entries.find((e) => e.path === 'other.txt')?.kind).toBe(
    'untracked',
  );
  await work.files('unstage', [bytes('tracked.txt')]);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('base');
  await writeFile(join(path, 'tracked.txt'), 'edited after unstage\n');
  const reopened = new WorkingTree('git', repo, join(root, 'profile'));
  await reopened.undo();
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('changed');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('edited after unstage\n');
  await reopened.undo();
  expect(fixtureGit(path, ['diff', '--cached', '--name-only'])).toBe('');
  await reopened.undo(true);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('changed');
});
test('external staging and existing locks prevent undo or writes from overwriting newer work', async () => {
  const { path, work } = await setup('stale');
  await writeFile(join(path, 'tracked.txt'), 'first\n');
  await work.files('stage', [bytes('tracked.txt')]);
  await writeFile(join(path, 'tracked.txt'), 'external\n');
  fixtureGit(path, ['add', 'tracked.txt']);
  await expect(work.undo()).rejects.toMatchObject({ code: 'STALE_UNDO' });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('external');
  await writeFile(join(path, '.git/index.lock'), 'owned by another process');
  await expect(work.files('unstage', [bytes('tracked.txt')])).rejects.toMatchObject({
    code: 'INDEX_LOCKED',
  });
  expect(await readFile(join(path, '.git/index.lock'), 'utf8')).toBe('owned by another process');
});
test('unstaging on unborn HEAD keeps working files, including edits made after staging', async () => {
  const path = join(root, 'unborn');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path);
  fixtureGit(path, ['init', '-b', 'main']);
  const repo = await new RepositoryService('git').open(path);
  const work = new WorkingTree('git', repo, join(root, 'profile'));
  await writeFile(join(path, 'new.txt'), 'initial\n');
  await work.files('stage', [bytes('new.txt')]);
  await writeFile(join(path, 'new.txt'), 'later\n');
  await work.files('unstage', [bytes('new.txt')]);
  expect(fixtureGit(path, ['ls-files'])).toBe('');
  expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('later\n');
  await work.undo();
  expect(fixtureGit(path, ['show', ':new.txt'])).toBe('initial');
});
test('commit and amend preserve messages, run native hooks, and undo/redo only owned HEAD/index state', async () => {
  const { path, work } = await setup('commit');
  fixtureGit(path, ['config', 'user.name', 'Test Author']);
  fixtureGit(path, ['config', 'user.email', 'test@example.test']);
  fixtureGit(path, ['config', 'commit.gpgSign', 'false']);
  await writeFile(join(path, 'tracked.txt'), 'commit me\n');
  await work.files('stage', [bytes('tracked.txt')]);
  const before = fixtureGit(path, ['rev-parse', 'HEAD']);
  const message = 'First commit\n\nBody with space  \n\n';
  await work.commit({ message, revision: (await work.state()).revision });
  const first = fixtureGit(path, ['rev-parse', 'HEAD']);
  const raw = (await import('./src/runner.js')).runGit;
  expect(
    (await raw('git', ['cat-file', 'commit', first], { cwd: path })).stdout
      .toString()
      .split('\n\n')
      .slice(1)
      .join('\n\n'),
  ).toBe(message);
  await work.commit({ message: 'Amended\n', amend: true, revision: (await work.state()).revision });
  const amended = fixtureGit(path, ['rev-parse', 'HEAD']);
  expect(amended).not.toBe(first);
  await work.undo();
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(first);
  await work.undo();
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(before);
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('commit me\n');
  await work.undo(true);
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(first);
  const hook = join(path, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\necho "Blocked by test hook" >&2\nexit 1\n', { mode: 0o755 });
  await expect(
    work.commit({ message: 'Blocked\n', amend: true, revision: (await work.state()).revision }),
  ).rejects.toThrow('Blocked by test hook');
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(first);
});
test('commit refuses stale staged content and loads the configured message template', async () => {
  const { path, work } = await setup('commit-stale');
  fixtureGit(path, ['config', 'user.name', 'Test Author']);
  fixtureGit(path, ['config', 'user.email', 'test@example.test']);
  await writeFile(join(path, 'template.txt'), 'Subject\n\nBody template\n');
  fixtureGit(path, ['config', 'commit.template', 'template.txt']);
  const state = await work.state();
  expect(state.messageTemplate).toBe('Subject\n\nBody template\n');
  await writeFile(join(path, 'tracked.txt'), 'external stage\n');
  fixtureGit(path, ['add', 'tracked.txt']);
  const head = fixtureGit(path, ['rev-parse', 'HEAD']);
  await expect(
    work.commit({ message: 'Old review\n', revision: state.revision }),
  ).rejects.toMatchObject({ code: 'STALE_COMMIT' });
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(head);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('external stage');
});
test('cancellation after Git moved HEAD still records a usable undo entry', async () => {
  if (process.platform === 'win32') return;
  const { path, work } = await setup('cancel-after-commit');
  fixtureGit(path, ['config', 'user.name', 'Test Author']);
  fixtureGit(path, ['config', 'user.email', 'test@example.test']);
  fixtureGit(path, ['config', 'commit.gpgSign', 'false']);
  await writeFile(join(path, 'tracked.txt'), 'committed before cancellation\n');
  await work.files('stage', [bytes('tracked.txt')]);
  const before = fixtureGit(path, ['rev-parse', 'HEAD']);
  await writeFile(
    join(path, '.git/hooks/post-commit'),
    '#!/bin/sh\nprintf done > hook-started\nsleep 30\n',
    { mode: 0o755 },
  );
  const controller = new AbortController();
  const result = work
    .commit({ message: 'Completed\n', revision: (await work.state()).revision }, controller.signal)
    .catch((e: unknown) => e);
  await expect
    .poll(() => readFile(join(path, 'hook-started'), 'utf8').catch(() => ''), { timeout: 5000 })
    .toBe('done');
  controller.abort();
  expect(await result).toMatchObject({ code: 'CANCELLED' });
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).not.toBe(before);
  await work.undo();
  expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(before);
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('committed before cancellation');
});

test.skipIf(!!spawnSync('ssh-keygen', ['-V']).error)(
  'Git SSH signing creates a commit that verify-commit accepts',
  async () => {
    const { path, work } = await setup('signed');
    const key = join(root, 'signing-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
    const allowed = join(root, 'allowed-signers');
    await writeFile(allowed, `test@example.test ${publicKey}\n`);
    for (const [name, value] of [
      ['user.name', 'Test Author'],
      ['user.email', 'test@example.test'],
      ['gpg.format', 'ssh'],
      ['user.signingKey', key],
      ['gpg.ssh.allowedSignersFile', allowed],
    ])
      fixtureGit(path, ['config', name!, value!]);
    await writeFile(join(path, 'tracked.txt'), 'signed content\n');
    await work.files('stage', [bytes('tracked.txt')]);
    await work.commit({
      message: 'Signed through Git\n',
      sign: true,
      revision: (await work.state()).revision,
    });
    fixtureGit(path, ['verify-commit', 'HEAD']);
    expect(fixtureGit(path, ['log', '-1', '--format=%s'])).toBe('Signed through Git');
  },
);
