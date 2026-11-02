import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { authenticatedRemote } from '../../packages/test-fixtures/src/authenticated-remote.js';
import { fixtureProtection } from './provider-fixtures.js';

test('saved-account pull reviews the upstream, refuses changes during validation and preserves Undo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-provider-pull-ui-'));
  const source = createFixture(join(root, 'source'));
  writeFileSync(join(source, 'incoming.txt'), 'Provider pull content\n');
  fixtureGit(source, ['add', 'incoming.txt']);
  fixtureGit(source, ['commit', '-m', 'Incoming provider change']);
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const remote = await authenticatedRemote(bare, {
    basePath: '/team/project.git',
    password: 'fixture-provider-secret',
  });
  const local = createFixture(join(root, 'local'));
  const initial = fixtureGit(local, ['rev-parse', 'HEAD']);
  fixtureGit(local, ['remote', 'set-url', 'origin', remote.url]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: {
      ...process.env,
      GIT_SSL_CAINFO: remote.certificate,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  try {
    await fixtureProtection(app);
    const origin = new URL(remote.url).origin;
    await app.evaluate(
      ({ session, dialog }, { origin, local }) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [local] });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          if (
            String(input) !== `${origin}/api/v3/user` ||
            new Headers(init?.headers).get('authorization') !== 'token fixture-provider-secret'
          )
            throw new Error('Unexpected provider request');
          return new Response(JSON.stringify({ id: 321, login: 'fixture-user' }), {
            headers: { 'content-type': 'application/json' },
          });
        };
      },
      { origin, local },
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
      Object.assign(window, { providerPullEvents: events });
      window.openkraken.subscribe((event) => events.push(event));
    });
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Pull upstream', exact: true });
    const authentication = dialog.getByLabel('Pull authentication', { exact: true });
    await authentication.selectOption({ label: `fixture-user · ${origin}` });
    await dialog.getByRole('button', { name: 'Review pull', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Reviewed pull' })).toContainText(remote.url);
    await expect(dialog.getByRole('region', { name: 'Reviewed pull' })).toContainText(
      'refs/remotes/origin/main',
    );
    await expect(authentication).toBeDisabled();
    expect(remote.requests()).toBe(0);
    await app.evaluate(({ session }) => {
      const partition = session.fromPartition('openkraken-providers');
      const original = partition.fetch;
      Object.assign(globalThis, { pullValidationStarted: false });
      partition.fetch = async (input, init) => {
        Object.assign(globalThis, { pullValidationStarted: true });
        await new Promise<void>((resolve) =>
          Object.assign(globalThis, { releasePullValidation: resolve }),
        );
        partition.fetch = original;
        return original(input, init);
      };
    });
    await dialog.getByRole('button', { name: 'Fetch reviewed upstream', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { pullValidationStarted: boolean })
              .pullValidationStarted,
        ),
      )
      .toBe(true);
    fixtureGit(local, ['config', 'branch.main.merge', 'refs/heads/feature']);
    await app.evaluate(() =>
      (
        globalThis as typeof globalThis & { releasePullValidation: () => void }
      ).releasePullValidation(),
    );
    await expect(dialog.getByRole('alert')).toContainText(
      'remote configuration or tracking refs changed',
    );
    expect(remote.requests()).toBe(0);
    expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(initial);
    fixtureGit(local, ['config', 'branch.main.merge', 'refs/heads/main']);
    await dialog.getByRole('button', { name: 'Review again', exact: true }).click();
    await dialog.getByRole('button', { name: 'Review pull', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Reviewed pull' })).toContainText(
      'refs/remotes/origin/main',
    );
    await expect(
      dialog.getByRole('button', { name: 'Fetch reviewed upstream', exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: 'test-results/provider-reviewed-pull.png' });
    await dialog.getByRole('button', { name: 'Fetch reviewed upstream', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Pull completed');
    expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    expect(readFileSync(join(local, 'incoming.txt'), 'utf8')).toBe('Provider pull content\n');
    const events = await page.evaluate(() =>
      JSON.stringify(
        (window as typeof window & { providerPullEvents: unknown[] }).providerPullEvents,
      ),
    );
    expect(events).not.toContain('authenticationPrompt');
    expect(events).not.toContain(remote.credentials.password);
    expect(readFileSync(join(local, '.git/config'), 'utf8')).not.toContain(
      remote.credentials.password,
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    expect(fixtureGit(local, ['rev-parse', 'HEAD'])).toBe(initial);
  } finally {
    await app.close();
    await remote.close();
    rmSync(root, { recursive: true, force: true });
  }
});
