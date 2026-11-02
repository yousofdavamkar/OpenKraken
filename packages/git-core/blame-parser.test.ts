import { expect, test } from 'vitest';
import fc from 'fast-check';
import { BlameParser } from './src/blame.js';
import type { BlameLine } from '@openkraken/ipc-contract';
test('blame parsing preserves metadata and text over arbitrary byte boundaries', () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 100 }).filter((value) => !value.includes('\n')),
      fc.integer({ min: 1, max: 60 }),
      (text, size) => {
        const oid = 'b'.repeat(40),
          rows: BlameLine[] = [];
        const input = Buffer.from(
          `${oid} 7 1 1\nauthor Zoë 雪\nauthor-mail <author@example.test>\nauthor-time 1700000000\nsummary A summary\nfilename "old\\012name"\n\t${text}\n`,
        );
        const parser = new BlameParser((batch) => rows.push(...batch));
        for (let index = 0; index < input.length; index += size)
          parser.push(input.subarray(index, index + size));
        expect(parser.finish()).toEqual({ lines: 1 });
        expect(rows).toEqual([
          {
            oid,
            originalLine: 7,
            line: 1,
            author: 'Zoë 雪',
            email: 'author@example.test',
            time: 1700000000,
            summary: 'A summary',
            text,
          },
        ]);
      },
    ),
    { numRuns: 500, seed: 8127 },
  );
});
test('blame rejects incomplete and malformed records', () => {
  for (const input of [
    'bad header\n',
    `${'a'.repeat(40)} 1 1\nauthor Only a partial record\n`,
    `${'a'.repeat(40)} 1 1\n\tmissing metadata\n`,
  ])
    expect(() => {
      const parser = new BlameParser(() => {});
      parser.push(Buffer.from(input));
      parser.finish();
    }).toThrow();
});
