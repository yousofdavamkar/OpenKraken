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
