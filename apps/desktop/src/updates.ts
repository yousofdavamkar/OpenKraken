import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { gt, valid } from 'semver';
import { z } from 'zod';
import type { UpdateState } from '@openkraken/ipc-contract';
import {
  stageAppImageUpdate,
  recoverAppImageUpdate,
  UnchangedAppImageError,
} from './appimage-install.js';
import type { InstalledUpdate } from './update-restart.js';
import {
  updateConfiguration,
  updateEnvelopeLimit,
  validateUpdateRelease,
  verifyUpdateRelease,
  type UpdateArtifact,
  type UpdateConfiguration,
  type UpdateRelease,
} from './update-protocol.js';

import {
  readUpdateEnvelope,
  requestUpdateFile,
  syncDirectory,
  UpdateFailure,
  verifyUpdateArtifact,
} from './update-transfer.js';

export const installTimeoutMs = 10 * 60_000;

const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
const watermarkSchema = z.strictObject({
  schemaVersion: z.literal(1),
  configuration: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const automaticSchema = z.strictObject({
  schemaVersion: z.literal(1),
  configuration: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean(),
  revision: z.uuid(),
  nextCheckAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});

/** Keep the existing destination intact until the complete signed file is ready. */
async function exportInstaller(
  input: FileHandle,
  artifact: UpdateArtifact,
  path: string,
  cacheDirectory: string,
  signal: AbortSignal,
  validate: () => Promise<void>,
) {
  const parent = await realpath(dirname(path));
  const inside = relative(await realpath(cacheDirectory), parent);
  if (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))
    throw new UpdateFailure('save');
  const destination = join(parent, basename(path));
  const current = () =>
    lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
  const before = await current();
  if (before && !before.isFile()) throw new UpdateFailure('save');
  const staging = await mkdtemp(join(parent, '.openkraken-'));
  const temporary = join(staging, 'installer.part');
  let staged: Stats | undefined;
  const matchesStagedFile = (info: Stats | undefined) =>
    !!info && !!staged && info.isFile() && info.dev === staged.dev && info.ino === staged.ino;
  try {
    const output = await open(temporary, 'wx', 0o600);
    try {
      staged = await output.stat();
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > artifact.size) throw new UpdateFailure('integrity');
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      if (size !== artifact.size || hash.digest('hex') !== artifact.sha256)
        throw new UpdateFailure('integrity');
      if (artifact.format === 'AppImage') await output.chmod(0o700);
      await output.sync();
      staged = await output.stat();
    } finally {
      await output.close();
    }
    await validate();
    const copy = await lstat(temporary);
    if (
      !matchesStagedFile(copy) ||
      copy.nlink !== 1 ||
      copy.size !== artifact.size ||
      copy.ctimeMs !== staged.ctimeMs
    )
      throw new UpdateFailure('save');
    const latest = await current();
    if (
      before?.dev !== latest?.dev ||
      before?.ino !== latest?.ino ||
      before?.size !== latest?.size ||
      before?.mtimeMs !== latest?.mtimeMs ||
      before?.ctimeMs !== latest?.ctimeMs
    )
      throw new UpdateFailure('save');
    signal.throwIfAborted();
    await rename(temporary, destination);
    staged = undefined;
  } finally {
    try {
      if (staged && matchesStagedFile(await lstat(temporary).catch(() => undefined)))
        await unlink(temporary);
    } finally {
      // A published installer stays usable if its empty staging directory cannot be removed.
      await rmdir(staging).catch(() => {});
    }
  }
  // The rename has published the complete installer even if the volume cannot confirm it.
  return syncDirectory(parent).then(
    () => true,
    () => false,
  );
}

/** Main-owned updater. No renderer-provided URL, path, key or executable is accepted. */
export class Updates {
  private config: UpdateConfiguration | null;
  private state: UpdateState;
  private ready: Promise<void>;
  private source: string | null = null;
  private watermark: z.infer<typeof watermarkSchema> | null = null;
  private directoryIdentity = '';
  private failedStorage = false;
  private release: UpdateRelease | null = null;
  private recoverableArtifact = false;
  private controller: AbortController | null = null;
  private work: Promise<UpdateState> | null = null;
  private closed = false;
  private installation: Awaited<ReturnType<typeof stageAppImageUpdate>> | null = null;
  private installController: AbortController | null = null;
  private startup: Promise<void> | null = null;
  private automatic: z.infer<typeof automaticSchema> | null = null;
  private automaticSource: string | null = null;
  private automaticFailure = false;
  private preferences: Promise<unknown> = Promise.resolve();
  private automaticTimer: ReturnType<typeof setTimeout> | null = null;
  private schedulingReady = false;
  private checkingAutomatically = false;
  private choosingDestination = false;
  private recoveryNotice: { name: string; source: string } | null = null;
  private abandonment: Promise<UpdateState> | null = null;
  constructor(
    private directory: string,
    configuration: unknown,
    private runtime: { version: string; platform: string; arch: string; appImage?: string },
    private send: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {
    this.config = updateConfiguration(configuration);
    if (!valid(runtime.version)) throw new Error('Invalid installed app version');
    this.state = this.empty(this.config ? 'idle' : 'disabled');
    this.ready = this.config
      ? this.load().catch(() => {
          this.failedStorage = true;
        })
      : Promise.resolve();
  }
  private empty(phase: UpdateState['phase']): UpdateState {
    return {
      ...(this.config && { channel: this.config.channel ?? 'stable' }),
      phase,
      version: null,
      artifacts: [],
      selected: null,
      downloaded: 0,
      installId: null,
      recovery: this.recoveryNotice ? 'restored' : null,
      automatic: this.automaticState(),
      error: null,
    };
  }
  private automaticState(): UpdateState['automatic'] {
    return {
      enabled: !this.automaticFailure && !!this.automatic?.enabled,
      revision: this.automatic?.revision ?? null,
      nextCheckAt:
        !this.automaticFailure && this.automatic?.enabled ? this.automatic.nextCheckAt : null,
      warning: this.automaticFailure ? 'storage' : null,
      host: this.config ? new URL(this.config.feed).host : null,
    };
  }
  private file(name: string) {
    return join(this.directory, name);
  }
  private async checkDirectory(initial = false) {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
      throw new UpdateFailure('storage');
    const identity = `${info.dev}:${info.ino}`;
    if (initial) this.directoryIdentity = identity;
    else if (identity !== this.directoryIdentity) throw new UpdateFailure('storage');
  }
  private safeFile(info: Stats, limit: number) {
    return (
      info.isFile() &&
      info.nlink === 1 &&
      info.size <= limit &&
      (process.platform === 'win32' || (info.mode & 0o077) === 0)
    );
  }
  private async readSource(name = 'trusted-release.json') {
    const path = this.file(name);
    try {
      const original = await lstat(path);
      if (!this.safeFile(original, 4096)) throw new UpdateFailure('storage');
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!this.safeFile(info, 4096) || info.ino !== original.ino || info.dev !== original.dev)
          throw new UpdateFailure('storage');
        const bytes = Buffer.alloc(4097);
        let length = 0;
        while (length < bytes.length) {
          const result = await file.read(bytes, length, bytes.length - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length > 4096) throw new UpdateFailure('storage');
        return bytes.subarray(0, length).toString('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new UpdateFailure('storage');
    }
  }
  private async removeOwned(name: string, limit: number) {
    await this.checkDirectory();
    try {
      if (!this.safeFile(await lstat(this.file(name)), limit)) throw new UpdateFailure('storage');
      await unlink(this.file(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new UpdateFailure('storage');
    }
  }
  private binding(root = this.config!) {
    const { feed, publicKey } = root;
    // Match the original stable and beta profile hashes, including field order.
    return digest(JSON.stringify({ channel: this.config!.channel, feed, publicKey }));
  }
  private matchesPredecessor(binding: string) {
    const previous = this.config?.migrateFrom;
    return !!previous && binding === this.binding(previous);
  }
  private async loadRecoveryNotice() {
    const temporary = 'rollback-notice.tmp';
    const published = 'rollback-notice.json';
    const pending = await this.readSource(temporary);
    const notice = await this.readSource(published);
    if (notice !== null) {
      z.strictObject({ schemaVersion: z.literal(1), outcome: z.literal('restored') }).parse(
        JSON.parse(notice),
      );
    }
    // The helper writes these exact bytes only after restoring the installed image.
    if (notice === null && pending === '{"schemaVersion":1,"outcome":"restored"}')
      return { name: temporary, source: pending };
    if (pending !== null) await this.removeOwned(temporary, 4096);
    return notice === null ? null : { name: published, source: notice };
  }
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory(true);
    this.source = await this.readSource();
    this.watermark = this.source === null ? null : watermarkSchema.parse(JSON.parse(this.source));
    if (
      this.watermark &&
      this.watermark.configuration !== this.binding() &&
      !this.matchesPredecessor(this.watermark.configuration)
    )
      throw new UpdateFailure('storage');
    await this.removeOwned('trusted-release.tmp', 4096);
    await this.removeOwned('artifact.part', 2 * 1024 ** 3);
    const cached = await this.cachedFile();
    if (cached && this.watermark?.configuration === this.binding()) this.recoverableArtifact = true;
    else if (cached) await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
    this.recoveryNotice = await this.loadRecoveryNotice();
    try {
      this.automaticSource = await this.readSource('automatic-checks.json');
      const saved =
        this.automaticSource === null
          ? null
          : automaticSchema.parse(JSON.parse(this.automaticSource));
      const migrate = saved !== null && saved.configuration !== this.binding();
      if (migrate && !this.matchesPredecessor(saved.configuration))
        throw new Error('Configuration changed');
      await this.removeOwned('automatic-checks.tmp', 4096);
      if (migrate) {
        // Consent belongs to the old feed and key. Restore the default-off state.
        await this.checkDirectory();
        if ((await this.readSource('automatic-checks.json')) !== this.automaticSource)
          throw new Error('Automatic update settings changed');
        await unlink(this.file('automatic-checks.json'));
        await syncDirectory(this.directory);
        this.automaticSource = null;
      } else {
        this.automatic = saved;
      }
    } catch {
      this.automaticFailure = true;
    }
  }
  private savePreferences<T>(action: () => Promise<T>): Promise<T> {
    const next = this.preferences
      .catch(() => {})
      .then(async () => {
        await this.ready;
        return action();
      });
    this.preferences = next;
    return next;
  }
  private scheduleAutomatic(minimumDelay = 0) {
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    this.automaticTimer = null;
    if (
      !this.schedulingReady ||
      this.closed ||
      this.failedStorage ||
      this.automaticFailure ||
      !this.automatic?.enabled
    )
      return;
    // Bound timer delays even if the wall clock moves backwards.
    const delay = Math.min(
      36_000_000,
      Math.max(minimumDelay, (this.automatic.nextCheckAt ?? this.now()) - this.now()),
    );
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = null;
      void this.runAutomatic().finally(() => this.scheduleAutomatic());
    }, delay);
    this.automaticTimer.unref();
  }
  private async runAutomatic() {
    try {
      const due = await this.savePreferences(async () => {
        if (this.closed || !this.automatic?.enabled || this.automaticFailure) return false;
        if (this.automatic.nextCheckAt !== null && this.automatic.nextCheckAt > this.now())
          return false;
        await this.persistAutomatic({ ...this.automatic, nextCheckAt: this.now() + 36_000_000 });
        return true;
      });
      if (
        due &&
        !this.closed &&
        this.automatic?.enabled &&
        !this.automaticFailure &&
        !this.work &&
        ['idle', 'current', 'unsupported', 'available', 'saved', 'error'].includes(this.state.phase)
      )
        await this.check(true);
    } catch {
      // Preference failure disables background work; manual checks remain available.
    }
  }
  private async persistAutomatic(next: z.infer<typeof automaticSchema>) {
    try {
      if (this.failedStorage) throw new UpdateFailure('storage');
      await this.checkDirectory();
      if (
        this.automaticFailure ||
        (await this.readSource('automatic-checks.json')) !== this.automaticSource
      )
        throw new Error('Automatic update settings changed');
      const raw = JSON.stringify(automaticSchema.parse(next));
      const handle = await open(this.file('automatic-checks.tmp'), 'wx', 0o600);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await this.readSource('automatic-checks.json')) !== this.automaticSource)
        throw new Error('Automatic update settings changed');
      await this.checkDirectory();
      await rename(this.file('automatic-checks.tmp'), this.file('automatic-checks.json'));
      await syncDirectory(this.directory);
      this.automaticSource = raw;
      this.automatic = next;
    } catch {
      this.automaticFailure = true;
      this.scheduleAutomatic();
      throw new Error(
        'Automatic update settings are unavailable or changed. Restart before trying again.',
      );
    }
  }
  setAutomatic(enabled: boolean, revision: string | null): Promise<UpdateState> {
    if (!this.config || this.closed)
      return Promise.reject(new Error('Automatic updates are unavailable.'));
    return this.savePreferences(async () => {
      // Shutdown drains revocations accepted before close and stops scheduling new checks.
      if (enabled && this.closed) throw new Error('Automatic updates are unavailable.');
      if (revision !== (this.automatic?.revision ?? null))
        throw new Error('Automatic update settings changed. Reopen the dialog before saving.');
      if (!enabled) {
        if (this.automatic)
          this.automatic = { ...this.automatic, enabled: false, nextCheckAt: null };
        this.scheduleAutomatic();
        if (this.checkingAutomatically) this.cancel();
      }
      await this.persistAutomatic({
        schemaVersion: 1,
        configuration: this.binding(),
        enabled,
        revision: randomUUID(),
        nextCheckAt: enabled ? this.now() + 30_000 : null,
      });
      this.scheduleAutomatic();
      return this.read();
    });
  }
  dismissRecovery(): Promise<UpdateState> {
    return this.savePreferences(async () => {
      if (!this.config || this.closed || this.recoveryNotice === null) return this.read();
      let { name } = this.recoveryNotice;
      let source = await this.readSource(name);
      if (name === 'rollback-notice.tmp' && source === null) {
        // A helper still completing publication can rename the same record after our read.
        name = 'rollback-notice.json';
        source = await this.readSource(name);
      }
      if (source !== this.recoveryNotice.source) throw new Error('Update recovery notice changed');
      await this.removeOwned(name, 4096);
      this.recoveryNotice = null;
      return this.read();
    });
  }
  private async checkStorage() {
    if (this.failedStorage) throw new UpdateFailure('storage');
    try {
      await this.checkDirectory();
      if ((await this.readSource()) !== this.source) throw new UpdateFailure('storage');
    } catch {
      this.failedStorage = true;
      throw new UpdateFailure('storage');
    }
  }
  private async trust(sequence: number, releaseDigest: string) {
    await this.checkStorage();
    if (
      this.watermark &&
      (sequence < this.watermark.sequence ||
        (sequence === this.watermark.sequence && releaseDigest !== this.watermark.digest))
    )
      throw new UpdateFailure('rollback');
    if (sequence === this.watermark?.sequence && this.watermark.configuration === this.binding())
      return;
    // Retire the previous download before publishing a new trusted generation.
    if (this.recoverableArtifact) {
      await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
      this.recoverableArtifact = false;
    }
    const next = {
      schemaVersion: 1 as const,
      configuration: this.binding(),
      sequence,
      digest: releaseDigest,
    };
    const raw = JSON.stringify(next);
    try {
      const file = await open(this.file('trusted-release.tmp'), 'wx', 0o600);
      try {
        await file.writeFile(raw);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.checkStorage();
      await rename(this.file('trusted-release.tmp'), this.file('trusted-release.json'));
      this.source = raw;
      this.watermark = next;
      // Persist the rename before offering an eligible release on POSIX.
      await syncDirectory(this.directory);
    } catch {
      this.failedStorage = true;
      throw new UpdateFailure('storage');
    }
  }
  async read(): Promise<UpdateState> {
    await this.ready;
    if (this.failedStorage && !this.work) return { ...this.empty('error'), error: 'storage' };
    return structuredClone({
      ...this.state,
      recovery: this.recoveryNotice ? 'restored' : null,
      automatic: this.automaticState(),
    });
  }
  private start(
    phase: 'checking' | 'downloading' | 'preparing' | 'saving',
    timeout: number,
    action: (signal: AbortSignal) => Promise<void>,
  ): Promise<UpdateState> {
    if (this.work || this.closed || !this.config || this.installation || this.abandonment)
      return this.read();
    const controller = new AbortController();
    this.controller = controller;
    this.state.phase = phase;
    this.state.error = null;
    const timer = setTimeout(() => controller.abort(new UpdateFailure('timeout')), timeout);
    this.work = (async () => {
      try {
        await this.ready;
        await this.startup;
        controller.signal.throwIfAborted();
        await this.checkStorage();
        await action(controller.signal);
      } catch (error) {
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        const code = failure instanceof UpdateFailure ? failure.code : 'network';
        if (phase === 'saving' && (code === 'save' || code === 'cancelled' || code === 'timeout')) {
          this.state.phase = 'verified';
          this.state.error = code;
        } else {
          this.state = { ...this.empty('error'), error: code };
          this.release = null;
        }
      } finally {
        clearTimeout(timer);
        // Also release an unread body if local validation/storage failed after headers.
        controller.abort();
        this.controller = null;
        this.work = null;
        this.checkingAutomatically = false;
      }
      return this.read();
    })();
    return this.work;
  }
  check(automatic = false): Promise<UpdateState> {
    if (this.work || this.closed || !this.config || this.installation || this.abandonment)
      return this.read();
    this.checkingAutomatically = automatic;
    return this.start('checking', 30_000, async (signal) => {
      if (!automatic && this.automatic?.enabled) {
        await this.savePreferences(async () => {
          if (this.automatic?.enabled && !this.automaticFailure)
            await this.persistAutomatic({
              ...this.automatic,
              nextCheckAt: this.now() + 36_000_000,
            });
        }).catch(() => {});
        this.scheduleAutomatic();
      }
      signal.throwIfAborted();
      this.release = null;
      this.state = this.empty('checking');
      if (!this.recoverableArtifact) await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
      const body = await requestUpdateFile(this.send, this.config!.feed, signal);
      const envelope = await readUpdateEnvelope(body, updateEnvelopeLimit, signal);
      let verified;
      try {
        verified = verifyUpdateRelease(envelope, this.config!, this.now());
      } catch {
        throw new UpdateFailure('invalid-release');
      }
      await this.trust(verified.release.sequence, verified.digest);
      signal.throwIfAborted();
      const release = verified.release;
      const artifacts = release.artifacts.filter(
        (artifact) =>
          artifact.platform === this.runtime.platform && artifact.arch === this.runtime.arch,
      );
      this.state = {
        ...this.empty(
          !gt(release.version, this.runtime.version)
            ? 'current'
            : artifacts.length
              ? 'available'
              : 'unsupported',
        ),
        version: release.version,
        artifacts: artifacts.map(({ format, size }) => ({ format, size })),
      };
      if (this.state.phase === 'available') this.release = release;
      else if (this.recoverableArtifact) {
        this.recoverableArtifact = false;
        await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
      }
    });
  }
  private async cachedFile() {
    try {
      const info = await lstat(this.file('artifact.ready'));
      if (!this.safeFile(info, 2 * 1024 ** 3)) throw new UpdateFailure('storage');
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new UpdateFailure('storage');
    }
  }
  private async openCachedArtifact(original: Stats) {
    const file = await open(
      this.file('artifact.ready'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => {
      throw new UpdateFailure('storage');
    });
    try {
      const info = await file.stat();
      if (
        !this.safeFile(info, original.size) ||
        info.size !== original.size ||
        info.dev !== original.dev ||
        info.ino !== original.ino ||
        info.ctimeMs !== original.ctimeMs
      )
        throw new UpdateFailure('integrity');
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  private async matchesRecoveredArtifact(artifact: UpdateArtifact, signal: AbortSignal) {
    const before = await this.cachedFile();
    if (before?.size !== artifact.size) return false;
    const file = await this.openCachedArtifact(before);
    this.state.phase = 'verifying';
    try {
      await verifyUpdateArtifact(
        file.createReadStream({ autoClose: false, signal }),
        artifact,
        signal,
        (chunk) => {
          this.state.downloaded += chunk.byteLength;
        },
      );
      const current = await this.cachedFile();
      if (
        !current ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.ctimeMs !== before.ctimeMs
      )
        throw new UpdateFailure('storage');
      return true;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof UpdateFailure && error.code === 'integrity') return false;
      throw new UpdateFailure('storage');
    } finally {
      await file.close();
    }
  }
  download(format: string): Promise<UpdateState> {
    if (this.work || this.closed || this.state.phase !== 'available' || !this.release)
      return this.read();
    const release = this.release;
    const artifact = release.artifacts.find(
      (a) =>
        a.platform === this.runtime.platform && a.arch === this.runtime.arch && a.format === format,
    );
    if (!artifact) return this.read();
    return this.start('downloading', 10 * 60_000, async (signal) => {
      const validateSelection = () => {
        signal.throwIfAborted();
        try {
          validateUpdateRelease(release, this.now());
        } catch {
          throw new UpdateFailure('invalid-release');
        }
      };
      validateSelection();
      this.state.selected = artifact.format;
      this.state.downloaded = 0;
      await this.removeOwned('artifact.part', 2 * 1024 ** 3);
      const recovered =
        this.recoverableArtifact && (await this.matchesRecoveredArtifact(artifact, signal));
      signal.throwIfAborted();
      let created = false;
      try {
        if (!recovered) {
          this.recoverableArtifact = false;
          this.state.phase = 'downloading';
          this.state.downloaded = 0;
          await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
          const body = await requestUpdateFile(
            this.send,
            new URL(artifact.name, this.config!.feed).href,
            signal,
            artifact.size,
          );
          const file = await open(this.file('artifact.part'), 'wx', 0o600).catch(() => {
            throw new UpdateFailure('storage');
          });
          created = true;
          try {
            await verifyUpdateArtifact(body, artifact, signal, async (chunk) => {
              await file.writeFile(chunk).catch(() => {
                throw new UpdateFailure('storage');
              });
              this.state.downloaded += chunk.byteLength;
            });
            await file.sync().catch(() => {
              throw new UpdateFailure('storage');
            });
          } finally {
            await file.close();
          }
        }
        await this.checkStorage();
        validateSelection();
        if (created) {
          await rename(this.file('artifact.part'), this.file('artifact.ready')).catch(() => {
            throw new UpdateFailure('storage');
          });
          created = false;
        }
        this.recoverableArtifact = true;
        // A failed directory sync can leave a complete file for a checked retry.
        await syncDirectory(this.directory).catch(() => {
          throw new UpdateFailure('download-unconfirmed');
        });
        await this.checkStorage();
        validateSelection();
        this.state.phase = 'verified';
        this.state.installId =
          artifact.format === 'AppImage' && this.runtime.appImage ? randomUUID() : null;
        if (!this.state.installId) this.state.saveId = randomUUID();
      } finally {
        if (created) await this.removeOwned('artifact.part', 2 * 1024 ** 3);
      }
    });
  }
  async save(saveId: string, choose: (signedName: string) => Promise<string | undefined>) {
    if (
      this.closed ||
      this.work ||
      this.choosingDestination ||
      this.state.phase !== 'verified' ||
      this.state.saveId !== saveId ||
      !this.release
    )
      return this.read();
    const release = this.release;
    const artifact = release.artifacts.find(
      (item) =>
        item.format === this.state.selected &&
        item.platform === this.runtime.platform &&
        item.arch === this.runtime.arch,
    )!;
    this.choosingDestination = true;
    try {
      const path = await choose(artifact.name);
      if (
        !path ||
        this.closed ||
        this.work ||
        this.state.phase !== 'verified' ||
        this.state.saveId !== saveId
      )
        return this.read();
      return await this.start('saving', 10 * 60_000, async (signal) => {
        const validate = () => {
          try {
            validateUpdateRelease(release, this.now());
          } catch {
            throw new UpdateFailure('invalid-release');
          }
        };
        validate();
        if (
          !isAbsolute(path) ||
          extname(path).toLowerCase() !== '.' + artifact.format.toLowerCase()
        )
          throw new UpdateFailure('save');
        const original = await this.cachedFile();
        if (!original) throw new UpdateFailure('storage');
        if (original.size !== artifact.size) throw new UpdateFailure('integrity');
        const input = await this.openCachedArtifact(original);
        try {
          const confirmed = await exportInstaller(
            input,
            artifact,
            path,
            this.directory,
            signal,
            async () => {
              await this.checkStorage();
              validate();
            },
          );
          if (confirmed) {
            this.state.phase = 'saved';
            delete this.state.saveId;
          } else {
            this.state.phase = 'verified';
            this.state.error = 'save-unconfirmed';
          }
        } catch (error) {
          if (error instanceof UpdateFailure) throw error;
          throw new UpdateFailure('save');
        } finally {
          await input.close();
        }
      });
    } finally {
      this.choosingDestination = false;
    }
  }
  async started() {
    if (!this.startup) {
      this.startup = (async () => {
        await this.ready;
        if (this.runtime.appImage) {
          try {
            await recoverAppImageUpdate(this.runtime.appImage, this.runtime.version);
          } catch {
            this.runtime.appImage = undefined;
            this.state = { ...this.empty('error'), error: 'installation' };
          }
        }
      })();
    }
    await this.startup;
    if (!this.schedulingReady) {
      this.schedulingReady = true;
      this.scheduleAutomatic(30_000);
    }
    return this.read();
  }
  prepareInstall(installId: string) {
    if (
      this.abandonment ||
      this.work ||
      this.closed ||
      this.state.phase !== 'verified' ||
      this.state.installId !== installId ||
      !this.release ||
      !this.runtime.appImage ||
      !['x64', 'arm64'].includes(this.runtime.arch)
    )
      return this.read();
    const release = this.release;
    const artifact = release.artifacts.find(
      (a) =>
        a.format === 'AppImage' &&
        a.platform === this.runtime.platform &&
        a.arch === this.runtime.arch,
    )!;
    this.state.installId = null;
    const installController = new AbortController();
    this.installController = installController;
    return this.start('preparing', installTimeoutMs, async (signal) => {
      const abort = () => installController.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        validateUpdateRelease(release, this.now());
        this.installation = await stageAppImageUpdate(
          {
            target: this.runtime.appImage!,
            source: this.file('artifact.ready'),
            artifact: { size: artifact.size, sha256: artifact.sha256 },
            version: release.version,
            arch: this.runtime.arch as 'x64' | 'arm64',
          },
          installController.signal,
        );
        await this.installation.arm();
        await this.checkStorage();
        validateUpdateRelease(release, this.now());
        signal.throwIfAborted();
        this.state.phase = 'restart-ready';
      } catch (error) {
        await this.installation?.discard().catch(() => {});
        this.installation = null;
        this.installController = null;
        if (signal.aborted) throw error;
        if (error instanceof UnchangedAppImageError) throw new UpdateFailure('unchanged-image');
        throw new UpdateFailure('installation');
      } finally {
        signal.removeEventListener('abort', abort);
      }
    });
  }
  abandonInstall(): Promise<UpdateState> {
    if (this.abandonment) return this.abandonment;
    this.abandonment = this.discardInstallation().finally(() => {
      this.abandonment = null;
    });
    return this.abandonment;
  }
  private async discardInstallation() {
    this.cancel();
    await this.work;
    if (!this.installation) return this.read();
    try {
      await this.installation.discard();
      this.state.phase = 'verified';
      this.state.installId = randomUUID();
    } catch {
      this.state = { ...this.empty('error'), error: 'installation' };
      this.release = null;
    }
    this.installation = null;
    this.installController = null;
    return this.read();
  }
  restartPlan(): InstalledUpdate | null {
    if (
      !this.installation ||
      this.state.phase !== 'restart-ready' ||
      !this.release ||
      !this.runtime.appImage ||
      this.abandonment
    )
      return null;
    const artifact = this.release.artifacts.find(
      (a) =>
        a.format === 'AppImage' &&
        a.platform === this.runtime.platform &&
        a.arch === this.runtime.arch,
    )!;
    return structuredClone({
      target: this.runtime.appImage,
      size: artifact.size,
      sha256: artifact.sha256,
      recovery: this.installation.recovery,
    });
  }
  async commitInstall(): Promise<InstalledUpdate | null> {
    const plan = this.restartPlan();
    const installation = this.installation;
    if (!plan || !installation || !this.release) return null;
    try {
      await this.checkStorage();
      validateUpdateRelease(this.release, this.now());
      await installation.commit();
      this.state.phase = 'installed';
      return plan;
    } catch {
      this.state = { ...this.empty('error'), error: 'installation' };
      // The executable already changed if a directory sync failed after rename.
      // Keep the armed helper and journal for verification at the next startup.
      if (installation.replaced) return plan;
      await installation.discard().catch(() => {});
      return null;
    } finally {
      this.installation = null;
      this.installController = null;
    }
  }
  cancel() {
    this.controller?.abort(new UpdateFailure('cancelled'));
  }
  async close() {
    this.closed = true;
    this.scheduleAutomatic();
    this.cancel();
    await this.work;
    await this.ready;
    await this.abandonment;
    await this.preferences.catch(() => {});
  }
}
