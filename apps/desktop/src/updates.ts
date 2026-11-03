import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gt, valid } from 'semver';
import { z } from 'zod';
import type { UpdateState } from '@openkraken/ipc-contract';
import { stageAppImageUpdate, recoverAppImageUpdate } from './appimage-install.js';
import {
  updateConfiguration,
  updateEnvelopeLimit,
  validateUpdateRelease,
  verifyUpdateRelease,
  type UpdateConfiguration,
  type UpdateRelease,
} from './update-protocol.js';

type UpdateError = NonNullable<UpdateState['error']>;
class UpdateFailure extends Error {
  constructor(readonly code: UpdateError) {
    super(code);
  }
}
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
const watermarkSchema = z.strictObject({
  schemaVersion: z.literal(1),
  configuration: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

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
  private controller: AbortController | null = null;
  private work: Promise<UpdateState> | null = null;
  private closed = false;
  private installation: Awaited<ReturnType<typeof stageAppImageUpdate>> | null = null;
  private installController: AbortController | null = null;
  private startup: Promise<void> | null = null;
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
      phase,
      version: null,
      artifacts: [],
      selected: null,
      downloaded: 0,
      installId: null,
      error: null,
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
  private async readSource() {
    const path = this.file('trusted-release.json');
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
  private binding() {
    return digest(JSON.stringify(this.config));
  }
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory(true);
    this.source = await this.readSource();
    this.watermark = this.source === null ? null : watermarkSchema.parse(JSON.parse(this.source));
    if (this.watermark && this.watermark.configuration !== this.binding())
      throw new UpdateFailure('storage');
    // A prior verified file is never trusted after restart without a fresh check/download.
    await this.removeOwned('trusted-release.tmp', 4096);
    await this.removeOwned('artifact.part', 2 * 1024 ** 3);
    await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
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
    if (sequence === this.watermark?.sequence) return;
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
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      this.failedStorage = true;
      throw new UpdateFailure('storage');
    }
  }
  async read(): Promise<UpdateState> {
    await this.ready;
    if (this.failedStorage && !this.work) return { ...this.empty('error'), error: 'storage' };
    return structuredClone(this.state);
  }
  private start(
    phase: 'checking' | 'downloading' | 'preparing',
    timeout: number,
    action: (signal: AbortSignal) => Promise<void>,
  ): Promise<UpdateState> {
    if (this.work || this.closed || !this.config || this.installation) return this.read();
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
        this.state = {
          ...this.empty('error'),
          error: failure instanceof UpdateFailure ? failure.code : 'network',
        };
        this.release = null;
      } finally {
        clearTimeout(timer);
        // Also release an unread body if local validation/storage failed after headers.
        controller.abort();
        this.controller = null;
        this.work = null;
      }
      return structuredClone(this.state);
    })();
    return this.work;
  }
  private async request(url: string, signal: AbortSignal) {
    const response = await this.send(url, {
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Accept-Encoding': 'identity' },
    });
    if (
      response.status !== 200 ||
      !response.body ||
      ![null, 'identity'].includes(response.headers.get('content-encoding'))
    ) {
      await response.body?.cancel();
      throw new UpdateFailure('network');
    }
    return response;
  }
  check(): Promise<UpdateState> {
    return this.start('checking', 30_000, async (signal) => {
      this.release = null;
      this.state = this.empty('checking');
      await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
      const response = await this.request(this.config!.feed, signal);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body!) {
        signal.throwIfAborted();
        size += chunk.byteLength;
        if (size > updateEnvelopeLimit) throw new UpdateFailure('invalid-release');
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      let verified;
      try {
        verified = verifyUpdateRelease(
          Buffer.concat(chunks).toString('utf8'),
          this.config!,
          this.now(),
        );
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
    });
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
      try {
        validateUpdateRelease(release, this.now());
      } catch {
        throw new UpdateFailure('invalid-release');
      }
      this.state.selected = artifact.format;
      this.state.downloaded = 0;
      await this.removeOwned('artifact.part', 2 * 1024 ** 3);
      await this.removeOwned('artifact.ready', 2 * 1024 ** 3);
      let created = false;
      try {
        const response = await this.request(new URL(artifact.name, this.config!.feed).href, signal);
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== artifact.size)) {
          await response.body!.cancel();
          throw new UpdateFailure('integrity');
        }
        const file = await open(this.file('artifact.part'), 'wx', 0o600).catch(() => {
          throw new UpdateFailure('storage');
        });
        created = true;
        try {
          const hash = createHash('sha256');
          for await (const chunk of response.body!) {
            signal.throwIfAborted();
            if (this.state.downloaded + chunk.byteLength > artifact.size)
              throw new UpdateFailure('integrity');
            await file.writeFile(chunk).catch(() => {
              throw new UpdateFailure('storage');
            });
            hash.update(chunk);
            this.state.downloaded += chunk.byteLength;
          }
          signal.throwIfAborted();
          if (this.state.downloaded !== artifact.size || hash.digest('hex') !== artifact.sha256)
            throw new UpdateFailure('integrity');
          await file.sync().catch(() => {
            throw new UpdateFailure('storage');
          });
        } finally {
          await file.close();
        }
        try {
          validateUpdateRelease(release, this.now());
        } catch {
          throw new UpdateFailure('invalid-release');
        }
        await this.checkStorage();
        signal.throwIfAborted();
        await rename(this.file('artifact.part'), this.file('artifact.ready')).catch(() => {
          throw new UpdateFailure('storage');
        });
        created = false;
        this.state.phase = 'verified';
        this.state.installId =
          artifact.format === 'AppImage' && this.runtime.appImage ? randomUUID() : null;
      } finally {
        if (created) await this.removeOwned('artifact.part', 2 * 1024 ** 3);
      }
    });
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
    return this.read();
  }
  prepareInstall(installId: string) {
    if (
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
    return this.start('preparing', 10 * 60_000, async (signal) => {
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
        throw new UpdateFailure('installation');
      } finally {
        signal.removeEventListener('abort', abort);
      }
    });
  }
  async abandonInstall() {
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
  async commitInstall(): Promise<{ target: string; size: number; sha256: string } | null> {
    if (
      !this.installation ||
      this.state.phase !== 'restart-ready' ||
      !this.release ||
      !this.runtime.appImage
    )
      return null;
    try {
      await this.checkStorage();
      validateUpdateRelease(this.release, this.now());
      await this.installation.commit();
      this.state.phase = 'installed';
      this.installation = null;
      this.installController = null;
      const artifact = this.release.artifacts.find(
        (a) =>
          a.format === 'AppImage' &&
          a.platform === this.runtime.platform &&
          a.arch === this.runtime.arch,
      )!;
      return { target: this.runtime.appImage, size: artifact.size, sha256: artifact.sha256 };
    } catch {
      await this.installation?.discard().catch(() => {});
      this.installation = null;
      this.installController = null;
      this.state = { ...this.empty('error'), error: 'installation' };
      return null;
    }
  }
  cancel() {
    this.controller?.abort(new UpdateFailure('cancelled'));
  }
  async close() {
    this.closed = true;
    this.cancel();
    await this.work;
    await this.ready;
  }
}
