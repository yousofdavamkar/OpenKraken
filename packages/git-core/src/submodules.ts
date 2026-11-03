import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Repository, Submodule, SubmoduleState } from '@openkraken/ipc-contract';
import { GitError, type RunOptions, type runGit } from './runner.js';
import { NulDecoder, StatusParser } from './parsers.js';

type Run = (args: string[], options: RunOptions) => ReturnType<typeof runGit>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function utf8(bytes: Buffer) {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value).equals(bytes))
    throw new GitError('SUBMODULE_ENCODING', 'Submodule paths and configuration must use UTF-8');
  return value;
}
function parts(path: string) {
  const result = path.split('/');
  if (
    isAbsolute(path) ||
    (process.platform === 'win32' && path.includes('\\')) ||
    result.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new GitError('SUBMODULE_PATH', 'Submodule path must stay inside its parent checkout');
  return result;
}
export class Submodules {
  private locations = new Map<string, { path: string; gitDir: string }>();
  constructor(
    private repo: Repository,
    private run: Run,
  ) {}

  private async configuration(cwd: string, signal?: AbortSignal) {
    const path = join(cwd, '.gitmodules');
    const config = new Map<string, { name: string; url?: string }>();
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new GitError(
          'SUBMODULE_CONFIG',
          'Submodule configuration must be a regular file up to 1 MiB',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return config;
      throw error;
    }
    const args = ['config', '--null', '--no-includes', '--file', path];
    const query = ['--get-regexp', '^submodule\\..*\\.(path|url)$'];
    const options = { cwd, signal, maxBytes: 1024 * 1024, allowedExitCodes: [0, 1] };
    const result = await this.run([...args, ...query], options);
    const values = new Map<string, { path?: string; url?: string }>();
    const decoder = new NulDecoder((record) => {
      const text = utf8(record);
      const split = text.indexOf('\n');
      const key = /^submodule\.(.*)\.(path|url)$/.exec(text.slice(0, split));
      if (split < 0 || !key)
        throw new GitError('SUBMODULE_CONFIG', 'Unsupported submodule configuration name');
      const name = key[1]!;
      const value = values.get(name) ?? {};
      const field = key[2] as 'path' | 'url';
      if (value[field] !== undefined)
        throw new GitError('SUBMODULE_CONFIG', 'Duplicate submodule configuration');
      value[field] = text.slice(split + 1);
      values.set(name, value);
    });
    decoder.push(result.stdout);
    decoder.finish();
    for (const [name, value] of values) {
      if (!value.path) continue;
      if (config.has(value.path))
        throw new GitError('SUBMODULE_CONFIG', 'Multiple submodules use the same path');
      config.set(value.path, { name, url: value.url });
    }
    return config;
  }

  async list(signal?: AbortSignal): Promise<SubmoduleState> {
    if (this.repo.isBare)
      throw new GitError('BARE_REPOSITORY', 'Open a checkout to inspect submodules');
    this.locations.clear();
    const entries: Submodule[] = [];
    const walk = async (
      cwd: string,
      prefix: string,
      depth: number,
      ancestors: Set<string>,
      parentId?: string,
    ): Promise<void> => {
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      const links = new Map<string, { indexOid?: string; conflict: boolean }>();
      const decoder = new NulDecoder((record) => {
        const tab = record.indexOf(9);
        const fields = record.subarray(0, tab).toString('ascii').split(' ');
        if (fields[0] !== '160000') return;
        if (
          tab < 0 ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[1] ?? '') ||
          !/^[0-3]$/.test(fields[2] ?? '')
        )
          throw new GitError('SUBMODULE_INDEX', 'Invalid submodule index entry');
        const path = utf8(record.subarray(tab + 1));
        parts(path);
        const link = links.get(path) ?? { conflict: false };
        if (fields[2] === '0') link.indexOid = fields[1];
        else link.conflict = true;
        links.set(path, link);
      });
      await this.run(['ls-files', '--stage', '-z'], {
        cwd,
        signal,
        maxBytes: 16 * 1024 * 1024,
        onStdout: (chunk) => decoder.push(chunk),
      });
      decoder.finish();
      if (!links.size) return;
      if (depth > 15)
        throw new GitError('SUBMODULE_LIMIT', 'Submodules exceed the maximum nesting depth of 16');
      const config = await this.configuration(cwd, signal);
      for (const [local, link] of links) {
        if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
        if (entries.length >= 256)
          throw new GitError('SUBMODULE_LIMIT', 'Too many submodules to display (maximum 256)');
        const path = prefix ? `${prefix}/${local}` : local;
        const entry: Submodule = {
          id: hash(path),
          parentId,
          path,
          depth,
          ...config.get(local),
          indexOid: link.indexOid,
          initialized: false,
          available: false,
          outOfDate: false,
          changedFiles: null,
          state: link.conflict ? 'conflict' : 'uninitialized',
        };
        entries.push(entry);
        let location: { path: string; gitDir: string } | undefined;
        try {
          let folder = cwd;
          for (const part of parts(local)) {
            folder = join(folder, part);
            if (!(await lstat(folder)).isDirectory())
              throw new GitError(
                'SUBMODULE_PATH',
                'Submodule folder must not contain symbolic links',
              );
          }
          const metadata = await lstat(join(folder, '.git'));
          if (!metadata.isFile() && !metadata.isDirectory())
            throw new GitError(
              'SUBMODULE_PATH',
              'Submodule Git metadata must not be a symbolic link',
            );
          entry.initialized = true;
          const text = async (args: string[], allowedExitCodes?: number[]) =>
            utf8(
              (await this.run(args, { cwd: folder, signal, maxBytes: 65536, allowedExitCodes }))
                .stdout,
            ).replace(/\n$/, '');
          const [top, gitDir, head] = await Promise.all([
            text(['rev-parse', '--show-toplevel']),
            text(['rev-parse', '--absolute-git-dir']),
            text(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]),
          ]);
          const canonical = await realpath(folder);
          if ((await realpath(top)) !== canonical)
            throw new GitError('SUBMODULE_REPLACED', 'This folder resolves to another checkout');
          const canonicalGit = await realpath(gitDir);
          if (ancestors.has(canonicalGit))
            throw new GitError('SUBMODULE_CYCLE', 'Submodule points back to a parent repository');
          const status = new StatusParser();
          await this.run(
            ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
            {
              cwd: canonical,
              signal,
              maxBytes: 8 * 1024 * 1024,
              onStdout: (chunk) => status.push(chunk),
            },
          );
          entry.head = head || undefined;
          entry.changedFiles = status.finish().entries.length;
          entry.outOfDate = entry.head !== entry.indexOid;
          entry.available = true;
          entry.state = link.conflict
            ? 'conflict'
            : entry.outOfDate
              ? 'out-of-date'
              : entry.changedFiles
                ? 'modified'
                : 'clean';
          location = { path: canonical, gitDir: canonicalGit };
          this.locations.set(entry.id, location);
        } catch (error) {
          if (signal?.aborted) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || entry.initialized) {
            entry.state = 'unavailable';
            entry.problem =
              error instanceof GitError
                ? error.message
                : 'Submodule checkout could not be inspected';
          }
        }
        if (location)
          await walk(
            location.path,
            path,
            depth + 1,
            new Set([...ancestors, location.gitDir]),
            entry.id,
          );
      }
    };
    await walk(this.repo.path, '', 0, new Set([this.repo.gitDir]));
    return { revision: hash(JSON.stringify([entries, [...this.locations]])), entries };
  }

  async select(id: string, revision: string, signal?: AbortSignal) {
    const state = await this.list(signal);
    if (state.revision !== revision)
      throw new GitError('STALE_SUBMODULES', 'Submodules changed. Refresh the list and try again.');
    if (!state.entries.some((entry) => entry.id === id))
      throw new GitError('SUBMODULE_NOT_FOUND', 'This submodule is not registered');
    const location = this.locations.get(id);
    if (!location)
      throw new GitError(
        'SUBMODULE_UNAVAILABLE',
        'Initialize or repair this submodule before opening it',
      );
    return location;
  }
}
