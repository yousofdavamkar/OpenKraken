import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stageAppImageUpdate,
  recoverAppImageUpdate,
  rollbackAppImageUpdate,
} from './src/appimage-install.js';

function image(text: string) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.set([0x41, 0x49, 2], 8);
  bytes.writeUInt16LE(62, 18);
  return Buffer.concat([bytes, Buffer.from(text)]);
}

test.skipIf(process.platform !== 'linux')(
  'startup retains the predecessor and journal until the replacement directory can sync',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-sync-'));
    const target = join(root, 'OpenKraken.AppImage');
    const source = join(root, 'artifact.ready');
    const folder = target + '.openkraken-update';
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      const staged = await stageAppImageUpdate(
        { target, source, artifact, version: '0.2.0', arch: 'x64' },
        new AbortController().signal,
      );
      await staged.commit();
      const journal = await readFile(join(folder, 'transaction.json'));
      const directory = await open(root, 'r');
      const prototype: typeof directory = Object.getPrototypeOf(directory);
      await directory.close();
      for (const failSecondDirectory of [false, true]) {
        const originalSync = prototype.sync;
        const sync = vi.spyOn(prototype, 'sync');
        if (failSecondDirectory) sync.mockImplementationOnce(originalSync);
        sync.mockRejectedValue(new Error('Directory sync failed'));
        try {
          await expect(recoverAppImageUpdate(target, '0.2.0')).rejects.toThrow(
            'Directory sync failed',
          );
          expect(await readFile(join(folder, 'previous.AppImage'))).toEqual(oldImage);
          expect(await readFile(join(folder, 'transaction.json'))).toEqual(journal);
        } finally {
          sync.mockRestore();
        }
      }
      expect(await recoverAppImageUpdate(target, '0.2.0')).toBe('confirmed');
      expect(await readFile(target)).toEqual(newImage);
      await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test.skipIf(process.platform !== 'linux')(
  'a failed replacement can restore the exact retained image without overwriting a changed target',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-rollback-'));
    const target = join(root, 'OpenKraken.AppImage');
    const source = join(root, 'artifact.ready');
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      const input = { target, source, artifact, version: '0.2.0', arch: 'x64' as const };
      const first = await stageAppImageUpdate(input, new AbortController().signal);
      await first.commit();
      await rollbackAppImageUpdate(target);
      expect(await readFile(target)).toEqual(oldImage);
      expect(await recoverAppImageUpdate(target, '0.1.0')).toBe('none');
      const second = await stageAppImageUpdate(input, new AbortController().signal);
      await second.commit();
      await writeFile(target, image('external-change'));
      await expect(rollbackAppImageUpdate(target)).rejects.toThrow();
      expect(await readFile(target)).toEqual(image('external-change'));
      expect(await readFile(join(target + '.openkraken-update', 'previous.AppImage'))).toEqual(
        oldImage,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'arming verifies and retains the predecessor without replacing it, and detects changes before commit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-arm-'));
    const target = join(root, 'OpenKraken.AppImage'),
      source = join(root, 'cache');
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      const staged = await stageAppImageUpdate(
        { target, source, artifact, version: '0.2.0', arch: 'x64' },
        new AbortController().signal,
      );
      await staged.arm();
      expect(await readFile(target)).toEqual(oldImage);
      await writeFile(join(target + '.openkraken-update', 'next.AppImage'), image('tampered!'));
      await expect(staged.commit()).rejects.toThrow();
      expect(await readFile(target)).toEqual(oldImage);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
const oldImage = image('old-image');
const newImage = image('new-image');
const artifact = {
  size: newImage.length,
  sha256: createHash('sha256').update(newImage).digest('hex'),
};

test.skipIf(process.platform !== 'linux')(
  'a newer release containing the installed image cannot stage a restart',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-duplicate-'));
    const target = join(root, 'OpenKraken.AppImage');
    const source = join(root, 'artifact.ready');
    try {
      await writeFile(target, newImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      await expect(
        stageAppImageUpdate(
          { target, source, artifact, version: '0.2.0', arch: 'x64' },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/already installed/);
      expect(await readFile(target)).toEqual(newImage);
      await expect(stat(target + '.openkraken-update')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux').each(['staged', 'armed', 'renamed'])(
  'startup discards a legacy %s journal for an identical replacement',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-old-journal-'));
    const target = join(root, 'OpenKraken.AppImage');
    const folder = target + '.openkraken-update';
    const leftover = join(folder, phase === 'renamed' ? 'previous.AppImage' : 'next.AppImage');
    try {
      await writeFile(target, newImage, { mode: 0o700 });
      await mkdir(folder, { mode: 0o700 });
      await writeFile(
        join(folder, 'transaction.json'),
        JSON.stringify({
          schemaVersion: 1,
          product: 'org.openkraken.desktop',
          target: 'OpenKraken.AppImage',
          version: '0.2.0',
          arch: 'x64',
          next: artifact,
          previous: artifact,
        }),
        { mode: 0o600 },
      );
      if (phase === 'armed') await link(target, join(folder, 'previous.AppImage'));
      await writeFile(leftover, oldImage, { mode: 0o700 });
      await expect(recoverAppImageUpdate(target, '0.1.0')).rejects.toThrow();
      expect(await readFile(leftover)).toEqual(oldImage);
      await writeFile(leftover, newImage);
      expect(await recoverAppImageUpdate(target, '0.1.0')).toBe('discarded');
      expect(await readFile(target)).toEqual(newImage);
      expect((await stat(target)).nlink).toBe(1);
      expect(await recoverAppImageUpdate(target, '0.1.0')).toBe('none');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'AppImage replacement preserves the filename and retains recovery until the new app confirms startup',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-install-'));
    const target = join(root, 'My app.AppImage');
    const source = join(root, 'artifact.ready');
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      const staged = await stageAppImageUpdate(
        { target, source, artifact, version: '0.2.0', arch: 'x64' },
        new AbortController().signal,
      );
      expect(await readFile(target)).toEqual(oldImage);
      await expect(
        stageAppImageUpdate(
          { target, source, artifact, version: '0.2.0', arch: 'x64' },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      await staged.commit();
      expect(await readFile(target)).toEqual(newImage);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(target + '.openkraken-update', 'previous.AppImage'))).toEqual(
        oldImage,
      );
      await expect(recoverAppImageUpdate(target, '0.1.0')).rejects.toThrow();
      expect(await recoverAppImageUpdate(target, '0.2.0')).toBe('confirmed');
      await expect(stat(target + '.openkraken-update')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await recoverAppImageUpdate(target, '0.2.0')).toBe('none');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'interrupted staging and interrupted acknowledgement can be recovered repeatedly',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-recovery-'));
    const target = join(root, 'OpenKraken.AppImage');
    const source = join(root, 'artifact.ready');
    const folder = target + '.openkraken-update';
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      // A crash while copying happens before any journal or replacement exists.
      await mkdir(folder, { mode: 0o700 });
      await writeFile(join(folder, 'next.AppImage'), 'partial', { mode: 0o600 });
      await writeFile(join(folder, 'transaction.tmp'), '{"partial":', { mode: 0o600 });
      expect(await recoverAppImageUpdate(target, '0.1.0')).toBe('discarded');
      expect(await readFile(target)).toEqual(oldImage);
      await stageAppImageUpdate(
        { target, source, artifact, version: '0.2.0', arch: 'x64' },
        new AbortController().signal,
      );
      // A crash after retaining the old inode but before the atomic rename.
      await link(target, join(folder, 'previous.AppImage'));
      expect(await recoverAppImageUpdate(target, '0.1.0')).toBe('discarded');
      expect((await stat(target)).nlink).toBe(1);
      const next = await stageAppImageUpdate(
        { target, source, artifact, version: '0.2.0', arch: 'x64' },
        new AbortController().signal,
      );
      await next.commit();
      // Cleanup itself can be interrupted after removing the old image.
      await unlink(join(folder, 'previous.AppImage'));
      expect(await recoverAppImageUpdate(target, '0.2.0')).toBe('confirmed');
      expect(await readFile(target)).toEqual(newImage);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'unrecognized recovery files are preserved before any old image is removed',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-recovery-files-'));
    const target = join(root, 'OpenKraken.AppImage');
    const source = join(root, 'artifact.ready');
    const folder = target + '.openkraken-update';
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      const staged = await stageAppImageUpdate(
        { target, source, artifact, version: '0.2.0', arch: 'x64' },
        new AbortController().signal,
      );
      await staged.commit();
      await writeFile(join(folder, 'unknown'), 'preserve');
      await expect(recoverAppImageUpdate(target, '0.2.0')).rejects.toThrow();
      expect(await readFile(join(folder, 'previous.AppImage'))).toEqual(oldImage);
      expect(await readFile(join(folder, 'unknown'), 'utf8')).toBe('preserve');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'tampering, wrong architecture and cancellation cannot replace an installed image',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-rejections-'));
    const target = join(root, 'OpenKraken.AppImage');
    const source = join(root, 'artifact.ready');
    try {
      await writeFile(target, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      const input = { target, source, artifact, version: '0.2.0', arch: 'x64' as const };
      const signal = new AbortController().signal;
      await expect(
        stageAppImageUpdate(
          { ...input, artifact: { ...artifact, sha256: '0'.repeat(64) } },
          signal,
        ),
      ).rejects.toThrow();
      await expect(stageAppImageUpdate({ ...input, arch: 'arm64' }, signal)).rejects.toThrow();
      await expect(stat(target + '.openkraken-update')).rejects.toMatchObject({ code: 'ENOENT' });
      const controller = new AbortController();
      const staged = await stageAppImageUpdate(input, controller.signal);
      controller.abort();
      await expect(staged.commit()).rejects.toThrow();
      expect(await staged.discard()).toBe('discarded');
      const changed = await stageAppImageUpdate(input, signal);
      await writeFile(join(target + '.openkraken-update', 'next.AppImage'), image('bad-image'));
      await expect(changed.commit()).rejects.toThrow();
      expect(await readFile(target)).toEqual(oldImage);
      await expect(recoverAppImageUpdate(target, '0.1.0')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'symlinks, hard links and writable install locations are not modified',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-ownership-'));
    const target = join(root, 'OpenKraken.AppImage');
    const source = join(root, 'artifact.ready');
    const original = join(root, 'original.AppImage');
    try {
      await writeFile(original, oldImage, { mode: 0o700 });
      await writeFile(source, newImage, { mode: 0o600 });
      const input = { target, source, artifact, version: '0.2.0', arch: 'x64' as const };
      const signal = new AbortController().signal;
      await symlink(original, target);
      await expect(stageAppImageUpdate(input, signal)).rejects.toThrow();
      await unlink(target);
      await link(original, target);
      await expect(stageAppImageUpdate(input, signal)).rejects.toThrow();
      await unlink(target);
      await writeFile(target, oldImage, { mode: 0o700 });
      await chmod(root, 0o777);
      await expect(stageAppImageUpdate(input, signal)).rejects.toThrow();
      await chmod(root, 0o700);
      expect(await readFile(original)).toEqual(oldImage);
      expect(await readFile(target)).toEqual(oldImage);
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);
