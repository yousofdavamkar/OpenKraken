import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { startGitea } from '../../packages/test-fixtures/src/gitea.js';
import { fixtureProtection } from './provider-fixtures.js';

test('saved-account remote deletion requires confirmation and refuses a changed branch or tag tip', async () => {
  test.skip(
    process.env.OPENKRAKEN_GITEA_TEST !== '1',
    'Enable the isolated Gitea transport fixture',
  );
  test.setTimeout(180000);
  const root = mkdtempSync(join(tmpdir(), 'openkraken-provider-delete-ui-'));
  const source = createFixture(join(root, 'source'));
  const local = createFixture(join(root, 'local'));
  fixtureGit(local, ['branch', 'obsolete']);
  fixtureGit(local, ['tag', '-a', 'obsolete', '-m', 'Local tag remains']);
  const localBranch = fixtureGit(local, ['rev-parse', 'refs/heads/obsolete']);
  const localTag = fixtureGit(local, ['rev-parse', 'refs/tags/obsolete']);
  let remote: Awaited<ReturnType<typeof startGitea>> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    remote = await startGitea(root);
    await remote.push(source);
    await remote.push(source, 'refs/heads/obsolete');
    fixtureGit(source, ['tag', '-a', 'obsolete', '-m', 'Server annotated tag']);
    await remote.push(source, 'refs/tags/obsolete', 'refs/tags/obsolete');
    fixtureGit(local, ['remote', 'set-url', '--push', 'origin', remote.httpsUrl]);
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
    expect(
      (
        await page.evaluate(
          ({ origin, token }) =>
            window.openkraken.request({
              id: crypto.randomUUID(),
              method: 'providerConnect',
              options: { provider: 'github', origin, token },
            }),
          { origin, token: remote.credentials.password },
        )
      ).kind,
    ).toBe('providerAccounts');
    await page.evaluate(() => {
      const events: unknown[] = [];
      Object.assign(window, { providerDeleteEvents: events });
      window.openkraken.subscribe((event) => events.push(event));
    });
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Manage remotes', exact: true }).click();
    const remotes = page.getByRole('dialog', { name: 'Manage remotes', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Delete from remote', exact: true });
    for (const kind of ['heads', 'tags']) {
      const ref = `refs/${kind}/obsolete`;
      await remotes
        .getByRole('button', { name: 'Delete branch or tag from origin', exact: true })
        .click();
      const authentication = dialog.getByLabel('Deletion authentication', { exact: true });
      await authentication.selectOption({ label: `fixture-user · ${origin}` });
      await dialog.getByRole('combobox', { name: 'Ref type', exact: true }).selectOption(kind);
      await dialog.getByLabel('Branch or tag name', { exact: true }).fill('obsolete');
      await dialog.getByRole('button', { name: 'Review deletion', exact: true }).click();
      const reviewed = dialog.getByRole('region', { name: 'Reviewed remote deletion' });
      const original = await remote.tip(ref);
      await expect(reviewed).toContainText(original);
      await expect(reviewed).toContainText(remote.httpsUrl);
      await expect(authentication).toBeDisabled();
      // Closing a review is not confirmation and leaves the server ref intact.
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await remote.tip(ref)).toBe(original);
      await remotes
        .getByRole('button', { name: 'Delete branch or tag from origin', exact: true })
        .click();
      await authentication.selectOption({ label: `fixture-user · ${origin}` });
      await dialog.getByRole('combobox', { name: 'Ref type', exact: true }).selectOption(kind);
      await dialog.getByLabel('Branch or tag name', { exact: true }).fill('obsolete');
      await dialog.getByRole('button', { name: 'Review deletion', exact: true }).click();
      await expect(reviewed).toContainText(original);
      fixtureGit(source, ['commit', '--allow-empty', '-m', `Competing ${kind} update`]);
      // A tag update requires explicit force in the synthetic fixture setup only.
      if (kind === 'tags')
        fixtureGit(source, ['tag', '-f', '-a', 'obsolete', '-m', 'Updated server tag']);
      await remote.push(source, ref, kind === 'tags' ? `+${ref}` : 'HEAD');
      const changed = await remote.tip(ref);
      expect(changed).not.toBe(original);
      await dialog.getByRole('button', { name: 'Delete reviewed remote ref', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('destination changed since review');
      expect(await remote.tip(ref)).toBe(changed);
      await dialog.getByRole('button', { name: 'Review again', exact: true }).click();
      await dialog.getByRole('button', { name: 'Review deletion', exact: true }).click();
      await expect(reviewed).toContainText(changed);
      if (kind === 'tags')
        await page.screenshot({ path: 'test-results/provider-reviewed-deletion.png' });
      await dialog.getByRole('button', { name: 'Delete reviewed remote ref', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('Remote ref deleted');
      expect(await remote.tip(ref)).toBe('');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    expect(fixtureGit(local, ['rev-parse', 'refs/heads/obsolete'])).toBe(localBranch);
    expect(fixtureGit(local, ['rev-parse', 'refs/tags/obsolete'])).toBe(localTag);
    const events = await page.evaluate(() =>
      JSON.stringify(
        (window as typeof window & { providerDeleteEvents: unknown[] }).providerDeleteEvents,
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
