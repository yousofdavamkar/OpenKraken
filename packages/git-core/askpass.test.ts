import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { AskpassBroker } from './src/askpass.js';
import { runProcess } from './src/runner.js';
const helper = resolve(
  'apps/desktop/dist/helpers',
  process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
);

test('malformed socket frames cannot obtain saved credentials or disable subsequent authentication', async () => {
  const events: unknown[] = [];
  const broker = new AskpassBroker(helper, (event) => events.push(event));
  const credential = {
    url: 'https://example.test/team/repo.git',
    username: 'fixture-user',
    password: 'fixture-private-password',
  };
  try {
    const scope = await broker.open(randomUUID(), 'Fetch origin', undefined, credential);
    const input = {
      token: scope.environment.OPENKRAKEN_ASKPASS_TOKEN,
      prompt: "Password for 'https://fixture-user@example.test/team/repo.git': ",
      hint: '',
    };
    const frame = JSON.stringify(input) + '\n';
    const exchange = (body: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = createConnection(scope.environment.OPENKRAKEN_ASKPASS_SOCKET);
        const chunks: Buffer[] = [];
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error('Rejected authentication socket did not close'));
        });
        socket.once('connect', () => socket.write(body));
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ECONNRESET') reject(error);
        });
        socket.once('close', () => resolve(Buffer.concat(chunks).toString()));
      });
    for (const body of [
      JSON.stringify({ ...input, token: '0'.repeat(64) }) + '\n',
      JSON.stringify({ ...input, token: input.token.slice(1) }) + '\n',
      JSON.stringify({ ...input, extra: true }) + '\n',
      '{invalid json}\n',
      frame + frame,
      'x'.repeat(32769),
    ])
      expect(await exchange(body)).toBe('');
    expect(events).toEqual([]);
    expect(
      (await runProcess(helper, [input.prompt], { env: scope.environment })).stdout.toString(),
    ).toBe('fixture-private-password\n');
    scope.close();
    expect(await exchange(frame)).toBe('');
    expect(events).toEqual([]);
  } finally {
    await broker.close();
  }
});

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

test.each([
  'https://github.com/team/project.git',
  'https://gitlab.example.test/company/subgroup/team/project.git',
])(
  'saved HTTPS credentials answer only their exact repository and account without renderer prompts: %s',
  async (url) => {
    const events: unknown[] = [];
    const broker = new AskpassBroker(helper, (event) => {
      events.push(event);
      if (event.type === 'authenticationPrompt') broker.answer(event.id, event.promptId, null);
    });
    const credential = {
      url,
      username: 'fixture-user',
      password: 'fixture-provider-token',
    };
    const { host, pathname } = new URL(url);
    try {
      const scope = await broker.open(
        randomUUID(),
        'Clone provider repository',
        undefined,
        credential,
      );
      expect(
        (
          await runProcess(helper, [`Username for '${url}': `], {
            env: scope.environment,
          })
        ).stdout.toString(),
      ).toBe('fixture-user\n');
      for (const prompt of [
        `Password for 'https://fixture-user@other.test${pathname}': `,
        `Password for 'https://fixture-user@${host}${pathname.replace('/project.git', '/other.git')}': `,
        `Password for 'https://fixture-user@${host}${pathname.replace('/project.git', '/sibling/project.git')}': `,
        `Password for 'https://fixture-user@${host}${pathname.replace('/project.git', '/hidden/../project.git')}': `,
        `Password for 'https://fixture-user@${host}:443${pathname}': `,
        `Password for 'http://fixture-user@${host}${pathname}': `,
        `Password for 'https://someone-else@${host}${pathname}': `,
        `Password for 'https://fixture-user@${host}${pathname}?secret': `,
        'Enter passphrase for SSH key: ',
      ])
        await expect(runProcess(helper, [prompt], { env: scope.environment })).rejects.toThrow();
      const prompt = `Password for 'https://fixture-user@${host}${pathname}': `;
      expect(
        (await runProcess(helper, [prompt], { env: scope.environment })).stdout.toString(),
      ).toBe('fixture-provider-token\n');
      expect(
        (await runProcess(helper, [prompt], { env: scope.environment })).stdout.toString(),
      ).toBe('fixture-provider-token\n');
      expect(events).toEqual([]);
      expect(JSON.stringify(scope.environment)).not.toContain('fixture-provider-token');
      scope.close();
      await expect(runProcess(helper, [prompt], { env: scope.environment })).rejects.toThrow();
    } finally {
      await broker.close();
    }
  },
);
