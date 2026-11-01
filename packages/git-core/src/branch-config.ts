import { randomUUID } from 'node:crypto';
import { readFile, writeFile, appendFile, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, type runGit, type RunOptions } from './runner.js';
export type BranchSettings = Record<string, string[]>;
type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
const LIMIT = 2 * 1024 * 1024;
function quote(bytes: Buffer) {
  const chunks: Buffer[] = [Buffer.from('"')];
  const escapes: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 34: '\\"', 92: '\\\\' };
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const escaped = escapes[bytes[i]!];
    if (escaped) {
      chunks.push(bytes.subarray(start, i), Buffer.from(escaped));
      start = i + 1;
    }
  }
  chunks.push(bytes.subarray(start), Buffer.from('"'));
  return Buffer.concat(chunks);
}
/** Scoped config restoration preserves unrelated settings and validates bytes with native Git. */
export class BranchConfiguration {
  constructor(
    private commonDir: string,
    private directory: string,
    private run: Run,
  ) {}
  async read(names: string[], signal?: AbortSignal, file?: string): Promise<BranchSettings> {
    const config: BranchSettings = Object.fromEntries(names.map((name) => [name, []]));
    const raw = (
      await this.run(['config', ...(file ? ['--file', file] : ['--local']), '--null', '--list'], {
        signal,
        maxBytes: LIMIT,
      })
    ).stdout;
    for (let at = 0; at < raw.length;) {
      const end = raw.indexOf(0, at);
      if (end < 0) break;
      const entry = raw.subarray(at, end),
        newline = entry.indexOf(10);
      const key = entry.subarray(0, newline < 0 ? entry.length : newline);
      const section = key.subarray(0, key.lastIndexOf(46));
      for (const name of names)
        if (section.equals(Buffer.from(`branch.${name}`)))
          config[name]!.push(entry.toString('base64'));
      at = end + 1;
    }
    return config;
  }
  private serialize(name: string, entries: string[]) {
    if (!entries.length) return Buffer.alloc(0);
    const chunks = [Buffer.from('\n[branch '), quote(Buffer.from(name)), Buffer.from(']\n')];
    for (const encoded of entries) {
      const entry = Buffer.from(encoded, 'base64');
      if (entry.toString('base64') !== encoded || entry.includes(0))
        throw new GitError('BACKUP_CORRUPT', 'Invalid branch settings backup');
      const newline = entry.indexOf(10),
        key = entry.subarray(0, newline < 0 ? entry.length : newline);
      const lastDot = key.lastIndexOf(46),
        variable = key.subarray(lastDot + 1).toString();
      if (
        !key.subarray(0, lastDot).equals(Buffer.from(`branch.${name}`)) ||
        !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(variable)
      )
        throw new GitError('BACKUP_CORRUPT', 'Branch settings backup has an unexpected key');
      chunks.push(Buffer.from(`\t${variable}`));
      if (newline >= 0) chunks.push(Buffer.from(' = '), quote(entry.subarray(newline + 1)));
      chunks.push(Buffer.from('\n'));
    }
    return Buffer.concat(chunks);
  }
  async restore(
    target: BranchSettings,
    expected: BranchSettings,
    change: () => Promise<void>,
    signal?: AbortSignal,
  ) {
    const path = join(this.commonDir, 'config'),
      lockPath = `${path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new GitError('CONFIG_LOCKED', 'Another Git operation holds config.lock');
      throw error;
    }
    const temporary = join(this.directory, `config-${randomUUID()}`);
    let published = false;
    try {
      const names = Object.keys(target);
      if (JSON.stringify(await this.read(names, signal)) !== JSON.stringify(expected))
        throw new GitError('STALE_UNDO', 'Branch settings changed outside this action');
      const current = await readFile(path);
      if (current.length > LIMIT)
        throw new GitError('CONFIG_LIMIT', 'Repository configuration exceeds 2 MiB');
      await writeFile(temporary, current, { mode: 0o600, flag: 'wx' });
      for (const name of names) {
        await this.run(['config', '--file', temporary, '--remove-section', `branch.${name}`], {
          signal,
          readOnly: false,
          allowedExitCodes: [0, 128],
        });
        await appendFile(temporary, this.serialize(name, target[name]!));
      }
      if (JSON.stringify(await this.read(names, signal, temporary)) !== JSON.stringify(target))
        throw new GitError('BACKUP_CORRUPT', 'Git could not verify the restored branch settings');
      const next = await readFile(temporary);
      if (next.length > LIMIT)
        throw new GitError('CONFIG_LIMIT', 'Restored configuration exceeds 2 MiB');
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      await change();
      // Once refs change, finish publishing their prepared configuration despite cancellation.
      await lock.writeFile(next);
      await lock.sync();
      await lock.close();
      await rename(lockPath, path);
      published = true;
    } finally {
      await lock.close().catch(() => {});
      if (!published) await rm(lockPath, { force: true });
      await rm(temporary, { force: true });
      await rm(`${temporary}.lock`, { force: true });
    }
  }
}
