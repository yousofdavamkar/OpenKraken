import { chromium, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { assertMsiSmokeProfile } from './msi-lifecycle.mjs';

const msiProfile = process.env.OPENKRAKEN_MSI_PROFILE;
if (msiProfile !== undefined) {
  assertMsiSmokeProfile(msiProfile, process.env.OPENKRAKEN_MSI_RETENTION_TOKEN);
  const marker = join(msiProfile, 'msi-lifecycle-retention.txt');
  if (
    !(await lstat(msiProfile)).isDirectory() ||
    !(await lstat(marker)).isFile() ||
    (await readFile(marker, 'utf8')) !== process.env.OPENKRAKEN_MSI_RETENTION_TOKEN
  )
    throw new Error('MSI smoke requires the lifecycle fixture profile and retention marker');
}
async function windowsProtocolSnapshot() {
  const { stdout } = await promisify(execFile)(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('scripts/read-windows-protocol.ps1'),
    ],
    { timeout: 15000, windowsHide: true },
  );
  return JSON.parse(stdout.trim());
}
const protocolBefore = process.platform === 'win32' ? await windowsProtocolSnapshot() : null;
const directory = resolve(
  process.env.OPENKRAKEN_PACKAGE_DIRECTORY ??
    `release/OpenKraken-${process.platform}-${process.arch}`,
);
const executable =
  process.env.OPENKRAKEN_PACKAGE_EXECUTABLE ??
  (process.platform === 'darwin'
    ? join(directory, 'OpenKraken.app/Contents/MacOS/openkraken')
    : join(directory, process.platform === 'win32' ? 'openkraken.exe' : 'openkraken'));
const profile = msiProfile ?? (await mkdtemp(join(tmpdir(), 'openkraken-package-')));
const linkedRepository = join(profile, 'linked repository');
await mkdir(linkedRepository, { recursive: !!msiProfile });
await promisify(execFile)('git', ['init', '--initial-branch=main', linkedRepository]);
const repositoryUri = `openkraken://repo?path=${encodeURIComponent(linkedRepository)}`;
const nativePicker = process.platform === 'linux' && !!process.env.OPENKRAKEN_XDOTOOL;
const packageShell = process.env.OPENKRAKEN_PACKAGE_SHELL ?? '/bin/bash';
if (nativePicker) {
  if (!isAbsolute(packageShell) || !['bash', 'zsh'].includes(basename(packageShell)))
    throw new Error('Packaged terminal smoke requires an absolute Bash or zsh executable');
  if (basename(packageShell) === 'zsh') {
    await writeFile(
      join(profile, '.zshenv'),
      'if [[ -n ${ZSH_TEST_MODULES-} ]]; then module_path=("$ZSH_TEST_MODULES"); fi\n',
    );
    await writeFile(join(profile, '.zshrc'), 'HISTFILE=/dev/null\nPROMPT="packaged> "\n');
  } else await writeFile(join(profile, '.bashrc'), 'HISTFILE=/dev/null\nPS1="packaged> "\n');
}
const child = spawn(
  executable,
  [
    '--remote-debugging-port=0',
    ...(msiProfile ? [] : [`--user-data-dir=${profile}`]),
    repositoryUri,
    ...(nativePicker ? ['--ozone-platform=x11', '--xdg-portal-required-version=999'] : []),
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ...(process.env.OPENKRAKEN_PACKAGE_EXECUTABLE ? { TMPDIR: profile } : {}),
      ...(nativePicker
        ? {
            SHELL: packageShell,
            HOME: profile,
            ...(basename(packageShell) === 'zsh' ? { ZDOTDIR: profile } : {}),
            ZSH_TEST_MODULES: process.env.OPENKRAKEN_ZSH_MODULE_PATH ?? '',
          }
        : {}),
    },
  },
);
let browser;
let mainProcessId;
function signalMainProcess(signal) {
  try {
    process.kill(mainProcessId, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
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
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  const mainProcess = processInfo.find((entry) => entry.type === 'browser');
  if (!mainProcess) throw new Error('Packaged browser process is missing');
  mainProcessId = mainProcess.id;
  await session.detach();
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  if (msiProfile)
    await page.getByRole('button', { name: 'Review repository link', exact: true }).waitFor();
  else await page.getByRole('heading', { name: 'A clear view of your history.' }).waitFor();
  const isolated = await page.evaluate(
    () =>
      typeof Reflect.get(window, 'require') === 'undefined' &&
      typeof Reflect.get(window, 'process') === 'undefined' &&
      typeof Reflect.get(window, 'openkraken')?.request === 'function',
  );
  if (!isolated) throw new Error('Packaged renderer isolation failed');
  const reporting = await page.evaluate(() =>
    window.openkraken.request({ id: crypto.randomUUID(), method: 'crashReporting' }),
  );
  if (reporting.kind !== 'crashReporting' || reporting.state.enabled)
    throw new Error('Packaged crash reporting must start without consent');
  const updates = await page.evaluate(() =>
    window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesRead' }),
  );
  if (
    updates.kind !== 'updates' ||
    !['disabled', 'idle'].includes(updates.state.phase) ||
    updates.state.error ||
    updates.state.automatic.enabled ||
    updates.state.automatic.nextCheckAt !== null ||
    updates.state.automatic.warning
  )
    throw new Error('Packaged updates must initialize without a background transfer');
  const diagnostics = await page.evaluate(() =>
    window.openkraken.request({ id: crypto.randomUUID(), method: 'diagnosticsRead' }),
  );
  if (
    diagnostics.kind !== 'diagnostics' ||
    diagnostics.state.warning ||
    !diagnostics.state.entries.some((entry) => entry.type === 'started')
  )
    throw new Error('Packaged local diagnostics failed to initialize');
  await page.getByRole('button', { name: 'Review repository link', exact: true }).click();
  const linkDialog = page.getByRole('dialog', { name: 'Open linked repository', exact: true });
  await expect(linkDialog).toContainText(linkedRepository);
  await linkDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (!msiProfile)
    await expect(
      page.getByRole('heading', { name: 'A clear view of your history.' }),
    ).toBeVisible();
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
    const xdo = (...args) =>
      promisify(execFile)(process.env.OPENKRAKEN_XDOTOOL, args, { timeout: 10000 });
    const pickFolder = async (button, path) => {
      await page.getByRole('button', { name: button, exact: true }).click();
      const windows = await xdo('search', '--sync', '--onlyvisible', '--name', '^Open repository$');
      const picker = windows.stdout.trim().split('\n').at(-1);
      if (!picker || !/^\d+$/.test(picker))
        throw new Error('Native repository picker was not found');
      await xdo('windowfocus', '--sync', picker);
      await xdo('mousemove', '--window', picker, '500', '400', 'click', '1');
      await xdo('key', '--clearmodifiers', 'ctrl+l');
      await xdo('key', '--clearmodifiers', 'ctrl+a');
      await xdo('type', '--clearmodifiers', '--delay', '1', path);
      await xdo('key', '--clearmodifiers', 'alt+o');
    };
    await pickFolder('Open a repository', repository);
    await expect(
      page.getByRole('heading', { name: 'terminal-repository', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Terminal', exact: true });
    await expect(panel.getByRole('status')).toContainText('Running');
    const integration = panel.getByLabel('Shell integration', { exact: true });
    await expect(integration).toHaveText('Ready for command');
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
    // An AppImage runtime can supervise Electron in a child process. Ask the
    // connected browser for its actual PID instead of assuming the launcher PID.
    const mainWindow = (
      await xdo('search', '--onlyvisible', '--pid', String(mainProcessId), '--name', '^OpenKraken$')
    ).stdout
      .trim()
      .split('\n')
      .at(-1);
    await xdo('windowfocus', '--sync', mainWindow);
    await xdo('key', '--clearmodifiers', 'ctrl+p');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(panel.locator('.xterm-accessibility-tree')).toContainText('16');
    await input.pressSequentially('false');
    await input.press('Enter');
    await expect(integration).toHaveText('Ready for command · last exit 1');
    await page.screenshot({ path: 'test-results/packaged-terminal.png' });
    await input.pressSequentially('exit 0');
    await input.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('Exited with code 0');
    await panel.getByRole('button', { name: 'Close terminal', exact: true }).click();
    const selected = repository + '\r';
    await promisify(execFile)('git', ['init', '--initial-branch=selected', selected]);
    await promisify(execFile)('git', [
      '-C',
      selected,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Selected checkout',
    ]);
    const shortcut = join(profile, 'selected-checkout');
    await symlink(selected, shortcut, 'dir');
    await pickFolder('Open repository', shortcut);
    await expect(page.locator('.repo-heading p')).toHaveAttribute('title', selected);
    await expect(
      page.getByRole('grid').getByText('Selected checkout', { exact: true }),
    ).toBeVisible();
    console.log(
      'Native folder selection preserved the canonical path and history of the carriage-return checkout.',
    );
    console.log(
      `Packaged native terminal opened the repository, tracked ${basename(packageShell)} commands, received native keyboard input and exited cleanly.`,
    );
  }
  if (process.platform !== 'darwin') {
    if (msiProfile) {
      await expect(
        page.getByRole('button', { name: 'Review repository link', exact: true }),
      ).toHaveCount(0);
      // Dispatch through Windows' registered URI handler, preserving the real
      // default profile and single-instance lock. Never rewrite registration.
      await promisify(execFile)(
        join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:OPENKRAKEN_REPOSITORY_URI",
        ],
        {
          timeout: 15000,
          windowsHide: true,
          env: { ...process.env, OPENKRAKEN_REPOSITORY_URI: repositoryUri },
        },
      );
    } else {
      await promisify(execFile)(executable, [`--user-data-dir=${profile}`, repositoryUri], {
        timeout: 15000,
        env: { ...process.env, TMPDIR: profile },
      });
    }
    await page.getByRole('button', { name: 'Review repository link', exact: true }).click();
    await expect(linkDialog).toContainText(linkedRepository);
    await linkDialog.getByRole('button', { name: 'Open repository', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'linked repository', exact: true }),
    ).toBeVisible();
    console.log(
      msiProfile
        ? 'Installed repository link delivered through the Windows URI handler and explicitly accepted.'
        : 'Packaged cold-start and second-process repository links require explicit consent.',
    );
  }
  await page.screenshot({ path: 'test-results/packaged-shell.png' });
  console.log(
    'Packaged ASAR app starts with hardened fuses; renderer isolation and native askpass/editor helpers passed.',
  );
} finally {
  await browser?.close();
  // CDP disconnect does not quit Electron. In extract-and-run mode the runtime
  // supervises a child; stop that child first so the runtime can finish and
  // close inherited pipes. Its extraction directory is inside our temp profile.
  if (mainProcessId && mainProcessId !== child.pid) {
    signalMainProcess('SIGTERM');
  } else child.kill();
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else {
      const timeout = setTimeout(() => {
        if (mainProcessId && mainProcessId !== child.pid) {
          try {
            signalMainProcess('SIGKILL');
          } catch (error) {
            return reject(error);
          }
        }
        child.kill('SIGKILL');
        reject(new Error('Packaged application did not shut down within 2 seconds'));
      }, 2000).unref();
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    }
  });
  // The AppImage runtime can exit just before its FUSE mount is released.
  // Bound filesystem teardown retries separately from the unchanged app exit deadline.
  if (!msiProfile)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
if (process.platform === 'win32') {
  expect(await windowsProtocolSnapshot()).toEqual(protocolBefore);
  console.log(
    'Launching the packaged desktop leaves installer-owned protocol registration unchanged.',
  );
}
