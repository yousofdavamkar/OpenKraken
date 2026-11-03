import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the application exits normally after its idle Git service crashes', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-service-exit-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  const desktopProcess = app.process();
  let closing: Promise<void> | undefined;
  try {
    await app.firstWindow();
    await app.evaluate(({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git service');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect
      .poll(() =>
        app.evaluate(({ app }) =>
          app.getAppMetrics().some((metric) => metric.name === 'OpenKraken Git'),
        ),
      )
      .toBe(false);
    closing = app.close();
    await expect.poll(() => desktopProcess.exitCode).toBe(0);
    await closing;
  } finally {
    if (desktopProcess.exitCode === null && desktopProcess.signalCode === null)
      desktopProcess.kill('SIGKILL');
    await closing?.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a Git-service crash closes an active native fetch transport without releasing the fixture server', async () => {
  const { createServer } = await import('node:http');
  const { createFixture, fixtureGit } = await import('../../packages/test-fixtures/src/index.js');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-service-fetch-crash-'));
  const repo = createFixture(join(root, 'repo'));
  let openRequests = 0;
  let requests = 0;
  const server = createServer((request) => {
    openRequests++;
    requests++;
    request.on('close', () => {
      openRequests--;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  fixtureGit(repo, ['remote', 'set-url', 'origin', `http://127.0.0.1:${address.port}/repo.git`]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.evaluate(async () => {
      const result = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (result.kind !== 'snapshot') throw new Error('Missing repository');
      void window.openkraken
        .request({
          id: crypto.randomUUID(),
          method: 'fetch',
          name: 'origin',
          repoId: result.snapshot.repository.id,
        })
        .then((result) => sessionStorage.setItem('crashed-fetch', JSON.stringify(result)));
    });
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect.poll(() => openRequests).toBe(1);
    await app.evaluate(({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git service');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('crashed-fetch')))
      .toContain('SERVICE_EXIT');
    await expect.poll(() => openRequests).toBe(0);
    expect(
      await page.evaluate(() =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }),
      ),
    ).toMatchObject({ kind: 'snapshot' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a service crash kills an ignoring commit hook and its descendant while retaining staged work', async () => {
  test.skip(process.platform !== 'linux', 'Linux process identity and zombie-state fixture');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { createFixture, fixtureGit } = await import('../../packages/test-fixtures/src/index.js');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-service-hook-crash-'));
  const repo = createFixture(join(root, 'repo'));
  const hookPidFile = join(root, 'hook.pid');
  const childPidFile = join(root, 'child.pid');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(repo, '.git/hooks/pre-commit'),
    `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' "$$" > ${quote(hookPidFile)}\nsleep 300 &\nprintf '%s\\n' "$!" > ${quote(childPidFile)}\nwait\n`,
    { mode: 0o755 },
  );
  await writeFile(join(repo, 'tracked.txt'), 'staged draft retained\n');
  fixtureGit(repo, ['add', 'tracked.txt']);
  const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
  const index = fixtureGit(repo, ['ls-files', '--stage']);
  const members: { pid: number; group: number; started: string }[] = [];
  const identity = async (pid: number) => {
    try {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      return { state: fields[0], group: Number(fields[2]), started: fields[19]! };
    } catch {
      return undefined;
    }
  };
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.evaluate(async () => {
      const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (opened.kind !== 'snapshot') throw new Error('Missing repository');
      const repoId = opened.snapshot.repository.id;
      const working = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'workingState',
        repoId,
      });
      if (working.kind !== 'workingState') throw new Error('Missing working state');
      void window.openkraken
        .request({
          id: crypto.randomUUID(),
          method: 'commit',
          repoId,
          options: { message: 'Never committed', revision: working.state.revision, sign: false },
        })
        .then((result) => sessionStorage.setItem('crashed-commit', JSON.stringify(result)));
    });
    for (const file of [hookPidFile, childPidFile]) {
      await expect
        .poll(async () => {
          try {
            return Number(await readFile(file, 'utf8'));
          } catch {
            return 0;
          }
        })
        .toBeGreaterThan(0);
      const pid = Number(await readFile(file, 'utf8'));
      const found = await identity(pid);
      expect(found).toBeDefined();
      members.push({ pid, group: found!.group, started: found!.started });
    }
    await app.evaluate(({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git service');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('crashed-commit')))
      .toContain('SERVICE_EXIT');
    for (const member of members) {
      await expect
        .poll(async () => {
          const current = await identity(member.pid);
          return !current || current.started !== member.started || current.state === 'Z';
        })
        .toBe(true);
    }
    expect(fixtureGit(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fixtureGit(repo, ['ls-files', '--stage'])).toBe(index);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('staged draft retained\n');
  } finally {
    // Only kill a group still containing the exact fixture process, never a reused PID.
    for (const member of members) {
      const current = await identity(member.pid);
      if (
        current?.started === member.started &&
        current.state !== 'Z' &&
        current.group === member.group
      )
        try {
          process.kill(-member.group, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
    }
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
