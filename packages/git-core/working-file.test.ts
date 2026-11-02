import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, chmod, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-working-editor-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('saving a reviewed WIP file preserves bytes and mode, leaves the index unchanged, and supports Undo/Redo', async () => {
  const path = createFixture(join(root, 'save'));
  const filename = join(path, 'script.txt'),
    pathBytes = Buffer.from('script.txt').toString('base64');
  await writeFile(filename, 'before\r\n');
  await chmod(filename, 0o755);
  const service = new RepositoryService('git', { dataDir: join(root, 'profile') });
  try {
    const repo = await service.open(path);
    const preview = await service.workingFile(repo.id, { pathBytes });
    expect(preview).toMatchObject({
      path: 'script.txt',
      text: 'before\r\n',
      encoding: 'UTF-8',
      bom: false,
      newline: 'crlf',
    });
    const index = fixtureGit(path, ['write-tree']);
    await service.saveWorkingFile(repo.id, { pathBytes, token: preview.token, text: 'after\r\n' });
    expect(await readFile(filename, 'utf8')).toBe('after\r\n');
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o755);
    expect(fixtureGit(path, ['write-tree'])).toBe(index);
    await service.undo(repo.id);
    expect(await readFile(filename, 'utf8')).toBe('before\r\n');
    await service.undo(repo.id, true);
    expect(await readFile(filename, 'utf8')).toBe('after\r\n');
  } finally {
    await service.dispose();
  }
});

test('stale editor saves refuse newer file edits and Git index changes', async () => {
  const path = createFixture(join(root, 'stale'));
  const filename = join(path, 'draft.txt'),
    pathBytes = Buffer.from('draft.txt').toString('base64');
  await writeFile(filename, 'draft\n');
  const service = new RepositoryService('git', { dataDir: join(root, 'stale-profile') });
  try {
    const repo = await service.open(path);
    const preview = await service.workingFile(repo.id, { pathBytes });
    await writeFile(filename, 'external edit\n');
    await expect(
      service.saveWorkingFile(repo.id, {
        pathBytes,
        token: preview.token,
        text: 'editor overwrite\n',
      }),
    ).rejects.toMatchObject({ code: 'STALE_FILE' });
    expect(await readFile(filename, 'utf8')).toBe('external edit\n');
    const refreshed = await service.workingFile(repo.id, { pathBytes });
    fixtureGit(path, ['add', 'draft.txt']);
    await expect(
      service.saveWorkingFile(repo.id, {
        pathBytes,
        token: refreshed.token,
        text: 'editor overwrite\n',
      }),
    ).rejects.toMatchObject({ code: 'STALE_FILE' });
    expect(await readFile(filename, 'utf8')).toBe('external edit\n');
    expect((await service.workingState(repo.id)).undo).toBeUndefined();
  } finally {
    await service.dispose();
  }
});

test('working-tree-encoding controls editor decoding and preserves BOM and raw encoding on save', async () => {
  const path = createFixture(join(root, 'encoded'));
  const filename = join(path, 'unicode.txt'),
    pathBytes = Buffer.from('unicode.txt').toString('base64');
  await writeFile(join(path, '.gitattributes'), 'unicode.txt working-tree-encoding=UTF-16LE-BOM\n');
  const original = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('Snow 雪\r\n', 'utf16le'),
  ]);
  await writeFile(filename, original);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Encoded baseline']);
  await writeFile(
    filename,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Draft 雪\r\n', 'utf16le')]),
  );
  const service = new RepositoryService('git', { dataDir: join(root, 'encoded-profile') });
  try {
    const repo = await service.open(path);
    const preview = await service.workingFile(repo.id, { pathBytes });
    expect(preview).toMatchObject({
      text: 'Draft 雪\r\n',
      encoding: 'UTF-16LE',
      bom: true,
      newline: 'crlf',
    });
    await service.saveWorkingFile(repo.id, {
      pathBytes,
      token: preview.token,
      text: 'Saved 雪\r\n',
    });
    expect(await readFile(filename)).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Saved 雪\r\n', 'utf16le')]),
    );
    expect(fixtureGit(path, ['show', ':unicode.txt'])).toBe('Snow 雪');
    await service.undo(repo.id);
    expect(await readFile(filename)).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Draft 雪\r\n', 'utf16le')]),
    );
  } finally {
    await service.dispose();
  }
});

test('editor refuses lossy saves and changed encoding attributes', async () => {
  const path = createFixture(join(root, 'lossy'));
  const filename = join(path, 'legacy.txt'),
    pathBytes = Buffer.from('legacy.txt').toString('base64');
  await writeFile(join(path, '.gitattributes'), 'legacy.txt working-tree-encoding=windows-1252\n');
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  await writeFile(filename, bytes);
  const service = new RepositoryService('git', { dataDir: join(root, 'lossy-profile') });
  try {
    const repo = await service.open(path);
    const preview = await service.workingFile(repo.id, { pathBytes });
    expect(preview.text).toBe('café\n');
    await expect(
      service.saveWorkingFile(repo.id, { pathBytes, token: preview.token, text: '雪\n' }),
    ).rejects.toMatchObject({ code: 'EDITOR_ENCODING' });
    expect(await readFile(filename)).toEqual(bytes);
    await writeFile(join(path, '.gitattributes'), 'legacy.txt working-tree-encoding=ISO-8859-1\n');
    await expect(
      service.saveWorkingFile(repo.id, { pathBytes, token: preview.token, text: 'café edited\n' }),
    ).rejects.toMatchObject({ code: 'STALE_FILE' });
    expect(await readFile(filename)).toEqual(bytes);
  } finally {
    await service.dispose();
  }
});

test.skipIf(process.platform === 'win32')(
  'editor refuses links and leaves their external target untouched',
  async () => {
    const path = createFixture(join(root, 'links'));
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside\n');
    await symlink(outside, join(path, 'link.txt'));
    const service = new RepositoryService('git', { dataDir: join(root, 'links-profile') });
    try {
      const repo = await service.open(path);
      await expect(
        service.workingFile(repo.id, { pathBytes: Buffer.from('link.txt').toString('base64') }),
      ).rejects.toMatchObject({ code: 'EDITOR_UNSUPPORTED' });
      expect(await readFile(outside, 'utf8')).toBe('outside\n');
    } finally {
      await service.dispose();
    }
  },
);
