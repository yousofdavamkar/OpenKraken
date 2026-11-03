import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareUpdateRestart } from './src/update-restart.js';

test
  .skipIf(process.platform !== 'linux')
  .each([
    'exited',
    'not-executable',
    'changed-backup',
    'changed-journal',
    'changed-target',
    'unknown-file',
    'confirmed',
    'live-descendant',
    'unconfirmed-running',
  ])(
  'native restart recovery: %s',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-restart-rollback-'));
    const helper = await prepareUpdateRestart(
      root,
      resolve('apps/desktop/dist/helpers/openkraken-askpass'),
    );
    const target = join(root, 'OpenKraken.AppImage');
    const recovery = target + '.openkraken-update';
    await mkdir(join(root, 'updates'), { mode: 0o700 });
    const replacement =
      scenario === 'not-executable'
        ? 'invalid executable bytes'
        : scenario === 'changed-target'
          ? '#!/bin/sh\nprintf changed > "$0"\nexit 9\n'
          : scenario === 'confirmed'
            ? '#!/bin/sh\nrm "$0.openkraken-update/previous.AppImage" "$0.openkraken-update/transaction.json"\nrmdir "$0.openkraken-update"\nexit 0\n'
            : scenario === 'live-descendant'
              ? '#!/bin/sh\nsleep 3 &\nprintf "%s" "$!" > "$0.child"\nexit 9\n'
              : scenario === 'unconfirmed-running'
                ? '#!/bin/sh\nprintf "%s" "$$" > "$0.child"\nexec sleep 62\n'
                : '#!/bin/sh\nexit 9\n';
    const predecessor = '#!/bin/sh\nprintf "%s" "$1" > "$0.restored"\n';
    const journal = JSON.stringify({ fixture: 'retained predecessor' });
    await mkdir(recovery, { mode: 0o700 });
    await writeFile(target, replacement, { mode: 0o700 });
    await writeFile(recovery + '/previous.AppImage', predecessor, { mode: 0o700 });
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
    if (scenario === 'changed-journal') await writeFile(recovery + '/transaction.json', '{}');
    if (scenario === 'unknown-file') await writeFile(recovery + '/unexpected', 'preserve');
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
      else if (output === 'armed\\n') process.stdout.write(String(child.pid), () => process.exit(0));
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
      await expect
        .poll(() => stopped(helperPid), {
          timeout: scenario === 'unconfirmed-running' ? 65000 : 5000,
        })
        .toBe(true);
      if (scenario === 'exited' || scenario === 'not-executable') {
        await expect
          .poll(() => readFile(target + '.restored', 'utf8'))
          .toBe(`--user-data-dir=${root}`);
        expect(await readFile(target, 'utf8')).toBe(predecessor);
        expect(await readFile(recovery + '/transaction.json', 'utf8')).toBe(journal);
        expect(
          JSON.parse(await readFile(join(root, 'updates/rollback-notice.json'), 'utf8')),
        ).toEqual({ schemaVersion: 1, outcome: 'restored' });
      } else {
        await expect(readFile(target + '.restored')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(target, 'utf8')).toBe(
          scenario === 'changed-target' ? 'changed' : replacement,
        );
        if (scenario === 'unknown-file')
          expect(await readFile(recovery + '/unexpected', 'utf8')).toBe('preserve');
        if (scenario === 'unconfirmed-running')
          expect(await stopped(Number(await readFile(target + '.child', 'utf8')))).toBe(false);
      }
    } finally {
      parent.kill('SIGKILL');
      await exited;
      if (['live-descendant', 'unconfirmed-running'].includes(scenario)) {
        const childPid = Number(await readFile(target + '.child', 'utf8'));
        await expect.poll(() => stopped(childPid), { timeout: 70000 }).toBe(true);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);

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
