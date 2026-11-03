import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

async function identity(pid: number) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (!fields[19]) return undefined;
    return { state: fields[0], started: fields[19] };
  } catch {
    return undefined;
  }
}

test('main-process death stops an active fetch and restart reports an unknown outcome', async () => {
  test.skip(process.platform !== 'linux', 'Linux process identity fixture');
  const root = await mkdtemp(join(tmpdir(), 'openkraken-main-crash-'));
  const repo = createFixture(join(root, 'repo'));
  let openRequests = 0;
  const server = createServer((request) => {
    openRequests++;
    request.on('close', () => {
      openRequests--;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  fixtureGit(repo, ['remote', 'set-url', 'origin', `http://127.0.0.1:${address.port}/repo.git`]);
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  const app = await electron.launch({ args });
  const main = app.process();
  const exited = new Promise<void>((resolve) => main.once('exit', () => resolve()));
  const owned: { pid: number; started: string }[] = [];
  let restarted: typeof app | undefined;
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.evaluate(async () => {
      const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (opened.kind !== 'snapshot') throw new Error('Missing repository');
      const saved = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commitDraftSave',
        repoId: opened.snapshot.repository.id,
        revision: null,
        draft: {
          message: 'Acknowledged before main crash',
          amendMessage: '',
          amend: false,
          amendHead: null,
          sign: 'default',
        },
      });
      if (saved.kind !== 'commitDraft') throw new Error('Draft was not acknowledged');
      void window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'fetch',
        repoId: opened.snapshot.repository.id,
        name: 'origin',
      });
    });
    await expect.poll(() => openRequests).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const activity = await window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'activityRead',
          });
          return (
            activity.kind === 'activity' &&
            activity.state.entries.some(
              (entry) => entry.action === 'fetch' && entry.outcome === 'running',
            )
          );
        }),
      )
      .toBe(true);
    for (const pid of await app.evaluate(({ app }) =>
      app.getAppMetrics().map((item) => item.pid),
    )) {
      if (pid === main.pid) continue;
      const found = await identity(pid);
      if (found) owned.push({ pid, started: found.started });
    }
    expect(main.kill('SIGKILL')).toBe(true);
    await exited;
    await expect.poll(() => openRequests).toBe(0);
    restarted = await electron.launch({ args });
    const newPage = await restarted.firstWindow();
    const result = await newPage.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'activityRead' }),
    );
    expect(result.kind).toBe('activity');
    if (result.kind === 'activity')
      expect(result.state.entries.filter((entry) => entry.action === 'fetch')).toMatchObject([
        { outcome: 'unknown' },
      ]);
    await restarted.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    expect(
      await newPage.evaluate(async () => {
        const reopened = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'open',
        });
        if (reopened.kind !== 'snapshot') throw new Error('Repository did not reopen');
        return window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'commitDraftRead',
          repoId: reopened.snapshot.repository.id,
        });
      }),
    ).toMatchObject({
      kind: 'commitDraft',
      state: { draft: { message: 'Acknowledged before main crash' } },
    });
  } finally {
    if (main.exitCode === null && main.signalCode === null) main.kill('SIGKILL');
    await exited;
    for (const member of owned) {
      const current = await identity(member.pid);
      if (current && current.started === member.started && current.state !== 'Z') {
        try {
          process.kill(member.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await restarted?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const target of ['main', 'terminal'] as const)
  test(`${target}-process death stops the PTY shell and its ordinary foreground command`, async () => {
    test.skip(process.platform !== 'linux', 'Linux process identity and POSIX PTY fixture');
    const root = await mkdtemp(join(tmpdir(), 'openkraken-terminal-crash-'));
    const repo = createFixture(join(root, 'repo'));
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env: { ...process.env, SHELL: '/bin/sh' },
    });
    const main = app.process();
    const exited = new Promise<void>((resolve) => main.once('exit', () => resolve()));
    const owned: { pid: number; started: string }[] = [];
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, repo);
      await page.evaluate(async () => {
        const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
        if (opened.kind !== 'snapshot') throw new Error('Missing repository');
        const sessionId = crypto.randomUUID();
        const terminal = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'terminalOpen',
          sessionId,
          repoId: opened.snapshot.repository.id,
          cols: 80,
          rows: 24,
        });
        if (terminal.kind !== 'terminalOpened') throw new Error('Missing terminal');
        await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'terminalInput',
          sessionId,
          data: `printf '%s\\n' "$$" > .git/terminal-shell.pid; sh -c 'echo $$ > .git/terminal-child.pid; exec sleep 300'\r`,
        });
      });
      const members: { pid: number; started: string }[] = [];
      for (const name of ['terminal-shell.pid', 'terminal-child.pid']) {
        const file = join(repo, '.git', name);
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
        if (!found) throw new Error('Fixture process exited before crash');
        members.push({ pid, started: found.started });
      }
      owned.push(...members);
      const metrics = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((metric) => ({ pid: metric.pid, name: metric.name })),
      );
      for (const metric of metrics) {
        if (metric.pid === main.pid) continue;
        const found = await identity(metric.pid);
        if (found) owned.push({ pid: metric.pid, started: found.started });
      }
      if (target === 'main') {
        expect(main.kill('SIGKILL')).toBe(true);
        await exited;
      } else {
        const terminal = metrics.find((metric) => metric.name === 'OpenKraken Terminal');
        if (!terminal) throw new Error('Missing terminal utility');
        process.kill(terminal.pid, 'SIGKILL');
      }
      for (const member of members)
        await expect
          .poll(async () => {
            const current = await identity(member.pid);
            return !current || current.started !== member.started || current.state === 'Z';
          })
          .toBe(true);
    } finally {
      if (main.exitCode === null && main.signalCode === null) await app.close();
      await exited;
      for (const member of owned) {
        const current = await identity(member.pid);
        if (current && current.started === member.started && current.state !== 'Z')
          try {
            process.kill(member.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
