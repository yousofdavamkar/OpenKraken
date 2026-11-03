import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareUpdateRestart } from './src/update-restart.js';

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
