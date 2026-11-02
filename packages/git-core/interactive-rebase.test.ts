import { afterAll, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-interactive-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const editorHelper = resolve(
  'apps/desktop/dist/helpers',
  process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
);
async function fixture(name: string) {
  const path = createFixture(join(root, name));
  const base = fixtureGit(path, ['rev-parse', 'HEAD']);
  const ids: string[] = [];
  for (const file of ['one', 'two', 'three']) {
    await writeFile(join(path, file + '.txt'), file + '\n');
    fixtureGit(path, ['add', '.']);
    fixtureGit(path, ['commit', '-m', file]);
    ids.push(fixtureGit(path, ['rev-parse', 'HEAD']));
  }
  const service = new RepositoryService('git', {
    dataDir: join(root, name + '-profile'),
    editorHelper,
  });
  const repo = await service.open(path);
  return { path, base, ids, service, repo };
}
test('reviewed interactive rebase reorders, rewords and drops native commits with Undo', async () => {
  const { path, base, ids, service, repo } = await fixture('reviewed');
  try {
    const preview = await service.interactiveRebasePreview(repo.id, base);
    expect(preview.commits.map((commit) => commit.oid)).toEqual(ids);
    expect(preview.commits.map((commit) => commit.message.trim())).toEqual(['one', 'two', 'three']);
    const result = await service.interactiveRebase(repo.id, {
      base,
      token: preview.token,
      steps: [
        { action: 'reword', oid: ids[2]!, newMessage: 'Third becomes first\n\nReviewed body\n' },
        { action: 'pick', oid: ids[0]! },
        { action: 'drop', oid: ids[1]! },
      ],
    });
    expect(result.operation?.kind).toBe('none');
    expect(fixtureGit(path, ['log', '--reverse', '--format=%s', `${base}..HEAD`])).toBe(
      'Third becomes first\none',
    );
    expect(fixtureGit(path, ['show', '-s', '--format=%B', 'HEAD~'])).toBe(
      'Third becomes first\n\nReviewed body',
    );
    await expect(readFile(join(path, 'two.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    const after = fixtureGit(path, ['rev-parse', 'HEAD']);
    await service.undo(repo.id);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(ids[2]);
    expect(await readFile(join(path, 'two.txt'), 'utf8')).toBe('two\n');
    await service.undo(repo.id, true);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(after);
  } finally {
    await service.dispose();
  }
});
test.each(['squash', 'fixup'] as const)(
  'interactive rebase preserves the reviewed message through a squash/%s chain',
  async (lastAction) => {
    const { path, base, ids, service, repo } = await fixture('chain-' + lastAction);
    try {
      const preview = await service.interactiveRebasePreview(repo.id, base);
      await service.interactiveRebase(repo.id, {
        base,
        token: preview.token,
        steps: [
          { action: 'pick', oid: ids[0]! },
          { action: 'squash', oid: ids[1]!, newMessage: 'Combined first pair' },
          {
            action: lastAction,
            oid: ids[2]!,
            ...(lastAction === 'squash' ? { newMessage: 'Combined all three' } : {}),
          },
        ],
      });
      expect(fixtureGit(path, ['rev-list', '--count', `${base}..HEAD`])).toBe('1');
      expect(fixtureGit(path, ['show', '-s', '--format=%B', 'HEAD'])).toBe(
        lastAction === 'squash' ? 'Combined all three' : 'Combined first pair',
      );
      for (const file of ['one', 'two', 'three'])
        expect(await readFile(join(path, file + '.txt'), 'utf8')).toBe(file + '\n');
      expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    } finally {
      await service.dispose();
    }
  },
);
test('an edit stop can be amended and resumed after restart with its reviewed later message', async () => {
  const setup = await fixture('edit-stop');
  const { path, base, ids } = setup;
  let { service, repo } = setup;
  try {
    const preview = await service.interactiveRebasePreview(repo.id, base);
    await service.interactiveRebase(repo.id, {
      base,
      token: preview.token,
      steps: [
        { action: 'edit', oid: ids[0]! },
        { action: 'reword', oid: ids[1]!, newMessage: 'Reworded after restart' },
        { action: 'pick', oid: ids[2]! },
      ],
    });
    expect(await service.operationState(repo.id)).toMatchObject({
      kind: 'rebase',
      editStopped: true,
      progress: { current: 1, total: 3 },
    });
    await writeFile(join(path, 'one.txt'), 'edited first commit\n');
    fixtureGit(path, ['add', 'one.txt']);
    await service.commit(repo.id, {
      amend: true,
      message: 'Amended first commit',
      revision: (await service.workingState(repo.id)).revision,
    });
    await service.dispose();
    service = new RepositoryService('git', {
      dataDir: join(root, 'edit-stop-profile'),
      editorHelper,
    });
    repo = await service.open(path);
    await service.operationAction(repo.id, {
      action: 'continue',
      token: (await service.operationState(repo.id)).token,
    });
    expect(fixtureGit(path, ['log', '--reverse', '--format=%s', `${base}..HEAD`])).toBe(
      'Amended first commit\nReworded after restart\nthree',
    );
    expect(await readFile(join(path, 'one.txt'), 'utf8')).toBe('edited first commit\n');
    await service.undo(repo.id);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(ids[2]);
    expect(await readFile(join(path, 'one.txt'), 'utf8')).toBe('one\n');
    expect((await service.workingState(repo.id)).undo).toBeUndefined();
  } finally {
    await service.dispose();
  }
});
test('interactive rebase refuses duplicate, missing, invalid-chain and stale plans before mutation', async () => {
  const { path, base, ids, service, repo } = await fixture('guards');
  try {
    const preview = await service.interactiveRebasePreview(repo.id, base);
    for (const steps of [
      ids.slice(1).map((oid) => ({ action: 'pick' as const, oid })),
      [ids[0]!, ids[0]!, ids[2]!].map((oid) => ({ action: 'pick' as const, oid })),
      ids.map((oid, index) => ({
        action: index === 0 ? ('fixup' as const) : ('pick' as const),
        oid,
      })),
    ])
      await expect(
        service.interactiveRebase(repo.id, { base, token: preview.token, steps }),
      ).rejects.toMatchObject({ code: 'INVALID_REBASE_PLAN' });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(ids[2]);
    expect((await service.operationState(repo.id)).kind).toBe('none');
    fixtureGit(path, ['commit', '--allow-empty', '-m', 'Newer external commit']);
    const newer = fixtureGit(path, ['rev-parse', 'HEAD']);
    await expect(
      service.interactiveRebase(repo.id, {
        base,
        token: preview.token,
        steps: ids.map((oid) => ({ action: 'pick', oid })),
      }),
    ).rejects.toMatchObject({ code: 'STALE_REBASE' });
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(newer);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
test('a reordered conflict resumes after restart and still uses the later reviewed message', async () => {
  const path = createFixture(join(root, 'conflict-restart'));
  const base = fixtureGit(path, ['rev-parse', 'HEAD']);
  const ids: string[] = [];
  for (const text of ['first', 'second']) {
    await writeFile(join(path, 'tracked.txt'), text + '\n');
    fixtureGit(path, ['commit', '-am', text]);
    ids.push(fixtureGit(path, ['rev-parse', 'HEAD']));
  }
  await writeFile(join(path, 'last.txt'), 'last\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'last']);
  ids.push(fixtureGit(path, ['rev-parse', 'HEAD']));
  const dataDir = join(root, 'conflict-restart-profile');
  let service = new RepositoryService('git', { dataDir, editorHelper });
  try {
    let repo = await service.open(path);
    const preview = await service.interactiveRebasePreview(repo.id, base);
    await expect(
      service.interactiveRebase(repo.id, {
        base,
        token: preview.token,
        steps: [
          { action: 'pick', oid: ids[1]! },
          { action: 'drop', oid: ids[0]! },
          { action: 'reword', oid: ids[2]!, newMessage: 'Reviewed after conflict' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED' });
    expect((await service.operationState(repo.id)).conflicts).toBe(1);
    await service.dispose();
    service = new RepositoryService('git', { dataDir, editorHelper });
    repo = await service.open(path);
    const pathBytes = Buffer.from('tracked.txt').toString('base64');
    const conflict = await service.conflictPreview(repo.id, pathBytes);
    await service.resolveConflict(repo.id, {
      pathBytes,
      token: conflict.token,
      choice: 'output',
      text: 'reviewed resolution\n',
    });
    await service.operationAction(repo.id, {
      action: 'continue',
      token: (await service.operationState(repo.id)).token,
    });
    expect(fixtureGit(path, ['log', '--reverse', '--format=%s', `${base}..HEAD`])).toBe(
      'second\nReviewed after conflict',
    );
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('reviewed resolution\n');
    await service.undo(repo.id);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(ids[2]);
    expect(await readFile(join(path, 'tracked.txt'), 'utf8')).toBe('second\n');
  } finally {
    await service.dispose();
  }
});
test('an additional native editor document is reviewed before it is saved', async () => {
  const { path, base, ids, service, repo } = await fixture('additional-editor');
  const document = join(path, '.git', 'review-message.txt');
  await writeFile(document, 'Native editor draft\n');
  await writeFile(
    join(path, '.git/hooks/pre-rebase'),
    '#!/bin/sh\ndocument="$(git rev-parse --absolute-git-dir)/review-message.txt"\neval "$GIT_EDITOR \\"\\$document\\""\n',
    { mode: 0o755 },
  );
  try {
    const preview = await service.interactiveRebasePreview(repo.id, base);
    let reviewed = false;
    await service.interactiveRebase(
      repo.id,
      { base, token: preview.token, steps: ids.map((oid) => ({ action: 'pick', oid })) },
      undefined,
      undefined,
      async (input, signal) => {
        expect(input.path).toBe(document);
        expect(input.text).toBe('Native editor draft\n');
        expect(signal.aborted).toBe(false);
        expect(await readFile(document, 'utf8')).toBe('Native editor draft\n');
        reviewed = true;
        return 'Reviewed extra document\n';
      },
    );
    expect(reviewed).toBe(true);
    expect(await readFile(document, 'utf8')).toBe('Reviewed extra document\n');
    expect((await service.operationState(repo.id)).kind).toBe('none');
  } finally {
    await service.dispose();
  }
});
test.each(['newer edit', 'cancel'] as const)(
  'additional editor preserves its document on %s',
  async (action) => {
    const { path, base, ids, service, repo } = await fixture('editor-' + action.replace(' ', '-'));
    const document = join(path, '.git', 'review-message.txt');
    await writeFile(document, 'Original draft\n');
    await writeFile(
      join(path, '.git/hooks/pre-rebase'),
      '#!/bin/sh\ndocument="$(git rev-parse --absolute-git-dir)/review-message.txt"\neval "$GIT_EDITOR \\"\\$document\\""\n',
      { mode: 0o755 },
    );
    try {
      const preview = await service.interactiveRebasePreview(repo.id, base);
      await expect(
        service.interactiveRebase(
          repo.id,
          { base, token: preview.token, steps: ids.map((oid) => ({ action: 'pick', oid })) },
          undefined,
          undefined,
          async () => {
            if (action === 'cancel') return null;
            await writeFile(document, 'Newer external edit\n');
            return 'Stale edited draft\n';
          },
        ),
      ).rejects.toMatchObject({ code: action === 'cancel' ? 'CANCELLED' : 'STALE_EDITOR' });
      expect(await readFile(document, 'utf8')).toBe(
        action === 'cancel' ? 'Original draft\n' : 'Newer external edit\n',
      );
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(ids[2]);
      expect((await service.operationState(repo.id)).kind).toBe('none');
    } finally {
      await service.dispose();
    }
  },
);
test.each(['outside', 'binary', 'hardlink'] as const)(
  'additional editor refuses %s documents before asking the renderer',
  async (kind) => {
    const { path, base, ids, service, repo } = await fixture('editor-guard-' + kind);
    const document = join(path, '.git/review-message.txt');
    const original = await readFile(join(path, 'tracked.txt'));
    if (kind === 'hardlink') await link(join(path, 'tracked.txt'), document);
    else await writeFile(document, Buffer.from([0, 1, 2, 255]));
    const location =
      kind === 'outside'
        ? '$(git rev-parse --show-toplevel)/tracked.txt'
        : '$(git rev-parse --absolute-git-dir)/review-message.txt';
    await writeFile(
      join(path, '.git/hooks/pre-rebase'),
      `#!/bin/sh\ndocument="${location}"\neval "$GIT_EDITOR \\"\\$document\\""\n`,
      { mode: 0o755 },
    );
    try {
      const preview = await service.interactiveRebasePreview(repo.id, base);
      let asked = false;
      await expect(
        service.interactiveRebase(
          repo.id,
          { base, token: preview.token, steps: ids.map((oid) => ({ action: 'pick', oid })) },
          undefined,
          undefined,
          async () => {
            asked = true;
            return 'invalid overwrite';
          },
        ),
      ).rejects.toMatchObject({
        code: kind === 'outside' ? 'INVALID_EDITOR_PATH' : 'EDITOR_LIMIT',
      });
      expect(asked).toBe(false);
      expect(await readFile(join(path, 'tracked.txt'))).toEqual(original);
      expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(ids[2]);
    } finally {
      await service.dispose();
    }
  },
);
