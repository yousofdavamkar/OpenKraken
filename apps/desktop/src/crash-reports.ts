import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CrashReportingState } from '@openkraken/ipc-contract';
import { reportDestination } from './report-destination.js';
import {
  ReportSession,
  reportingRuntimeSchema as runtimeSchema,
  type ReportingRuntime,
} from './report-session.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const oldDiskSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    destination: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const diskSchema = z.discriminatedUnion('version', [
  oldDiskSchema,
  oldDiskSchema.extend({ version: z.literal(2), nonce: z.string().uuid() }),
]);
const processSchema = z.enum(['main', 'renderer', 'git', 'terminal', 'gpu']);
const reasonSchema = z.enum([
  'crashed',
  'oom',
  'abnormal-exit',
  'launch-failed',
  'integrity-failure',
  'unclean-exit',
  'unhandled-exception',
  'unhandled-rejection',
]);

export class CrashReports {
  private config: ReturnType<typeof reportDestination>;
  private runtime: z.infer<typeof runtimeSchema>;
  private file: string;
  private source: string | null = null;
  private state: CrashReportingState;
  private ready: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private active: AbortController | undefined;
  private seen = new Set<string>();
  private attempts = 0;
  private generation = 0;
  private closed = false;
  private started = false;
  private session: ReportSession;
  constructor(
    private directory: string,
    dsn: string | null,
    runtime: unknown,
    private send: typeof fetch = fetch,
  ) {
    this.session = new ReportSession(directory);
    this.config = reportDestination(dsn);
    this.runtime = runtimeSchema.parse(runtime);
    this.file = join(directory, 'crash-reporting.json');
    this.state = {
      enabled: false,
      revision: null,
      destination: this.config?.destination ?? null,
      warning: null,
      delivery: 'idle',
    };
    this.ready = this.load();
  }
  private async readSource() {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 4096) throw new Error('Unsupported consent file');
      const raw = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(raw) > 4096) throw new Error('Unsupported consent size');
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async load() {
    try {
      this.source = await this.readSource();
      if (this.source === null) return;
      const saved = diskSchema.parse(JSON.parse(this.source));
      this.state.revision = digest(this.source);
      this.state.enabled =
        !!this.config &&
        saved.version === 2 &&
        saved.enabled &&
        saved.destination === digest(this.config.dsn);
    } catch {
      this.state.warning = 'unreadable';
    }
  }
  start(): Promise<void> {
    if (this.started) return this.idle().then(() => {});
    this.started = true;
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (!this.state.enabled || this.closed) return null;
        try {
          if ((await this.readSource()) !== this.source) throw new Error('Consent changed');
        } catch {
          this.stop();
          this.state.warning = 'unreadable';
          return null;
        }
        try {
          return await this.session.begin(this.state.revision!, this.runtime);
        } catch {
          this.stop();
          this.state.warning = 'session';
          return null;
        }
      });
    this.writes = next;
    return next.then((previous) => {
      // Replace the marker before attempting delivery. No failed-report queue
      // or retry is retained, and startup never waits for the network.
      if (previous) void this.captureEvent('main', 'unclean-exit', previous);
    });
  }
  async read() {
    await this.ready;
    await this.writes.catch(() => {});
    return structuredClone(this.state);
  }
  private stop() {
    this.generation++;
    this.state.enabled = false;
    this.active?.abort();
    this.state.delivery = 'idle';
  }
  save(enabled: boolean, revision: string | null) {
    // Revocation takes effect before disk work or waiting on another preference
    // write. A failed persistence attempt never leaves transmission enabled.
    if (this.closed) return Promise.reject(new Error('Crash reporting is closed'));
    if (!enabled) this.stop();
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (enabled && this.closed) throw new Error('Crash reporting is closed');
        if (!enabled) this.stop();
        if (
          revision !== this.state.revision ||
          (this.state.warning && (enabled || this.state.warning !== 'session')) ||
          (await this.readSource()) !== this.source
        )
          throw new Error(
            'Crash reporting settings changed or cannot be read. Restart before saving.',
          );
        if (enabled && !this.config)
          throw new Error('This build has no crash reporting destination');
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (!(await lstat(this.directory)).isDirectory())
          throw new Error('Unsupported profile directory');
        const raw = JSON.stringify({
          version: 2,
          nonce: randomUUID(),
          enabled,
          destination: digest(this.config?.dsn ?? ''),
        });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(raw);
            await file.sync();
          } finally {
            await file.close();
          }
          // Only publish renewed consent once its session marker can be created.
          if (enabled && this.started) {
            try {
              await this.session.begin(digest(raw), this.runtime);
            } catch (error) {
              this.stop();
              this.state.warning = 'session';
              throw error;
            }
          }
          if ((await this.readSource()) !== this.source)
            throw new Error('Crash reporting settings changed externally');
          if (enabled && this.closed) throw new Error('Crash reporting is closed');
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
        this.source = raw;
        this.state.revision = digest(raw);
        this.generation++;
        this.active?.abort();
        this.state.delivery = 'idle';
        this.state.enabled = enabled && !this.closed;
        if (!enabled) {
          // Persist the off setting before attempting to remove the previous session marker.
          const unverifiedMarker = this.state.warning === 'session';
          try {
            await this.session.end();
            this.state.warning = unverifiedMarker ? 'cleanup' : null;
          } catch {
            this.state.warning = 'cleanup';
          }
        }
        return structuredClone(this.state);
      });
    this.writes = next;
    return next;
  }
  capture(process: string, reason: string) {
    return this.captureEvent(process, reason, this.runtime);
  }
  private async captureEvent(process: string, reason: string, runtime: ReportingRuntime) {
    // No caller-provided message, stack, path, exit description or exception
    // object can cross this boundary. Unknown events are discarded.
    if (!processSchema.safeParse(process).success || !reasonSchema.safeParse(reason).success)
      return;
    if (!this.state.enabled || this.closed) return;
    const generation = this.generation;
    await this.ready;
    await this.writes.catch(() => {});
    if (
      !this.config ||
      !this.state.enabled ||
      this.active ||
      this.attempts >= 5 ||
      this.seen.has(`${process}:${reason}`)
    )
      return;
    try {
      if ((await this.readSource()) !== this.source) throw new Error('Consent changed');
    } catch {
      this.stop();
      this.state.warning = 'changed';
      return;
    }
    if (
      !this.state.enabled ||
      this.closed ||
      generation !== this.generation ||
      this.active ||
      this.attempts >= 5 ||
      this.seen.has(`${process}:${reason}`)
    )
      return;
    this.seen.add(`${process}:${reason}`);
    this.attempts++;
    const controller = new AbortController();
    this.active = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    const event_id = randomUUID().replaceAll('-', '');
    const payload = JSON.stringify({
      event_id,
      platform: 'native',
      level:
        reason === 'unclean-exit' ? 'warning' : reason.startsWith('unhandled-') ? 'error' : 'fatal',
      release: `openkraken@${runtime.version}`,
      message: 'OpenKraken process failure',
      tags: { process, reason, os: runtime.platform, arch: runtime.arch },
    });
    this.state.delivery = 'sending';
    try {
      const response = await this.send(this.config.endpoint, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body: `${JSON.stringify({ event_id, dsn: this.config.dsn })}\n${JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) })}\n${payload}\n`,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Report rejected');
      if (this.state.enabled && generation === this.generation) this.state.delivery = 'sent';
    } catch {
      if (this.state.enabled && generation === this.generation) this.state.delivery = 'failed';
    } finally {
      clearTimeout(timeout);
      this.active = undefined;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.writes = this.writes
      .catch(() => {})
      .then(() => this.session.end())
      .catch(() => {
        this.state.warning = 'changed';
      });
  }
  idle() {
    return this.writes.catch(() => {});
  }
}
