import { expect, test } from 'vitest';
import fc from 'fast-check';
import { FileHistoryParser } from './src/file-history.js';
test('file-history streaming preserves arbitrary raw filenames and UTF-8 authors across chunk boundaries', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 200 }).filter((bytes) => !bytes.includes(0)),
      fc.integer({ min: 1, max: 80 }),
      (path, size) => {
        const oid = 'a'.repeat(40);
        const input = Buffer.concat([
          Buffer.from([oid, 'Zoë', '1700000000', 'Rename', '\nR100', 'old', ''].join('\0')),
          Buffer.from(path),
          Buffer.from([0]),
        ]);
        const parser = new FileHistoryParser();
        for (let index = 0; index < input.length; index += size)
          parser.push(input.subarray(index, index + size));
        expect(parser.finish()).toEqual([
          {
            oid,
            author: 'Zoë',
            time: 1700000000,
            summary: 'Rename',
            path: Buffer.from(path).toString('utf8'),
            pathBytes: Buffer.from(path).toString('base64'),
            status: 'R',
          },
        ]);
      },
    ),
    { numRuns: 500, seed: 7142 },
  );
});
test('file history refuses malformed and truncated records', () => {
  for (const input of [
    'invalid\0author\0time\0summary\0\nM\0path\0',
    `${'a'.repeat(40)}\0author\0`,
  ]) {
    expect(() => {
      const parser = new FileHistoryParser();
      parser.push(Buffer.from(input));
      parser.finish();
    }).toThrow();
  }
});
