import { createHash } from 'node:crypto';
import {
  remoteOptionsSchema,
  remoteNameSchema,
  type RemoteOptions,
  type RemoteState,
} from '@openkraken/ipc-contract';
import { GitError, type runGit, type RunOptions } from './runner.js';

/** Display configured endpoints without propagating embedded credentials to the renderer. */
function displayUrl(value: string) {
  return value
    .replace(/(https?:\/\/)[^/@]*@/gi, '$1[credentials]@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/:@]*):[^/@]*@/gi, '$1:[redacted]@')
    .replace(/[?#].*$/, '[redacted parameters]');
}
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
  constructor(private run: (args: string[], options?: RunOptions) => ReturnType<typeof runGit>) {}
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
  async fetch(input: string, signal?: AbortSignal) {
    const name = remoteNameSchema.parse(input);
    const state = await this.state(signal);
    if (!state.remotes.some((remote) => remote.name === name))
      throw new GitError('UNKNOWN_REMOTE', 'Choose an existing remote');
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
      await this.run(
        [
          ...overrides,
          'fetch',
          '--atomic',
          '--prune',
          '--tags',
          '--progress',
          '--no-recurse-submodules',
          '--',
          name,
        ],
        {
          signal,
          readOnly: false,
          timeoutMs: 180000,
          env: { GIT_ALLOW_PROTOCOL: 'file:https:http:ssh:git' },
        },
      );
    } catch (error) {
      if (error instanceof GitError)
        throw new GitError(error.code, displayUrl(error.message), error.exitCode);
      throw error;
    }
    return this.state();
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
