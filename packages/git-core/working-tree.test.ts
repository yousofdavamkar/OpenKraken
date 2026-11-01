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
test('reviewed line selections stage/unstage through Git, reject stale previews, and undo', async () => {
  const { path, work } = await setup('partial');
  await writeFile(join(path, 'tracked.txt'), 'first\nanchor\nsecond\n');
  await work.files('stage', [bytes('tracked.txt')]);
  fixtureGit(path, ['commit', '-m', 'Base']);
  await writeFile(join(path, 'tracked.txt'), 'FIRST\nanchor\nSECOND\n');
  const preview = await work.diff(bytes('tracked.txt'), 'worktree');
  const lines = preview.hunks
    .flatMap((h) => h.lines)
    .filter((l) => ['first', 'FIRST'].includes(l.text))
    .map((l) => l.id);
  await work.patch({
    pathBytes: bytes('tracked.txt'),
    side: 'worktree',
    token: preview.token,
    lines,
  });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('FIRST\nanchor\nsecond');
  await expect(
    work.patch({ pathBytes: bytes('tracked.txt'), side: 'worktree', token: preview.token, lines }),
  ).rejects.toMatchObject({ code: 'STALE_DIFF' });
  await work.undo();
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('first\nanchor\nsecond');
  const newFile = bytes('new.txt');
  await writeFile(join(path, 'new.txt'), 'one\ntwo\n');
  const added = await work.diff(newFile, 'worktree');
  await work.patch({
    pathBytes: newFile,
    side: 'worktree',
    token: added.token,
    lines: added.hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.text === 'two')
      .map((l) => l.id),
  });
  expect(fixtureGit(path, ['show', ':new.txt'])).toBe('two');
  const staged = await work.diff(newFile, 'index');
  await work.patch({
    pathBytes: newFile,
    side: 'index',
    token: staged.token,
    lines: staged.hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.kind !== 'context')
      .map((l) => l.id),
  });
  expect(fixtureGit(path, ['ls-files', 'new.txt'])).toBe('');
  expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('one\ntwo\n');
});
test('partial staging respects Git clean filters and refuses lossy non-UTF-8 previews', async () => {
  const { path, work } = await setup('filtered');
  if (process.platform !== 'win32') {
    await writeFile(join(path, '.gitattributes'), 'new.txt filter=upper\n');
    fixtureGit(path, ['config', 'filter.upper.clean', 'tr a-z A-Z']);
    fixtureGit(path, ['config', 'filter.upper.required', 'true']);
    await writeFile(join(path, 'new.txt'), 'hello\nworld\n');
    const diff = await work.diff(bytes('new.txt'), 'worktree');
    expect(diff.partialReason).toBeUndefined();
    await work.patch({
      pathBytes: bytes('new.txt'),
      side: 'worktree',
      token: diff.token,
      lines: diff.hunks
        .flatMap((h) => h.lines)
        .filter((l) => l.text === 'HELLO')
        .map((l) => l.id),
    });
    expect(fixtureGit(path, ['show', ':new.txt'])).toBe('HELLO');
    expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('hello\nworld\n');
  }
  await writeFile(join(path, 'latin.txt'), Buffer.from([0xe9, 0x0a]));
  const latin = await work.diff(bytes('latin.txt'), 'worktree');
  expect(latin.partialReason).toContain('Non-UTF-8');
  expect(fixtureGit(path, ['ls-files', 'latin.txt'])).toBe('');
  await work.files('stage', [bytes('latin.txt')]);
  const { runGit } = await import('./src/runner.js');
  expect((await runGit('git', ['show', ':latin.txt'], { cwd: path })).stdout).toEqual(
    Buffer.from([0xe9, 0x0a]),
  );
});
test('copying the index preserves Git’s conservative checks for files with racy cached timestamps', async () => {
  const { path, work } = await setup('racy-index');
  const { utimes } = await import('node:fs/promises');
  const file = join(path, 'tracked.txt'),
    timestamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 30000);
  fixtureGit(path, ['config', 'core.trustctime', 'false']);
  await writeFile(file, 'before\n');
  await utimes(file, timestamp, timestamp);
  fixtureGit(path, ['add', 'tracked.txt']);
  fixtureGit(path, ['commit', '-m', 'Racy base']);
  await utimes(join(path, '.git/index'), timestamp, timestamp);
  await writeFile(file, 'AFTER!\n');
  await utimes(file, timestamp, timestamp);
  const diff = await work.diff(bytes('tracked.txt'), 'worktree');
  expect(diff.hunks).toHaveLength(1);
  await work.patch({
    pathBytes: bytes('tracked.txt'),
    side: 'worktree',
    token: diff.token,
    lines: diff.hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.kind !== 'context')
      .map((l) => l.id),
  });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('AFTER!');
});
test('discard preserves staged content and undo restores tracked and untracked bytes without overwriting newer edits', async () => {
  const { path, work } = await setup('discard');
  await writeFile(join(path, 'tracked.txt'), 'staged\n');
  await work.files('stage', [bytes('tracked.txt')]);
  const original = Buffer.from([0, 255, 2, 10, 128]);
  await writeFile(join(path, 'tracked.txt'), original);
  await writeFile(join(path, 'new.txt'), 'untracked content\n', { mode: 0o755 });
  const selected = [bytes('tracked.txt'), bytes('new.txt')];
  const preview = await work.discardPreview(selected);
  await work.discard(selected, preview.token);
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('staged\n');
  await expect(readFile(join(path, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('staged');
  await work.undo();
  expect(await readFile(join(path, 'tracked.txt'))).toEqual(original);
  expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('untracked content\n');
  await work.undo(true);
  await writeFile(join(path, 'tracked.txt'), 'newer editor changes\n');
  await expect(work.undo()).rejects.toMatchObject({ code: 'STALE_UNDO' });
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('newer editor changes\n');
  const stale = await work.discardPreview([bytes('tracked.txt')]);
  await writeFile(join(path, 'tracked.txt'), 'changed after confirmation\n');
  await expect(work.discard([bytes('tracked.txt')], stale.token)).rejects.toMatchObject({
    code: 'STALE_DISCARD',
  });
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('changed after confirmation\n');
});
test.skipIf(process.platform === 'win32')(
  'discard restores links and executable permissions without following the link target',
  async () => {
    const { path, work } = await setup('discard-links');
    const { symlink, readlink, chmod, stat } = await import('node:fs/promises');
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside stays unchanged\n');
    await rm(join(path, 'tracked.txt'));
    await symlink(outside, join(path, 'tracked.txt'));
    await writeFile(join(path, 'new.sh'), '#!/bin/sh\necho original\n');
    await chmod(join(path, 'new.sh'), 0o755);
    const selected = [bytes('tracked.txt'), bytes('new.sh')];
    await work.discard(selected, (await work.discardPreview(selected)).token);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(await readFile(outside, 'utf8')).toBe('outside stays unchanged\n');
    await work.undo();
    expect(await readlink(join(path, 'tracked.txt'))).toBe(outside);
    expect((await stat(join(path, 'new.sh'))).mode & 0o777).toBe(0o755);
    expect(await readFile(outside, 'utf8')).toBe('outside stays unchanged\n');
  },
);

test('discard refuses unresolved index entries without changing conflict contents', async () => {
  const { path, work } = await setup('discard-conflict');
  fixtureGit(path, ['checkout', '-b', 'other']);
  await writeFile(join(path, 'tracked.txt'), 'other\n');
  fixtureGit(path, ['commit', '-am', 'Other']);
  fixtureGit(path, ['checkout', 'main']);
  await writeFile(join(path, 'tracked.txt'), 'main\n');
  fixtureGit(path, ['commit', '-am', 'Main']);
  spawnSync('git', ['merge', 'other'], { cwd: path });
  const content = await readFile(join(path, 'tracked.txt'));
  const selected = [bytes('tracked.txt')];
  const preview = await work.discardPreview(selected);
  await expect(work.discard(selected, preview.token)).rejects.toMatchObject({
    code: 'UNRESOLVED_CONFLICT',
  });
  expect(await readFile(join(path, 'tracked.txt'))).toEqual(content);
});
test('branch and annotated tag creation are undoable and reject stale or injected ref changes', async () => {
  const { path, work } = await setup('references');
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  await work.reference({ action: 'createBranch', name: 'feature/review', target });
  expect(fixtureGit(path, ['rev-parse', 'refs/heads/feature/review'])).toBe(target);
  await work.undo();
  expect(fixtureGit(path, ['branch', '--list', 'feature/review'])).toBe('');
  await work.undo(true);
  expect(fixtureGit(path, ['rev-parse', 'refs/heads/feature/review'])).toBe(target);
  const message = 'Reviewed release\n\nBody\n\n';
  await work.reference({ action: 'createTag', name: 'release/review', target, message });
  const tag = fixtureGit(path, ['rev-parse', 'refs/tags/release/review']);
  const { runGit } = await import('./src/runner.js');
  const raw = (await runGit('git', ['cat-file', 'tag', tag], { cwd: path })).stdout.toString();
  expect(raw.slice(raw.indexOf('\n\n') + 2)).toBe(message);
  await work.reference({ action: 'deleteTag', name: 'release/review', expected: tag });
  await work.undo();
  expect(fixtureGit(path, ['rev-parse', 'refs/tags/release/review'])).toBe(tag);
  fixtureGit(path, ['tag', '-f', 'release/review', 'HEAD~1']);
  await expect(work.undo()).rejects.toMatchObject({ code: 'STALE_UNDO' });
  await expect(
    work.reference({ action: 'deleteTag', name: 'release/review', expected: tag }),
  ).rejects.toMatchObject({ code: 'STALE_REF' });
  await expect(
    work.reference({ action: 'createBranch', name: '--help', target }),
  ).rejects.toMatchObject({ code: 'INVALID_REF' });
});
test('bare repository ref actions and undo never create a working index', async () => {
  const { path } = await setup('bare-reference-source');
  const bare = join(root, 'bare-reference.git');
  fixtureGit(path, ['clone', '--bare', '.', bare]);
  const repo = await new RepositoryService('git').open(bare);
  const work = new WorkingTree('git', repo, join(root, 'profile'));
  const target = fixtureGit(bare, ['rev-parse', 'HEAD']);
  await work.reference({ action: 'createBranch', name: 'bare-created', target });
  expect(fixtureGit(bare, ['rev-parse', 'bare-created'])).toBe(target);
  await work.undo();
  expect(fixtureGit(bare, ['branch', '--list', 'bare-created'])).toBe('');
  await work.reference({
    action: 'renameBranch',
    name: 'main',
    newName: 'bare-main',
    expected: target,
  });
  await work.undo();
  await expect(readFile(join(bare, 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test('undo refuses to remove a branch checked out by another worktree', async () => {
  const { path, work } = await setup('branch-in-use');
  const target = fixtureGit(path, ['rev-parse', 'HEAD']);
  await work.reference({ action: 'createBranch', name: 'occupied', target });
  fixtureGit(path, ['worktree', 'add', join(root, 'occupied-worktree'), 'occupied']);
  await expect(work.undo()).rejects.toMatchObject({ code: 'BRANCH_IN_USE' });
  expect(fixtureGit(path, ['rev-parse', 'occupied'])).toBe(target);
});
test('branch checkout and undo preserve later nonconflicting edits and refuse overwritten or moved targets', async () => {
  const { path, work } = await setup('switch');
  fixtureGit(path, ['checkout', '-b', 'other']);
  await writeFile(join(path, 'tracked.txt'), 'other branch\n');
  fixtureGit(path, ['commit', '-am', 'Other tree']);
  const other = fixtureGit(path, ['rev-parse', 'HEAD']);
  fixtureGit(path, ['checkout', 'main']);
  await work.reference({ action: 'checkoutBranch', name: 'other', expected: other });
  expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/other');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('other branch\n');
  await writeFile(join(path, 'after.txt'), 'keep this later untracked edit\n');
  await work.undo();
  expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('base\n');
  expect(await readFile(join(path, 'after.txt'), 'utf8')).toBe('keep this later untracked edit\n');
  await work.undo(true);
  expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/other');
  await writeFile(join(path, 'tracked.txt'), 'later edit in other\n');
  await expect(work.undo()).rejects.toThrow();
  expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/other');
  expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('later edit in other\n');
  fixtureGit(path, ['restore', 'tracked.txt']);
  fixtureGit(path, ['branch', '-f', 'main', 'main~1']);
  await expect(work.undo()).rejects.toMatchObject({ code: 'STALE_UNDO' });
  await expect(
    work.reference({ action: 'checkoutBranch', name: 'main', expected: other }),
  ).rejects.toMatchObject({ code: 'STALE_REF' });
});
test('checkout undo supports detached and unborn starting HEADs', async () => {
  for (const kind of ['detached', 'unborn']) {
    const { path, work } = await setup(`switch-${kind}`);
    const target = fixtureGit(path, ['rev-parse', 'main']);
    if (kind === 'detached') fixtureGit(path, ['switch', '--detach', 'HEAD~1']);
    else fixtureGit(path, ['switch', '--orphan', 'empty']);
    const before = (await work.state()).head;
    await work.reference({ action: 'checkoutBranch', name: 'main', expected: target });
    await work.undo();
    expect((await work.state()).head).toEqual(before);
    await work.undo(true);
    expect((await work.state()).head).toEqual({
      kind: 'branch',
      ref: 'refs/heads/main',
      oid: target,
    });
  }
});
test.skipIf(process.platform === 'win32')(
  'failed post-checkout hook keeps the completed switch recoverable',
  async () => {
    const { path, work } = await setup('switch-hook');
    fixtureGit(path, ['branch', 'other', 'HEAD~1']);
    const target = fixtureGit(path, ['rev-parse', 'other']);
    const hook = join(path, '.git/hooks/post-checkout');
    await writeFile(hook, '#!/bin/sh\necho checkout-hook-failed >&2\nexit 1\n', { mode: 0o755 });
    await expect(
      work.reference({ action: 'checkoutBranch', name: 'other', expected: target }),
    ).rejects.toThrow('checkout-hook-failed');
    expect((await work.state()).head).toEqual({
      kind: 'branch',
      ref: 'refs/heads/other',
      oid: target,
    });
    expect((await work.state()).undo?.label).toBe('Switch branch');
    await rm(hook);
    await work.undo();
    expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  },
);
test('renaming a current branch moves its configuration and undo restores both without replacing newer settings', async () => {
  const { path, work } = await setup('rename-branch');
  fixtureGit(path, ['config', 'branch.main.rebase', 'true']);
  fixtureGit(path, ['config', 'branch.main.description', 'Reviewed\nbranch description']);
  const expected = fixtureGit(path, ['rev-parse', 'HEAD']);
  await work.reference({
    action: 'renameBranch',
    name: 'main',
    newName: 'renamed/topic',
    expected,
  });
  expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/renamed/topic');
  expect(fixtureGit(path, ['config', 'branch.renamed/topic.remote'])).toBe('origin');
  expect(fixtureGit(path, ['config', 'branch.renamed/topic.description'])).toBe(
    'Reviewed\nbranch description',
  );
  fixtureGit(path, ['config', 'branch.main.child.remote', 'unrelated']);
  await work.undo();
  expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  expect(fixtureGit(path, ['config', 'branch.main.child.remote'])).toBe('unrelated');
  expect(fixtureGit(path, ['config', 'branch.main.rebase'])).toBe('true');
  await work.undo(true);
  fixtureGit(path, ['config', 'branch.renamed/topic.rebase', 'false']);
  await expect(work.undo()).rejects.toMatchObject({ code: 'STALE_UNDO' });
  expect(fixtureGit(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/renamed/topic');
  expect(fixtureGit(path, ['config', 'branch.renamed/topic.rebase'])).toBe('false');
});
test('upstream changes and undo preserve exact branch settings and unrelated configuration', async () => {
  const { path, work } = await setup('upstream');
  fixtureGit(path, ['config', '--add', 'branch.main.description', 'first\nline\t"quoted"']);
  fixtureGit(path, ['config', '--add', 'branch.main.description', 'second']);
  const expected = fixtureGit(path, ['rev-parse', 'main']);
  fixtureGit(path, ['branch', 'local-upstream', 'HEAD~1']);
  await work.reference({
    action: 'setUpstream',
    name: 'main',
    expected,
    upstream: 'refs/heads/local-upstream',
  });
  expect(fixtureGit(path, ['rev-parse', '--symbolic-full-name', 'main@{upstream}'])).toBe(
    'refs/heads/local-upstream',
  );
  fixtureGit(path, ['config', 'user.email', 'later@example.test']);
  await work.undo();
  expect(fixtureGit(path, ['rev-parse', '--symbolic-full-name', 'main@{upstream}'])).toBe(
    'refs/remotes/origin/main',
  );
  expect(fixtureGit(path, ['config', '--get-all', 'branch.main.description'])).toBe(
    'first\nline\t"quoted"\nsecond',
  );
  expect(fixtureGit(path, ['config', 'user.email'])).toBe('later@example.test');
  await work.undo(true);
  expect(fixtureGit(path, ['rev-parse', '--symbolic-full-name', 'main@{upstream}'])).toBe(
    'refs/heads/local-upstream',
  );
  await work.reference({ action: 'setUpstream', name: 'main', expected });
  expect((await work.state()).status.upstream).toBeUndefined();
  await work.undo();
  expect(fixtureGit(path, ['rev-parse', '--symbolic-full-name', 'main@{upstream}'])).toBe(
    'refs/heads/local-upstream',
  );
});
test('upstream undo preserves byte-valued and boolean settings and respects an existing config lock', async () => {
  const { path, work } = await setup('upstream-bytes');
  const { appendFile } = await import('node:fs/promises');
  const { runGit } = await import('./src/runner.js');
  await appendFile(
    join(path, '.git/config'),
    Buffer.concat([
      Buffer.from('\n[branch "main"]\n\trebase\n\tdescription = "'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"\n'),
    ]),
  );
  const before = (
    await runGit('git', ['config', '--null', '--get-all', 'branch.main.description'], { cwd: path })
  ).stdout;
  const expected = fixtureGit(path, ['rev-parse', 'main']);
  await work.reference({ action: 'setUpstream', name: 'main', expected });
  await writeFile(join(path, '.git/config.lock'), 'another writer');
  await expect(work.undo()).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
  expect(await readFile(join(path, '.git/config.lock'), 'utf8')).toBe('another writer');
  await rm(join(path, '.git/config.lock'));
  await work.undo();
  expect(fixtureGit(path, ['config', '--bool', 'branch.main.rebase'])).toBe('true');
  expect(
    (
      await runGit('git', ['config', '--null', '--get-all', 'branch.main.description'], {
        cwd: path,
      })
    ).stdout,
  ).toEqual(before);
});
