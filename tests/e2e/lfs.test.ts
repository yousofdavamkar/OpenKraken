import { _electron as electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0;
if (process.env.OPENKRAKEN_LFS_TEST === '1' && !hasLfs)
  throw new Error('LFS acceptance requires git-lfs on PATH');

test('commit comparison explains LFS pointer identity and size without fetching content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-pointer-ui-'));
  const path = createFixture(join(root, 'parent'));
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12345\n`;
  writeFileSync(join(path, 'asset.bin'), pointer);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'LFS pointer']);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const grid = page.getByRole('grid', { name: 'Commit history' });
    await grid.press('Home');
    await grid.press('Enter');
    await page.getByRole('button', { name: 'Compare asset.bin', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'File comparison' });
    await expect(viewer).toContainText('Git LFS pointer');
    await expect(viewer).toContainText('12,345 bytes');
    await expect(viewer).toContainText('a'.repeat(64));
    await expect(viewer.getByRole('button', { name: 'Blame', exact: true })).toBeDisabled();
    await expect(viewer.locator('.cm-editor')).toHaveCount(0);
    expect(readFileSync(join(path, 'asset.bin'), 'utf8')).toBe(pointer);
    await page.screenshot({ path: 'test-results/lfs-pointer.png' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('LFS view shows installed version, tracked objects, cached locks and pointer-only checkouts', async () => {
  test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
  const { createServer } = await import('node:http');
  const { runGit } = await import('../../packages/git-core/src/runner.js');
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
    response.end(
      JSON.stringify({
        locks: [
          {
            id: 'fixture-lock',
            path: 'asset.bin',
            owner: { name: 'Fixture Owner' },
            locked_at: '2026-11-02T00:00:00Z',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-state-ui-'));
  const path = createFixture(join(root, 'parent'));
  fixtureGit(path, ['lfs', 'install', '--local', '--skip-smudge']);
  fixtureGit(path, ['lfs', 'track', '*.bin']);
  writeFileSync(join(path, 'asset.bin'), 'large file contents\n');
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'LFS fixture']);
  fixtureGit(path, ['config', 'lfs.url', `http://127.0.0.1:${address.port}/lfs`]);
  await runGit('git', ['lfs', 'locks', '--json'], { cwd: path });
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Git LFS', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Git LFS', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git LFS', exact: true });
    await expect(dialog).toContainText('git-lfs/');
    const files = dialog.getByRole('list', { name: 'LFS tracked files' });
    await expect(files).toContainText('asset.bin');
    await expect(files).toContainText('Full content checked out');
    await expect(files).toContainText('Object available locally');
    await expect(files).toContainText('Server lock state unknown');
    await expect(files).toContainText('Cached lock: Fixture Owner');
    await expect(dialog.getByRole('list', { name: 'Cached LFS locks' })).toContainText(
      'Fixture Owner',
    );
    writeFileSync(join(path, 'asset.bin'), fixtureGit(path, ['show', 'HEAD:asset.bin']) + '\n');
    await dialog.getByRole('button', { name: 'Refresh local state', exact: true }).click();
    await expect(files).toContainText('Pointer or missing working file');
    expect(requests).toBe(1);
    await page.screenshot({ path: 'test-results/lfs-state.png' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewed LFS download refreshes stale plans and fills a missing object', async () => {
  test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const content = Buffer.from('downloaded LFS content\n');
  const oid = createHash('sha256').update(content).digest('hex');
  let endpoint = '';
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/lfs/objects/batch') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
      response.end(
        JSON.stringify({
          transfer: 'basic',
          objects: [
            { oid, size: content.length, actions: { download: { href: `${endpoint}/object` } } },
          ],
        }),
      );
    } else if (request.url === '/lfs/object') {
      response.writeHead(200, { 'Content-Length': content.length });
      response.end(content);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  endpoint = `http://127.0.0.1:${address.port}/lfs`;
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-pull-ui-'));
  const path = createFixture(join(root, 'parent'));
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
  writeFileSync(join(path, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(join(path, 'asset.bin'), pointer);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'LFS pointer']);
  fixtureGit(path, ['config', 'lfs.url', endpoint]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Git LFS', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git LFS', exact: true });
    await expect(
      dialog.getByRole('button', { name: 'Review download', exact: true }),
    ).toBeEnabled();
    await dialog.getByRole('button', { name: 'Review download', exact: true }).click();
    const review = dialog.getByRole('group', { name: 'Review LFS download' });
    await expect(review).toContainText(endpoint);
    await expect(review.getByRole('button', { name: 'Cancel review', exact: true })).toBeFocused();
    expect(requests).toBe(0);
    await review.getByRole('button', { name: 'Cancel review', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Review download', exact: true }),
    ).toBeFocused();
    await dialog.getByRole('button', { name: 'Review download', exact: true }).click();
    await expect(review).toBeVisible();
    fixtureGit(path, ['config', 'lfs.concurrenttransfers', '2']);
    await review.getByRole('button', { name: 'Download and check out', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    expect(requests).toBe(0);
    await dialog.getByRole('button', { name: 'Review download', exact: true }).click();
    await expect(review).toBeVisible();
    await page.screenshot({ path: 'test-results/lfs-download-review.png' });
    await review.getByRole('button', { name: 'Download and check out', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('LFS pull finished');
    await expect(dialog.getByRole('list', { name: 'LFS tracked files' })).toContainText(
      'Full content checked out',
    );
    expect(readFileSync(join(path, 'asset.bin'))).toEqual(content);
    expect(requests).toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling a stalled LFS download preserves its pointer and requires another review', async () => {
  test.skip(!hasLfs, 'Install git-lfs to run native LFS acceptance');
  const { createServer } = await import('node:http');
  let requests = 0;
  const server = createServer(() => {
    requests++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-lfs-cancel-ui-'));
  const path = createFixture(join(root, 'parent'));
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 100\n`;
  writeFileSync(join(path, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(join(path, 'asset.bin'), pointer);
  fixtureGit(path, ['add', '.']);
  fixtureGit(path, ['commit', '-m', 'LFS pointer']);
  fixtureGit(path, ['config', 'lfs.url', `http://127.0.0.1:${address.port}/lfs`]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Git LFS', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git LFS', exact: true });
    await dialog.getByRole('button', { name: 'Review download', exact: true }).click();
    await dialog.getByRole('button', { name: 'Download and check out', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel download', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('LFS download cancelled');
    await expect(dialog.getByRole('alert')).toContainText(
      'Some objects or files may already have changed',
    );
    await expect(dialog.getByRole('group', { name: 'Review LFS download' })).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Review download', exact: true }),
    ).toBeEnabled();
    expect(readFileSync(join(path, 'asset.bin'), 'utf8')).toBe(pointer);
    await dialog.getByRole('button', { name: 'Refresh local state', exact: true }).click();
    await expect(dialog.getByRole('list', { name: 'LFS tracked files' })).toContainText(
      'Object missing locally',
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
