import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  prepareUpdateRestart,
  prepareUpdateLaunch,
  type InstalledUpdate,
} from './src/update-restart.js';

test.skipIf(process.platform !== 'linux')(
  'restart preparation proves helper readiness and can be cancelled before shutdown',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-restart-preflight-'));
    const helper = await prepareUpdateRestart(
      root,
      resolve('apps/desktop/dist/helpers/openkraken-askpass'),
    );
    const target = join(root, 'image');
    const bytes = '#!/bin/sh\nprintf launched > "$0.started"\n';
    await writeFile(target, bytes, { mode: 0o700 });
    const plan: InstalledUpdate = {
      target,
      size: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      recovery: { previous: { sha256: '0'.repeat(64), size: 64 }, journalSha256: '0'.repeat(64) },
    };
    const launches: Awaited<ReturnType<typeof prepareUpdateLaunch>>[] = [];
    try {
      await expect(prepareUpdateLaunch(helper + '.missing', plan, root)).rejects.toThrow('helper');
      const ready = await prepareUpdateLaunch(helper, plan, root);
      launches.push(ready);
      await expect(readFile(target + '.started')).rejects.toMatchObject({ code: 'ENOENT' });
      await ready.cancel();
      await expect(ready.arm()).rejects.toThrow();
      const controller = new AbortController();
      const abortable = await prepareUpdateLaunch(helper, plan, root, controller.signal);
      launches.push(abortable);
      controller.abort();
      await expect(abortable.arm()).rejects.toThrow('cancelled');
      await abortable.cancel();
      await expect(prepareUpdateLaunch(helper, plan, root, controller.signal)).rejects.toThrow(
        'cancelled',
      );
      const armed = await prepareUpdateLaunch(helper, plan, root);
      launches.push(armed);
      await armed.arm();
      await expect(readFile(target + '.started')).rejects.toMatchObject({ code: 'ENOENT' });
      await armed.cancel();
      expect(await readFile(target, 'utf8')).toBe(bytes);
    } finally {
      await Promise.all(launches.map((launch) => launch.cancel()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'linux').each(['silent', 'malformed', 'unarmed', 'exited'])(
  'restart preparation stops a %s helper without launching an application',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-restart-protocol-'));
    const helper = join(root, 'helper');
    const output = scenario === 'malformed' ? 'invalid' : scenario !== 'silent' ? 'ready\\n' : '';
    await writeFile(
      helper,
      `#!/bin/sh\nprintf '%s' "$$" > "$0.pid"\nprintf '${output}'\n${scenario === 'exited' ? 'exit 1' : 'exec sleep 5'}\n`,
      { mode: 0o700 },
    );
    const plan: InstalledUpdate = {
      target: join(root, 'untouched'),
      size: 64,
      sha256: '0'.repeat(64),
      recovery: { previous: { size: 64, sha256: '0'.repeat(64) }, journalSha256: '0'.repeat(64) },
    };
    try {
      if (scenario === 'unarmed' || scenario === 'exited') {
        const ready = await prepareUpdateLaunch(helper, plan, root);
        try {
          if (scenario === 'exited') {
            const pid = Number(await readFile(helper + '.pid', 'utf8'));
            await expect.poll(() => stopped(pid)).toBe(true);
            await expect(ready.arm()).rejects.toThrow('helper');
          } else await expect(ready.arm()).rejects.toThrow('did not arm');
        } finally {
          await ready.cancel();
        }
      } else {
        await expect(prepareUpdateLaunch(helper, plan, root)).rejects.toThrow(
          scenario === 'silent' ? 'did not become ready' : 'Invalid restart helper response',
        );
      }
      const pid = Number(await readFile(helper + '.pid', 'utf8'));
      await expect.poll(() => stopped(pid)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test
  .skipIf(process.platform !== 'linux')
  .for([
    'exited',
    'not-executable',
    'rollback-sync-error',
    'before-rename',
    'before-rename-changed-stage',
    'before-rename-copied-backup',
    'before-rename-extra-link',
    'before-rename-unknown-file',
    'before-rename-changed-journal',
    'changed-backup',
    'changed-journal',
    'changed-target',
    'unknown-file',
    'confirmed',
    'live-descendant',
    'delayed-descendant',
    'unconfirmed-running',
    'confirmed-after-deadline',
    'replaced-transaction',
    'changed-after-arming',
  ])('native restart recovery: %s', { timeout: 90000 }, async (scenario, context) => {
  const syncError = scenario === 'rollback-sync-error';
  if (syncError && process.getuid?.() === 0) context.skip('Root can open a mode-0300 directory');
  const root = await mkdtemp(join(tmpdir(), 'openkraken-restart-rollback-'));
  const helper = await prepareUpdateRestart(
    root,
    resolve('apps/desktop/dist/helpers/openkraken-askpass'),
  );
  const imageDirectory = join(root, 'install');
  await mkdir(imageDirectory, { mode: 0o700 });
  const target = join(imageDirectory, 'OpenKraken.AppImage');
  const recovery = target + '.openkraken-update';
  await mkdir(join(root, 'updates'), { mode: 0o700 });
  const lateExit = ['unconfirmed-running', 'live-descendant', 'confirmed-after-deadline'].includes(
    scenario,
  );
  const waitForRelease = 'while [ ! -e "$0.release" ]; do sleep 0.1; done';
  const markLauncher = 'printf "%s" "$$" > "$0.child"';
  const confirm =
    'rm "$0.openkraken-update/previous.AppImage" "$0.openkraken-update/transaction.json"\nrmdir "$0.openkraken-update"';
  const descendant = (command: string) => `( ${command} ) &\nprintf "%s" "$!" > "$0.child"\nexit 9`;
  const scripts: Record<string, string> = {
    'changed-after-arming': 'printf launched > "$0.started"\nexit 9',
    'changed-target': 'printf changed > "$0"\nexit 9',
    'replaced-transaction':
      'mv "$0.openkraken-update" "$0.old"\nmkdir -m 700 "$0.openkraken-update"\ncp -p "$0.old/"* "$0.openkraken-update/"\nexit 9',
    'confirmed-after-deadline': [markLauncher, waitForRelease, confirm].join('\n'),
    confirmed: confirm,
    'live-descendant': descendant(waitForRelease),
    'delayed-descendant': descendant('sleep 3'),
    'unconfirmed-running': [markLauncher, waitForRelease, 'exit 9'].join('\n'),
  };
  const replacement =
    scenario === 'not-executable'
      ? 'invalid executable bytes'
      : `#!/bin/sh\n${scripts[scenario] ?? 'exit 9'}\n`;
  const predecessor = '#!/bin/sh\nprintf "%s" "$1" > "$0.restored"\n';
  const journal = JSON.stringify({ fixture: 'retained predecessor' });
  await mkdir(recovery, { mode: 0o700 });
  const beforeRename = scenario.startsWith('before-rename');
  await writeFile(target, beforeRename ? predecessor : replacement, { mode: 0o700 });
  const backup = recovery + '/previous.AppImage';
  if (beforeRename) {
    await writeFile(
      recovery + '/next.AppImage',
      scenario === 'before-rename-changed-stage' ? 'altered' : replacement,
      { mode: 0o700 },
    );
    if (scenario === 'before-rename-copied-backup') {
      // Both inodes have the expected bytes and link count, but differ in identity.
      await writeFile(backup, predecessor, { mode: 0o700 });
      await link(target, target + '.second');
      await link(backup, target + '.second-backup');
    } else await link(target, backup);
    if (scenario === 'before-rename-extra-link') await link(target, target + '.extra');
  } else await writeFile(backup, predecessor, { mode: 0o700 });
  await writeFile(recovery + '/transaction.json', journal, { mode: 0o600 });
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const args = [
    target,
    root,
    digest(replacement),
    String(Buffer.byteLength(replacement)),
    digest(predecessor),
    String(Buffer.byteLength(predecessor)),
    digest(journal),
  ];
  if (scenario === 'changed-backup') await writeFile(recovery + '/previous.AppImage', 'changed');
  if (scenario.endsWith('changed-journal')) await writeFile(recovery + '/transaction.json', '{}');
  if (scenario.endsWith('unknown-file')) await writeFile(recovery + '/unexpected', 'preserve');
  if (syncError) {
    await chmod(imageDirectory, 0o300);
    // The rename is allowed, but opening the parent directory for fsync fails.
    await expect(open(imageDirectory, 'r')).rejects.toMatchObject({ code: 'EACCES' });
  }
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `
    const child = require('node:child_process').spawn(${JSON.stringify(helper)},
      ['--relaunch', String(process.pid), ...${JSON.stringify(args)}], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
      if (output === 'ready\\n') { output = ''; child.stdin.end('launch\\n'); }
      else if (output === 'armed\\n') {
        if (${scenario === 'changed-after-arming'}) {
          const fs = require('node:fs');
          const folder = ${JSON.stringify(recovery)};
          fs.renameSync(folder, folder + '.original');
          fs.cpSync(folder + '.original', folder, {recursive: true, preserveTimestamps: true});
        }
        process.stdout.write(String(child.pid), () => process.exit(0));
      }
    });
    child.once('exit', () => process.exit(2));
    child.once('error', () => process.exit(3));
  `,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  parent.stdout.on('data', (data) => {
    output += data;
  });
  const exited = new Promise<number | null>((resolve) => parent.once('exit', resolve));
  try {
    expect(await exited).toBe(0);
    const helperPid = Number(output);
    expect(helperPid).toBeGreaterThan(1);
    if (lateExit) {
      await expect.poll(() => readFile(target + '.child', 'utf8')).toMatch(/^\d+$/);
      const childPid = Number(await readFile(target + '.child', 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 61000));
      expect(await stopped(childPid)).toBe(false);
      expect(await readFile(target, 'utf8')).toBe(replacement);
      expect(await readFile(backup, 'utf8')).toBe(predecessor);
      await expect(readFile(target + '.restored')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await stopped(helperPid)).toBe(false);
      await writeFile(target + '.release', '');
    }
    await expect.poll(() => stopped(helperPid), { timeout: 10000 }).toBe(true);
    if (beforeRename) {
      if (scenario === 'before-rename') {
        await expect
          .poll(() => readFile(target + '.restored', 'utf8'))
          .toBe(`--user-data-dir=${root}`);
      } else {
        await expect(readFile(target + '.restored')).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(target, 'utf8')).toBe(predecessor);
      expect(await readFile(backup, 'utf8')).toBe(predecessor);
      expect(await readFile(recovery + '/next.AppImage', 'utf8')).toBe(
        scenario === 'before-rename-changed-stage' ? 'altered' : replacement,
      );
      await expect(readFile(join(root, 'updates/rollback-notice.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } else if (
      [
        'exited',
        'not-executable',
        'delayed-descendant',
        'live-descendant',
        'unconfirmed-running',
        'rollback-sync-error',
      ].includes(scenario)
    ) {
      expect(await readFile(target, 'utf8')).toBe(predecessor);
      await expect
        .poll(() => readFile(target + '.restored', 'utf8'))
        .toBe(`--user-data-dir=${root}`);
      expect(await readFile(recovery + '/transaction.json', 'utf8')).toBe(journal);
      expect(
        JSON.parse(await readFile(join(root, 'updates/rollback-notice.json'), 'utf8')),
      ).toEqual({ schemaVersion: 1, outcome: 'restored' });
    } else {
      await expect(readFile(target + '.restored')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(target, 'utf8')).toBe(
        scenario === 'changed-target' ? 'changed' : replacement,
      );
      if (scenario.endsWith('unknown-file'))
        expect(await readFile(recovery + '/unexpected', 'utf8')).toBe('preserve');
      if (scenario === 'changed-after-arming')
        await expect(readFile(target + '.started')).rejects.toMatchObject({ code: 'ENOENT' });
      if (['replaced-transaction', 'changed-after-arming'].includes(scenario))
        expect(await readFile(backup, 'utf8')).toBe(predecessor);
      if (scenario === 'confirmed-after-deadline')
        await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    parent.kill('SIGKILL');
    await exited;
    if (lateExit) await writeFile(target + '.release', '');
    if (lateExit || scenario === 'delayed-descendant') {
      const childPid = Number(await readFile(target + '.child', 'utf8'));
      await expect.poll(() => stopped(childPid), { timeout: 70000 }).toBe(true);
    }
    if (syncError) await chmod(imageDirectory, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

async function stopped(pid: number) {
  try {
    return /\) [ZXx] /.test(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

test.skipIf(process.platform !== 'linux')(
  'native restart waits for its parent and rechecks executable bytes before launch',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-native-restart-'));
    const helper = await prepareUpdateRestart(
      root,
      resolve('apps/desktop/dist/helpers/openkraken-askpass'),
    );
    const script = '#!/bin/sh\nprintf "%s" "$1" > "$0.started"\n';
    try {
      for (const tamper of [false, true]) {
        const target = join(root, tamper ? 'altered' : 'valid');
        await writeFile(target, script, { mode: 0o700 });
        const args = [
          target,
          root,
          createHash('sha256').update(script).digest('hex'),
          String(Buffer.byteLength(script)),
          '0'.repeat(64),
          '64',
          '0'.repeat(64),
        ];
        const parent = spawn(
          process.execPath,
          [
            '-e',
            `
        const child = require('node:child_process').spawn(${JSON.stringify(helper)},
          ['--relaunch', String(process.pid), ...${JSON.stringify(args)}], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
        let pending = '';
        child.stdout.on('data', (data) => {
          pending += data;
          if (pending === 'ready\\n') { pending = ''; child.stdin.end('launch\\n'); }
          else if (pending === 'armed\\n') { process.stdout.write(String(child.pid) + '\\n'); }
        });
        child.once('error', () => process.exit(2));
        child.once('exit', (code) => { if (code) process.exit(3); });
        process.stdin.on('data', () => process.exit(0));
      `,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const exited = new Promise<number | null>((resolve) => parent.once('exit', resolve));
        try {
          const pid = await new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Native helper did not arm')), 5000);
            parent.stdout.once('data', (data) => {
              clearTimeout(timeout);
              resolve(Number(String(data).trim()));
            });
            parent.once('exit', () => {
              clearTimeout(timeout);
              reject(new Error('Native parent exited early'));
            });
          });
          expect(pid).toBeGreaterThan(1);
          await expect(readFile(target + '.started')).rejects.toMatchObject({ code: 'ENOENT' });
          if (tamper) await writeFile(target, script.replace('printf', 'printf '));
          parent.stdin.end('exit\n');
          expect(await exited).toBe(0);
          await expect
            .poll(async () => {
              try {
                return /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'));
              } catch {
                return true;
              }
            })
            .toBe(true);
          if (tamper)
            await expect(readFile(target + '.started')).rejects.toMatchObject({ code: 'ENOENT' });
          else
            await expect
              .poll(() => readFile(target + '.started', 'utf8'))
              .toBe(`--user-data-dir=${root}`);
        } finally {
          parent.kill('SIGKILL');
          await exited;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
