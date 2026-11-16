import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkingFileDrafts } from './src/working-file-drafts.js';

const left = { path: '/left', gitDir: '/common/.git' };
const right = { path: '/right', gitDir: '/common/.git/worktrees/right' };
const pathBytes = Buffer.from('docs/私.txt').toString('base64');
const draft = { text: 'unsubmitted text', newline: 'crlf', token: 'f'.repeat(64) } as const;
let profile: string;
afterEach(async () => {
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('working draft inventory isolates checkout and raw path, preserves previews on native close and drains writes on discard', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-working-draft-list-'));
  const drafts = new WorkingFileDrafts(profile);
  await drafts.open(left, pathBytes, 'first');
  await drafts.write('first', draft);
  expect(await drafts.list(right)).toEqual({ entries: [], unreadable: false });
  expect(await drafts.list(left)).toEqual({
    entries: [{ path: 'docs/私.txt', pathBytes }],
    unreadable: false,
  });
  await drafts.open(right, pathBytes, 'other');
  await expect(drafts.write('first', null)).rejects.toThrow();
  await drafts.close('first', true);
  await drafts.write('other', { ...draft, text: 'right' });
  expect(await drafts.open(left, pathBytes, 'preview', true)).toEqual(draft);
  await expect(drafts.write('preview', null)).rejects.toThrow();
  await drafts.close(undefined, true);
  expect(await drafts.open(left, pathBytes, 'reopened')).toEqual(draft);
  const writing = drafts.write('reopened', { ...draft, text: 'newest' });
  const discarding = drafts.close(undefined, true);
  await Promise.all([writing, discarding]);
  expect(await drafts.open(left, pathBytes, 'cleared')).toBeNull();
  expect(await drafts.open(right, pathBytes, 'right')).toMatchObject({ text: 'right' });
});

test('an external draft edit prevents stale removal and corrupt drafts survive listing', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-working-draft-external-'));
  const drafts = new WorkingFileDrafts(profile);
  await drafts.open(left, pathBytes, 'edit');
  await drafts.write('edit', draft);
  const folder = join(profile, 'working-file-drafts');
  const [name] = await readdir(folder);
  expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
  const file = join(folder, name!);
  if (process.platform !== 'win32') expect((await lstat(file)).mode & 0o777).toBe(0o600);
  const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes + '\n');
  await expect(drafts.close('edit', true)).rejects.toThrow('Draft changed');
  expect(await readFile(file, 'utf8')).toBe(bytes + '\n');
  await writeFile(file, 'incomplete');
  expect(await drafts.list(left)).toEqual({ entries: [], unreadable: true });
  await expect(drafts.write('edit', draft)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('incomplete');
});

test('working text and conflict choices have separate identities for the same checkout path', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-conflict-draft-scope-'));
  const drafts = new WorkingFileDrafts(profile);
  await drafts.open(left, pathBytes, 'file');
  await drafts.write('file', draft);
  const conflict = {
    editor: 'conflict',
    token: draft.token,
    text: 'merged',
    choices: [{ index: 1, ours: '01', theirs: '0' }],
  } as const;
  const saved = { ...conflict, choices: [...conflict.choices] };
  await expect(drafts.write('file', saved)).rejects.toThrow();
  expect(await drafts.open(left, pathBytes, 'merge', false, 'conflict')).toBeNull();
  await expect(drafts.write('merge', draft)).rejects.toThrow();
  await drafts.write('merge', saved);
  await drafts.close('merge', false);
  expect((await drafts.list(left)).entries).toEqual(
    expect.arrayContaining([
      { path: 'docs/私.txt', pathBytes },
      { path: 'docs/私.txt', pathBytes, editor: 'conflict' },
    ]),
  );
  expect((await drafts.list(right)).entries).toEqual([]);
  expect(await drafts.open(left, pathBytes, 'preview', true, 'conflict')).toEqual(saved);
  await drafts.close('preview', true);
  expect(await drafts.open(left, pathBytes, 'file')).toEqual(draft);
  expect((await drafts.list(left)).entries).toHaveLength(1);
});

test('partially merged output can exceed the size of a single stage', async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-conflict-draft-size-'));
  const drafts = new WorkingFileDrafts(profile);
  await drafts.open(left, pathBytes, 'edit', false, 'conflict');
  const text = 'line\n'.repeat(250000) + 'x'.repeat(1024 * 1024);
  await drafts.write('edit', { editor: 'conflict', text, token: draft.token, choices: [] });
  const reopened = await drafts.open(left, pathBytes, 'reopened', false, 'conflict');
  expect(reopened?.text === text).toBe(true);
});
