import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { releaseVersionSchema } from './update-protocol.js';
import { z } from 'zod';

const maximum = 2 * 1024 ** 3;
const digestSchema = z.strictObject({
  size: z.number().int().min(64).max(maximum),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const transactionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  product: z.literal('org.openkraken.desktop'),
  target: z.string().min(1).max(255),
  version: releaseVersionSchema,
  arch: z.enum(['x64', 'arm64']),
  next: digestSchema,
  previous: digestSchema,
});
type Digest = z.infer<typeof digestSchema>;
type Transaction = z.infer<typeof transactionSchema>;
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const matches = (a: Digest, b: Digest) => a.size === b.size && a.sha256 === b.sha256;
function fail(): never {
  throw new Error('AppImage update files are unavailable or changed');
}
function targetPath(target: string) {
  if (
    process.platform !== 'linux' ||
    !isAbsolute(target) ||
    normalize(target) !== target ||
    /\p{Cc}/u.test(target)
  )
    fail();
  return target + '.openkraken-update';
}
async function directory(path: string, privateOnly = false) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    info.mode & (privateOnly ? 0o077 : 0o022)
  )
    fail();
  return info;
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function ownedFile(path: string, limit: number, links = 1, privateOnly = false) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid!() ||
    info.nlink !== links ||
    info.size > limit ||
    info.mode & (privateOnly ? 0o077 : 0o022)
  )
    fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!same(await file.stat(), info)) {
    await file.close();
    fail();
  }
  return { file, info };
}
async function imageDigest(
  path: string,
  arch: 'x64' | 'arm64',
  signal: AbortSignal,
  links = 1,
): Promise<Digest> {
  const { file, info } = await ownedFile(path, maximum, links);
  try {
    signal.throwIfAborted();
    const header = Buffer.alloc(64);
    const read = await file.read(header, 0, 64, 0);
    if (
      read.bytesRead !== 64 ||
      header.subarray(0, 7).toString('hex') !== '7f454c46020101' ||
      header.subarray(8, 11).toString('hex') !== '414902' ||
      header.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183)
    )
      fail();
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > maximum || size > info.size) fail();
      hash.update(chunk);
    }
    if (size !== info.size || !same(await file.stat(), info) || !same(await lstat(path), info))
      fail();
    return { size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}
async function readTransaction(target: string) {
  const folder = targetPath(target);
  await directory(dirname(target));
  await directory(folder, true);
  const { file } = await ownedFile(folder + '/transaction.json', 4096, 1, true);
  try {
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 4096) fail();
    const transaction = transactionSchema.parse(
      JSON.parse(bytes.subarray(0, size).toString('utf8')),
    );
    if (transaction.target !== basename(target)) fail();
    return transaction;
  } finally {
    await file.close();
  }
}
/** Identifies the installed transaction for the slow-start dialog. Recovery verifies the images. */
export async function pendingAppImageStartup(target: string, version: string) {
  try {
    const transaction = await readTransaction(target);
    if (transaction.version !== version || transaction.arch !== process.arch) return false;
    const files = await readdir(targetPath(target), { withFileTypes: true });
    return (
      files.length === 2 &&
      files.every(
        (entry) => entry.isFile() && ['transaction.json', 'previous.AppImage'].includes(entry.name),
      )
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class UnchangedAppImageError extends Error {
  constructor() {
    super('This AppImage is already installed.');
  }
}

/** A main-owned file transaction; staging never changes the running image. */
export async function stageAppImageUpdate(
  input: {
    target: string;
    source: string;
    artifact: Digest;
    version: string;
    arch: 'x64' | 'arm64';
  },
  signal: AbortSignal,
) {
  const { target, source, arch } = input;
  const folder = targetPath(target);
  const parent = await directory(dirname(target));
  const previous = await imageDigest(target, arch, signal);
  const original = await lstat(target);
  const next = digestSchema.parse(input.artifact);
  if (!matches(await imageDigest(source, arch, signal), next)) fail();
  if (matches(previous, next)) throw new UnchangedAppImageError();
  const transaction = transactionSchema.parse({
    schemaVersion: 1,
    product: 'org.openkraken.desktop',
    target: basename(target),
    version: input.version,
    arch,
    next,
    previous,
  });
  signal.throwIfAborted();
  await mkdir(folder, { mode: 0o700 }); // Existing transactions are never overwritten.
  const owned = await directory(folder, true);
  const staged = folder + '/next.AppImage';
  const backup = folder + '/previous.AppImage';
  const journal = folder + '/transaction.json';
  const journalTemporary = folder + '/transaction.tmp';
  let committed = false;
  let armed: { target: Stats; staged: Stats; backup: Stats } | null = null;
  const checkFolder = async () => {
    const current = await directory(folder, true);
    const currentParent = await directory(dirname(target));
    if (
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      currentParent.dev !== parent.dev ||
      currentParent.ino !== parent.ino
    )
      fail();
  };
  try {
    const { file: sourceFile, info } = await ownedFile(source, maximum);
    try {
      const output = await open(staged, 'wx', 0o600);
      try {
        let size = 0;
        for await (const chunk of sourceFile.createReadStream({ autoClose: false })) {
          signal.throwIfAborted();
          size += chunk.length;
          if (size > next.size) fail();
          await output.writeFile(chunk);
        }
        if (size !== next.size || !same(await sourceFile.stat(), info)) fail();
        await output.sync();
      } finally {
        await output.close();
      }
    } finally {
      await sourceFile.close();
    }
    if (!matches(await imageDigest(staged, arch, signal), next)) fail();
    const journalFile = await open(journalTemporary, 'wx', 0o600);
    try {
      await journalFile.writeFile(JSON.stringify(transaction));
      await journalFile.sync();
    } finally {
      await journalFile.close();
    }
    await rename(journalTemporary, journal);
    await syncDirectory(folder);
    await syncDirectory(dirname(target));
  } catch (error) {
    // Only files created by this attempt can exist here. Never recursively remove a directory.
    await checkFolder();
    for (const path of [staged, journalTemporary, journal]) {
      if (await exists(path)) {
        const { file } = await ownedFile(path, path === staged ? maximum : 4096, 1, true);
        await file.close();
        await unlink(path);
      }
    }
    await rmdir(folder);
    throw error;
  }
  const arm = async () => {
    if (committed) fail();
    if (armed) return;
    signal.throwIfAborted();
    await checkFolder();
    if (
      JSON.stringify(await readTransaction(target)) !== JSON.stringify(transaction) ||
      !same(await lstat(target), original) ||
      !matches(await imageDigest(target, arch, signal), previous) ||
      !matches(await imageDigest(staged, arch, signal), next)
    )
      fail();
    const { file: executable } = await ownedFile(staged, maximum, 1, true);
    try {
      await executable.chmod(0o700);
      await executable.sync();
    } finally {
      await executable.close();
    }
    await link(target, backup);
    await syncDirectory(folder);
    if (!same(await lstat(target), original) || !same(await lstat(backup), original)) fail();
    armed = {
      target: await lstat(target),
      staged: await lstat(staged),
      backup: await lstat(backup),
    };
  };
  return {
    get replaced() {
      return committed;
    },
    recovery: {
      previous: { ...previous },
      journalSha256: createHash('sha256').update(JSON.stringify(transaction)).digest('hex'),
    },
    arm,
    async commit() {
      if (committed) fail();
      await arm();
      await checkFolder();
      if (JSON.stringify(await readTransaction(target)) !== JSON.stringify(transaction)) fail();
      for (const [path, before] of [
        [target, armed!.target],
        [staged, armed!.staged],
        [backup, armed!.backup],
      ] as const) {
        const current = await lstat(path);
        if (
          !same(current, before) ||
          current.ctimeMs !== before.ctimeMs ||
          current.mode !== before.mode ||
          current.nlink !== before.nlink
        )
          fail();
      }
      signal.throwIfAborted();
      await rename(staged, target);
      committed = true;
      await syncDirectory(dirname(target));
      await syncDirectory(folder);
    },
    async discard() {
      if (committed) fail();
      // Cancellation stops installation, not the cleanup it requires.
      return recoverAppImageUpdate(target, '');
    },
  };
}

/** Called after startup: discard interrupted staging or acknowledge the new app version. */
export async function recoverAppImageUpdate(
  target: string,
  version: string,
  signal = new AbortController().signal,
): Promise<'none' | 'discarded' | 'confirmed'> {
  const folder = targetPath(target);
  if (!(await exists(folder))) return 'none';
  await directory(dirname(target));
  await directory(folder, true);
  const names = await readdir(folder);
  if (
    names.some(
      (name) =>
        !['next.AppImage', 'previous.AppImage', 'transaction.json', 'transaction.tmp'].includes(
          name,
        ),
    )
  )
    fail();
  if (!names.includes('transaction.json')) {
    if (names.includes('previous.AppImage')) fail();
    // Replacement cannot begin before the durable journal exists. A crash in
    // the initial copy leaves only our private, possibly incomplete staging file.
    for (const name of names) {
      const { file } = await ownedFile(
        folder + '/' + name,
        name === 'next.AppImage' ? maximum : 4096,
        1,
        true,
      );
      await file.close();
    }
    signal.throwIfAborted();
    for (const name of names) await unlink(folder + '/' + name);
    await rmdir(folder);
    await syncDirectory(dirname(target));
    return 'discarded';
  }
  if (names.includes('transaction.tmp')) fail();
  const transaction: Transaction = await readTransaction(target);
  const backup = folder + '/previous.AppImage';
  const staged = folder + '/next.AppImage';
  const hasBackup = await exists(backup);
  const targetInfo = await lstat(target);
  const backupInfo = hasBackup ? await lstat(backup) : null;
  const linked =
    backupInfo !== null && backupInfo.dev === targetInfo.dev && backupInfo.ino === targetInfo.ino;
  const current = await imageDigest(target, transaction.arch, signal, linked ? 2 : 1);
  // Older builds could stage identical images. If the predecessor is still present,
  // discard the journal after validating all retained files, including hard links.
  const installed = !matches(current, transaction.previous);
  if (installed && (!matches(current, transaction.next) || version !== transaction.version)) fail();
  // Validate every existing file before removing any part of the recovery transaction.
  if (
    hasBackup &&
    !matches(
      await imageDigest(backup, transaction.arch, signal, linked ? 2 : 1),
      transaction.previous,
    )
  )
    fail();
  if (await exists(staged)) {
    if (!matches(await imageDigest(staged, transaction.arch, signal), transaction.next)) fail();
  }
  // A parent or helper can exit after a rename but before syncing either directory.
  // Keep the rollback files until the currently verified image is durable.
  await syncDirectory(dirname(target));
  await syncDirectory(folder);
  signal.throwIfAborted();
  if (hasBackup) await unlink(backup);
  if (await exists(staged)) await unlink(staged);
  await unlink(folder + '/transaction.json');
  await rmdir(folder);
  await syncDirectory(dirname(target));
  return installed ? 'confirmed' : 'discarded';
}

/** Restore only the locally retained predecessor of this exact replacement. */
export async function rollbackAppImageUpdate(target: string) {
  const folder = targetPath(target);
  const transaction = await readTransaction(target);
  const names = await readdir(folder);
  if (names.some((name) => !['previous.AppImage', 'transaction.json'].includes(name))) fail();
  const signal = new AbortController().signal;
  const backup = folder + '/previous.AppImage';
  if (
    !matches(await imageDigest(target, transaction.arch, signal), transaction.next) ||
    !matches(await imageDigest(backup, transaction.arch, signal), transaction.previous)
  )
    fail();
  await rename(backup, target);
  await syncDirectory(dirname(target));
  await syncDirectory(folder);
  await recoverAppImageUpdate(target, '');
}
