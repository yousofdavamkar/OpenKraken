import { expect, test } from 'vitest';
import { decodeHistoryPage, encodeHistoryPage, type Result } from './src/index.js';

const page: Extract<Result, { kind: 'page' }> = {
  kind: 'page',
  cursor: '00000000-0000-4000-8000-000000000001',
  offset: 2000,
  hasMore: false,
  commits: [],
};
const signature = { name: 'Zoë', email: 'a@example.test', time: -1, tzOffsetMin: -480 };

test('preserves page metadata and ordered message bodies across a structured clone', () => {
  const commits = ['', '🌱 "quotes" \\ slash\r\n\t\u0000end', '\nlong\n'.repeat(20000)].map(
    (body, i) => ({
      oid: String(i).repeat(64),
      parents: i === 2 ? ['a'.repeat(64), 'b'.repeat(64)] : [],
      author: signature,
      committer: { ...signature, name: 'Other', tzOffsetMin: 330 },
      summary: 'Independent summary',
      body,
      isStash: i === 1,
    }),
  );
  const original = { ...page, commits };
  const wire = structuredClone(encodeHistoryPage(original));
  expect(wire.bodies).toEqual(commits.map((commit) => commit.body));
  expect(JSON.parse(wire.metadata).commits.every((c: object) => !Object.hasOwn(c, 'body'))).toBe(
    true,
  );
  expect(decodeHistoryPage(wire)).toStrictEqual(original);
  expect(decodeHistoryPage(encodeHistoryPage(page))).toStrictEqual(page);
  wire.bodies.pop();
  expect(() => decodeHistoryPage(wire)).toThrow('Incomplete history page');
});

test('returns ordinary error and cancellation responses intact', () => {
  for (const reply of [
    { kind: 'error', code: 'STALE_PAGE', message: 'Refresh' },
    { kind: 'cancelled' },
  ] as const)
    expect(decodeHistoryPage(reply)).toBe(reply);
});
