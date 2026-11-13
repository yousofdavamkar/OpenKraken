import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  diagnosticActions,
  diagnosticCodes,
  diagnosticReasons,
  diagnosticEntrySchema,
  type DiagnosticAction,
  type DiagnosticEntry,
  type DiagnosticsState,
  type Request,
  type ServiceResult,
} from '@openkraken/ipc-contract';

const segmentSchema = z
  .object({ version: z.literal(1), entries: z.array(diagnosticEntrySchema).max(256) })
  .strict();
const maxBytes = 256 * 1024;
type Job =
  | { event: DiagnosticEntry }
  | {
      command: 'read' | 'clear';
      resolve: (state: DiagnosticsState) => void;
      reject: (error: Error) => void;
    };
class Changed extends Error {}

/** Local, bounded, content-free diagnostics. Storage failure never rejects an application operation. */
export class Diagnostics {
  private sources: (string | null)[] = [null, null, null];
  private segments: DiagnosticEntry[][] = [[], [], []];
  private jobs: Job[] = [];
  private work?: Promise<void>;
  private ready: Promise<void>;
  private warning: DiagnosticsState['warning'] = null;
  private dropped = 0;
  private pendingDropped = 0;
  private closed = false;
  constructor(
    private directory: string,
    private runtime: { version: string; platform: string; arch: string },
  ) {
    this.ready = this.load();
    this.enqueue({ ...this.identity(), type: 'started', ...runtime });
  }
  private identity() {
    return { id: randomUUID(), time: Date.now() };
  }
  private file(index: number) {
    return join(this.directory, `diagnostics-${index}.json`);
  }
  private temporary() {
    return join(this.directory, 'diagnostics-next.tmp');
  }
  private fail(error: unknown) {
    this.warning ??= error instanceof Changed ? 'changed' : 'unavailable';
  }
  private async readSource(index: number) {
    try {
      const file = this.file(index),
        info = await lstat(file);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > maxBytes ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw new Error('Unsupported diagnostic file');
      const raw = await readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > maxBytes) throw new Error('Unsupported diagnostic size');
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async checkDirectory() {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
      throw new Error('Unsupported diagnostic directory');
  }
  private async load() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.checkDirectory();
      const identities = new Set<string>();
      for (let index = 0; index < 3; index++) {
        const raw = await this.readSource(index);
        const entries = raw === null ? [] : segmentSchema.parse(JSON.parse(raw)).entries;
        for (const entry of entries) {
          if (identities.has(entry.id)) throw new Error('Duplicate diagnostic entry');
          identities.add(entry.id);
        }
        this.sources[index] = raw;
        this.segments[index] = entries;
      }
      // Single-instance main owns this fixed scratch file. Interrupted writes
      // never replace the committed segment or accumulate random orphan files.
      try {
        const info = await lstat(this.temporary());
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > maxBytes ||
          (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
        )
          throw new Error('Unsupported diagnostic scratch file');
        await rm(this.temporary());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } catch (error) {
      this.fail(error);
    }
  }
  private async checkSources() {
    await this.checkDirectory();
    for (let index = 0; index < 3; index++)
      if ((await this.readSource(index)) !== this.sources[index]) throw new Changed();
  }
  private state(): DiagnosticsState {
    return {
      entries: structuredClone([...this.segments].reverse().flat()),
      warning: this.warning,
      dropped: this.dropped,
    };
  }
  private async append(entry: DiagnosticEntry) {
    await this.checkSources();
    if (this.segments[0]!.length >= 256) {
      if (this.sources[2] !== null) await rm(this.file(2));
      this.sources[2] = null;
      this.segments[2] = [];
      for (let index = 1; index >= 0; index--) {
        if (this.sources[index] !== null) await rename(this.file(index), this.file(index + 1));
        this.sources[index + 1] = this.sources[index]!;
        this.segments[index + 1] = this.segments[index]!;
        this.sources[index] = null;
        this.segments[index] = [];
      }
    }
    const entries = [...this.segments[0]!, entry];
    const raw = JSON.stringify(segmentSchema.parse({ version: 1, entries }));
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Diagnostic segment too large');
    const temporary = this.temporary();
    let created = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.checkSources();
      await rename(temporary, this.file(0));
      this.sources[0] = raw;
      this.segments[0] = entries;
    } finally {
      if (created) await rm(temporary, { force: true });
    }
  }
  private enqueue(input: unknown) {
    if (this.closed) return;
    const parsed = diagnosticEntrySchema.safeParse(input);
    if (!parsed.success) return;
    if (this.warning || this.jobs.length >= 128) {
      this.dropped++;
      if (!this.warning) this.pendingDropped++;
      return;
    }
    this.jobs.push({ event: parsed.data });
    this.drain();
  }
  private drain() {
    if (this.work) return;
    this.work = (async () => {
      await this.ready;
      while (this.jobs.length || this.pendingDropped) {
        const job = this.jobs.shift() ?? {
          event: { ...this.identity(), type: 'dropped' as const, count: this.pendingDropped },
        };
        if ('event' in job && job.event.type === 'dropped') this.pendingDropped = 0;
        try {
          if ('event' in job) {
            if (this.warning) {
              this.dropped++;
              continue;
            }
            await this.append(job.event);
          } else {
            if (!this.warning) await this.checkSources();
            if (job.command === 'clear') {
              if (this.warning)
                throw new Error('Diagnostic storage is unavailable; existing files were retained.');
              this.dropped = 0;
              this.pendingDropped = 0;
              for (let index = 2; index >= 0; index--) {
                if (this.sources[index] !== null) await rm(this.file(index));
                this.sources[index] = null;
                this.segments[index] = [];
              }
            }
            job.resolve(this.state());
          }
        } catch (error) {
          this.fail(error);
          if ('command' in job) {
            if (job.command === 'read') job.resolve(this.state());
            else job.reject(new Error('Diagnostic logs could not be cleared.'));
          } else this.dropped++;
        }
      }
    })().finally(() => {
      this.work = undefined;
      if (this.jobs.length || this.pendingDropped) this.drain();
    });
  }
  private command(command: 'read' | 'clear') {
    return new Promise<DiagnosticsState>((resolve, reject) => {
      this.jobs.push({ command, resolve, reject });
      this.drain();
    });
  }
  read() {
    return this.command('read');
  }
  clear() {
    return this.command('clear');
  }
  async idle() {
    while (this.work) await this.work;
  }
  close() {
    if (!this.closed) this.enqueue({ ...this.identity(), type: 'stopped', ...this.runtime });
    this.closed = true;
    return this.idle();
  }
  failure(component: 'main' | 'renderer' | 'git' | 'terminal' | 'gpu', reason: string) {
    if (reason === 'clean-exit') return;
    this.enqueue({
      ...this.identity(),
      type: 'process',
      component,
      reason: diagnosticReasons.find((known) => known === reason) ?? 'unknown',
    });
  }
  async track(request: Request, execute: () => Promise<ServiceResult>): Promise<ServiceResult> {
    const method = request.method === 'providerGit' ? request.operation.method : request.method;
    const action: DiagnosticAction = Object.hasOwn(diagnosticActions, method)
      ? (method as DiagnosticAction)
      : 'other';
    const started = performance.now();
    const record = (
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
      code: string | null,
    ) => {
      if (action === 'other' && outcome === 'succeeded') return;
      this.enqueue({
        ...this.identity(),
        type: 'request',
        action,
        outcome,
        code: code === null ? null : (diagnosticCodes.find((known) => known === code) ?? 'OTHER'),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      });
    };
    try {
      const result = await execute();
      record(
        result.kind === 'error'
          ? 'failed'
          : result.kind === 'cancelled'
            ? 'cancelled'
            : 'succeeded',
        result.kind === 'error' ? result.code : null,
      );
      return result;
    } catch (error) {
      record('unknown', 'OTHER');
      throw error;
    }
  }
}
