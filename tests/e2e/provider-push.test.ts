import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { startGitea } from '../../packages/test-fixtures/src/gitea.js';
import { fixtureProtection } from './provider-fixtures.js';

test('saved-account HTTPS push preserves review, non-fast-forward rejection and force-with-lease', async () => {
  test.skip(
    process.env.OPENKRAKEN_GITEA_TEST !== '1',
    'Enable the isolated Gitea transport fixture',
  );
  test.setTimeout(180000);
  const root = mkdtempSync(join(tmpdir(), 'openkraken-provider-push-ui-'));
  const source = createFixture(join(root, 'source'));
  const local = createFixture(join(root, 'local'));
  let remote: Awaited<ReturnType<typeof startGitea>> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    remote = await startGitea(root);
    await remote.push(source);
    fixtureGit(local, ['remote', 'set-url', 'origin', remote.httpsUrl]);
    fixtureGit(local, ['commit', '--allow-empty', '-m', 'Saved-account push']);
    const firstTip = fixtureGit(local, ['rev-parse', 'HEAD']);
    app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env: remote.environment,
    });
    await fixtureProtection(app);
    const origin = new URL(remote.httpsUrl).origin;
    await app.evaluate(
      ({ session, dialog }, { origin, local, credentials }) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [local] });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          if (
            String(input) !== `${origin}/api/v3/user` ||
            new Headers(init?.headers).get('authorization') !== `token ${credentials.password}`
          )
            throw new Error('Unexpected provider request');
          return new Response(JSON.stringify({ id: 321, login: credentials.username }), {
            headers: { 'content-type': 'application/json' },
          });
        };
      },
      { origin, local, credentials: remote.credentials },
    );
    const page = await app.firstWindow();
    const connected = await page.evaluate(
      ({ origin, token }) =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'providerConnect',
          options: { provider: 'github', origin, token },
        }),
      { origin, token: remote.credentials.password },
    );
    expect(connected.kind).toBe('providerAccounts');
    await page.evaluate(() => {
      const events: unknown[] = [];
      Object.assign(window, { providerPushEvents: events });
      window.openkraken.subscribe((event) => events.push(event));
    });
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    const push = page.getByRole('dialog', { name: 'Push to remote', exact: true });
    const authentication = push.getByLabel('Push authentication', { exact: true });
    await authentication.selectOption({ label: `fixture-user · ${origin}` });
    await push.getByRole('button', { name: 'Review push', exact: true }).click();
    await expect(push.getByRole('region', { name: 'Reviewed push' })).toContainText(
      remote.httpsUrl,
    );
    await expect(authentication).toBeDisabled();
    await push.getByRole('checkbox', { name: 'Set upstream after push' }).check();
    await push.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await expect(push.getByRole('status')).toHaveText('Push completed');
    expect(await remote.tip()).toBe(firstTip);
    expect(fixtureGit(local, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/main');
    fixtureGit(source, ['fetch', local, 'main']);
    fixtureGit(source, ['reset', '--hard', 'FETCH_HEAD']);
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Remote competitor']);
    await remote.push(source);
    fixtureGit(local, ['commit', '--allow-empty', '-m', 'Local divergent tip']);
    const localTip = fixtureGit(local, ['rev-parse', 'HEAD']);
    await push.getByRole('button', { name: 'Review again', exact: true }).click();
    await push.getByRole('button', { name: 'Review push', exact: true }).click();
    await push.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await expect(push.getByRole('alert')).toContainText('Push rejected by the server');
    expect(await remote.tip()).toBe(fixtureGit(source, ['rev-parse', 'HEAD']));
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Remote changed after review']);
    await remote.push(source);
    await push
      .getByRole('checkbox', { name: 'Replace remote history with force-with-lease' })
      .check();
    await push.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await expect(push.getByRole('alert')).toContainText('destination changed since review');
    expect(await remote.tip()).toBe(fixtureGit(source, ['rev-parse', 'HEAD']));
    await push.getByRole('button', { name: 'Review again', exact: true }).click();
    await push.getByRole('button', { name: 'Review push', exact: true }).click();
    await push
      .getByRole('checkbox', { name: 'Replace remote history with force-with-lease' })
      .check();
    await page.screenshot({ path: 'test-results/provider-reviewed-push.png' });
    await push.getByRole('button', { name: 'Push reviewed tip', exact: true }).click();
    await expect(push.getByRole('status')).toHaveText('Push completed');
    expect(await remote.tip()).toBe(localTip);
    const events = await page.evaluate(() =>
      JSON.stringify(
        (window as typeof window & { providerPushEvents: unknown[] }).providerPushEvents,
      ),
    );
    expect(events).not.toContain('authenticationPrompt');
    expect(events).not.toContain(remote.credentials.password);
    expect(readFileSync(join(local, '.git/config'), 'utf8')).not.toContain(
      remote.credentials.password,
    );
  } finally {
    await app?.close();
    await remote?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
