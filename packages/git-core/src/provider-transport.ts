import { providerGitCredentialSchema, type ProviderGitTarget } from '@openkraken/ipc-contract';
import { GitError, type runGit, type RunOptions } from './runner.js';

/** Keep provider tokens in askpass only, scoped to a canonical URL with no transport redirects. */
export async function providerCloneSettings(
  run: (args: string[], options?: RunOptions) => ReturnType<typeof runGit>,
  target: ProviderGitTarget,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
) {
  const parsed = providerGitCredentialSchema.omit({ password: true }).safeParse(target);
  if (!parsed.success)
    throw new GitError('PROVIDER_CLONE_URL', 'Choose a valid provider repository.');
  const env = { ...environment };
  for (const key of Object.keys({ ...process.env, ...env }))
    if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') env[key] = undefined;
  env.GIT_TRACE_REDACT = '1';
  const expanded = await run(['ls-remote', '--get-url', '--', target.url], {
    signal,
    env,
    maxBytes: 8192,
  });
  if (expanded.stdout.toString().trimEnd() !== target.url)
    throw new GitError(
      'PROVIDER_CLONE_REWRITE',
      'This URL is rewritten by Git settings. Disable the rewrite or use Git credential helpers for this clone.',
    );
  const settings = await run(
    ['config', '--null', '--name-only', '--get-regexp', '^(http|credential)\\.'],
    { signal, env, allowedExitCodes: [0, 1], maxBytes: 2 * 1024 * 1024 },
  );
  const http: Record<string, string> = {
    followredirects: 'false',
    extraheader: '',
    cookiefile: '',
    savecookies: 'false',
    sslverify: 'true',
  };
  const credential: Record<string, string> = {
    helper: '',
    username: target.username,
    usehttppath: 'true',
  };
  const args: string[] = [];
  // URL-specific HTTP settings outrank generic command-line values; override each matching key.
  for (const key of settings.stdout.toString().split('\0').filter(Boolean)) {
    const section = key.slice(0, key.indexOf('.')).toLowerCase();
    const name = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    const value = (section === 'http' ? http : credential)[name];
    if (value !== undefined) args.push('-c', `${key}=${value}`);
  }
  for (const [section, values] of Object.entries({ http, credential }))
    for (const [name, value] of Object.entries(values))
      args.push('-c', `${section}.${name}=${value}`);
  for (const target of ['normalTarget', 'eventTarget', 'perfTarget'])
    args.push('-c', `trace2.${target}=0`);
  return { args, env };
}
