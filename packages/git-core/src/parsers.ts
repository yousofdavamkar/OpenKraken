import { StringDecoder } from 'node:string_decoder';
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
/** UTF-8 records with byte limits; decode each read once instead of each field. */
class TextNulFields {
  private utf8 = new StringDecoder('utf8');
  private pending = '';
  private size = 0;
  constructor(private maxFieldBytes = 2 * 1024 * 1024) {}
  push(chunk: Buffer) {
    const first = chunk.indexOf(0);
    if (first < 0) {
      this.size += chunk.length;
      if (this.size > this.maxFieldBytes) throw new Error('NUL field exceeds limit');
    } else {
      if (this.size + first > this.maxFieldBytes) throw new Error('NUL field exceeds limit');
      // Ordinary process reads fit below the field limit. Larger caller-supplied
      // chunks need each intervening field checked as well as the final tail.
      let start = first + 1;
      while (chunk.length - start > this.maxFieldBytes) {
        const end = chunk.indexOf(0, start);
        if (end < 0 || end - start > this.maxFieldBytes) throw new Error('NUL field exceeds limit');
        start = end + 1;
      }
      this.size = chunk.length - chunk.lastIndexOf(0) - 1;
    }
    const fields = this.utf8.write(chunk).split('\0');
    fields[0] = this.pending + fields[0]!;
    this.pending = fields.pop()!;
    return fields;
  }
  finish(allowFinalNewline = false) {
    if (allowFinalNewline && this.size === 1 && this.pending === '\n') {
      this.pending = '';
      this.size = 0;
    }
    if (this.size) throw new Error('Truncated NUL record');
  }
}
export class TextNulDecoder {
  private fields: TextNulFields;
  constructor(
    private accept: (field: string) => void,
    maxFieldBytes?: number,
  ) {
    this.fields = new TextNulFields(maxFieldBytes);
  }
  push(chunk: Buffer) {
    for (const field of this.fields.push(chunk)) this.accept(field);
  }
  finish(allowFinalNewline = false) {
    this.fields.finish(allowFinalNewline);
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
  '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(upstream)%00%(upstream:track)%00%(HEAD)%00';
// Existing callers can feed this unpeeled, eight-field stream to the default parser.
export const REF_DIRECT_FORMAT =
  '%(refname)%00%(objectname)%00%(objecttype)%00%00%00%(upstream)%00%(upstream:track)%00%(HEAD)%00';
const directRefFormat =
  '%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00%(upstream:track)%00%(HEAD)%00';
const oid = (value: string) => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error('Invalid object ID');
  return value;
};
const refPrefixLength = {
  local: 'refs/heads/'.length,
  remote: 'refs/remotes/'.length,
  tag: 'refs/tags/'.length,
  stash: 0,
  other: 0,
};

export class RefsParser {
  readonly value: Ref[] = [];
  private pendingFields: string[] = [];
  private decoder = new TextNulFields();
  private readonly width: 6 | 8;
  constructor(format: 'full' | 'direct' = 'full') {
    this.width = format === 'direct' ? 6 : 8;
  }
  get gitFormat() {
    return this.width === 6 ? directRefFormat : REF_FORMAT;
  }
  private append(fields: string[], offset: number) {
    const rawName = fields[offset]!;
    const name = rawName.startsWith('\n') ? rawName.slice(1) : rawName;
    const target = fields[offset + 1]!;
    const objectType = fields[offset + 2]!;
    const peeled = this.width === 8 ? fields[offset + 3]! : '';
    const peeledType = this.width === 8 ? fields[offset + 4]! : '';
    const end = offset + this.width;
    const upstream = fields[end - 3]!;
    const track = fields[end - 2]!;
    const head = fields[end - 1]!;
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
      shortName: name.slice(refPrefixLength[kind]),
      kind,
      isHead: head === '*',
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
  }
  push(chunk: Buffer) {
    // Read complete records directly from the decoded chunk.
    const batch = this.decoder.push(chunk);
    const fields = this.pendingFields.length ? this.pendingFields.concat(batch) : batch;
    let offset = 0;
    for (; offset + this.width <= fields.length; offset += this.width) this.append(fields, offset);
    this.pendingFields = fields.slice(offset);
  }
  finish() {
    this.decoder.finish(true);
    if (this.pendingFields.length) throw new Error('Truncated ref');
    return this.value;
  }
}
// Fixed field count is essential: empty parent lists or bodies are valid fields.
const historyDetails = '%an%x00%ae%x00%at%x00%ai%x00%cn%x00%ce%x00%ct%x00%ci%x00%B%x00%x00';
export const HISTORY_FORMAT = '%H%x00%P%x00' + historyDetails;
// rev-list --parents supplies "commit <oid> <parents>\n" before this custom format.
export const HISTORY_WALK_FORMAT = '%x00%x00' + historyDetails;
// Git's raw dates contain epoch seconds and the recorded UTC offset, even
// when applying that offset would place the local calendar date before 1970.
export function rawHistoryStream(source: 'walk' | 'log', accept?: (commit: Commit) => void) {
  const ids = source === 'walk' ? '%x00%x00' : '%H%x00%P%x00';
  const details = '%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%B%x00%x00';
  return {
    parser: new HistoryParser(accept, 'raw'),
    formatArgs: ['--date=raw', `--format=${ids}${details}`],
  };
}
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
  private readonly signatureWidth: number;
  constructor(
    private accept?: (commit: Commit) => void,
    dateFormat: 'iso' | 'raw' = 'iso',
  ) {
    this.signatureWidth = dateFormat === 'raw' ? 3 : 4;
  }
  private readSignature(fields: string[], start: number) {
    const name = fields[start]!,
      email = fields[start + 1]!,
      value = fields[start + 2]!;
    if (this.signatureWidth === 4) return signature(name, email, value, fields[start + 3]!);
    const separator = value.length - 6;
    if (separator < 1 || value[separator] !== ' ') throw new Error('Invalid commit timestamp');
    return signature(name, email, value.slice(0, separator), value);
  }
  readonly value: Commit[] = [];
  private pendingFields: string[] = [];
  private decoder = new TextNulFields();
  private append(fields: string[], offset: number) {
    const first = fields[offset]!;
    const header = first.startsWith('\n') ? first.slice(1) : first;
    let id = header;
    let parents = fields[offset + 1]!;
    if (header.startsWith('commit ')) {
      // A trailing formatted OID identifies the original stream, whose parents
      // occupy the second field. The compact walk gets both from Git's header.
      const match = /^commit ([0-9a-f]+)((?: [0-9a-f]+)*)\n([0-9a-f]*)$/.exec(header);
      if (!match || (!match[3] && parents)) throw new Error('Malformed history header');
      id = match[3] || match[1]!;
      if (!match[3]) parents = match[2]!.slice(1);
    }
    const author = offset + 2;
    const committer = author + this.signatureWidth;
    const bodyOffset = committer + this.signatureWidth;
    if (fields[bodyOffset + 1] !== '') throw new Error('Malformed history record');
    const body = fields[bodyOffset]!;
    const newline = body.indexOf('\n');
    const commit: Commit = {
      oid: oid(id),
      parents: parents ? parents.split(' ').map(oid) : [],
      author: this.readSignature(fields, author),
      committer: this.readSignature(fields, committer),
      summary: newline < 0 ? body : body.slice(0, newline),
      body,
      isStash: false,
    };
    if (this.accept) this.accept(commit);
    else this.value.push(commit);
  }
  push(chunk: Buffer) {
    const batch = this.decoder.push(chunk);
    const fields = this.pendingFields.length ? this.pendingFields.concat(batch) : batch;
    let offset = 0;
    const width = 4 + 2 * this.signatureWidth;
    for (; offset + width <= fields.length; offset += width) this.append(fields, offset);
    this.pendingFields = fields.slice(offset);
  }
  finish() {
    this.decoder.finish(true);
    if (this.pendingFields.length) throw new Error('Truncated commit');
    return this.value;
  }
}
