import { expect, test } from 'vitest';
import {
  clampColumn,
  defaultColumnWidths,
  gridColumns,
  loadColumnWidths,
  saveColumnWidths,
  totalColumnsWidth,
} from './src/history-columns.js';

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
const repo = 'a'.repeat(64);

test('defaults reproduce the previous fixed layout', () => {
  expect(gridColumns(defaultColumnWidths, 100)).toBe(
    '130px 100px 80px minmax(160px, 1fr) 130px 90px',
  );
  expect(totalColumnsWidth(defaultColumnWidths, 100)).toBe(130 + 100 + 470);
});

test('widths round-trip per repository, clamp to limits and store only changes', () => {
  const storage = memory();
  expect(loadColumnWidths(repo, storage)).toEqual(defaultColumnWidths);
  expect(saveColumnWidths(repo, { ...defaultColumnWidths, author: 241.6 }, storage)).toBe(true);
  expect(JSON.parse(storage.values.get(`openkraken.history-columns.v1.${repo}`)!)).toEqual({
    author: 242,
  });
  expect(loadColumnWidths(repo, storage).author).toBe(242);
  expect(loadColumnWidths('b'.repeat(64), storage)).toEqual(defaultColumnWidths);
  saveColumnWidths(repo, defaultColumnWidths, storage);
  expect(storage.values.size).toBe(0);
  expect(clampColumn('commit', 5)).toBe(56);
  expect(clampColumn('refs', 9000)).toBe(480);
});

test('damaged or unavailable storage falls back to defaults', () => {
  const storage = memory();
  for (const raw of ['{', '[1]', '"x"', '{"refs":"wide","date":1e9,"commit":-4}']) {
    storage.values.set(`openkraken.history-columns.v1.${repo}`, raw);
    const widths = loadColumnWidths(repo, storage);
    expect(widths.refs).toBe(130);
    if (raw.includes('date')) expect(widths).toMatchObject({ date: 320, commit: 56 });
  }
  const failing = {
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {},
  };
  expect(saveColumnWidths(repo, { ...defaultColumnWidths, date: 100 }, failing)).toBe(false);
});
