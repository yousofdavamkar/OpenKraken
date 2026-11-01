import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  remoteOptionsSchema,
  cloneOptionsSchema,
  type CloneOptions,
  pushSelectionSchema,
  pushOptionsSchema,
  oidSchema,
  type PushSelection,
  type PushOptions,
  type PushPlan,
  remoteNameSchema,
  type RemoteOptions,
  type RemoteState,
} from '@openkraken/ipc-contract';
import { GitError, type runGit, type RunOptions } from './runner.js';

import { GitProgressLines, redactGitMessage as displayUrl } from './progress.js';
function validateUrl(value: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new GitError('INVALID_REMOTE_URL', 'Enter a valid remote URL');
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol))
      throw new GitError(
        'INVALID_REMOTE_URL',
        'Use HTTPS, SSH, Git, file, or a local repository path',
      );
    if (
      url.password ||
      (['http:', 'https:'].includes(url.protocol) && url.username) ||
      url.search ||
      url.hash
    )
      throw new GitError(
        'CREDENTIALS_IN_URL',
        'Use a credential helper or SSH agent instead of credentials or parameters in the URL',
      );
  } else if (value.includes('::')) {
    throw new GitError('INVALID_REMOTE_URL', 'External transport helper URLs are not supported');
  }
}
export class Remotes {
  constructor(
    private run: (args: string[], options?: RunOptions) => ReturnType<typeof runGit>,
    private onProgress?: (text: string) => void,
  ) {}
  async state(signal?: AbortSignal): Promise<RemoteState> {
    const config = await this.run(['config', '--null', '--list'], {
      signal,
      maxBytes: 2 * 1024 * 1024,
    });
    const refs = await this.run(
      ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/remotes'],
      { signal, maxBytes: 8 * 1024 * 1024 },
    );
    const remotes = new Map<string, RemoteState['remotes'][number]>();
    for (const record of config.stdout.toString('utf8').split('\0')) {
      const newline = record.indexOf('\n');
      const key = newline < 0 ? record : record.slice(0, newline);
      const match = /^remote\.(.+)\.([^.]+)$/.exec(key);
      if (!match) continue;
      const [, name, field] = match;
      const remote = remotes.get(name!) ?? { name: name!, urls: [], pushUrls: [] };
      remotes.set(name!, remote);
      if (newline >= 0 && (field === 'url' || field === 'pushurl'))
        (field === 'url' ? remote.urls : remote.pushUrls).push(
          displayUrl(record.slice(newline + 1)),
        );
    }
    return {
      token: createHash('sha256').update(config.stdout).update(refs.stdout).digest('hex'),
      remotes: [...remotes.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  async clone(input: CloneOptions, signal?: AbortSignal) {
    const options = cloneOptionsSchema.parse(input);
    validateUrl(options.url);
    if (
      !isAbsolute(options.url) &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(options.url) &&
      !/^[^/:\s]+:.+/.test(options.url)
    )
      throw new GitError(
        'INVALID_CLONE_URL',
        'Use a repository URL or an absolute local repository path',
      );
    if (options.branch) {
      if (options.branch.startsWith('-'))
        throw new GitError('INVALID_REF', 'Choose a valid branch or tag name');
      await this.run(['check-ref-format', `refs/heads/${options.branch}`], { signal });
    }
    const url =
      isAbsolute(options.url) && (options.depth || options.filter)
        ? pathToFileURL(options.url).href
        : options.url;
    await this.network(
      [
        'clone',
        '--progress',
        '--origin=origin',
        '--no-recurse-submodules',
        ...(options.branch ? ['--branch', options.branch] : []),
        ...(options.depth ? ['--depth', String(options.depth)] : []),
        ...(options.filter ? [`--filter=${options.filter}`] : []),
        ...(options.sparse ? ['--sparse'] : []),
        '--',
        url,
        '.',
      ],
      signal,
      false,
      { timeoutMs: 1800000 },
    );
    if (options.sparse)
      await this.network(['sparse-checkout', 'set', '--cone', '--stdin'], signal, false, {
        stdin: options.sparse.map((path) => JSON.stringify(path)).join('\n') + '\n',
        timeoutMs: 1800000,
      });
  }
  async fetch(input: string, signal?: AbortSignal, background = false) {
    const name = remoteNameSchema.parse(input);
    const state = await this.state(signal);
    if (!state.remotes.some((remote) => remote.name === name))
      throw new GitError('UNKNOWN_REMOTE', 'Choose an existing remote');
    await this.network(
      [
        'fetch',
        '--atomic',
        '--prune',
        '--tags',
        '--progress',
        '--no-recurse-submodules',
        '--',
        name,
      ],
      signal,
      background,
    );
    return this.state();
  }
  private async network(
    args: string[],
    signal?: AbortSignal,
    background = false,
    options: { stdin?: string; timeoutMs?: number } = {},
  ) {
    const progress = this.onProgress ? new GitProgressLines(this.onProgress) : undefined;
    // URL-specific settings can outrank the global TLS setting, even in local config.
    const tls = await this.run(['config', '--null', '--get-regexp', '^http\\..*\\.sslverify$'], {
      signal,
      allowedExitCodes: [0, 1],
    });
    const overrides = tls.stdout
      .toString()
      .split('\0')
      .filter(Boolean)
      .flatMap((record) => ['-c', `${record.split('\n')[0]}=true`]);
    try {
      const result = await this.run(
        [...overrides, ...(background ? ['-c', 'credential.interactive=false'] : []), ...args],
        {
          signal,
          readOnly: false,
          timeoutMs: options.timeoutMs ?? 180000,
          stdin: options.stdin,
          onStderr: progress ? (chunk) => progress.push(chunk) : undefined,
          allowedExitCodes: [0, 1],
          env: {
            GIT_ALLOW_PROTOCOL: 'file:https:http:ssh:git',
            ...(background
              ? {
                  GIT_ASKPASS: '',
                  SSH_ASKPASS: '',
                  SSH_ASKPASS_REQUIRE: 'never',
                  GCM_INTERACTIVE: 'never',
                }
              : {}),
          },
        },
      );
      if (result.exitCode)
        throw new GitError(
          'GIT_FAILED',
          `${result.stdout.toString()}\n${result.stderr}`.trim(),
          result.exitCode,
        );
      return result;
    } catch (error) {
      if (error instanceof GitError)
        throw new GitError(error.code, displayUrl(error.message), error.exitCode);
      throw error;
    } finally {
      progress?.end();
    }
  }
  private async sourceOid(ref: string, signal?: AbortSignal) {
    await this.run(['check-ref-format', ref], { signal });
    const result = await this.run(
      ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ref],
      { signal },
    );
    const record = result.stdout
      .toString()
      .split('\n')
      .map((line) => line.split('\0'))
      .find(([name]) => name === ref);
    if (!record || record[2])
      throw new GitError('INVALID_PUSH_SOURCE', 'Choose an existing direct branch or tag');
    return oidSchema.parse(record[1]);
  }
  private async pushUrl(name: string, signal?: AbortSignal) {
    const raw = await this.run(['remote', 'get-url', '--push', '--all', '--', name], { signal });
    const urls = raw.stdout.toString().trimEnd().split('\n');
    if (urls.length !== 1 || !urls[0])
      throw new GitError('MULTIPLE_PUSH_URLS', 'This push flow requires one push URL per remote');
    return urls[0];
  }
  async pushPreview(input: PushSelection, signal?: AbortSignal): Promise<PushPlan> {
    const selection = pushSelectionSchema.parse(input);
    const state = await this.state(signal);
    if (!state.remotes.some((remote) => remote.name === selection.name))
      throw new GitError('UNKNOWN_REMOTE', 'Choose an existing remote');
    const sourceOid = await this.sourceOid(selection.source, signal);
    await this.run(['check-ref-format', selection.destination], { signal });
    const url = await this.pushUrl(selection.name, signal);
    const result = await this.network(
      ['ls-remote', '--refs', '--', url, selection.destination],
      signal,
    );
    const match = result.stdout
      .toString()
      .split('\n')
      .map((line) => line.split('\t'))
      .find(([, ref]) => ref === selection.destination);
    return {
      ...selection,
      sourceOid,
      remoteOid: match ? oidSchema.parse(match[0]) : null,
      token: state.token,
      url: displayUrl(url),
    };
  }
  async push(input: PushOptions, signal?: AbortSignal) {
    const { plan, force, upstream } = pushOptionsSchema.parse(input);
    await this.run(['check-ref-format', plan.destination], { signal });
    if (
      (await this.state(signal)).token !== plan.token ||
      (await this.sourceOid(plan.source, signal)) !== plan.sourceOid
    )
      throw new GitError(
        'STALE_PUSH',
        'The source or remote configuration changed. Review the push again.',
      );
    await this.pushUrl(plan.name, signal);
    if (
      upstream &&
      (!plan.source.startsWith('refs/heads/') || !plan.destination.startsWith('refs/heads/'))
    )
      throw new GitError(
        'INVALID_UPSTREAM',
        'Upstream tracking requires a branch source and destination',
      );
    await this.network(
      [
        '-c',
        `remote.${plan.name}.mirror=false`,
        '-c',
        'push.followTags=false',
        'push',
        '--porcelain',
        '--progress',
        '--no-recurse-submodules',
        ...(force ? [`--force-with-lease=${plan.destination}:${plan.remoteOid ?? ''}`] : []),
        '--',
        plan.name,
        `${plan.sourceOid}:${plan.destination}`,
      ],
      signal,
    );
    let warning: string | undefined;
    if (upstream) {
      try {
        if ((await this.sourceOid(plan.source)) !== plan.sourceOid)
          throw new Error('The local branch moved during push');
        await this.run(
          [
            'branch',
            `--set-upstream-to=refs/remotes/${plan.name}/${plan.destination.slice('refs/heads/'.length)}`,
            '--',
            plan.source.slice('refs/heads/'.length),
          ],
          { readOnly: false },
        );
      } catch (error) {
        warning = `Push completed, but upstream was not set: ${displayUrl(error instanceof Error ? error.message : String(error))}`;
      }
    }
    return { state: await this.state(), warning };
  }
  async change(input: RemoteOptions, signal?: AbortSignal) {
    const options = remoteOptionsSchema.parse(input);
    for (const name of [options.name, ...(options.action === 'rename' ? [options.newName] : [])])
      await this.run(['check-ref-format', `refs/remotes/${name}/probe`], { signal });
    if ('url' in options) validateUrl(options.url);
    const current = await this.state(signal);
    if (current.token !== options.token)
      throw new GitError(
        'STALE_REMOTES',
        'Remote configuration or tracking refs changed. Reload before editing.',
      );
    const found = current.remotes.some((r) => r.name === options.name);
    if (options.action === 'add' ? found : !found)
      throw new GitError(
        'REMOTE_CHANGED',
        found ? 'That remote already exists' : 'That remote no longer exists',
      );
    const args =
      options.action === 'add'
        ? ['add', '--', options.name, options.url]
        : options.action === 'rename'
          ? ['rename', '--', options.name, options.newName]
          : options.action === 'remove'
            ? ['remove', '--', options.name]
            : ['set-url', ...(options.push ? ['--push'] : []), '--', options.name, options.url];
    await this.run(['remote', ...args], { signal, readOnly: false });
    return this.state();
  }
}
