import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

test('a repository terminal uses a separate PTY, accepts input and resize, and rejects stale sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 3);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, ...(process.platform === 'win32' ? {} : { SHELL: '/bin/sh' }) },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const opened = await page.evaluate(async () => {
      const snapshot = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (snapshot.kind !== 'snapshot') throw new Error('Repository missing');
      const sessionId = crypto.randomUUID();
      const events: unknown[] = [];
      Reflect.set(window, 'terminalEvents', events);
      window.openkraken.subscribe((event) => {
        if (event.type === 'terminalData' || event.type === 'terminalExit') events.push(event);
        if (event.type === 'terminalData')
          void window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'terminalAck',
            sessionId,
            sequence: event.sequence,
          });
      });
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'terminalOpen',
        sessionId,
        repoId: snapshot.snapshot.repository.id,
        cols: 80,
        rows: 24,
      });
      return { result, sessionId };
    });
    expect(opened.result).toMatchObject({ kind: 'terminalOpened', sessionId: opened.sessionId });
    expect(
      await app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .filter((metric) => metric.type === 'Utility')
          .map((metric) => metric.name),
      ),
    ).toEqual(expect.arrayContaining(['OpenKraken Terminal', 'OpenKraken Git']));
    const send = (data: string) =>
      page.evaluate(
        ({ sessionId, data }) =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'terminalInput',
            sessionId,
            data,
          }),
        { sessionId: opened.sessionId, data },
      );
    const output = () =>
      page.evaluate(() =>
        (Reflect.get(window, 'terminalEvents') as { data?: string }[])
          .map((event) => event.data ?? '')
          .join(''),
      );
    await send(
      process.platform === 'win32'
        ? 'git rev-parse --show-toplevel\r'
        : 'printf \'PTY:%s\\n\' "$(git rev-parse --show-toplevel)"\r',
    );
    await expect.poll(output).toContain(repository.replaceAll('\\', '/'));
    expect(
      await page.evaluate(
        (sessionId) =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'terminalResize',
            sessionId,
            cols: 91,
            rows: 27,
          }),
        opened.sessionId,
      ),
    ).toEqual({ kind: 'terminalAck' });
    if (process.platform !== 'win32') {
      await send('stty size\r');
      await expect.poll(output).toContain('27 91');
    }
    await send('echo terminal-roundtrip-ok\r');
    await expect
      .poll(async () => ((await output()).match(/terminal-roundtrip-ok/g) ?? []).length)
      .toBe(2);
    await send('exit 7\r');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (Reflect.get(window, 'terminalEvents') as { type: string; exitCode?: number }[]).find(
              (event) => event.type === 'terminalExit',
            )?.exitCode,
        ),
      )
      .toBe(7);
    expect(await send('echo should-not-run\r')).toMatchObject({
      kind: 'error',
      code: 'TERMINAL_CLOSED',
    });
    expect(
      await page.evaluate(() =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'terminalOpen',
          sessionId: crypto.randomUUID(),
          repoId: '0'.repeat(64),
          cols: 80,
          rows: 24,
        }),
      ),
    ).toMatchObject({ kind: 'error', code: 'TERMINAL_REPOSITORY' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal output pauses without acknowledgments and closing or reloading reaps its shell', async () => {
  test.skip(process.platform === 'win32', 'POSIX stream and process-lifecycle acceptance');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-flow-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 3);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, SHELL: '/bin/sh' },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeEnabled();
    const opened = await page.evaluate(async () => {
      const result = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (result.kind !== 'snapshot') throw new Error('Missing repository');
      const sessionId = crypto.randomUUID();
      let output = '';
      let sequence = 0;
      let automatic = false;
      const acknowledge = () =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'terminalAck',
          sessionId,
          sequence,
        });
      Reflect.set(window, 'readTerminalOutput', () => output);
      Reflect.set(window, 'resumeTerminalOutput', () => {
        automatic = true;
        return acknowledge();
      });
      window.openkraken.subscribe((event) => {
        if (event.type !== 'terminalData' || event.id !== sessionId) return;
        output += event.data;
        sequence = event.sequence;
        if (automatic) void acknowledge();
      });
      const opened = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'terminalOpen',
        sessionId,
        repoId: result.snapshot.repository.id,
        cols: 100,
        rows: 24,
      });
      return { opened, sessionId, repoId: result.snapshot.repository.id };
    });
    expect(opened.opened.kind).toBe('terminalOpened');
    const output = () => page.evaluate<string>(() => Reflect.get(window, 'readTerminalOutput')());
    const send = (data: string) =>
      page.evaluate(
        ({ sessionId, data }) =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'terminalInput',
            sessionId,
            data,
          }),
        { sessionId: opened.sessionId, data },
      );
    await send("head -c 1048576 /dev/zero | tr '\\0' X; printf '\\nSTREAM_FINISHED\\n'\r");
    await expect.poll(async () => (await output()).length).toBeGreaterThanOrEqual(262144);
    const paused = (await output()).length;
    expect(paused).toBeLessThan(400000);
    await page.waitForTimeout(250);
    expect((await output()).length).toBe(paused);
    await page.evaluate(() => Reflect.get(window, 'resumeTerminalOutput')());
    await expect.poll(output).toContain('\r\nSTREAM_FINISHED\r\n');
    expect(((await output()).match(/X/g) ?? []).length).toBe(1048577);
    await send('printf \'SHELL_PID:%s\\n\' "$$"; sleep 30\r');
    await expect.poll(output).toMatch(/SHELL_PID:\d+/);
    const shellPid = Number(/SHELL_PID:(\d+)/.exec(await output())![1]);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(shellPid)).toBe(true);
    await page.evaluate(
      (sessionId) =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'terminalClose', sessionId }),
      opened.sessionId,
    );
    await expect.poll(() => alive(shellPid)).toBe(false);
    const nextId = await page.evaluate(async (repoId) => {
      const sessionId = crypto.randomUUID();
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'terminalOpen',
        sessionId,
        repoId,
        cols: 80,
        rows: 24,
      });
      if (result.kind !== 'terminalOpened') throw new Error('Could not restart terminal');
      return sessionId;
    }, opened.repoId);
    await page.reload();
    await expect
      .poll(() =>
        app.evaluate(({ app }) =>
          app.getAppMetrics().some((metric) => metric.name === 'OpenKraken Terminal'),
        ),
      )
      .toBe(false);
    expect(
      await page.evaluate(
        (sessionId) =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'terminalInput',
            sessionId,
            data: 'echo stale\r',
          }),
        nextId,
      ),
    ).toMatchObject({ kind: 'error', code: 'TERMINAL_CLOSED' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
