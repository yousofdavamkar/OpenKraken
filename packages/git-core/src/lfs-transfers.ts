import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  remoteNameSchema,
  lfsLocksSchema,
  type LfsPullPreview,
  type Repository,
} from '@openkraken/ipc-contract';
import { GitError, type RunOptions, type runGit } from './runner.js';
import { NulDecoder } from './parsers.js';
import { lfsState, parseLfsLocks } from './lfs.js';
import { GitProgressLines } from './progress.js';
import { transportError, validateUrl } from './remotes.js';

type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface LfsPullPlan {
  token: string;
  remote: string;
  fingerprint: string;
  expiresAt: number;
}
const transferOptions = [
  '-c',
  'lfs.basictransfersonly=true',
  '-c',
  'lfs.remote.autodetect=false',
  '-c',
  'lfs.remote.searchall=false',
  '-c',
  'lfs.transfer.enablehrefrewrite=false',
  '-c',
  'lfs.skipdownloaderrors=false',
];

export class LfsTransfers {
  constructor(
    private repo: Repository,
    private run: Run,
    private plans: Map<string, LfsPullPlan>,
  ) {}
  private async configFile(signal?: AbortSignal): Promise<string | null> {
    const path = join(this.repo.path, '.lfsconfig');
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new GitError(
        'LFS_CONFIG',
        'The checkout .lfsconfig must be a regular file no larger than 1 MiB',
      );
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat();
      if (
        length > 1024 * 1024 ||
        after.ino !== info.ino ||
        after.dev !== info.dev ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new GitError('LFS_CONFIG', 'The checkout .lfsconfig changed during inspection');
      return digest(buffer.subarray(0, length));
    } finally {
      await file.close();
    }
  }
  private async target(remote: string, signal?: AbortSignal) {
    remoteNameSchema.parse(remote);
    if (this.repo.isBare)
      throw new GitError('BARE_REPOSITORY', 'Open a working checkout before pulling LFS objects');
    const remotes = (await this.run(['remote'], { signal, maxBytes: 1024 * 1024 })).stdout
      .toString('utf8')
      .trimEnd()
      .split('\n');
    if (!remotes.includes(remote))
      throw new GitError('UNKNOWN_REMOTE', 'Select a configured remote');
    const lfsConfig = await this.configFile(signal);
    const config = await this.run(['config', '--null', '--list'], {
      signal,
      maxBytes: 2 * 1024 * 1024,
    });
    const tls = new Set<string>();
    for (const record of config.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const split = record.indexOf('\n');
      const key = record.slice(0, split < 0 ? undefined : split);
      const value = split < 0 ? '' : record.slice(split + 1);
      if (/^http\..*\.sslverify$/i.test(key)) tls.add(key);
      if ((/^lfs\.standalonetransferagent$/i.test(key) && value) || /^lfs\.extension\./i.test(key))
        throw new GitError(
          'LFS_CUSTOM_TRANSFER',
          'This action does not run standalone transfer agents or LFS extensions',
        );
    }
    if (tls.size > 256 || [...tls].join('').length > 65536)
      throw new GitError('LFS_LIMIT', 'Too many URL-specific TLS settings to enforce');
    const branch = (
      await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        signal,
        allowedExitCodes: [0, 1],
        maxBytes: 4096,
      })
    ).stdout
      .toString('utf8')
      .trimEnd();
    const scope = [
      '-c',
      `remote.lfsdefault=${remote}`,
      ...(branch ? ['-c', `branch.${branch}.remote=${remote}`] : []),
    ];
    const environment = await this.run([...scope, ...transferOptions, 'lfs', 'env'], {
      signal,
      maxBytes: 2 * 1024 * 1024,
    });
    const lines = environment.stdout.toString('utf8').split('\n');
    const named = lines.filter((line) => line.startsWith(`Endpoint (${remote})=`));
    const candidates = named.length ? named : lines.filter((line) => line.startsWith('Endpoint='));
    if (candidates.length !== 1)
      throw new GitError(
        'LFS_ENDPOINT',
        'Git LFS did not report one unambiguous endpoint for this remote',
      );
    const endpoint = candidates[0]!
      .slice(named.length ? `Endpoint (${remote})=`.length : 'Endpoint='.length)
      .replace(/ \(auth=[^\r\n]*\)$/, '');
    validateUrl(endpoint);
    if (
      !/^https?:\/\//i.test(endpoint) ||
      ['\r', '\n', '\0'].some((character) => endpoint.includes(character))
    )
      throw new GitError(
        'LFS_ENDPOINT',
        'This action currently requires an HTTP or HTTPS LFS endpoint',
      );
    const filters = lines.filter((line) => /^Fetch(?:Include|Exclude)=/.test(line));
    return { endpoint, filters, tls: [...tls], config, environment, lfsConfig };
  }
  private async inspect(remote: string, signal?: AbortSignal) {
    remoteNameSchema.parse(remote);
    if (this.repo.isBare)
      throw new GitError('BARE_REPOSITORY', 'Open a working checkout before pulling LFS objects');
    await this.configFile(signal);
    const names = await readdir(this.repo.gitDir);
    if (
      [
        'MERGE_HEAD',
        'MERGE_AUTOSTASH',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'REBASE_HEAD',
        'BISECT_LOG',
        'sequencer',
        'rebase-merge',
        'rebase-apply',
        'index.lock',
      ].some((name) => names.includes(name))
    )
      throw new GitError(
        'LFS_OPERATION',
        'Finish the current Git operation before pulling LFS objects',
      );
    const index = await this.run(['ls-files', '--stage', '-z'], {
      signal,
      maxBytes: 16 * 1024 * 1024,
    });
    const stages = new NulDecoder((record) => {
      const tab = record.indexOf(9);
      const fields = /^([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])$/.exec(
        record.subarray(0, tab).toString('ascii'),
      );
      if (tab < 0 || !fields) throw new GitError('LFS_INDEX', 'Git returned invalid index entries');
      if (fields[3] !== '0')
        throw new GitError('LFS_OPERATION', 'Resolve index conflicts before pulling LFS objects');
    });
    stages.push(index.stdout);
    stages.finish();
    const state = await lfsState(this.run, signal);
    if (!state.available)
      throw new GitError('LFS_UNAVAILABLE', 'Install Git LFS before downloading objects');
    const { endpoint, filters, tls, config, environment, lfsConfig } = await this.target(
      remote,
      signal,
    );
    const head = await this.run(['rev-parse', '--verify', 'HEAD'], { signal, maxBytes: 4096 });
    const attributes = await this.run(['check-attr', '-z', '--stdin', 'filter'], {
      signal,
      stdin: state.files.map((file) => file.path + '\0').join(''),
      maxBytes: 16 * 1024 * 1024,
    });
    const metadata: unknown[] = [];
    for (const file of state.files) {
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      const parts = file.path.split('/');
      if (
        parts.length > 128 ||
        isAbsolute(file.path) ||
        parts.some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase())) ||
        (process.platform === 'win32' && /[\\:]/.test(file.path))
      )
        throw new GitError('LFS_PATH', 'Unsafe LFS checkout path');
      for (let i = 1; i <= parts.length; i++) {
        const path = join(this.repo.path, ...parts.slice(0, i));
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            metadata.push([path, 'missing']);
            break;
          }
          throw error;
        }
        if (info.isSymbolicLink() || (i < parts.length ? !info.isDirectory() : !info.isFile()))
          throw new GitError(
            'LFS_PATH',
            'Repair symbolic links or non-file LFS paths before downloading',
          );
        if (i === parts.length)
          metadata.push([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
      }
    }
    return {
      state,
      endpoint,
      filters,
      tls: [...tls],
      fingerprint: digest(
        JSON.stringify([
          digest(config.stdout),
          digest(environment.stdout),
          digest(head.stdout),
          digest(index.stdout),
          digest(attributes.stdout),
          lfsConfig,
          state.files,
          metadata,
        ]),
      ),
    };
  }
  async locks(remote: string, signal?: AbortSignal, authentication?: NodeJS.ProcessEnv) {
    try {
      const target = await this.target(remote, signal);
      const args = [
        ...transferOptions,
        ...target.tls.flatMap((key) => ['-c', `${key}=true`]),
        '-c',
        `lfs.url=${target.endpoint}`,
        'lfs',
        'locks',
        `--remote=${remote}`,
      ];
      const options: RunOptions = {
        signal,
        readOnly: false,
        timeoutMs: 180000,
        maxBytes: 8 * 1024 * 1024,
        env: { ...authentication, GIT_ALLOW_PROTOCOL: 'http:https:ssh' },
      };
      // Native --json can return success and [] when the server query failed.
      // A successful non-JSON query refreshes the complete native cache; only
      // then read that cache as JSON without making another server request.
      await this.run(args, options);
      const output = await this.run([...args, '--cached', '--json'], options);
      return lfsLocksSchema.parse({
        remote,
        endpoint: target.endpoint,
        checkedAt: new Date().toISOString(),
        locks: parseLfsLocks(output.stdout),
      });
    } catch (error) {
      if (error instanceof GitError) throw transportError(error);
      throw error;
    }
  }
  async preview(remote: string, signal?: AbortSignal): Promise<LfsPullPreview> {
    const inspected = await this.inspect(remote, signal).catch((error: unknown) => {
      if (error instanceof GitError) throw transportError(error);
      throw error;
    });
    const token = randomUUID();
    for (const [id, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(this.repo.id, {
      token,
      remote,
      fingerprint: inspected.fingerprint,
      expiresAt: Date.now() + 600000,
    });
    return {
      token,
      remote,
      endpoint: inspected.endpoint,
      filters: inspected.filters,
      files: inspected.state.files,
    };
  }
  async pull(
    token: string,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
  ) {
    const plan = this.plans.get(this.repo.id);
    if (!plan || plan.token !== token || plan.expiresAt < Date.now())
      throw new GitError('STALE_LFS_PULL', 'Review the LFS download again before continuing');
    const inspected = await this.inspect(plan.remote, signal).catch((error: unknown) => {
      if (error instanceof GitError) throw transportError(error);
      throw error;
    });
    if (inspected.fingerprint !== plan.fingerprint) {
      this.plans.delete(this.repo.id);
      throw new GitError(
        'STALE_LFS_PULL',
        'Repository files or LFS configuration changed. Review the download again',
      );
    }
    this.plans.delete(this.repo.id);
    const progress = onProgress ? new GitProgressLines(onProgress) : undefined;
    try {
      await this.run(
        [
          ...transferOptions,
          ...inspected.tls.flatMap((key) => ['-c', `${key}=true`]),
          '-c',
          `lfs.url=${inspected.endpoint}`,
          'lfs',
          'pull',
          '--',
          plan.remote,
        ],
        {
          signal,
          readOnly: false,
          timeoutMs: 180000,
          maxBytes: 8 * 1024 * 1024,
          env: {
            ...authentication,
            GIT_ALLOW_PROTOCOL: 'http:https:ssh',
            GIT_LFS_SKIP_DOWNLOAD_ERRORS: '0',
            GIT_LFS_FORCE_PROGRESS: '1',
            GIT_LFS_PROGRESS: '',
          },
          onStdout: progress ? (chunk) => progress.push(chunk) : undefined,
          onStderr: progress ? (chunk) => progress.push(chunk) : undefined,
        },
      );
    } catch (error) {
      if (error instanceof GitError) throw transportError(error);
      throw error;
    } finally {
      progress?.end();
    }
    return lfsState(this.run, signal);
  }
}
