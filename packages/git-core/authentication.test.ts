import { expect, test } from 'vitest';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
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
