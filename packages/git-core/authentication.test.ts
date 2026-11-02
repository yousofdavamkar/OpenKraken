import { expect, test } from 'vitest';
import { mkdtemp, mkdir, copyFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixture, fixtureGit } from '../test-fixtures/src/index.js';
import { authenticatedRemote } from '../test-fixtures/src/authenticated-remote.js';
import { AskpassBroker } from './src/askpass.js';
import { RepositoryService } from './src/repository.js';
test('verified HTTPS clone uses native username/password prompts with a helper path containing spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-auth-'));
  const source = createFixture(join(root, 'source'));
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const remote = await authenticatedRemote(bare);
  const helper = join(root, process.platform === 'win32' ? 'askpass helper.exe' : 'askpass helper');
  await copyFile(
    resolve(
      'apps/desktop/dist/helpers',
      process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
    ),
    helper,
  );
  const prompts: string[] = [];
  const id = randomUUID();
  const broker = new AskpassBroker(helper, (event) => {
    if (event.type === 'authenticationPrompt') {
      prompts.push(event.kind);
      broker.answer(
        id,
        event.promptId,
        event.kind === 'username' ? remote.credentials.username : remote.credentials.password,
      );
    }
  });
  const service = new RepositoryService('git');
  try {
    const target = join(root, 'target');
    await mkdir(target);
    const scope = await broker.open(id, 'Clone repository');
    const repo = await service.clone(target, { url: remote.url }, undefined, undefined, {
      ...scope.environment,
      GIT_SSL_CAINFO: remote.certificate,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    scope.close();
    expect(repo.head.oid).toBe(fixtureGit(source, ['rev-parse', 'HEAD']));
    expect(prompts).toEqual(['username', 'secret']);
    expect(remote.authenticated()).toBeGreaterThan(1);
  } finally {
    await broker.close();
    await service.dispose();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('saved-provider HTTPS clone keeps credentials out of helpers, config, traces and UI events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-provider-clone-'));
  const source = createFixture(join(root, 'source'));
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const remote = await authenticatedRemote(bare, {
    basePath: '/team/project.git',
    password: 'fixture-provider-token',
  });
  const config = join(root, 'gitconfig'),
    store = join(root, 'plaintext-store'),
    trace = join(root, 'curl-trace');
  fixtureGit(source, [
    'config',
    '--file',
    config,
    `credential.${remote.url}.helper`,
    `store --file=${store}`,
  ]);
  fixtureGit(source, ['config', '--file', config, `credential.${remote.url}.useHttpPath`, 'false']);
  fixtureGit(source, [
    'config',
    '--file',
    config,
    `credential.${remote.url}.username`,
    'wrong-user',
  ]);
  const events: unknown[] = [];
  const broker = new AskpassBroker(
    resolve(
      'apps/desktop/dist/helpers',
      process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
    ),
    (event) => {
      events.push(event);
      if (event.type === 'authenticationPrompt') broker.answer(event.id, event.promptId, null);
    },
  );
  const service = new RepositoryService('git');
  try {
    const target = join(root, 'target');
    await mkdir(target);
    const credential = {
      url: remote.url,
      ...{ username: remote.credentials.username, password: remote.credentials.password },
    };
    const scope = await broker.open(
      randomUUID(),
      'Clone provider repository',
      undefined,
      credential,
    );
    const repo = await service.clone(
      target,
      { url: remote.url },
      undefined,
      undefined,
      {
        ...scope.environment,
        GIT_SSL_CAINFO: remote.certificate,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TRACE_CURL: trace,
        GIT_TRACE_REDACT: '0',
      },
      { url: credential.url, username: credential.username },
    );
    scope.close();
    expect(repo.head.oid).toBe(fixtureGit(source, ['rev-parse', 'HEAD']));
    expect(remote.authenticated()).toBeGreaterThan(1);
    expect(events).toEqual([]);
    await expect(stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(trace)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(target, '.git/config'), 'utf8')).not.toContain(
      remote.credentials.password,
    );
  } finally {
    await broker.close();
    await service.dispose();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('provider clones refuse Git URL rewrites and authenticated redirects even with URL-specific overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-provider-boundary-'));
  const source = createFixture(join(root, 'source'));
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const destination = await authenticatedRemote(bare, {
    basePath: '/team/project.git',
    password: 'fixture-provider-token',
  });
  const redirect = await authenticatedRemote(bare, {
    basePath: '/team/project.git',
    password: 'fixture-provider-token',
    redirect: destination.url + '/info/refs',
  });
  const config = join(root, 'gitconfig');
  fixtureGit(source, ['config', '--file', config, `http.${redirect.url}.followRedirects`, 'true']);
  const broker = new AskpassBroker(
    resolve(
      'apps/desktop/dist/helpers',
      process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
    ),
    () => {
      throw new Error('Provider clone must not expose a credential prompt');
    },
  );
  const service = new RepositoryService('git');
  try {
    const target = join(root, 'redirect');
    await mkdir(target);
    const credential = {
      url: redirect.url,
      username: redirect.credentials.username,
      password: redirect.credentials.password,
    };
    const scope = await broker.open(
      randomUUID(),
      'Clone provider repository',
      undefined,
      credential,
    );
    const environment = {
      ...scope.environment,
      GIT_SSL_CAINFO: redirect.certificate,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    await expect(
      service.clone(target, { url: redirect.url }, undefined, undefined, environment, {
        url: credential.url,
        username: credential.username,
      }),
    ).rejects.toThrow(/redirect|302/i);
    expect(redirect.authenticated()).toBeGreaterThan(0);
    expect(destination.requests()).toBe(0);
    scope.close();
    fixtureGit(source, [
      'config',
      '--file',
      config,
      `url.${destination.url}.insteadOf`,
      redirect.url,
    ]);
    const rewritten = join(root, 'rewritten');
    await mkdir(rewritten);
    await expect(
      service.clone(rewritten, { url: redirect.url }, undefined, undefined, environment, {
        url: credential.url,
        username: credential.username,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TRANSPORT_REWRITE' });
    expect(destination.requests()).toBe(0);
    expect(await stat(join(rewritten, '.git')).catch(() => undefined)).toBeUndefined();
  } finally {
    await broker.close();
    await service.dispose();
    await redirect.close();
    await destination.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('saved-account fetch validates the current remote before updating tracking refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-provider-fetch-'));
  const source = createFixture(join(root, 'source'));
  fixtureGit(source, ['commit', '--allow-empty', '-m', 'Provider fetch tip']);
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const remote = await authenticatedRemote(bare, {
    basePath: '/team/project.git',
    password: 'fixture-provider-token',
  });
  const local = createFixture(join(root, 'local'));
  fixtureGit(local, ['remote', 'set-url', 'origin', remote.url]);
  const broker = new AskpassBroker(
    resolve(
      'apps/desktop/dist/helpers',
      process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
    ),
    () => {
      throw new Error('Saved-account fetch must not prompt the renderer');
    },
  );
  const service = new RepositoryService('git');
  try {
    const repo = await service.open(local);
    const target = await service.providerRemoteTarget(repo.id, 'origin', 'fetch');
    expect(target.url).toBe(remote.url);
    const credential = {
      url: target.url,
      username: remote.credentials.username,
      password: remote.credentials.password,
    };
    const scope = await broker.open(randomUUID(), 'Fetch origin', undefined, credential);
    const environment = {
      ...scope.environment,
      GIT_SSL_CAINFO: remote.certificate,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    await service.fetch(repo.id, 'origin', undefined, false, undefined, environment, {
      ...target,
      username: credential.username,
    });
    expect(fixtureGit(local, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    expect(remote.authenticated()).toBeGreaterThan(1);
    const changed = await service.providerRemoteTarget(repo.id, 'origin', 'fetch');
    fixtureGit(local, [
      'remote',
      'set-url',
      'origin',
      remote.url.replace('/team/', '/another-team/'),
    ]);
    const requests = remote.requests();
    await expect(
      service.fetch(repo.id, 'origin', undefined, false, undefined, environment, {
        ...changed,
        username: credential.username,
      }),
    ).rejects.toMatchObject({ code: 'STALE_PROVIDER_REMOTE' });
    expect(remote.requests()).toBe(requests);
    fixtureGit(local, ['remote', 'set-url', '--add', 'origin', remote.url]);
    await expect(service.providerRemoteTarget(repo.id, 'origin', 'fetch')).rejects.toMatchObject({
      code: 'PROVIDER_REMOTE_URL',
    });
    fixtureGit(local, ['config', '--unset-all', 'remote.origin.url']);
    for (const url of [
      'git@example.test:team/project.git',
      'http://example.test/team/project.git',
      'https://user:secret@example.test/team/project.git',
      remote.url + '?token=secret',
    ]) {
      fixtureGit(local, ['config', 'remote.origin.url', url]);
      await expect(service.providerRemoteTarget(repo.id, 'origin', 'fetch')).rejects.toMatchObject({
        code: 'PROVIDER_REMOTE_URL',
      });
    }
    fixtureGit(local, ['config', 'remote.origin.url', remote.url]);
    fixtureGit(local, ['config', `url.https://other.test/team/project.git.insteadOf`, remote.url]);
    await expect(service.providerRemoteTarget(repo.id, 'origin', 'fetch')).rejects.toMatchObject({
      code: 'PROVIDER_TRANSPORT_REWRITE',
    });
    expect(remote.requests()).toBe(requests);
    scope.close();
  } finally {
    await broker.close();
    await service.dispose();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});
