import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
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
const child = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
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
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/packaged-shell.png' });
  console.log('Packaged ASAR app starts with hardened fuses; renderer isolation passed.');
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
