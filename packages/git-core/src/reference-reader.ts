import type { Ref } from '@openkraken/ipc-contract';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { RefsParser, REF_FORMAT } from './parsers.js';
import { GitError, type RunOptions, type runGit } from './runner.js';

type Run = (args: string[], options: RunOptions) => ReturnType<typeof runGit>;
const MAX_BYTES = 32 * 1024 * 1024;
const PARALLEL_THRESHOLD = 10000;
const MAX_SPARSE_PACK_BYTES = 8 * 1024 * 1024;
const MAX_SAMPLED_NAMES = 8;

export interface PackedRefSample {
  singleTarget?: string;
  repeatedTargets: boolean;
  hasPeeledTags?: boolean;
  annotationNames?: string[];
  manyBranches: boolean;
}
const ordinaryRefs: PackedRefSample = { repeatedTargets: false, manyBranches: false };
function sampleTargets(sample: Buffer, length: number): PackedRefSample {
  const targets = new Set<string>();
  let rows = 0,
    branches = 0;
  const text = sample.toString('latin1', 0, length);
  for (const match of text.matchAll(/^([0-9a-f]{40}|[0-9a-f]{64}) refs\/(heads\/)?/gm)) {
    targets.add(match[1]!);
    rows++;
    if (match[2]) branches++;
  }
  return {
    singleTarget: rows >= 32 && targets.size === 1 ? targets.values().next().value : undefined,
    repeatedTargets: rows >= 32 && targets.size * 4 <= rows,
    manyBranches: branches >= 32,
    hasPeeledTags: text.includes('\n^'),
  };
}

// A peeled line identifies a possible annotated ref on the preceding line.
function sparseAnnotationNames(packed: Buffer) {
  const names: string[] = [];
  for (let end = packed.indexOf('\n^'); end >= 0; end = packed.indexOf('\n^', end + 2)) {
    if (names.length === MAX_SAMPLED_NAMES || end === 0) return;
    const start = packed.lastIndexOf(10, end - 1) + 1;
    const space = packed.indexOf(32, start);
    if ((space - start !== 40 && space - start !== 64) || space >= end || end - space > 1025)
      return;
    const field = packed.subarray(space + 1, end);
    if (!isUtf8(field) || field.some((byte) => byte <= 32)) return;
    const name = field.toString('utf8');
    if (!name.startsWith('refs/') || /[*?\[]/.test(name)) return;
    names.push(name);
  }
  return names.length ? names : undefined;
}

// This bounded sample selects a Git query. Only Git supplies the actual refs and types.
export async function samplePackedRefs(commonDir: string) {
  if (process.env.GIT_REPLACE_REF_BASE !== undefined) return ordinaryRefs;
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const file = await open(join(commonDir, 'packed-refs'), flags).catch(() => undefined);
  if (!file) return ordinaryRefs;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 512 * 1024) return ordinaryRefs;
    // Contiguous aliases usually fit in one small read. A larger prefix
    // also detects targets that recur hundreds of names apart in Git order.
    const sample = Buffer.allocUnsafe(256 * 1024);
    const { bytesRead } = await file.read(sample, 0, 8192, 0);
    const prefix = sampleTargets(sample, bytesRead);
    if (prefix.repeatedTargets) return prefix;
    const more = await file.read(sample, bytesRead, sample.length - bytesRead, bytesRead);
    const length = bytesRead + more.bytesRead;
    const result = sampleTargets(sample, length);
    if (!result.repeatedTargets && info.size <= MAX_SPARSE_PACK_BYTES) {
      const packed = Buffer.allocUnsafe(info.size);
      sample.copy(packed, 0, 0, length);
      const tail = await file.read(packed, length, packed.length - length, length);
      if (length + tail.bytesRead === packed.length)
        result.annotationNames = sparseAnnotationNames(packed);
    }
    return result;
  } catch {
    return ordinaryRefs;
  } finally {
    await file.close();
  }
}

function sameDirectFields(ref: Ref, original: Ref) {
  return (
    ref === original ||
    (ref.name === original.name &&
      ref.target === original.target &&
      ref.objectType === original.objectType &&
      ref.isHead === original.isHead &&
      ref.upstream?.ref === original.upstream?.ref &&
      ref.upstream?.ahead === original.upstream?.ahead &&
      ref.upstream?.behind === original.upstream?.behind &&
      ref.upstream?.gone === original.upstream?.gone)
  );
}

// Git emits these English tracking fields under the runner's C locale.
function trackingField(upstream: Ref['upstream']) {
  if (!upstream) return '';
  if (upstream.gone) return '[gone]';
  const counts = [];
  if (upstream.ahead) counts.push('ahead ' + upstream.ahead);
  if (upstream.behind) counts.push('behind ' + upstream.behind);
  return counts.length ? '[' + counts.join(', ') + ']' : '';
}

function sameRefStream(output: Buffer, refs: Ref[]) {
  if (!isUtf8(output)) return false;
  const text = output.toString('utf8');
  let offset = 0;
  for (const ref of refs) {
    const upstream = ref.upstream?.ref ?? '';
    const head = ref.isHead ? '*' : ' ';
    const fields = `${ref.name}\0${ref.target}\0\0${upstream}\0${trackingField(ref.upstream)}\0${head}\0\n`;
    if (!text.startsWith(fields, offset)) return false;
    offset += fields.length;
  }
  return offset === text.length;
}

/** Complete records, bounded parallel native reads, and a single-read compatibility path. */
export class ReferenceReader {
  private pagingSupported?: boolean;
  private maxBytes: number;
  constructor(
    private run: Run,
    options: { maxBytes?: number } = {},
  ) {
    this.maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
      throw new Error('Invalid output limit');
  }

  async read(
    cwd: string,
    signal?: AbortSignal,
    sample = ordinaryRefs,
    onSample?: (objects?: ReadonlyMap<string, Ref>) => void,
  ): Promise<Ref[]> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30000);
    timer.unref();
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const groupedSample = sample.repeatedTargets && sample.hasPeeledTags;
      if (!groupedSample) onSample?.();
      const sampled =
        (groupedSample || sample.annotationNames?.length) &&
        process.env.GIT_REPLACE_REF_BASE === undefined
          ? await this.sampleTagObjects(cwd, active, sample.annotationNames)
          : undefined;
      if (groupedSample) onSample?.(sampled);
      const omitUpstreams = sample.manyBranches && (await this.noConfiguredUpstreams(cwd, active));
      const refs = await this.readStable(
        cwd,
        active,
        sample.repeatedTargets,
        omitUpstreams,
        sampled,
      );
      if (omitUpstreams && !(await this.noConfiguredUpstreams(cwd, active)))
        return await this.readStable(cwd, active, sample.repeatedTargets);
      return refs;
    } catch (error) {
      if (deadline.signal.aborted && !signal?.aborted)
        throw new GitError('TIMEOUT', 'Reference enumeration timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async noConfiguredUpstreams(cwd: string, signal: AbortSignal) {
    try {
      const result = await this.run(
        ['config', '--includes', '--name-only', '--get-regexp', '^branch\\..*\\.merge$'],
        {
          cwd,
          signal,
          allowedExitCodes: [0, 1],
          maxBytes: this.maxBytes,
        },
      );
      return result.exitCode === 1 && !result.stdout.length && !result.stderr;
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  }

  private async all(cwd: string, signal: AbortSignal): Promise<Ref[]> {
    const parser = new RefsParser();
    await this.run(['for-each-ref', `--format=${REF_FORMAT}`], {
      cwd,
      signal,
      maxBytes: this.maxBytes,
      onStdout: (chunk) => parser.push(chunk),
    });
    return this.peelNestedTags(cwd, signal, parser.finish());
  }

  private async peelNestedTags(cwd: string, signal: AbortSignal, refs: Ref[]) {
    // Older for-each-ref versions peel a single layer. Resolve only the remaining tags.
    const nested = refs.filter((ref) => ref.peeledType === 'tag');
    if (nested.length) await this.peelTags(cwd, signal, nested);
    return refs;
  }

  private async peelTags(
    cwd: string,
    signal: AbortSignal,
    tags: Ref[],
    ignoreReplacements = false,
  ) {
    const ids = [...new Set(tags.map((ref) => ref.peeled ?? ref.target))];
    const { stdout } = await this.run(
      [
        ...(ignoreReplacements ? ['--no-replace-objects'] : []),
        'cat-file',
        '--buffer',
        '--batch-check=%(rest) %(objectname) %(objecttype)',
      ],
      {
        cwd,
        signal,
        maxBytes: this.maxBytes,
        stdin: ids.map((id) => id + '^{} ' + id + '\n').join(''),
      },
    );
    const lines = stdout.toString('utf8').split('\n');
    const resolved = new Map<string, { peeled: string; peeledType: string }>();
    if (lines.pop() !== '' || lines.length !== ids.length)
      throw new GitError('INVALID_REFS', 'Incomplete annotated tag targets');
    for (const [index, id] of ids.entries()) {
      const match = /^(\S+) ([0-9a-f]+) (commit|tree|blob)$/.exec(lines[index]!);
      if (!match || match[1] !== id || match[2]!.length !== id.length)
        throw new GitError('INVALID_REFS', 'Invalid annotated tag target');
      resolved.set(id, { peeled: match[2]!, peeledType: match[3]! });
    }
    for (const ref of tags) Object.assign(ref, resolved.get(ref.peeled ?? ref.target)!);
  }

  private async sampleTagObjects(cwd: string, signal: AbortSignal, names?: string[]) {
    const parser = new RefsParser();
    const format = REF_FORMAT.replace('%(upstream)', '').replace('%(upstream:track)', '');
    try {
      await this.run(
        [
          '--no-replace-objects',
          'for-each-ref',
          '--count=128',
          '--format=' + format,
          ...(names ? ['--', ...names] : []),
        ],
        {
          cwd,
          signal,
          maxBytes: this.maxBytes,
          onStdout: (chunk) => parser.push(chunk),
        },
      );
      const sample = parser.finish();
      const nested = sample.filter((ref) => ref.peeledType === 'tag');
      if (nested.length) await this.peelTags(cwd, signal, nested, true);
      return new Map(sample.map((ref) => [ref.target, ref]));
    } catch (error) {
      if (
        signal.aborted ||
        !(error instanceof GitError) ||
        (error.code !== 'GIT_FAILED' && error.code !== 'OUTPUT_LIMIT')
      )
        throw error;
      return undefined;
    }
  }

  private async resolveRepeatedTypes(cwd: string, signal: AbortSignal, refs: Ref[]) {
    const targets = new Set<string>();
    for (const ref of refs) {
      if (ref.name.startsWith('refs/replace/')) return false;
      targets.add(ref.target);
      if (targets.size > 4096) return false;
    }
    if (!targets.size) return true;
    const ids = [...targets];
    const result = await this.run(
      ['--no-replace-objects', 'cat-file', '--buffer', '--batch-check=%(objectname) %(objecttype)'],
      {
        cwd,
        signal,
        maxBytes: this.maxBytes,
        stdin: ids.join('\n') + '\n',
      },
    ).catch((error: unknown) => {
      if (error instanceof GitError && error.code === 'GIT_FAILED') return undefined;
      throw error;
    });
    if (!result) return false;
    const lines = result.stdout.toString('utf8').split('\n');
    if (lines.pop() !== '' || lines.length !== ids.length) return false;
    const types = new Map<string, string>();
    for (const [index, id] of ids.entries()) {
      const [oid, type, extra] = lines[index]!.split(' ');
      if (
        oid !== id ||
        extra !== undefined ||
        !type ||
        !['commit', 'blob', 'tree', 'tag'].includes(type)
      )
        return false;
      types.set(id, type);
    }
    for (const ref of refs) ref.objectType = types.get(ref.target)!;
    return true;
  }

  private async readStable(
    cwd: string,
    signal: AbortSignal,
    grouped = false,
    omitUpstreams = false,
    sampled?: ReadonlyMap<string, Ref>,
  ): Promise<Ref[]> {
    const parser = new RefsParser('direct');
    // Independently valid chunks start and end on UTF-8 code point boundaries.
    // A split character needs streaming validation from that chunk onward.
    let decoder: TextDecoder | undefined;
    let validUtf8 = true;
    const checkUtf8 = (chunk?: Buffer) => {
      if (!validUtf8 || (!decoder && (!chunk || isUtf8(chunk)))) return;
      decoder ??= new TextDecoder('utf-8', { fatal: true });
      try {
        decoder.decode(chunk, { stream: chunk !== undefined });
      } catch {
        validUtf8 = false;
      }
    };
    let bytes = 0;
    const account = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > this.maxBytes)
        throw new GitError('OUTPUT_LIMIT', 'Git output exceeded the safety limit');
    };
    let format = grouped ? parser.gitFormat.replace('%(objecttype)', '') : parser.gitFormat;
    if (omitUpstreams) format = format.replace('%(upstream)', '').replace('%(upstream:track)', '');
    const args = ['for-each-ref', `--format=${format}`];
    const original = grouped ? createHash('sha256') : undefined;
    await this.run(args, {
      cwd,
      signal,
      maxBytes: this.maxBytes,
      onStdout: (chunk) => {
        account(chunk);
        original?.update(chunk);
        checkUtf8(chunk);
        parser.push(chunk);
      },
      onStderr: account,
    });
    let refs = parser.finish();
    checkUtf8();
    // All mutable fields come from this final enumeration. Only immutable object
    // metadata may be filled from the earlier replacement-free Git sample.
    if (
      sampled &&
      validUtf8 &&
      refs.every(
        (ref) =>
          !ref.name.startsWith('refs/replace/') &&
          ((!grouped && ref.objectType !== 'tag') || sampled.has(ref.target)),
      )
    ) {
      for (const ref of refs) {
        if (!grouped && ref.objectType !== 'tag') continue;
        const object = sampled.get(ref.target)!;
        ref.objectType = object.objectType;
        ref.peeledType = object.peeledType;
        if (object.peeled) ref.peeled = object.peeled;
        bytes +=
          (grouped ? object.objectType.length : 0) +
          object.peeledType.length +
          (object.peeled?.length ?? 0);
      }
      if (bytes > this.maxBytes)
        throw new GitError('OUTPUT_LIMIT', 'Git output exceeded the safety limit');
      return refs;
    }
    if (grouped) {
      if (!(await this.resolveRepeatedTypes(cwd, signal, refs)))
        return this.readStable(cwd, signal);
      // Charge the same direct-record byte budget as the single native query.
      for (const ref of refs) bytes += ref.objectType.length;
      if (bytes > this.maxBytes)
        throw new GitError('OUTPUT_LIMIT', 'Git output exceeded the safety limit');
    }
    if (!refs.some((ref) => ref.objectType === 'tag')) return refs;
    if (!validUtf8) return this.all(cwd, signal);
    const expected = refs;
    const unchanged = async () => {
      if (!original) {
        const { stdout } = await this.run(
          ['for-each-ref', '--format=' + format.replace('%(objecttype)', '')],
          { cwd, signal, maxBytes: this.maxBytes },
        );
        return sameRefStream(stdout, expected);
      }
      const observed = createHash('sha256');
      await this.run(args, {
        cwd,
        signal,
        maxBytes: this.maxBytes,
        onStdout: (chunk) => {
          observed.update(chunk);
        },
      });
      return observed.digest().equals(original.digest());
    };
    const tags = refs.filter((ref) => ref.objectType === 'tag');
    if (
      grouped &&
      tags.length > 128 &&
      new Set(tags.map((ref) => ref.target)).size * 4 <= tags.length
    ) {
      // Keep the direct records and ask Git to peel the captured objects once per ID.
      await this.peelTags(cwd, signal, tags);
      for (const tag of tags) bytes += tag.peeled!.length + tag.peeledType.length;
      if (bytes > this.maxBytes)
        throw new GitError('OUTPUT_LIMIT', 'Git output exceeded the safety limit');
      return (await unchanged()) ? refs : this.all(cwd, signal);
    }
    const cancelled = new AbortController();
    const groupSignal = AbortSignal.any([signal, cancelled.signal]);
    const readPages = async (format: string): Promise<Ref[]> => {
      const count = Math.ceil(expected.length / 3);
      const starts = [0, count, count * 2];
      const markers = starts.map((start) => (start ? expected[start - 1]!.name : ''));
      if (markers.some((marker) => Buffer.byteLength(marker) > 4096)) return this.all(cwd, signal);
      const jobs = starts.map(async (start, index) => {
        const parser = new RefsParser();
        await this.run(
          [
            'for-each-ref',
            `--format=${format}`,
            `--start-after=${markers[index]}`,
            `--count=${Math.min(count, expected.length - start)}`,
          ],
          {
            cwd,
            signal: groupSignal,
            maxBytes: this.maxBytes,
            onStdout: (chunk) => {
              account(chunk);
              parser.push(chunk);
            },
            onStderr: account,
          },
        );
        return parser.finish();
      });
      try {
        return (await Promise.all(jobs)).flat();
      } catch (error) {
        cancelled.abort();
        await Promise.allSettled(jobs); // Release the repository queue only after every child closes.
        throw error;
      }
    };
    // Exact names are valid ref names (no glob metacharacters). Git also matches
    // slash descendants, so retain only requested names and validate coverage.
    const batches: string[][] = [];
    let names: string[] = [],
      nameBytes = 0;
    for (const tag of tags) {
      const size = Buffer.byteLength(tag.name) + 1;
      if (size > 4096) return this.all(cwd, signal);
      if (names.length >= 128 || nameBytes + size > 16384) {
        batches.push(names);
        names = [];
        nameBytes = 0;
      }
      names.push(tag.name);
      nameBytes += size;
    }
    if (names.length) batches.push(names);
    // Dense annotated-tag repositories use three full pages rather than an
    // unbounded number of pattern scans. All reads share the same byte budget.
    if (batches.length > 3) {
      if (refs.length < PARALLEL_THRESHOLD) return this.all(cwd, signal);
      if (this.pagingSupported === undefined) {
        const probe = await this.run(
          ['for-each-ref', '--start-after=', '--count=1', '--format=%(refname)'],
          { cwd, signal, maxBytes: this.maxBytes, allowedExitCodes: [0, 129] },
        );
        this.pagingSupported = probe.exitCode === 0;
      }
      if (!this.pagingSupported) return this.all(cwd, signal);
      refs = await readPages(REF_FORMAT);
    } else {
      const details = new Map<string, Ref>();
      for (const names of batches) {
        const wanted = new Set(names);
        const parser = new RefsParser();
        await this.run(['for-each-ref', `--format=${REF_FORMAT}`, '--', ...names], {
          cwd,
          signal,
          maxBytes: this.maxBytes,
          onStdout: (chunk) => {
            account(chunk);
            parser.push(chunk);
          },
          onStderr: account,
        });
        for (const ref of parser.finish()) if (wanted.has(ref.name)) details.set(ref.name, ref);
      }
      if (tags.some((tag) => details.get(tag.name)?.target !== tag.target)) {
        return this.all(cwd, signal);
      }
      refs = refs.map((ref) => details.get(ref.name) ?? ref);
    }
    // Check page boundaries and the direct fields of detail rows before peeling them.
    if (
      refs.length !== expected.length ||
      refs.some((ref, index) => !sameDirectFields(ref, expected[index]!))
    ) {
      return this.all(cwd, signal);
    }
    await this.peelNestedTags(cwd, signal, refs);
    return (await unchanged()) ? refs : this.all(cwd, signal);
  }
}
