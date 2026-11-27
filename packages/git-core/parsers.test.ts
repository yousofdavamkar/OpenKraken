import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  HistoryParser,
  rawHistoryStream,
  RefsParser,
  StatusParser,
  NulDecoder,
  TextNulDecoder,
} from './src/parsers.js';
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
  test('NUL decoding preserves binary fields across arbitrary chunk boundaries', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.uint8Array({ maxLength: 400 }).filter((field) => !field.includes(0)),
          { minLength: 1, maxLength: 30 },
        ),
        fc.integer({ min: 1, max: 1024 }),
        (fields, size) => {
          const records: Buffer[] = [];
          const decoder = new NulDecoder((field) => records.push(field), 400);
          const data = Buffer.concat(
            fields.flatMap((field) => [Buffer.from(field), Buffer.from([0])]),
          );
          feed(decoder, data, size);
          const text: string[] = [];
          feed(new TextNulDecoder((field) => text.push(field), 400), data, size);
          expect(text).toEqual(fields.map((field) => Buffer.from(field).toString('utf8')));
          // Completed fields are owned buffers; retained rename paths must not
          // alias a subsequently reused input chunk.
          data.fill(0xff);
          expect(records).toEqual(fields.map((field) => Buffer.from(field)));
        },
      ),
      { seed: 94095, numRuns: 500 },
    );
  });
  test('NUL limits include fragments and permit only the optional final newline', () => {
    const records: Buffer[] = [];
    const exact = new NulDecoder((field) => records.push(field), 3);
    exact.push(Buffer.from('ab'));
    exact.push(Buffer.from('c\0\0\n'));
    exact.finish(true);
    expect(records).toEqual([Buffer.from('abc'), Buffer.alloc(0)]);
    const texts: string[] = [];
    const text = new TextNulDecoder((field) => texts.push(field), 3);
    feed(text, Buffer.from('abc\0\0'), 2);
    text.push(Buffer.from('\n'));
    text.finish(true);
    expect(texts).toEqual(['abc', '']);
    for (const Decoder of [NulDecoder, TextNulDecoder]) {
      for (const chunks of [['abcd\0'], ['ab', 'cd\0'], ['abc', 'd'], ['a\0bbbb\0c\0'], ['😀\0']]) {
        const decoder = new Decoder(() => {}, 3);
        expect(() => chunks.forEach((chunk) => decoder.push(Buffer.from(chunk)))).toThrow('limit');
      }
      for (const trailing of ['\n\n', 'x', '\r\n', '\ufffd']) {
        const decoder = new Decoder(() => {});
        decoder.push(Buffer.from(`ok\0${trailing}`));
        expect(() => decoder.finish(true)).toThrow('Truncated');
      }
      const strict = new Decoder(() => {});
      strict.push(Buffer.from('\n'));
      expect(() => strict.finish()).toThrow('Truncated');
    }
  });
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
      fc.property(path, fc.integer({ min: 1, max: 25 }), (name, size) => {
        const data = Buffer.from(
          `refs/heads/${name}\0${hash}\0commit\0\0\0refs/remotes/origin/main\0[ahead 2, behind 3]\0*\0\n`,
        );
        const result = feed(new RefsParser(), data, size) as ReturnType<RefsParser['finish']>;
        expect(result[0]).toMatchObject({
          name: `refs/heads/${name}`,
          isHead: true,
          upstream: { ahead: 2, behind: 3 },
        });
      }),
      { numRuns: 300 },
    );
  });
  test('ref batches keep rich fields attached to their record at every byte boundary', () => {
    const target = 'b'.repeat(64);
    const data = Buffer.from(
      [
        ['refs/heads/café', hash, 'commit', '', '', 'refs/remotes/origin/main', '[gone]', '*'],
        ['refs/tags/雪', target, 'tag', hash, 'commit', '', '', ' '],
        ['refs/stash', hash, 'commit', '', '', '', '', ' '],
      ]
        .map((fields) => fields.join('\0') + '\0\n')
        .join(''),
    );
    const expected = [
      {
        name: 'refs/heads/café',
        shortName: 'café',
        kind: 'local',
        target: hash,
        objectType: 'commit',
        peeledType: '',
        isHead: true,
        upstream: { ref: 'refs/remotes/origin/main', ahead: 0, behind: 0, gone: true },
      },
      {
        name: 'refs/tags/雪',
        shortName: '雪',
        kind: 'tag',
        target,
        objectType: 'tag',
        peeled: hash,
        peeledType: 'commit',
        isHead: false,
      },
      {
        name: 'refs/stash',
        shortName: 'refs/stash',
        kind: 'stash',
        target: hash,
        objectType: 'commit',
        peeledType: '',
        isHead: false,
      },
    ];
    for (let cut = 0; cut <= data.length; cut++) {
      const parser = new RefsParser();
      parser.push(data.subarray(0, cut));
      parser.push(data.subarray(cut));
      expect(parser.finish()).toEqual(expected);
    }
    const incomplete = new RefsParser();
    incomplete.push(data);
    incomplete.push(Buffer.from('refs/tags/unread\0'));
    expect(() => incomplete.finish()).toThrow('Truncated ref');
  });
  test('direct reference records preserve tracking and HEAD across every chunk boundary', () => {
    const hash = 'b'.repeat(64);
    const fields = [
      ['refs/heads/作業', hash, 'commit', 'refs/remotes/origin/main', '[ahead 2, behind 1]', '*'],
      ['refs/tags/v1', hash, 'tag', '', '', ' '],
    ];
    const data = Buffer.from(fields.map((row) => row.join('\0') + '\0\n').join(''));
    const full = Buffer.from(
      fields
        .map((row) => [...row.slice(0, 3), '', '', ...row.slice(3)].join('\0') + '\0\n')
        .join(''),
    );
    const expected = feed(new RefsParser(), full, 7);
    for (let cut = 0; cut <= data.length; cut++) {
      const parser = new RefsParser('direct');
      parser.push(data.subarray(0, cut));
      parser.push(data.subarray(cut));
      expect(parser.finish()).toEqual(expected);
    }
    const partial = new RefsParser('direct');
    partial.push(Buffer.from(fields[0]!.slice(0, 5).join('\0') + '\0'));
    expect(() => partial.finish()).toThrow('Truncated ref');
  });
  test.each([40, 64])('ref aliases preserve complete %i-character IDs across reads', (width) => {
    const outer = 'a'.repeat(width);
    const commit = 'b'.repeat(width);
    const other = 'c'.repeat(width);
    const record = (name: string, target: string, peeled: string) =>
      Buffer.from(
        [`refs/tags/${name}`, target, 'tag', peeled, 'commit', '', '', ' ', '\n'].join('\0'),
      );
    const parser = new RefsParser();
    for (const [name, target, peeled] of [
      ['first', outer, commit],
      ['same', outer, commit],
      ['retagged', other, commit],
      ['last', outer, other],
    ] as const) {
      parser.push(record(name, target, peeled));
    }
    expect(parser.finish().map(({ target, peeled }) => [target, peeled])).toEqual([
      [outer, commit],
      [outer, commit],
      [other, commit],
      [outer, other],
    ]);
    // An emitted record is mutable. It must never become the source of validation.
    for (const bad of [
      '',
      outer.slice(1),
      outer + 'a',
      outer.slice(1) + 'g',
      outer.slice(1) + 'A',
      outer.slice(1) + 'é',
      outer.slice(1) + '\n',
    ]) {
      const targets = new RefsParser();
      targets.push(record('good', outer, commit));
      targets.value[0]!.target = bad;
      expect(() => targets.push(record('bad', bad, commit))).toThrow('Invalid object ID');
      if (bad) {
        const peels = new RefsParser();
        peels.push(record('good', outer, commit));
        peels.value[0]!.peeled = bad;
        expect(() => peels.push(record('bad', outer, bad))).toThrow('Invalid object ID');
      }
    }
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
  test('graph and log records match the original history stream at every byte boundary', () => {
    const second = 'b'.repeat(64);
    const record = (id: string, parents: string, body: string, mode: 'log' | 'walk' | 'legacy') =>
      [
        mode === 'walk'
          ? `commit ${id}${parents ? ' ' + parents : ''}\n`
          : mode === 'legacy'
            ? `commit ${id}\n${id}`
            : id,
        mode === 'walk' ? '' : parents,
        'Zoë',
        '',
        '0',
        '1970-01-01 01:00:00 +0100',
        'C',
        'c@example.test',
        '0',
        '1970-01-01 00:00:00 +0000',
        body,
        '',
        '',
      ].join('\0');
    const stream = (mode: 'log' | 'walk' | 'legacy') =>
      Buffer.from(
        [
          record(second, hash, 'subject 🌱\n\ncommit fake\nbody', mode),
          record(hash, '', '', mode),
          '',
        ].join('\n'),
      );
    const legacy = new HistoryParser();
    legacy.push(stream('legacy'));
    const expected = legacy.finish();
    for (const mode of ['walk', 'log'] as const) {
      const data = stream(mode);
      for (let cut = 0; cut <= data.length; cut++) {
        const parser = new HistoryParser();
        parser.push(data.subarray(0, cut));
        parser.push(data.subarray(cut));
        expect(parser.finish()).toEqual(expected);
      }
    }
    const data = stream('walk');
    expect(expected[0]).toMatchObject({ oid: second, parents: [hash], summary: 'subject 🌱' });
    const truncated = new HistoryParser();
    truncated.push(data.subarray(0, data.length - 2));
    expect(() => truncated.finish()).toThrow();
  });
  test.each(['walk', 'log'] as const)(
    'raw %s dates survive byte boundaries and reject incomplete offsets',
    (source) => {
      const parent = 'b'.repeat(40);
      const record = (date: string) =>
        Buffer.from(
          [
            source === 'walk' ? `commit ${hash} ${parent}\n` : hash,
            source === 'walk' ? '' : parent,
            'Zoë',
            'a@example.test',
            date,
            'René',
            'b@example.test',
            '1 +0545',
            'one\ntwo',
            '',
            '\n',
          ].join('\0'),
        );
      const { parser } = rawHistoryStream(source);
      expect(feed(parser, record('0 -0330'), 1)).toMatchObject([
        {
          oid: hash,
          parents: [parent],
          body: 'one\ntwo',
          author: { name: 'Zoë', time: 0, tzOffsetMin: -210 },
          committer: { name: 'René', time: 1, tzOffsetMin: 345 },
        },
      ]);
      for (const malformed of ['0', '-0330', '0 -03', '0  +0545', '0 +05:45']) {
        expect(() => feed(rawHistoryStream(source).parser, record(malformed), 3)).toThrow(
          'Invalid commit timestamp',
        );
      }
    },
  );
  test('streamed history decodes invalid UTF-8 per field and enforces the message byte limit', () => {
    const prefix = Buffer.from(
      [
        `commit ${hash}\n${hash}`,
        '',
        'A',
        '',
        '0',
        '1970-01-01 00:00:00 +0000',
        'C',
        '',
        '0',
        '1970-01-01 00:00:00 +0000',
        '',
      ].join('\0'),
    );
    const messages: string[] = [];
    const parser = new HistoryParser((commit) => messages.push(commit.body));
    parser.push(prefix);
    parser.push(Buffer.from([0xf0, 0x9f]));
    parser.push(Buffer.from([0, 0, 10]));
    expect(parser.finish()).toEqual([]);
    expect(messages).toEqual(['\uFFFD']);

    const oversized = new HistoryParser();
    oversized.push(prefix);
    oversized.push(Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect(() => oversized.push(Buffer.from('b\0\0\n'))).toThrow('limit');
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
