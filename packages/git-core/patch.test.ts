import { afterAll, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import fc from 'fast-check';
import { parsePatch, selectPatch } from './src/patch.js';
const root = mkdtempSync(join(tmpdir(), 'openkraken-patches-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
test('selected replacement lines stage and unstage without including neighboring edits', () => {
  const path = createFixture(join(root, 'selection'));
  writeFileSync(join(path, 'tracked.txt'), 'one\ntwo\nthree\n');
  fixtureGit(path, ['add', 'tracked.txt']);
  fixtureGit(path, ['commit', '-m', 'Base']);
  writeFileSync(join(path, 'tracked.txt'), 'ONE\ntwo\nTHREE\n');
  const raw =
    fixtureGit(path, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--',
      'tracked.txt',
    ]) + '\n';
  const patch = parsePatch(raw, 'tracked.txt');
  const ids = patch.hunks
    .flatMap((h) => h.lines)
    .filter((l) => ['one', 'ONE'].includes(l.text))
    .map((l) => l.id);
  fixtureGit(
    path,
    ['apply', '--cached', '--recount', '--unidiff-zero', '-'],
    selectPatch(patch, ids),
  );
  expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe('ONE\ntwo\nthree');
  const staged = parsePatch(
    fixtureGit(path, ['diff', '--cached', '--', 'tracked.txt']) + '\n',
    'tracked.txt',
  );
  const stagedIds = staged.hunks
    .flatMap((h) => h.lines)
    .filter((l) => l.kind !== 'context')
    .map((l) => l.id);
  fixtureGit(
    path,
    ['apply', '--cached', '--recount', '--unidiff-zero', '-'],
    selectPatch(staged, stagedIds, true),
  );
  expect(fixtureGit(path, ['diff', '--cached'])).toBe('');
});
test('partial deletion, partial new files, disjoint hunks, and no-newline markers retain unselected bytes', () => {
  const path = createFixture(join(root, 'edges'));
  const cases = [
    ['deleted.txt', 'first\nsecond\n', null, ['first'], 'second'],
    ['new.txt', null, 'first\nsecond\n', ['second'], 'second'],
    ['eof.txt', 'old', 'new', ['old', 'new'], 'new'],
    [
      'far.txt',
      'old\n' + 'same\n'.repeat(10) + 'last\n',
      'NEW\n' + 'same\n'.repeat(10) + 'LAST\n',
      ['old', 'NEW', 'last', 'LAST'],
      'NEW\n' + 'same\n'.repeat(10) + 'LAST',
    ],
  ] as const;
  for (const [name, before] of cases) {
    if (before !== null) {
      writeFileSync(join(path, name), before);
      fixtureGit(path, ['add', '--', name]);
    }
  }
  fixtureGit(path, ['commit', '-m', 'Bases']);
  for (const [name, before, after, wanted, expected] of cases) {
    if (after === null) rmSync(join(path, name));
    else writeFileSync(join(path, name), after);
    if (before === null) fixtureGit(path, ['add', '-N', '--', name]);
    const patch = parsePatch(fixtureGit(path, ['diff', '--', name]) + '\n', name);
    const ids = patch.hunks
      .flatMap((h) => h.lines)
      .filter((l) => new Set<string>(wanted).has(l.text))
      .map((l) => l.id);
    fixtureGit(
      path,
      ['apply', '--cached', '--recount', '--unidiff-zero', '-'],
      selectPatch(patch, ids),
    );
    expect(fixtureGit(path, ['show', `:${name}`])).toBe(expected);
  }
});

test('10,000 random line selections produce exactly Git’s expected staged diff, forward and reverse', () => {
  const path = join(root, 'generated');
  mkdirSync(path);
  fixtureGit(path, ['init', '-b', 'main']);
  const cases = fc.sample(
    fc.array(
      fc.record({
        remove: fc.boolean(),
        add: fc.boolean(),
        selectRemove: fc.boolean(),
        selectAdd: fc.boolean(),
      }),
      { minLength: 1, maxLength: 30 },
    ),
    { seed: 73021, numRuns: 10000 },
  );
  const files = cases.map((rows, i) => {
    const base: string[] = [],
      changed: string[] = [],
      forward: string[] = [],
      reverse: string[] = [],
      selected = new Set<string>();
    // A replacement block has no stable interior anchor. Its old lines precede
    // its new lines in Git's canonical diff; partial selection keeps that order.
    let removed: { text: string; selected: boolean }[] = [],
      inserted: { text: string; selected: boolean }[] = [];
    const flush = () => {
      forward.push(
        ...removed.filter((l) => !l.selected).map((l) => l.text),
        ...inserted.filter((l) => l.selected).map((l) => l.text),
      );
      reverse.push(
        ...removed.filter((l) => l.selected).map((l) => l.text),
        ...inserted.filter((l) => !l.selected).map((l) => l.text),
      );
      removed = [];
      inserted = [];
    };
    rows.forEach((row, j) => {
      const old = `old-${i}-${j}`,
        added = `new-${i}-${j}`;
      base.push(old);
      if (!row.remove) {
        changed.push(old);
        flush();
        forward.push(old);
        reverse.push(old);
      } else removed.push({ text: old, selected: row.selectRemove });
      if (row.add) {
        changed.push(added);
        inserted.push({ text: added, selected: row.selectAdd });
      }
      if (row.remove && row.selectRemove) selected.add(old);
      if (row.add && row.selectAdd) selected.add(added);
    });
    flush();
    const text = (lines: string[]) => (lines.length ? lines.join('\n') + '\n' : '');
    return {
      base: text(base),
      changed: text(changed),
      forward: text(forward),
      reverse: text(reverse),
      selected,
    };
  });
  let stream = '';
  for (const [index, variant] of (['base', 'changed', 'forward', 'reverse'] as const).entries()) {
    stream += `commit refs/heads/${variant}\nmark :${index + 1}\ncommitter Fixture <fixture@example.test> 1700000000 +0000\ndata 8\nFixture\n`;
    files.forEach((file, i) => {
      const content = file[variant];
      stream += `M 100644 inline case-${i}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    });
    stream += '\n';
  }
  fixtureGit(path, ['fast-import', '--quiet'], stream + 'done\n');
  const raw =
    fixtureGit(path, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      'base',
      'changed',
    ]) + '\n';
  const patches = raw
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((section) => {
      const i = Number(/^diff --git a\/case-(\d+)\.txt /m.exec(section)![1]);
      const patch = parsePatch(section, `case-${i}.txt`);
      const ids = patch.hunks
        .flatMap((h) => h.lines)
        .filter((line) => files[i]!.selected.has(line.text))
        .map((line) => line.id);
      return { patch, ids };
    });
  for (const reverse of [false, true]) {
    fixtureGit(path, ['read-tree', reverse ? 'changed' : 'base']);
    const patch = patches
      .filter((p) => p.ids.length)
      .map((p) => selectPatch(p.patch, p.ids, reverse))
      .join('');
    fixtureGit(
      path,
      ['apply', '--cached', '--recount', '--unidiff-zero', '--whitespace=nowarn', '-'],
      patch,
    );
    const target = reverse ? 'reverse' : 'forward';
    const mismatch = fixtureGit(path, ['diff', '--cached', '--name-only', target])
      .split('\n')
      .filter(Boolean);
    expect(mismatch.slice(0, 5), `${target}: ${mismatch.length} mismatched cases`).toEqual([]);
    expect(fixtureGit(path, ['write-tree'])).toBe(
      fixtureGit(path, ['rev-parse', `${target}^{tree}`]),
    );
  }
}, 120000);
