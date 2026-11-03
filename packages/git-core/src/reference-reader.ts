import type { Ref } from '@openkraken/ipc-contract';
import { isUtf8 } from 'node:buffer';
import { RefsParser, REF_FORMAT, REF_DIRECT_FORMAT } from './parsers.js';
import { GitError, type RunOptions, type runGit } from './runner.js';

type Run = (args: string[], options: RunOptions) => ReturnType<typeof runGit>;
type Key = [name: string, target: string, upstream: string, head: string];
const KEY_FORMAT = '%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00';
const MAX_BYTES = 32 * 1024 * 1024;
const PARALLEL_THRESHOLD = 10000;

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

  async read(cwd: string, signal?: AbortSignal): Promise<Ref[]> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30000);
    timer.unref();
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      return await this.readStable(cwd, active);
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

  private async readStable(cwd: string, signal: AbortSignal): Promise<Ref[]> {
    if (this.pagingSupported === false) return this.all(cwd, signal);
    const identity = () =>
      this.run(['for-each-ref', `--format=${KEY_FORMAT}`], {
        cwd,
        signal,
        maxBytes: this.maxBytes,
      });
    const before = (await identity()).stdout;
    // Node argv cannot represent arbitrary non-UTF-8 ref-name bytes. Preserve
    // the original single native enumeration for these repositories.
    if (!isUtf8(before)) return this.all(cwd, signal);
    const expected = keys(before);
    if (expected.length < PARALLEL_THRESHOLD) return this.all(cwd, signal);
    const count = Math.ceil(expected.length / 3);
    const starts = [0, count, count * 2];
    const markers = starts.map((start) => (start ? expected[start - 1]![0] : ''));
    if (markers.some((marker) => Buffer.byteLength(marker) > 4096)) return this.all(cwd, signal);
    if (this.pagingSupported === undefined) {
      const probe = await this.run(
        ['for-each-ref', '--start-after=', '--count=1', '--format=%(refname)'],
        {
          cwd,
          signal,
          maxBytes: this.maxBytes,
          allowedExitCodes: [0, 129],
        },
      );
      this.pagingSupported = probe.exitCode === 0;
      if (!this.pagingSupported) return this.all(cwd, signal);
    }
    const cancelled = new AbortController();
    const groupSignal = AbortSignal.any([signal, cancelled.signal]);
    let bytes = 0;
    const account = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > this.maxBytes)
        throw new GitError('OUTPUT_LIMIT', 'Git output exceeded the safety limit');
    };
    const readPages = async (format: string): Promise<Ref[]> => {
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
    let refs = await readPages(REF_DIRECT_FORMAT);
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
    if (batches.length > 3) refs = await readPages(REF_FORMAT);
    else {
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
    // New/deleted/moved refs or changed HEAD/upstream state invalidate page
    // boundaries. Retry once with the original complete native command.
    if (
      !before.equals(after) ||
      refs.length !== expected.length ||
      refs.some((ref, index) => !matches(ref, expected[index]!))
    ) {
      return this.all(cwd, signal);
    }
    return refs;
  }
}
