import { expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openGitEditor } from './src/editor.js';
import { runProcess } from './src/runner.js';
const helper = resolve(
  'apps/desktop/dist/helpers',
  process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
);
test('native Git editor helper acknowledges only authenticated, approved file edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-editor-test-'));
  const path = join(directory, 'message with spaces.txt');
  await writeFile(path, 'before\n');
  let calls = 0;
  const scope = await openGitEditor(helper, async (requested, signal) => {
    calls++;
    if (requested !== path) throw new Error('Unexpected editor path');
    signal.throwIfAborted();
    await writeFile(path, 'reviewed commit message ✓\n');
  });
  try {
    await expect(
      runProcess(helper, ['--editor', path], {
        env: { ...scope.environment, OPENKRAKEN_EDITOR_TOKEN: '0'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('before\n');
    const result = await runProcess(helper, ['--editor', path], { env: scope.environment });
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toBe('');
    expect(await readFile(path, 'utf8')).toBe('reviewed commit message ✓\n');
    await expect(
      runProcess(helper, ['--editor', join(directory, 'unapproved')], { env: scope.environment }),
    ).rejects.toThrow();
    await scope.close();
    await expect(
      runProcess(helper, ['--editor', path], { env: scope.environment }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  } finally {
    await scope.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('cancellation revokes an editor capability while its request is pending', async () => {
  const controller = new AbortController();
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let cancelled = false;
  const scope = await openGitEditor(
    helper,
    async (_path, signal) => {
      notifyStarted();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new Error('Cancelled'));
          },
          { once: true },
        ),
      );
    },
    controller.signal,
  );
  try {
    const result = runProcess(helper, ['--editor', '/reviewed/message'], {
      env: scope.environment,
    }).then(
      () => 'unexpected success',
      () => 'cancelled',
    );
    await started;
    controller.abort();
    expect(await result).toBe('cancelled');
    expect(cancelled).toBe(true);
    await expect(
      runProcess(helper, ['--editor', '/reviewed/message'], { env: scope.environment }),
    ).rejects.toThrow();
  } finally {
    await scope.close();
  }
});
