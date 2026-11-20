import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { releaseVersionSchema } from '../apps/desktop/src/update-protocol.ts';
import { msiVersion } from './msi.mjs';

// Build a disposable future version through the real bundle and installer CLIs.
// Never change the workspace version or relabel an unchanged application ASAR.
const target = process.argv[2] ?? (process.platform === 'win32' ? 'msi' : 'rpm');
assert.ok(
  (process.platform === 'linux' && ['deb', 'rpm'].includes(target)) ||
    (process.platform === 'win32' && process.arch === 'x64' && target === 'msi'),
  'Upgrade fixtures require native Linux deb/rpm or Windows x64 msi',
);
const root = resolve('.');
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const [flag, betaOffset = '1', ...extra] = process.argv.slice(3);
const beta = flag === '--beta';
assert.ok(
  (flag === undefined || beta) && /^[1-9][0-9]{0,9}$/.test(betaOffset) && extra.length === 0,
  'Expected target [--beta [positive revision offset]]',
);
const [base, prerelease] = releaseVersionSchema.parse(source.version).split('-');
const [major, minor] = base.split('.');
const stable = prerelease ? base : `${major}.${Number(minor) + 1}.0`;
const version = beta
  ? `${stable}-beta.${BigInt(prerelease?.slice(5) ?? 0) + BigInt(betaOffset)}`
  : stable;
if (target === 'msi') msiVersion(version);
await mkdir(join(root, 'release'), { recursive: true });
const fixture = await mkdtemp(join(root, 'release/installer-upgrade-'));
await writeFile(join(fixture, 'package.json'), JSON.stringify({ ...source, version }));
// Simulate leftovers from interrupted developer builds and Electron tests.
for (const directory of ['', 'helpers', 'shell-integration', 'node_modules']) {
  const path = join(fixture, 'apps/desktop/dist', directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'stale-release-fixture.cjs'), '// fixture only');
}
await cp(join(root, 'build-resources'), join(fixture, 'build-resources'), { recursive: true });
await symlink(
  join(root, 'node_modules'),
  join(fixture, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);

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
  const sourceCommit = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })
  ).stdout.trim();
  await run('package.mjs');
  const require = createRequire(import.meta.url);
  const { extractFile, listPackage } = createRequire(require.resolve('@electron/packager'))(
    '@electron/asar',
  );
  const archive = join(
    fixture,
    `release/OpenKraken-${process.platform}-${process.arch}/resources/app.asar`,
  );
  const entries = listPackage(archive).map((path) => path.replaceAll('\\', '/'));
  assert.ok(
    !entries.some((path) => path.endsWith('/stale-release-fixture.cjs')),
    'Stale development output in installer payload',
  );
  assert.ok(
    !entries.includes('/dist/tsconfig.tsbuildinfo') && !entries.includes('/dist/types'),
    'Compiler output in installer payload',
  );
  const bundled = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(
    bundled.version,
    version,
    'Bundle must use the release version, not a hard-coded value',
  );
  // Model a failed rebuild that updated staging but left the previous bundle on disk.
  await writeFile(join(fixture, 'package.json'), JSON.stringify(source));
  const staging = join(fixture, 'release/staging');
  await mkdir(staging, { recursive: true });
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify({ ...bundled, version: source.version }),
  );
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [join(root, 'scripts/installers.mjs'), '--test-metadata', '--target', target],
      { cwd: fixture },
    ),
    (error) => {
      assert.match(error.stderr, /Rebuild the platform bundle/);
      return true;
    },
    'An installer must reject a bundle whose embedded version differs from the requested release',
  );
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ ...source, version }));
  await rm(staging, { recursive: true });
  // An installer workspace can have a different checkout or no source history.
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: fixture });
  await run('installers.mjs', ['--test-metadata', '--target', target]);
  const manifestPath = join(
    fixture,
    `release/installers/${process.platform}-${process.arch}/test/${target}/manifest.json`,
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.source?.commit, sourceCommit);
  assert.deepEqual(manifest.source, bundled.openkrakenSource);
  const pointer = JSON.stringify({ fixture, target, version, manifestPath }, null, 2) + '\n';
  // Keep the last-built pointer for local callers; CI consumes per-format
  // pointers so building an RPM cannot replace the Debian upgrade fixture.
  const suffix = !beta ? '' : betaOffset === '1' ? '-beta' : `-beta-${betaOffset}`;
  await writeFile(join(root, `release/installer-upgrade-${target}${suffix}.json`), pointer);
  await writeFile(join(root, 'release/installer-upgrade.json'), pointer);
  console.log(`Verified upgrade fixture version ${version}: ${manifestPath}`);
} catch (error) {
  console.error(`Retained upgrade fixture: ${fixture}`);
  throw error;
}
