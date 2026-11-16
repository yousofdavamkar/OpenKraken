import type { Ref } from '@openkraken/ipc-contract';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { RefsParser, REF_FORMAT } from './parsers.js';
import { GitError, type RunOptions, type runGit } from './runner.js';

type Run = (args: string[], options: RunOptions) => ReturnType<typeof runGit>;
type Key = [name: string, target: string, upstream: string, head: string];
const KEY_FORMAT = '%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00';
const MAX_BYTES = 32 * 1024 * 1024;
const PARALLEL_THRESHOLD = 10000;

function repeatedTargets(sample: Buffer, length: number) {
  const targets = new Set<string>();
  let rows = 0;
  for (const match of sample
    .toString('latin1', 0, length)
    .matchAll(/^([0-9a-f]{40}|[0-9a-f]{64}) refs\//gm)) {
    targets.add(match[1]!);
    rows++;
  }
  return rows >= 32 && targets.size * 4 <= rows;
}

// This bounded sample selects a Git query. Only Git supplies the actual refs and types.
export async function hasRepeatedPackedTargets(commonDir: string) {
  if (process.env.GIT_REPLACE_REF_BASE !== undefined) return false;
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const file = await open(join(commonDir, 'packed-refs'), flags).catch(() => undefined);
  if (!file) return false;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 512 * 1024) return false;
    // Contiguous aliases usually fit in one small read. A larger prefix
    // also detects targets that recur hundreds of names apart in Git order.
    const sample = Buffer.allocUnsafe(256 * 1024);
    const { bytesRead } = await file.read(sample, 0, 8192, 0);
    if (repeatedTargets(sample, bytesRead)) return true;
    const more = await file.read(sample, bytesRead, sample.length - bytesRead, bytesRead);
    return repeatedTargets(sample, bytesRead + more.bytesRead);
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

function keys(data: Buffer): Key[] {
  const lines = data.toString('utf8').split('\n');
  if (lines.pop() !== '') throw new GitError('INVALID_REFS', 'Truncated reference identity');
  return lines.map((line) => {
    const fields = line.split('\0');
    if (
      fields.length !== 5 ||
      fields.pop() !== '' ||
      !fields[0]!.startsWith('refs/') ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[1]!)
    )
      throw new GitError('INVALID_REFS', 'Malformed reference identity');
    return fields as Key;
  });
}
function matches(ref: Ref, [name, target, upstream, head]: Key) {
  return (
    ref.name === name &&
    ref.target === target &&
    ref.isHead === (head === '*') &&
    (ref.upstream?.ref ?? '') === upstream
  );
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

  async read(cwd: string, signal?: AbortSignal, grouped = false): Promise<Ref[]> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30000);
    timer.unref();
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      return await this.readStable(cwd, active, grouped);
    } catch (error) {
      if (deadline.signal.aborted && !signal?.aborted)
        throw new GitError('TIMEOUT', 'Reference enumeration timed out');
      throw error;
    } finally {
      clearTimeout(timer);
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
    return parser.finish();
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

  private async readStable(cwd: string, signal: AbortSignal, grouped = false): Promise<Ref[]> {
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
    const format = grouped ? parser.gitFormat.replace('%(objecttype)', '') : parser.gitFormat;
    await this.run(['for-each-ref', `--format=${format}`], {
      cwd,
      signal,
      maxBytes: this.maxBytes,
      onStdout: (chunk) => {
        account(chunk);
        checkUtf8(chunk);
        parser.push(chunk);
      },
      onStderr: account,
    });
    let refs = parser.finish();
    if (grouped) {
      if (!(await this.resolveRepeatedTypes(cwd, signal, refs)))
        return this.readStable(cwd, signal);
      // Charge the same direct-record byte budget as the single native query.
      for (const ref of refs) bytes += ref.objectType.length;
      if (bytes > this.maxBytes)
        throw new GitError('OUTPUT_LIMIT', 'Git output exceeded the safety limit');
    }
    if (!refs.some((ref) => ref.objectType === 'tag')) return refs;
    checkUtf8();
    if (!validUtf8) return this.all(cwd, signal);
    const expected: Key[] = refs.map((ref) => [
      ref.name,
      ref.target,
      ref.upstream?.ref ?? '',
      ref.isHead ? '*' : ' ',
    ]);
    const identity = () =>
      this.run(['for-each-ref', `--format=${KEY_FORMAT}`], {
        cwd,
        signal,
        maxBytes: this.maxBytes,
      });
    const cancelled = new AbortController();
    const groupSignal = AbortSignal.any([signal, cancelled.signal]);
    const readPages = async (format: string): Promise<Ref[]> => {
      const count = Math.ceil(expected.length / 3);
      const starts = [0, count, count * 2];
      const markers = starts.map((start) => (start ? expected[start - 1]![0] : ''));
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
    const tags = refs.filter((ref) => ref.objectType === 'tag');
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
    const after = (await identity()).stdout;
    if (!isUtf8(after)) return this.all(cwd, signal);
    const observed = keys(after);
    // New/deleted/moved refs or changed HEAD/upstream state invalidate page
    // boundaries. Retry once with the original complete native command.
    if (
      observed.length !== expected.length ||
      observed.some((key, index) => key.some((field, at) => field !== expected[index]?.[at])) ||
      refs.length !== expected.length ||
      refs.some((ref, index) => !matches(ref, expected[index]!))
    ) {
      return this.all(cwd, signal);
    }
    return refs;
  }
}
