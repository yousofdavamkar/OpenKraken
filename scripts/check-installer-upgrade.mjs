import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Build a disposable future version through the real bundle and installer CLIs.
// Never change the workspace version or relabel an unchanged application ASAR.
if (process.platform !== 'linux') throw new Error('Linux installer upgrade fixture requires Linux');
const target = process.argv[2] ?? 'rpm';
assert.ok(['deb', 'rpm'].includes(target), 'Choose deb or rpm');
const root = resolve('.');
await mkdir(join(root, 'release'), { recursive: true });
const fixture = await mkdtemp(join(root, 'release/installer-upgrade-'));
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const parts = source.version.split('.').map(Number);
assert.ok(
  parts.length === 3 && parts.every(Number.isSafeInteger),
  'Use a stable numeric release version',
);
const version = `${parts[0]}.${parts[1] + 1}.0`;
await writeFile(join(fixture, 'package.json'), JSON.stringify({ ...source, version }));
await cp(join(root, 'apps/desktop/dist'), join(fixture, 'apps/desktop/dist'), { recursive: true });
await cp(join(root, 'build-resources'), join(fixture, 'build-resources'), { recursive: true });
await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');

async function run(script, args = []) {
  const child = spawn(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: fixture,
    stdio: 'inherit',
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Fixture ${script} failed: ${code ?? signal}`)),
    );
  });
}
try {
  await run('package.mjs');
  const require = createRequire(import.meta.url);
  const { extractFile } = createRequire(require.resolve('@electron/packager'))('@electron/asar');
  const bundled = JSON.parse(
    extractFile(
      join(fixture, `release/OpenKraken-linux-${process.arch}/resources/app.asar`),
      'package.json',
    ).toString('utf8'),
  );
  assert.equal(
    bundled.version,
    version,
    'Bundle must use the release version, not a hard-coded value',
  );
  await run('installers.mjs', ['--test-metadata', '--target', target]);
  const manifestPath = join(
    fixture,
    `release/installers/linux-${process.arch}/test/${target}/manifest.json`,
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.version, version);
  await writeFile(
    join(root, 'release/installer-upgrade.json'),
    JSON.stringify({ fixture, target, version, manifestPath }, null, 2) + '\n',
  );
  console.log(`Verified upgrade fixture version ${version}: ${manifestPath}`);
} catch (error) {
  console.error(`Retained upgrade fixture: ${fixture}`);
  throw error;
}
