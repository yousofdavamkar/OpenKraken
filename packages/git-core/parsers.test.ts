import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { HistoryParser, RefsParser, StatusParser, NulDecoder } from './src/parsers.js';
const hash = 'a'.repeat(40);
function feed<T extends { push(b: Buffer): void; finish(): unknown }>(
  parser: T,
  data: Buffer,
  size: number,
) {
  for (let i = 0; i < data.length; i += size) parser.push(data.subarray(i, i + size));
  return parser.finish();
}
const path = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.includes('\0'));
describe('stream parsers', () => {
  test('status preserves arbitrary path bytes and rename boundaries', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 200 }).filter((b) => !b.includes(0)),
        fc.integer({ min: 1, max: 31 }),
        (bytes, size) => {
          const data = Buffer.concat([
            Buffer.from(`2 R. N... 100644 100644 100644 ${hash} ${hash} R100 `),
            Buffer.from(bytes),
            Buffer.from('\0old name\n.txt\0'),
          ]);
          const result = feed(new StatusParser(), data, size) as ReturnType<StatusParser['finish']>;
          expect(result.entries[0]?.pathBytes).toBe(Buffer.from(bytes).toString('base64'));
          expect(result.entries[0]?.origPath).toBe('old name\n.txt');
        },
      ),
      { numRuns: 400 },
    );
  });
  test('branch counts, conflicts, ignored and untracked', () => {
    const p = new StatusParser();
    p.push(
      Buffer.from(
        `# branch.ab +12 -3\0# branch.upstream origin/main\0u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict\0? new file\0! ignored\0`,
      ),
    );
    const result = p.finish();
    expect(result).toMatchObject({ ahead: 12, behind: 3, upstream: 'origin/main' });
    expect(result.entries[0]?.stages?.ours).toBe(hash);
  });
  test('refs handle empty fields and ahead/behind', () => {
    fc.assert(
      fc.property(path, fc.integer({ min: 1, max: 25 }), (subject, size) => {
        const data = Buffer.from(
          `refs/heads/main\0${hash}\0commit\0\0\0refs/remotes/origin/main\0[ahead 2, behind 3]\0*\0${subject}\0\n`,
        );
        const result = feed(new RefsParser(), data, size) as ReturnType<RefsParser['finish']>;
        expect(result[0]).toMatchObject({
          subject,
          isHead: true,
          upstream: { ahead: 2, behind: 3 },
        });
      }),
      { numRuns: 300 },
    );
  });
  test('history empty parents/body, unicode and fake header in messages', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes('\0')),
        fc.integer({ min: 1, max: 19 }),
        (body, size) => {
          const data = Buffer.from(
            [
              `commit ${hash}\n${hash}`,
              '',
              'Zoë',
              'a@example.test',
              '1700000000',
              '2023-11-14 22:13:20 +0130',
              'René',
              'c@example.test',
              '1700000000',
              '2023-11-14 22:13:20 -0230',
              body,
              '',
              '\n',
            ].join('\0'),
          );
          const result = feed(new HistoryParser(), data, size) as ReturnType<
            HistoryParser['finish']
          >;
          expect(result[0]).toMatchObject({
            body,
            parents: [],
            author: { name: 'Zoë', tzOffsetMin: 90 },
            committer: { tzOffsetMin: -150 },
          });
        },
      ),
      { numRuns: 300 },
    );
  });
  test('malformed streams fail closed and bounded fields reject', () => {
    for (const Parser of [HistoryParser, RefsParser, StatusParser])
      expect(() => feed(new Parser(), Buffer.from('truncated'), 1)).toThrow();
    const decoder = new NulDecoder(() => {}, 3);
    expect(() => decoder.push(Buffer.from('abcd'))).toThrow('limit');
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 500 }), (bytes) => {
        for (const Parser of [StatusParser, RefsParser, HistoryParser]) {
          try {
            feed(new Parser(), Buffer.from(bytes), 3);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
          }
        }
      }),
    );
  });
});
