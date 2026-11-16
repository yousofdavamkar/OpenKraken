import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { NativeEditorDrafts } from './src/native-editor-drafts.js';

let profile: string;
let drafts: NativeEditorDrafts;
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'ok-native-doc-'));
  drafts = new NativeEditorDrafts(profile);
});
afterEach(async () => {
  await drafts.idle();
  await rm(profile, { recursive: true, force: true });
});
const checkout = {
  id: 'a'.repeat(64),
  path: join(tmpdir(), 'checkout'),
  gitDir: join(tmpdir(), 'checkout', '.git'),
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const start = (initial = 'source') => {
  const request = randomUUID(),
    prompt = randomUUID();
  drafts.register(
    checkout,
    request,
    prompt,
    join(checkout.gitDir, 'rebase-merge', 'message'),
    initial,
  );
  return { request, prompt };
};

test('only a matching completed native write clears submitted text, including an in-flight profile write', async () => {
  const a = start();
  const saving = drafts.write(a.request, a.prompt, 'reviewed text');
  drafts.closed(a.request, a.prompt, 'submitted');
  const confirmed = drafts.written(a.request, a.prompt, hash('reviewed text'));
  await Promise.all([saving, confirmed]);
  expect((await drafts.list(checkout)).entries).toEqual([]);
  for (const completion of ['none', 'wrong digest', 'wrong parent']) {
    const { request, prompt } = start();
    await drafts.write(request, prompt, completion);
    drafts.closed(request, prompt, 'submitted');
    if (completion === 'wrong digest')
      await drafts.written(request, prompt, hash('other contents'));
    if (completion === 'wrong parent') await drafts.written(randomUUID(), prompt, hash(completion));
    drafts.finished(request);
    expect((await drafts.read(checkout, prompt)).text).toBe(completion);
  }
});

test('retry candidates are scoped to checkout, document and original contents, and deletion checks the reviewed revision', async () => {
  const a = start();
  await drafts.write(a.request, a.prompt, 'saved');
  drafts.closed(a.request, a.prompt, 'aborted');
  const same = start(),
    changed = start('changed source');
  expect((await drafts.candidates(same.request, same.prompt)).entries).toMatchObject([
    { promptId: a.prompt, sameSource: true, path: join('rebase-merge', 'message') },
  ]);
  expect((await drafts.candidates(changed.request, changed.prompt)).entries).toMatchObject([
    { promptId: a.prompt, sameSource: false },
  ]);
  const other = {
    ...checkout,
    id: 'b'.repeat(64),
    path: join(tmpdir(), 'linked'),
    gitDir: join(checkout.gitDir, 'worktrees', 'linked'),
  };
  expect((await drafts.list(other)).entries).toEqual([]);
  await expect(drafts.read(other, a.prompt)).rejects.toThrow();
  const reviewed = await drafts.read(checkout, a.prompt);
  const folder = join(profile, 'native-editor-drafts');
  const file = join(folder, (await readdir(folder))[0]!);
  if (process.platform !== 'win32') expect((await lstat(file)).mode & 0o777).toBe(0o600);
  const newer = (await readFile(file, 'utf8')) + '\n';
  await writeFile(file, newer);
  await expect(drafts.remove(checkout, a.prompt, reviewed.revision)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe(newer);
  await drafts.remove(checkout, a.prompt, (await drafts.read(checkout, a.prompt)).revision);
  expect((await drafts.list(checkout)).entries).toEqual([]);
});

test('interrupted editor writes can be kept or discarded while stale and out-of-scope prompt identifiers are refused', async () => {
  const invalid = randomUUID(),
    requestId = randomUUID();
  drafts.register(checkout, requestId, invalid, join(checkout.path, 'work.txt'), 'input');
  expect(() => drafts.write(requestId, invalid, 'text')).toThrow();
  const a = start(),
    b = start();
  expect(() => drafts.write(a.request, b.prompt, 'text')).toThrow();
  await expect(drafts.dismiss(a.request, a.prompt, true)).rejects.toThrow();
  drafts.interrupt([a.request, b.request]);
  await drafts.write(a.request, a.prompt, 'keep');
  await drafts.dismiss(a.request, a.prompt, false);
  const writing = drafts.write(b.request, b.prompt, 'discard');
  const clearing = drafts.dismiss(b.request, b.prompt, true);
  drafts.interrupt([b.request]);
  drafts.closed(b.request, b.prompt, 'aborted');
  drafts.finished(b.request);
  expect(() => drafts.write(b.request, b.prompt, 'late')).toThrow();
  await Promise.all([writing, clearing]);
  expect((await drafts.list(checkout)).entries).toMatchObject([{ promptId: a.prompt }]);
  expect((await drafts.read(checkout, a.prompt)).text).toBe('keep');
});
