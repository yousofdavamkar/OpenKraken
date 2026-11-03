import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildAppImage } from './appimage.mjs';
import { sha256 } from './package-security.mjs';
import { stat } from 'node:fs/promises';
import {
  stageAppImageUpdate,
  recoverAppImageUpdate,
  rollbackAppImageUpdate,
} from '../apps/desktop/src/appimage-install.ts';

if (process.platform !== 'linux') throw new Error('This acceptance check requires Linux');
await mkdir('release', { recursive: true });
const root = await mkdtemp(resolve('release/appimage-update-check-'));
const live = new Set();
function launch(target, args, env) {
  const child = spawn(target, args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  live.add(child);
  const timeout = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 20000);
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      live.delete(child);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      live.delete(child);
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Fixture exit ${code ?? signal}: ${stderr}`));
    });
  });
  // Retain failure for the owner while avoiding an unhandled rejection during staging.
  void exited.catch(() => {});
  return { child, exited };
}
async function readWhenReady(path) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('AppImage fixture did not report readiness');
}
try {
  const artifacts = [];
  for (const version of ['0.1.0', '0.2.0']) {
    const bundle = join(root, version, 'bundle');
    const work = join(root, version, 'work');
    await mkdir(bundle, { recursive: true });
    await mkdir(work);
    await writeFile(join(bundle, 'version'), version);
    await writeFile(
      join(bundle, 'openkraken'),
      `#!/bin/sh
set -eu
directory=$(dirname -- "$(readlink -f -- "$0")")
if [ "$1" = hold ]; then
  cat "$directory/version" > "$2/ready"
  while [ ! -f "$2/release" ]; do sleep 0.02; done
  cat "$directory/version" > "$2/old-after-replacement"
else
  cat "$directory/version" > "$2/new-started"
fi
`,
      { mode: 0o755 },
    );
    const result = await buildAppImage(bundle, work, `OpenKraken-${version}.AppImage`, {
      version,
      testOnly: true,
    });
    artifacts.push(result.artifact);
  }
  for (const extract of [false, true]) {
    const profile = join(root, extract ? 'extract' : 'fuse');
    await mkdir(profile, { mode: 0o700 });
    const target = join(profile, 'My OpenKraken.AppImage');
    await cp(artifacts[0], target);
    const env = { ...process.env, TMPDIR: profile };
    delete env.APPIMAGE;
    delete env.APPDIR;
    delete env.ARGV0;
    if (extract) env.APPIMAGE_EXTRACT_AND_RUN = '1';
    else delete env.APPIMAGE_EXTRACT_AND_RUN;
    const running = launch(target, ['hold', profile], env);
    assert.equal(await readWhenReady(join(profile, 'ready')), '0.1.0');
    const staged = await stageAppImageUpdate(
      {
        target,
        source: artifacts[1],
        arch: process.arch,
        artifact: { size: (await stat(artifacts[1])).size, sha256: await sha256(artifacts[1]) },
        version: '0.2.0',
      },
      new AbortController().signal,
    );
    await staged.commit();
    const replacement = launch(target, ['report', profile], env);
    await replacement.exited;
    assert.equal(await readWhenReady(join(profile, 'new-started')), '0.2.0');
    await writeFile(join(profile, 'release'), '');
    await running.exited;
    assert.equal(await readFile(join(profile, 'old-after-replacement'), 'utf8'), '0.1.0');
    await rollbackAppImageUpdate(target);
    await launch(target, ['report', profile], env).exited;
    assert.equal(await readFile(join(profile, 'new-started'), 'utf8'), '0.1.0');
    const retry = await stageAppImageUpdate(
      {
        target,
        source: artifacts[1],
        arch: process.arch,
        artifact: { size: (await stat(artifacts[1])).size, sha256: await sha256(artifacts[1]) },
        version: '0.2.0',
      },
      new AbortController().signal,
    );
    await retry.commit();
    await launch(target, ['report', profile], env).exited;
    assert.equal(await readFile(join(profile, 'new-started'), 'utf8'), '0.2.0');
    assert.equal(await recoverAppImageUpdate(target, '0.2.0'), 'confirmed');
    assert.equal(await recoverAppImageUpdate(target, '0.2.0'), 'none');
    console.log(
      `AppImage ${extract ? 'extract-and-run' : 'FUSE'}: old process retained old files, replacement and rollback launched, retry confirmed.`,
    );
  }
} finally {
  for (const child of live) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
