import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryService } from './src/repository.js';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-comparison-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('commit comparison returns native blob contents and Git hunks without changing the workspace', async () => {
  const path = createFixture(join(root, 'text'));
  await writeFile(join(path, 'sample.txt'), 'alpha\nbeta\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Before']);
  await writeFile(join(path, 'sample.txt'), 'alpha\nBETA\nlast\n');
  fixtureGit(path, ['commit', '-am', 'After']);
  const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const result = await service.commitComparison(repo.id, {
      commit,
      pathBytes: Buffer.from('sample.txt').toString('base64'),
    });
    expect(result.oldVersion).toMatchObject({
      kind: 'text',
      text: 'alpha\nbeta\n',
      encoding: 'UTF-8',
      lines: 2,
    });
    expect(result.newVersion).toMatchObject({
      kind: 'text',
      text: 'alpha\nBETA\nlast\n',
      encoding: 'UTF-8',
      lines: 3,
    });
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 });
    expect(result.hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['context', 'alpha'],
      ['del', 'beta'],
      ['add', 'BETA'],
      ['add', 'last'],
    ]);
    expect(fixtureGit(path, ['rev-parse', 'HEAD'])).toBe(commit);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});
test('comparison applies native whitespace modes and separates binary from large text', async () => {
  const path = createFixture(join(root, 'formats'));
  await writeFile(join(path, 'spaces.txt'), 'one two\n');
  await writeFile(join(path, 'binary.dat'), Buffer.from([0, 1, 2]));
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Before formats']);
  await writeFile(join(path, 'spaces.txt'), 'one   two\n');
  await writeFile(join(path, 'binary.dat'), Buffer.from([0, 3, 4]));
  await writeFile(
    join(path, 'large.txt'),
    Array.from({ length: 50000 }, (_, index) => `line ${index}\n`).join(''),
  );
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'After formats']);
  const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const text = { commit, pathBytes: Buffer.from('spaces.txt').toString('base64') };
    expect((await service.commitComparison(repo.id, text)).hunks).toHaveLength(1);
    expect(
      (await service.commitComparison(repo.id, { ...text, whitespace: 'all' })).hunks,
    ).toHaveLength(0);
    expect(
      (await service.commitComparison(repo.id, { ...text, whitespace: 'changes' })).hunks,
    ).toHaveLength(0);
    const binary = await service.commitComparison(repo.id, {
      commit,
      pathBytes: Buffer.from('binary.dat').toString('base64'),
    });
    expect(binary.oldVersion).toMatchObject({ kind: 'binary', bytes: 3 });
    expect(binary.newVersion).toMatchObject({ kind: 'binary', bytes: 3 });
    expect(binary.hunks).toEqual([]);
    const selection = { commit, pathBytes: Buffer.from('large.txt').toString('base64') };
    const guarded = await service.commitComparison(repo.id, selection);
    expect(guarded.guard).toEqual({ reason: 'lines', limit: 10000, canLoad: true });
    expect(guarded.newVersion.text).toBeUndefined();
    const loaded = await service.commitComparison(repo.id, { ...selection, allowLarge: true });
    expect(loaded.guard).toBeUndefined();
    expect(loaded.oldVersion.kind).toBe('missing');
    expect(loaded.newVersion).toMatchObject({ kind: 'text', lines: 50000 });
    expect(loaded.hunks[0]?.lines).toHaveLength(50000);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});

test('comparison detects Shift-JIS and UTF-16 and permits an explicit legacy encoding', async () => {
  const path = createFixture(join(root, 'encodings'));
  const japanese = '日本語のテキストです。これは文字コードの比較を確認するための文章です。\n';
  await writeFile(
    join(path, 'japanese.txt'),
    Buffer.from(
      '93fa967b8cea82cc8365834c8358836782c582b7814282b182ea82cd95b68e9a8352815b836882cc94e48a7282f08a6d944682b782e982bd82df82cc95b68fcd82c582b781420a',
      'hex',
    ),
  );
  await writeFile(
    join(path, 'unicode.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Snow 雪\n', 'utf16le')]),
  );
  await writeFile(join(path, 'legacy.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Encoded text']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
    const selection = (file: string) => ({
      commit,
      pathBytes: Buffer.from(file).toString('base64'),
    });
    const detected = await service.commitComparison(repo.id, selection('japanese.txt'));
    expect(detected.newVersion).toMatchObject({
      kind: 'text',
      encoding: 'Shift_JIS',
      text: japanese,
    });
    const unicode = await service.commitComparison(repo.id, selection('unicode.txt'));
    expect(unicode.newVersion).toMatchObject({
      kind: 'text',
      encoding: 'UTF-16LE',
      text: 'Snow 雪\n',
    });
    const legacy = await service.commitComparison(repo.id, {
      ...selection('legacy.txt'),
      encoding: 'windows-1252',
    });
    expect(legacy.newVersion).toMatchObject({
      kind: 'text',
      encoding: 'windows-1252',
      text: 'café\n',
    });
    expect(legacy.hunks[0]?.lines[0]?.text).toBe('café');
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});

test('comparison exposes bounded raster images but refuses excessive dimensions and active markup', async () => {
  const path = createFixture(join(root, 'images'));
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
    'base64',
  );
  const huge = Buffer.from(pixel);
  huge.writeUInt32BE(100000, 16);
  await writeFile(join(path, 'pixel.png'), pixel);
  await writeFile(join(path, 'huge.png'), huge);
  await writeFile(
    join(path, 'markup.png'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Image fixtures']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
    const compare = (file: string) =>
      service.commitComparison(repo.id, {
        commit,
        pathBytes: Buffer.from(file).toString('base64'),
      });
    const result = await compare('pixel.png');
    expect(result.newVersion).toMatchObject({
      kind: 'image',
      image: { mime: 'image/png', width: 1, height: 1, base64: pixel.toString('base64') },
    });
    expect(result.hunks).toEqual([]);
    const refused = await compare('huge.png');
    expect(refused.newVersion.kind).toBe('binary');
    expect(refused.newVersion.image).toBeUndefined();
    const markup = await compare('markup.png');
    expect(markup.newVersion.kind).toBe('text');
    expect(markup.newVersion.image).toBeUndefined();
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
  } finally {
    await service.dispose();
  }
});

test('comparison identifies LFS pointers without fetching objects or treating them as editable text', async () => {
  const path = createFixture(join(root, 'lfs-pointers'));
  const oid = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`;
  await writeFile(join(path, 'asset.bin'), pointer);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'LFS pointer']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const options = {
      commit: fixtureGit(path, ['rev-parse', 'HEAD']),
      pathBytes: Buffer.from('asset.bin').toString('base64'),
    };
    const result = await service.commitComparison(repo.id, options);
    expect(result.newVersion).toMatchObject({ kind: 'lfs', lfs: { oid, size: '12345' } });
    expect(result.newVersion.text).toBeUndefined();
    expect(result.hunks).toEqual([]);
    expect(fixtureGit(path, ['status', '--porcelain'])).toBe('');
    await writeFile(join(path, 'asset.bin'), pointer.replace('size 12345', 'size invalid'));
    fixtureGit(path, ['commit', '-am', 'Not a pointer']);
    const invalid = await service.commitComparison(repo.id, {
      ...options,
      commit: fixtureGit(path, ['rev-parse', 'HEAD']),
    });
    expect(invalid.oldVersion.kind).toBe('lfs');
    expect(invalid.newVersion).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('size invalid'),
    });
  } finally {
    await service.dispose();
  }
});

test('LFS pointer recognition preserves large size metadata and rejects ambiguous or malformed encodings', async () => {
  const path = createFixture(join(root, 'lfs-validation'));
  const version = 'version https://git-lfs.github.com/spec/v1\n';
  const oid = `oid sha256:${'b'.repeat(64)}\n`;
  const cases = [
    [
      'extension',
      `${version}ext-0-fixture sha256:${'c'.repeat(64)}\n${oid}size 9223372036854775807\n`,
      'lfs',
    ],
    ['legacy', `version https://hawser.github.com/spec/v1\n${oid}size 0\n`, 'lfs'],
    ['duplicate', `${version}${oid}${oid}size 1\n`, 'text'],
    ['unsorted', `${version}size 1\n${oid}`, 'text'],
    ['oversized-number', `${version}${oid}size 9223372036854775808\n`, 'text'],
    ['oversized-pointer', `${version}extra ${'a'.repeat(1024)}\n${oid}size 1\n`, 'text'],
    ['crlf', `${version}${oid}size 1\n`.replaceAll('\n', '\r\n'), 'text'],
    ['no-newline', `${version}${oid}size 1`, 'text'],
  ] as const;
  for (const [name, text] of cases) await writeFile(join(path, name), text);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'Pointer validation']);
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(path);
    const commit = fixtureGit(path, ['rev-parse', 'HEAD']);
    for (const [name, , kind] of cases) {
      const result = await service.commitComparison(repo.id, {
        commit,
        pathBytes: Buffer.from(name).toString('base64'),
      });
      expect(result.newVersion.kind, name).toBe(kind);
      if (name === 'extension') expect(result.newVersion.lfs?.size).toBe('9223372036854775807');
    }
  } finally {
    await service.dispose();
  }
});
