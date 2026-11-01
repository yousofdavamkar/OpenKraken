import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  lstat,
  readlink,
  symlink,
  rename,
  rm,
  chmod,
  copyFile,
  writeFile,
  open,
  readdir,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { GitError } from './runner.js';
const MAX_FILE = 64 * 1024 * 1024;
const MAX_OPERATION = 128 * 1024 * 1024;
export const fileImageSchema = z
  .object({
    pathBytes: z.string(),
    kind: z.enum(['missing', 'file', 'symlink']),
    mode: z.number().int().optional(),
    bytes: z.number().int().nonnegative().max(MAX_FILE).optional(),
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    target: z.string().optional(),
  })
  .refine(
    (image) =>
      image.kind === 'missing' ||
      (image.kind === 'file'
        ? image.digest !== undefined && image.bytes !== undefined && image.mode !== undefined
        : image.target !== undefined &&
          Buffer.from(image.target, 'base64').toString('base64') === image.target),
    'Incomplete file backup metadata',
  );
export type FileImage = z.infer<typeof fileImageSchema>;
export const sameImages = (a?: FileImage[], b?: FileImage[]) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Raw worktree bytes live outside Git so pruning dangling Git objects cannot lose discarded edits. */
export class FileBackups {
  constructor(
    private repository: string,
    private directory: string,
  ) {}
  private blob(digest: string) {
    return join(this.directory, 'files', digest);
  }
  private async path(encoded: string, createParents = false) {
    const bytes = Buffer.from(encoded, 'base64');
    const parts = bytes.toString('latin1').split('/');
    if (
      bytes.toString('base64') !== encoded ||
      bytes.includes(0) ||
      parts.some((p) => !p || ['.', '..', '.git'].includes(p.toLowerCase())) ||
      (process.platform === 'win32' && /[\\:]/.test(bytes.toString('latin1')))
    )
      throw new GitError('UNSAFE_PATH', 'Invalid worktree path');
    const root = Buffer.from(this.repository + sep);
    for (let i = 1; i < parts.length; i++) {
      const parent = Buffer.concat([root, Buffer.from(parts.slice(0, i).join('/'), 'latin1')]);
      try {
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new GitError('UNSAFE_PATH', 'Refusing to follow a symlink or non-directory parent');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (createParents) await mkdir(parent);
        else break;
      }
    }
    return Buffer.concat([root, bytes]);
  }
  private async one(pathBytes: string, persist: boolean, signal?: AbortSignal): Promise<FileImage> {
    if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
    const path = await this.path(pathBytes);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pathBytes, kind: 'missing' };
      throw error;
    }
    if (info.isSymbolicLink())
      return {
        pathBytes,
        kind: 'symlink',
        target: (await readlink(path, { encoding: 'buffer' })).toString('base64'),
      };
    if (!info.isFile())
      throw new GitError(
        'UNSUPPORTED_FILE',
        'Discard supports files and links, not directories or submodule worktrees',
      );
    if (info.size > MAX_FILE)
      throw new GitError('UNDO_LIMIT', 'A file exceeds the 64 MiB discard backup limit');
    if (persist) await mkdir(join(this.directory, 'files'), { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, 'files', `${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    const consume = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FILE)
        throw new GitError('UNDO_LIMIT', 'A file exceeds the 64 MiB discard backup limit');
      hash.update(chunk);
    };
    const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const input = source.createReadStream({ autoClose: false, signal });
    try {
      if (persist) {
        await pipeline(
          input,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              try {
                consume(chunk);
                callback(null, chunk);
              } catch (e) {
                callback(e as Error);
              }
            },
          }),
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        );
        const file = await open(temporary, 'r');
        try {
          await file.sync();
        } finally {
          await file.close();
        }
      } else for await (const chunk of input) consume(Buffer.from(chunk));
      const after = await lstat(path);
      if (
        !after.isFile() ||
        info.ino !== after.ino ||
        info.dev !== after.dev ||
        info.size !== after.size ||
        info.mtimeMs !== after.mtimeMs ||
        info.ctimeMs !== after.ctimeMs
      )
        throw new GitError('FILE_CHANGED', 'The file changed while its backup was being read');
      const digest = hash.digest('hex');
      if (persist) await rename(temporary, this.blob(digest));
      return { pathBytes, kind: 'file', mode: info.mode & 0o777, bytes: size, digest };
    } finally {
      await source.close();
      if (persist) await rm(temporary, { force: true });
    }
  }
  async capture(paths: string[], persist = false, signal?: AbortSignal) {
    const images: FileImage[] = [];
    let bytes = 0;
    for (const path of [...new Set(paths)]) {
      const image = await this.one(path, persist, signal).catch((error: unknown) => {
        if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
        throw error;
      });
      bytes += image.bytes ?? 0;
      if (bytes > MAX_OPERATION)
        throw new GitError('UNDO_LIMIT', 'Selected files exceed the 128 MiB discard backup limit');
      images.push(image);
    }
    return images;
  }
  async assertCurrent(images: FileImage[], code = 'STALE_UNDO') {
    if (!sameImages(images, await this.capture(images.map((i) => i.pathBytes))))
      throw new GitError(
        code,
        'Working files changed after this action. Newer edits were left untouched.',
      );
  }
  async trash(image: FileImage, signal?: AbortSignal) {
    if (image.kind === 'missing') return;
    await this.assertCurrent([image], 'FILE_CHANGED');
    if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
    const source = await this.path(image.pathBytes);
    const directory = join(this.directory, 'trash', randomUUID()),
      target = join(directory, 'content');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'original.json'), JSON.stringify(image), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      if (image.kind === 'symlink') await symlink(Buffer.from(image.target!, 'base64'), target);
      else {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        const file = await open(target, 'r');
        try {
          await file.sync();
        } finally {
          await file.close();
        }
      }
      await this.assertCurrent([image], 'FILE_CHANGED');
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      await rm(source);
    }
  }
  private async verify(images: FileImage[]) {
    for (const image of images)
      if (image.kind === 'file') {
        if (!image.digest) throw new GitError('BACKUP_CORRUPT', 'Missing backup digest');
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(this.blob(image.digest))) {
          bytes += chunk.length;
          if (bytes > MAX_FILE) throw new GitError('BACKUP_CORRUPT', 'Backup exceeds size limit');
          hash.update(chunk);
        }
        if (bytes !== image.bytes || hash.digest('hex') !== image.digest)
          throw new GitError(
            'BACKUP_CORRUPT',
            'Backup verification failed; working files were left unchanged',
          );
      }
  }
  private async restoreOne(image: FileImage, signal?: AbortSignal) {
    if (image.kind === 'missing') {
      await this.trash(await this.one(image.pathBytes, false), signal);
      return;
    }
    const path = await this.path(image.pathBytes, true),
      temporary = Buffer.concat([path, Buffer.from(`.openkraken-${randomUUID()}.tmp`)]);
    try {
      if (image.kind === 'symlink') await symlink(Buffer.from(image.target!, 'base64'), temporary);
      else {
        await copyFile(this.blob(image.digest!), temporary, constants.COPYFILE_EXCL);
        await chmod(temporary, image.mode!);
        const file = await open(temporary, 'r');
        try {
          await file.sync();
        } finally {
          await file.close();
        }
      }
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async prune(images: FileImage[]) {
    const names = await readdir(this.directory).catch(() => []);
    if (names.some((name) => name.startsWith('pending-'))) return;
    const keep = new Set(images.map((i) => i.digest).filter(Boolean));
    for (const name of await readdir(join(this.directory, 'files')).catch(() => [])) {
      if (/^[0-9a-f]{64}$/.test(name) && !keep.has(name))
        await rm(this.blob(name), { force: true });
    }
  }
  async restore(images: FileImage[], signal?: AbortSignal) {
    await this.verify(images);
    const before = await this.capture(
      images.map((i) => i.pathBytes),
      true,
    );
    const done: number[] = [];
    try {
      for (const [i, image] of images.entries()) {
        await this.assertCurrent([before[i]!]);
        await this.restoreOne(image, signal);
        done.push(i);
      }
    } catch (error) {
      for (const i of done.reverse()) {
        try {
          await this.assertCurrent([images[i]!]);
          await this.restoreOne(before[i]!);
        } catch {
          /* Preserve backups if an editor raced rollback. */
        }
      }
      throw error;
    }
  }
}
