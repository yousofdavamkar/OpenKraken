import type { Commit, Ref, Status, StatusEntry } from '@openkraken/ipc-contract';

/** Buffer fields until NUL, not strings: UTF-8 codepoints can straddle chunks. */
export class NulDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(
    private accept: (field: Buffer) => void,
    private maxFieldBytes = 2 * 1024 * 1024,
  ) {}
  push(chunk: Buffer) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0) continue;
      this.append(chunk.subarray(start, i));
      this.accept(Buffer.concat(this.chunks, this.size));
      this.chunks = [];
      this.size = 0;
      start = i + 1;
    }
    this.append(chunk.subarray(start));
  }
  private append(chunk: Buffer) {
    this.size += chunk.length;
    if (this.size > this.maxFieldBytes) throw new Error('NUL field exceeds limit');
    if (chunk.length) this.chunks.push(chunk);
  }
  finish(allowFinalNewline = false) {
    if (allowFinalNewline && Buffer.concat(this.chunks, this.size).equals(Buffer.from('\n'))) {
      this.chunks = [];
      this.size = 0;
    }
    if (this.size) throw new Error('Truncated NUL record');
  }
}
function fieldsAndPath(record: Buffer, count: number): { fields: string[]; path: Buffer } {
  let start = 0;
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(32, start);
    if (end < 0) throw new Error('Malformed status record');
    fields.push(record.subarray(start, end).toString());
    start = end + 1;
  }
  if (start >= record.length) throw new Error('Missing status path');
  return { fields, path: record.subarray(start) };
}
export class StatusParser {
  readonly value: Status = { entries: [], ahead: 0, behind: 0 };
  private rename: StatusEntry | undefined;
  private decoder = new NulDecoder((record) => {
    if (this.rename) {
      this.rename.origPath = record.toString('utf8');
      this.rename.origPathBytes = record.toString('base64');
      this.rename = undefined;
      return;
    }
    const text = record.toString('utf8');
    if (text.startsWith('# ')) {
      if (text.startsWith('# branch.upstream ')) this.value.upstream = text.slice(18);
      if (text.startsWith('# branch.ab ')) {
        const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(text);
        if (!match) throw new Error('Malformed branch counts');
        this.value.ahead = Number(match[1]);
        this.value.behind = Number(match[2]);
      }
      return;
    }
    const type = text[0];
    if (!['1', '2', 'u', '?', '!'].includes(type ?? '')) throw new Error('Unknown status record');
    const { fields, path } = fieldsAndPath(
      record,
      type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 1,
    );
    const xy = fields[1] ?? (type === '!' ? '!!' : '??');
    const entry: StatusEntry = {
      path: path.toString('utf8'),
      pathBytes: path.toString('base64'),
      index: xy[0]!,
      worktree: xy[1]!,
      submodule: fields[2] ?? 'N...',
      kind:
        type === '1'
          ? 'ordinary'
          : type === '2'
            ? 'rename'
            : type === 'u'
              ? 'conflict'
              : type === '?'
                ? 'untracked'
                : 'ignored',
    };
    if (type === 'u') entry.stages = { base: fields[7]!, ours: fields[8]!, theirs: fields[9]! };
    this.value.entries.push(entry);
    if (type === '2') this.rename = entry;
  });
  push(chunk: Buffer) {
    this.decoder.push(chunk);
  }
  finish(): Status {
    this.decoder.finish();
    if (this.rename) throw new Error('Missing rename source');
    return this.value;
  }
}
export const REF_FORMAT =
  '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(upstream)%00%(upstream:track)%00%(HEAD)%00%(subject)%00';
const oid = (value: string) => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error('Invalid object ID');
  return value;
};
export class RefsParser {
  readonly value: Ref[] = [];
  private fields: string[] = [];
  private decoder = new NulDecoder((field) => {
    this.fields.push(field.toString('utf8'));
    if (this.fields.length !== 9) return;
    const [rawName, target, objectType, peeled, peeledType, upstream, track, head, subject] = this
      .fields as [string, string, string, string, string, string, string, string, string];
    const name = rawName.replace(/^\n/, '');
    if (!name.startsWith('refs/')) throw new Error('Invalid ref name');
    const kind = name.startsWith('refs/heads/')
      ? 'local'
      : name.startsWith('refs/remotes/')
        ? 'remote'
        : name.startsWith('refs/tags/')
          ? 'tag'
          : name === 'refs/stash'
            ? 'stash'
            : 'other';
    const ref: Ref = {
      name,
      target: oid(target),
      objectType,
      peeledType,
      shortName: name.replace(/^refs\/(heads|remotes|tags)\//, ''),
      kind,
      isHead: head === '*',
      subject,
    };
    if (peeled) ref.peeled = oid(peeled);
    if (upstream)
      ref.upstream = {
        ref: upstream,
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
        gone: track === '[gone]',
      };
    this.value.push(ref);
    this.fields = [];
  });
  push(chunk: Buffer) {
    this.decoder.push(chunk);
  }
  finish() {
    this.decoder.finish(true);
    if (this.fields.length) throw new Error('Truncated ref');
    return this.value;
  }
}
// Fixed field count is essential: empty parent lists or bodies are valid fields.
export const HISTORY_FORMAT =
  '%H%x00%P%x00%an%x00%ae%x00%at%x00%ai%x00%cn%x00%ce%x00%ct%x00%ci%x00%B%x00%x00';
function signature(name: string, email: string, time: string, date: string) {
  const zone = /([+-])(\d\d)(\d\d)$/.exec(date);
  if (!/^-?\d+$/.test(time) || !zone) throw new Error('Invalid commit timestamp');
  return {
    name,
    email,
    time: Number(time),
    tzOffsetMin: (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])),
  };
}
export class HistoryParser {
  constructor(private accept?: (commit: Commit) => void) {}
  readonly value: Commit[] = [];
  private fields: string[] = [];
  private decoder = new NulDecoder((field) => {
    this.fields.push(field.toString('utf8'));
    if (this.fields.length !== 12) return;
    const [header, parents, an, ae, at, ai, cn, ce, ct, ci, body, end] = this.fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const match = /^\n?commit [0-9a-f]+(?: [0-9a-f]+)*\n([0-9a-f]+)$/.exec(header);
    if (!match || end !== '') throw new Error('Malformed history record');
    const commit: Commit = {
      oid: oid(match[1]!),
      parents: parents ? parents.split(' ').map(oid) : [],
      author: signature(an, ae, at, ai),
      committer: signature(cn, ce, ct, ci),
      summary: body.split('\n')[0]!,
      body,
      isStash: false,
    };
    if (this.accept) this.accept(commit);
    else this.value.push(commit);
    this.fields = [];
  });
  push(chunk: Buffer) {
    this.decoder.push(chunk);
  }
  finish() {
    this.decoder.finish(true);
    if (this.fields.length) throw new Error('Truncated commit');
    return this.value;
  }
}
