import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repository, SubmoduleSyncPreview } from '@openkraken/ipc-contract';
import { GitError, type RunOptions, type runGit } from './runner.js';
import { Submodules } from './submodules.js';
import { redactGitMessage } from './progress.js';
import { validateUrl } from './remotes.js';

type Run = (args: string[], options: RunOptions) => ReturnType<typeof runGit>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface SubmoduleSyncPlan {
  token: string;
  fingerprint: string;
  expiresAt: number;
}
async function metadata(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new GitError(
        'SUBMODULE_SYNC_CONFIG',
        `Use a regular configuration file no larger than 1 MiB: ${path}`,
      );
    return [path, info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null];
    throw error;
  }
}

export class SubmoduleSync {
  constructor(
    private repo: Repository,
    private run: Run,
    private plans: Map<string, SubmoduleSyncPlan>,
  ) {}
  private async inspect(signal?: AbortSignal) {
    const state = await new Submodules(this.repo, this.run).list(signal);
    if (!state.entries.length)
      throw new GitError('NO_SUBMODULES', 'No submodules are registered in this checkout');
    if (state.entries.some((entry) => entry.state === 'conflict' || entry.state === 'unavailable'))
      throw new GitError(
        'SUBMODULE_NOT_READY',
        'Resolve conflicted or unavailable submodules before synchronizing URLs',
      );
    const folders = [
      this.repo.path,
      ...state.entries
        .filter((entry) => entry.available)
        .map((entry) => join(this.repo.path, entry.path)),
    ];
    const configs = new Map<string, Map<string, string>>();
    const fingerprints: unknown[] = [];
    const sources: SubmoduleSyncPreview['sources'] = [];
    const text = async (cwd: string, args: string[], allowedExitCodes?: number[]) =>
      (await this.run(args, { cwd, signal, allowedExitCodes, maxBytes: 65536 })).stdout
        .toString('utf8')
        .replace(/\n$/, '');
    for (const cwd of folders) {
      const gitDir = await text(cwd, ['rev-parse', '--absolute-git-dir']);
      const commonDir = await text(cwd, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      const files = await Promise.all(
        [
          ...new Set([
            join(commonDir, 'config'),
            join(gitDir, 'config.worktree'),
            join(cwd, '.gitmodules'),
          ]),
        ].map(metadata),
      );
      const config = await this.run(['config', '--null', '--list'], {
        cwd,
        signal,
        maxBytes: 2 * 1024 * 1024,
      });
      const decoded = config.stdout.toString('utf8');
      if (!Buffer.from(decoded).equals(config.stdout))
        throw new GitError('SUBMODULE_ENCODING', 'Submodule configuration must use UTF-8');
      const values = new Map<string, string>();
      for (const record of decoded.split('\0').filter(Boolean)) {
        const split = record.indexOf('\n');
        const key = split < 0 ? record : record.slice(0, split);
        const value = split < 0 ? '' : record.slice(split + 1);
        values.set(key, value);
        if (/^(?:remote|submodule)\..*\.url$/.test(key) || /^url\..*\.insteadof$/.test(key)) {
          sources.push({
            repository: gitDir,
            setting: redactGitMessage(key),
            value: redactGitMessage(value),
          });
          if (sources.length > 2048)
            throw new GitError('SUBMODULE_LIMIT', 'Too many URL settings to review');
        }
      }
      configs.set(cwd, values);
      fingerprints.push([
        gitDir,
        commonDir,
        files,
        hash(config.stdout),
        await text(cwd, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1]),
      ]);
    }
    const entries = state.entries.map((entry) => {
      if (!entry.name || !entry.url)
        throw new GitError(
          'SUBMODULE_CONFIG',
          `Add an unambiguous name and URL for ${entry.path} in .gitmodules before synchronizing`,
        );
      validateUrl(entry.url);
      const parent = entry.parentId
        ? state.entries.find((candidate) => candidate.id === entry.parentId)
        : undefined;
      const configured = configs.get(parent ? join(this.repo.path, parent.path) : this.repo.path)!;
      const key = `submodule.${entry.name}.url`;
      return {
        path: entry.path,
        declaredUrl: redactGitMessage(entry.url),
        configuredUrl: configured.has(key) ? redactGitMessage(configured.get(key)!) : undefined,
        registered: configured.has(key),
      };
    });
    if (!entries.some((entry) => entry.registered))
      throw new GitError(
        'NO_REGISTERED_SUBMODULE_URLS',
        'Initialize submodules before synchronizing their local URLs',
      );
    return {
      state,
      entries,
      sources,
      fingerprint: hash(JSON.stringify([state.revision, fingerprints])),
    };
  }
  async preview(signal?: AbortSignal): Promise<SubmoduleSyncPreview> {
    const inspected = await this.inspect(signal);
    const token = randomUUID();
    for (const [id, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(this.repo.id, {
      token,
      fingerprint: inspected.fingerprint,
      expiresAt: Date.now() + 600000,
    });
    return { token, entries: inspected.entries, sources: inspected.sources };
  }
  async sync(token: string, signal?: AbortSignal) {
    const plan = this.plans.get(this.repo.id);
    if (!plan || plan.token !== token || plan.expiresAt < Date.now())
      throw new GitError('STALE_SUBMODULE_SYNC', 'Review submodule URL synchronization again');
    this.plans.delete(this.repo.id);
    const inspected = await this.inspect(signal);
    if (inspected.fingerprint !== plan.fingerprint)
      throw new GitError(
        'STALE_SUBMODULE_SYNC',
        'Submodules or configuration changed. Review URL synchronization again.',
      );
    await this.run(
      [
        'submodule',
        'sync',
        '--recursive',
        '--',
        ...inspected.state.entries
          .filter((entry) => entry.depth === 0)
          .map((entry) => `:(literal)${entry.path}`),
      ],
      {
        cwd: this.repo.path,
        signal,
        readOnly: false,
        timeoutMs: 180000,
        maxBytes: 8 * 1024 * 1024,
        env: { GIT_ALLOW_PROTOCOL: '' },
      },
    );
    return new Submodules(this.repo, this.run).list(signal);
  }
}
