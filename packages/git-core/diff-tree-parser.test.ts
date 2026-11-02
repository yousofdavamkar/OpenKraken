import { expect, test } from 'vitest';
import fc from 'fast-check';
import { DiffTreeParser } from './src/commit-files.js';
test('raw diff parsing preserves arbitrary path bytes across chunk boundaries', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 200 }).filter((bytes) => !bytes.includes(0)),
      fc.integer({ min: 1, max: 47 }),
      (bytes, size) => {
        const path = Buffer.from(bytes);
        const data = Buffer.concat([
          Buffer.from(`:100644 100755 ${'a'.repeat(40)} ${'b'.repeat(40)} R092\0old name\0`),
          path,
          Buffer.from([0]),
        ]);
        const parser = new DiffTreeParser();
        for (let start = 0; start < data.length; start += size)
          parser.push(data.subarray(start, start + size));
        expect(parser.finish()).toEqual([
          {
            path: path.toString('utf8'),
            pathBytes: path.toString('base64'),
            oldPath: 'old name',
            oldPathBytes: Buffer.from('old name').toString('base64'),
            newPath: path.toString('utf8'),
            newPathBytes: path.toString('base64'),
            oldMode: '100644',
            newMode: '100755',
            oldOid: 'a'.repeat(40),
            newOid: 'b'.repeat(40),
            status: 'renamed',
            similarity: 92,
          },
        ]);
      },
    ),
    { seed: 141500, numRuns: 500 },
  );
});
test('raw diff parsing rejects malformed and truncated records', () => {
  for (const data of [
    'invalid\0',
    `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R100\0one\0`,
    `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0`,
  ]) {
    expect(() => {
      const parser = new DiffTreeParser();
      parser.push(Buffer.from(data));
      parser.finish();
    }).toThrow();
  }
});
