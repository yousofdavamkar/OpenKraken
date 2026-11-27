// Run under X11 after pnpm package. Each phase gets its own D-Bus session and keyring daemon.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium, expect } from '@playwright/test';

async function connect(child) {
  for await (const line of createInterface({ input: child.stderr })) {
    const endpoint = /DevTools listening on (ws:\/\/.*)/.exec(line);
    if (endpoint) return chromium.connectOverCDP(endpoint[1], { timeout: 15000 });
  }
  throw new Error('Packaged desktop exited before opening its debugging endpoint');
}

async function phase(mode, root) {
  assert.equal(process.env.XDG_DATA_HOME, join(root, mode === 'foreign' ? 'other-data' : 'data'));
  assert.equal(process.env.XDG_RUNTIME_DIR, join(root, 'runtime'));
  const daemon = spawn(
    'gnome-keyring-daemon',
    [
      '--foreground',
      '--unlock',
      '--components=secrets',
      '--control-directory=' + join(root, 'control'),
    ],
    { stdio: ['inherit', 'ignore', 'inherit'], timeout: 55000, killSignal: 'SIGKILL' },
  );
  const daemonExit = once(daemon, 'exit');
  let app, appExit, browser;
  try {
    execFileSync('gdbus', ['wait', '--session', '--timeout', '10', 'org.freedesktop.secrets']);
    const owner = execFileSync(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.GetConnectionUnixProcessID',
        'org.freedesktop.secrets',
      ],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(
      owner,
      '(uint32 ' + daemon.pid + ',)',
      'Secret Service must be owned by the fixture daemon',
    );
    const profile = join(root, 'profile');
    const account = {
      provider: 'github',
      origin: 'https://github.com',
      providerUserId: '42',
      login: 'fixture',
    };
    const accountId = createHash('sha256')
      .update(JSON.stringify([account.provider, account.origin, account.providerUserId]))
      .digest('hex');
    if (mode === 'write')
      await writeFile(
        join(profile, 'provider-accounts.json'),
        JSON.stringify([{ ...account, id: accountId }]),
        { mode: 0o600 },
      );
    app = spawn(
      resolve('release/OpenKraken-linux-' + process.arch + '/openkraken'),
      [
        '--password-store=gnome-libsecret',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 45000, killSignal: 'SIGKILL' },
    );
    appExit = once(app, 'exit');
    browser = await connect(app);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).waitFor();
    const scope = { accountId, repository: { owner: 'team', name: 'project' }, number: 17 };
    const message = 'Private fixture merge message ' + accountId;
    if (mode === 'write') {
      const result = await page.evaluate(
        async ({ scope, message }) => {
          const reply = await window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'mergeDraftSave',
            scope,
            revision: null,
            draft: {
              provider: 'github',
              method: 'merge',
              defaults: false,
              title: 'Private subject',
              message,
              uncertain: true,
            },
          });
          return reply.kind;
        },
        { scope, message },
      );
      assert.equal(
        result,
        'mergeDraft',
        'Packaged desktop must save using available OS protection',
      );
      const folder = join(profile, 'provider-merge-drafts', accountId);
      const files = await readdir(folder);
      assert.equal(files.length, 1);
      const record = JSON.parse(await readFile(join(folder, files[0]), 'utf8'));
      assert.equal(Buffer.from(record.draft, 'base64').includes(Buffer.from(message)), false);
    } else {
      await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
      await page.getByRole('button', { name: 'Saved merge drafts' }).click();
      if (mode === 'foreign') {
        await expect(page.getByText('Some saved merge drafts could not be read.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'team/project #17' })).toHaveCount(0);
        return;
      }
      await page.getByRole('button', { name: 'team/project #17' }).click();
      await expect(page.getByLabel('Saved merge message')).toHaveText(message);
      await expect(page.getByText(/may have received this merge/)).toBeVisible();
      await page.getByRole('button', { name: 'Discard saved merge draft' }).click();
      await page.getByRole('button', { name: 'Confirm discard' }).click();
      await expect(page.getByText('No saved merge drafts for this account.')).toBeVisible();
    }
  } finally {
    await browser?.close();
    if (app && app.exitCode === null && app.signalCode === null) app.kill();
    if (appExit) await appExit;
    daemon.kill();
    await daemonExit;
  }
}

assert.equal(process.platform, 'linux');
const [mode, root] = process.argv.slice(2);
if (['read', 'write', 'foreign'].includes(mode)) await phase(mode, root);
else {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-private-keyring-'));
  try {
    for (const name of ['data', 'other-data', 'config', 'runtime', 'control', 'profile'])
      await mkdir(join(directory, name), { mode: 0o700 });
    const env = {
      ...process.env,
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_RUNTIME_DIR: join(directory, 'runtime'),
      XDG_CURRENT_DESKTOP: 'GNOME',
    };
    for (const key of [
      'DBUS_SESSION_BUS_ADDRESS',
      'DBUS_STARTER_ADDRESS',
      'DBUS_STARTER_BUS_TYPE',
      'GNOME_KEYRING_CONTROL',
      'SSH_AUTH_SOCK',
    ])
      delete env[key];
    const password = randomBytes(32).toString('hex');
    for (const action of ['write', 'foreign', 'read']) {
      const run = spawnSync(
        'dbus-run-session',
        ['--', process.execPath, import.meta.filename, action, directory],
        {
          env: {
            ...env,
            XDG_DATA_HOME: join(directory, action === 'foreign' ? 'other-data' : 'data'),
          },
          input: password,
          stdio: ['pipe', 'inherit', 'inherit'],
          timeout: 60000,
        },
      );
      if (run.error) throw run.error;
      assert.equal(run.status, 0, 'Private keyring ' + action + ' phase failed');
    }
    console.log(
      'Packaged Linux desktop recovered and discarded a protected merge draft after both the app and its private GNOME keyring restarted.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
