import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AskpassBroker } from './src/askpass.js';
import { runProcess } from './src/runner.js';
const helper = resolve(
  'apps/desktop/dist/helpers',
  process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
);
test('the native helper exchanges a secret only through its authenticated request scope', async () => {
  const id = randomUUID();
  const events: unknown[] = [];
  const broker = new AskpassBroker(helper, (event) => {
    events.push(event);
    if (event.type === 'authenticationPrompt') {
      expect(event.id).toBe(id);
      expect(event.kind).toBe('secret');
      expect(broker.answer(id, event.promptId, 'fixture-secret-✓')).toBe(true);
    }
  });
  try {
    const scope = await broker.open(id, 'Fetch origin');
    const result = await runProcess(helper, ["Password for 'https://example.test':"], {
      env: scope.environment,
    });
    expect(result.stdout.toString()).toBe('fixture-secret-✓\n');
    expect(result.stderr).toBe('');
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
    scope.close();
    await expect(runProcess(helper, ['Password:'], { env: scope.environment })).rejects.toThrow();
  } finally {
    await broker.close();
  }
});
test('bad tokens and cancellation cannot receive an answer; SSH confirmation is explicit', async () => {
  let shown = 0;
  const id = randomUUID();
  const controller = new AbortController();
  const broker = new AskpassBroker(helper, (event) => {
    if (event.type === 'authenticationPrompt') {
      shown++;
      if (event.kind === 'confirm') broker.answer(id, event.promptId, 'yes');
      else controller.abort();
    }
  });
  try {
    const scope = await broker.open(id, 'SSH connection', controller.signal);
    await expect(
      runProcess(helper, ['Password:'], {
        env: { ...scope.environment, OPENKRAKEN_ASKPASS_TOKEN: '0'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(shown).toBe(0);
    expect(
      (
        await runProcess(helper, ['Trust host fingerprint?'], {
          env: { ...scope.environment, SSH_ASKPASS_PROMPT: 'confirm' },
        })
      ).stdout.toString(),
    ).toBe('yes\n');
    await expect(runProcess(helper, ['Passphrase:'], { env: scope.environment })).rejects.toThrow();
    expect(shown).toBe(2);
  } finally {
    await broker.close();
  }
});
test('SSH host-key confirmation without a hint is explicit and replies cannot cross operation scopes', async () => {
  const id = randomUUID();
  const broker = new AskpassBroker(helper, (event) => {
    if (event.type === 'authenticationPrompt') {
      expect(event.kind).toBe('confirm');
      expect(broker.answer(randomUUID(), event.promptId, 'yes')).toBe(false);
      expect(broker.answer(id, event.promptId, '')).toBe(false);
      expect(broker.answer(id, event.promptId, 'no')).toBe(true);
    }
  });
  let path: string;
  try {
    const scope = await broker.open(id, 'SSH clone');
    path = scope.environment.OPENKRAKEN_ASKPASS_SOCKET;
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    } else expect(path.startsWith('\\\\.\\pipe\\openkraken-')).toBe(true);
    const result = await runProcess(
      helper,
      [
        "The authenticity of host 'example.test' can't be established.\nED25519 key fingerprint is SHA256:fixture.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
      ],
      { env: scope.environment },
    );
    expect(result.stdout.toString()).toBe('no\n');
    scope.close();
  } finally {
    await broker.close();
  }
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
