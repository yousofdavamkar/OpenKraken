import { chromium, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
const directory = resolve(`release/OpenKraken-${process.platform}-${process.arch}`);
const executable =
  process.platform === 'darwin'
    ? join(directory, 'OpenKraken.app/Contents/MacOS/openkraken')
    : join(directory, process.platform === 'win32' ? 'openkraken.exe' : 'openkraken');
const profile = await mkdtemp(join(tmpdir(), 'openkraken-package-'));
const nativePicker = process.platform === 'linux' && !!process.env.OPENKRAKEN_XDOTOOL;
const child = spawn(
  executable,
  [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    ...(nativePicker ? ['--ozone-platform=x11', '--xdg-portal-required-version=999'] : []),
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ...(process.platform === 'linux' && process.env.OPENKRAKEN_XDOTOOL
        ? { SHELL: '/bin/sh' }
        : {}),
    },
  },
);
let browser;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let diagnostics = '';
    const timeout = setTimeout(
      () => reject(new Error(`Packaged app failed to start: ${diagnostics}`)),
      15000,
    );
    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      diagnostics = (diagnostics + '\n' + line).slice(-4096);
      const match = /DevTools listening on (ws:\/\/.*)/.exec(line);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Packaged app exited ${code}: ${diagnostics}`));
    });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.getByRole('heading', { name: 'A clear view of your history.' }).waitFor();
  const isolated = await page.evaluate(
    () =>
      typeof Reflect.get(window, 'require') === 'undefined' &&
      typeof Reflect.get(window, 'process') === 'undefined' &&
      typeof Reflect.get(window, 'openkraken')?.request === 'function',
  );
  if (!isolated) throw new Error('Packaged renderer isolation failed');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\openkraken-${randomUUID()}`
      : join(profile, 'prompt.sock');
  const token = randomBytes(32).toString('hex');
  const server = createServer((socket) => {
    let frame = '';
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', (chunk) => {
      frame += chunk;
      if (frame.length > 32768) {
        socket.destroy();
        return;
      }
      if (!frame.endsWith('\n')) return;
      try {
        const request = JSON.parse(frame);
        if (request.token !== token) throw new Error('Invalid helper request');
        if (request.prompt === 'Packaged helper test')
          socket.end(JSON.stringify({ ok: true, answer: 'packaged-helper-ok' }) + '\n');
        else if (request.path === 'Packaged editor test') socket.end('{"ok":true}\n');
        else throw new Error('Invalid helper request');
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    const resources =
      process.platform === 'darwin'
        ? join(directory, 'OpenKraken.app/Contents/Resources')
        : join(directory, 'resources');
    const helper = join(
      resources,
      'app.asar.unpacked/dist/helpers',
      process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
    );
    const reply = await promisify(execFile)(helper, ['Packaged helper test'], {
      timeout: 5000,
      env: {
        ...process.env,
        OPENKRAKEN_ASKPASS_SOCKET: socketPath,
        OPENKRAKEN_ASKPASS_TOKEN: token,
      },
    });
    if (reply.stdout !== 'packaged-helper-ok\n' || reply.stderr)
      throw new Error('Packaged native helper failed');
    const editor = await promisify(execFile)(helper, ['--editor', 'Packaged editor test'], {
      timeout: 5000,
      env: {
        ...process.env,
        OPENKRAKEN_EDITOR_SOCKET: socketPath,
        OPENKRAKEN_EDITOR_TOKEN: token,
      },
    });
    if (editor.stdout || editor.stderr) throw new Error('Packaged native editor helper failed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await mkdir('test-results', { recursive: true });
  if (process.platform === 'linux' && process.env.OPENKRAKEN_XDOTOOL) {
    const repository = join(profile, 'terminal-repository');
    await mkdir(repository);
    await promisify(execFile)('git', ['init', repository]);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const xdo = (...args) =>
      promisify(execFile)(process.env.OPENKRAKEN_XDOTOOL, args, { timeout: 10000 });
    const windows = await xdo('search', '--sync', '--onlyvisible', '--name', '^Open repository$');
    const picker = windows.stdout.trim().split('\n').at(-1);
    if (!picker || !/^\d+$/.test(picker)) throw new Error('Native repository picker was not found');
    await xdo('windowfocus', '--sync', picker);
    await xdo('mousemove', '--window', picker, '500', '400', 'click', '1');
    await xdo('key', '--clearmodifiers', 'ctrl+l');
    await xdo('key', '--clearmodifiers', 'ctrl+a');
    await xdo('type', '--clearmodifiers', '--delay', '1', repository);
    await xdo('key', '--clearmodifiers', 'alt+o');
    await expect(
      page.getByRole('heading', { name: 'terminal-repository', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Terminal', exact: true });
    await expect(panel.getByRole('status')).toContainText('Running');
    const input = panel.getByRole('textbox', { name: 'Terminal input', exact: true });
    await input.pressSequentially('echo packaged-pty-ok');
    await input.press('Enter');
    await expect
      .poll(
        async () =>
          (
            (await panel.locator('.xterm-accessibility-tree').innerText()).match(
              /packaged-pty-ok/g,
            ) ?? []
          ).length,
      )
      .toBe(2);
    await input.pressSequentially(
      'stty -echo -icanon; dd bs=1 count=1 2>/dev/null | od -An -t u1; stty sane',
    );
    await input.press('Enter');
    const mainWindow = (
      await xdo('search', '--onlyvisible', '--pid', String(child.pid), '--name', '^OpenKraken$')
    ).stdout
      .trim()
      .split('\n')
      .at(-1);
    await xdo('windowfocus', '--sync', mainWindow);
    await xdo('key', '--clearmodifiers', 'ctrl+p');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(panel.locator('.xterm-accessibility-tree')).toContainText('16');
    await page.screenshot({ path: 'test-results/packaged-terminal.png' });
    await input.pressSequentially('exit 0');
    await input.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('Exited with code 0');
    await panel.getByRole('button', { name: 'Close terminal', exact: true }).click();
    console.log('Packaged native terminal opened the repository, echoed input and exited cleanly.');
  }
  await page.screenshot({ path: 'test-results/packaged-shell.png' });
  console.log(
    'Packaged ASAR app starts with hardened fuses; renderer isolation and native askpass/editor helpers passed.',
  );
} finally {
  await browser?.close();
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once('exit', resolve);
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000).unref();
    }
  });
  await rm(profile, { recursive: true, force: true });
}
