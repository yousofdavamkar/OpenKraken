import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Exercise the shipped launcher as a process, including paths and arguments
// that would expose accidental shell splitting or sandbox flag injection.
const run = promisify(execFile);
const fixture = await mkdtemp(join(tmpdir(), 'openkraken AppDir '));
try {
  await mkdir(join(fixture, 'usr/lib/openkraken'), { recursive: true });
  await cp('build-resources/AppRun', join(fixture, 'AppRun'));
  await writeFile(
    join(fixture, 'usr/lib/openkraken/openkraken'),
    '#!/bin/sh\nprintf "%s\\0" "$PWD" "$@"\nexit 37\n',
    { mode: 0o755 },
  );
  const args = ['one path with spaces', '', '$(touch unexpected)', '--user-data-dir=/tmp/a b'];
  await assert.rejects(
    run(join(fixture, 'AppRun'), args, {
      cwd: resolve('.'),
      env: { ...process.env, APPDIR: '/not-the-application' },
    }),
    (error) => {
      assert.equal(error.code, 37);
      assert.deepEqual(error.stdout.split('\0'), [resolve('.'), ...args, '']);
      return true;
    },
  );
  console.log('AppImage launcher preserves arguments, cwd and exit status without sandbox flags');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
