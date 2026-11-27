import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertDisposableWindows,
  assertEmptyMsiState,
  assertInstalledMsiState,
  assertMsiSmokeProfile,
  assertMsiUpgradePair,
  assertRemovedMsiState,
} from './msi-lifecycle.mjs';
import { msiUpgradeCode, readMsiMetadata, verifyMsiMetadata } from './msi.mjs';
import { comparePayload, payloadManifest, sha256, verifyFuses } from './package-security.mjs';

// Opt-in must be checked before reading artifacts, creating files or invoking MSI.
// This gate is only for our locally built test artifacts on an empty hosted VM.
assertDisposableWindows();
assert.ok(process.env.SystemRoot && isAbsolute(process.env.SystemRoot));
assert.ok(process.argv.length >= 4, 'Provide MSI manifests in increasing release order');
const run = promisify(execFile);
const system32 = join(process.env.SystemRoot, 'System32');
const powershell = join(system32, 'WindowsPowerShell/v1.0/powershell.exe');
const scriptPath = (name) => fileURLToPath(new URL(name, import.meta.url));
const require = createRequire(import.meta.url);
const { extractFile } = createRequire(require.resolve('@electron/packager'))('@electron/asar');

async function readArtifact(path) {
  const manifestPath = resolve(path);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(
    manifest.schemaVersion === 1 &&
      manifest.target === 'msi' &&
      manifest.platform === 'win32' &&
      manifest.arch === 'x64' &&
      manifest.metadataMode === 'test-only' &&
      manifest.signed === false &&
      typeof manifest.artifact?.file === 'string' &&
      manifest.artifact.file === basename(manifest.artifact.file) &&
      manifest.artifact.file.endsWith('.msi'),
    'MSI lifecycle accepts native test-only unsigned manifests',
  );
  const artifact = join(dirname(manifestPath), manifest.artifact.file);
  assert.equal((await stat(artifact)).size, manifest.artifact.size);
  assert.equal(await sha256(artifact), manifest.artifact.sha256);
  const metadata = await readMsiMetadata(artifact);
  verifyMsiMetadata(metadata, manifest);
  const main = metadata.files.find((entry) => entry.id === 'mainExecutable');
  const component = metadata.components.find((entry) => entry.id === main.component);
  assert.equal(component?.keyPath, 'mainExecutable');
  assert.match(component.guid, /^\{[A-F0-9]{8}-(?:[A-F0-9]{4}-){3}[A-F0-9]{12}\}$/i);
  return {
    manifest,
    artifact,
    version: manifest.version,
    productCode: metadata.properties.ProductCode,
    componentCode: component.guid,
    asarSha256: manifest.payload['resources/app.asar']?.sha256,
  };
}

async function readState(identity) {
  const { stdout } = await run(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath('./read-msi-state.ps1'),
      '-UpgradeCode',
      `{${msiUpgradeCode}}`,
      '-ComponentCode',
      identity.componentCode,
    ],
    { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout.trim());
}

const releases = [];
for (const path of process.argv.slice(2)) releases.push(await readArtifact(path));
const current = releases[0];
const replacement = releases.at(-1);
for (let index = 1; index < releases.length; index++)
  assertMsiUpgradePair(releases[index - 1], releases[index]);
assert.equal(
  new Set(releases.map((item) => item.productCode.toUpperCase())).size,
  releases.length,
  'Each release requires its own product code',
);
const initial = await readState(current);
assertEmptyMsiState(initial);
const token = randomBytes(32).toString('hex');
assertMsiSmokeProfile(initial.profileDirectory, token);
await mkdir('test-results', { recursive: true });
const evidence = await mkdtemp(resolve('test-results/msi-lifecycle-'));
const sentinel = join(initial.profileDirectory, 'msi-lifecycle-retention.txt');
const executable = join(initial.installDirectory, 'openkraken.exe');

async function record(name, state) {
  await writeFile(join(evidence, `${name}.json`), JSON.stringify(state, null, 2) + '\n');
}
async function retained() {
  assert.equal(await readFile(sentinel, 'utf8'), token, 'MSI changed user data');
}
async function installOperation(name, args) {
  console.log(`MSI lifecycle: ${name}`);
  // A timeout is a failure, not permission to erase a possibly active install.
  // Require exit 0: reboot-required codes are not silently accepted.
  await run(
    join(system32, 'msiexec.exe'),
    [...args, '/qn', '/norestart', 'REBOOT=ReallySuppress', '/L*v', join(evidence, `${name}.log`)],
    { timeout: 300_000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
}
async function verifyInstalled(name, identity) {
  const state = await readState(identity);
  await record(name, state);
  assertInstalledMsiState(state, initial, identity);
  comparePayload(identity.manifest.payload, await payloadManifest(initial.installDirectory));
  await verifyFuses(executable);
  const bundled = JSON.parse(
    extractFile(join(initial.installDirectory, 'resources/app.asar'), 'package.json').toString(
      'utf8',
    ),
  );
  assert.equal(bundled.version, identity.version, 'Installed ASAR version differs');
  await retained();
}
async function smoke(name) {
  const result = await run(process.execPath, [scriptPath('./smoke-package.mjs')], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      OPENKRAKEN_PACKAGE_DIRECTORY: initial.installDirectory,
      OPENKRAKEN_PACKAGE_EXECUTABLE: executable,
      OPENKRAKEN_MSI_PROFILE: initial.profileDirectory,
      OPENKRAKEN_MSI_RETENTION_TOKEN: token,
    },
  }).catch(async (error) => {
    await writeFile(
      join(evidence, `${name}.log`),
      `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}\n`,
    );
    throw error;
  });
  await writeFile(join(evidence, `${name}.log`), `${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
  await retained();
}

try {
  await record('initial', initial);
  // Non-recursive creation refuses a profile appearing after the inventory.
  await mkdir(initial.profileDirectory);
  await writeFile(sentinel, token, { flag: 'wx' });
  await installOperation('install', ['/i', current.artifact]);
  await verifyInstalled('installed', current);
  await smoke('installed-desktop');
  // Only remove resources just verified as owned by this disposable product.
  await verifyInstalled('before-repair', current);
  const helperPath = 'resources/app.asar.unpacked/dist/helpers/openkraken-askpass.exe';
  assert.equal(current.manifest.payload[helperPath]?.type, 'file');
  const helper = join(initial.installDirectory, helperPath);
  await chmod(helper, 0o666);
  await unlink(helper);
  await unlink(initial.shortcutPath);
  await installOperation('repair', ['/faums', current.productCode]);
  await verifyInstalled('repaired', current);
  for (let index = 1; index < releases.length; index++) {
    const previous = releases[index - 1];
    const next = releases[index];
    await installOperation(`upgrade-${index}`, ['/i', next.artifact]);
    await verifyInstalled(`upgraded-${index}`, next);
    if (
      previous.version.includes('-beta.') &&
      previous.version.split('-')[0] === next.version.split('-')[0]
    ) {
      const name = `reject-downgrade-${index}`;
      await assert.rejects(installOperation(name, ['/i', previous.artifact]), { code: 1603 });
      const log = await readFile(join(evidence, `${name}.log`));
      const encoding = log[0] === 0xff || log[1] === 0 ? 'utf16le' : 'utf8';
      assert.match(
        log.toString(encoding),
        /A newer OpenKraken beta or the stable release is already installed/,
      );
      await verifyInstalled(`after-${name}`, next);
    }
  }
  await smoke('upgraded-desktop');
  await verifyInstalled('before-removal', replacement);
  await installOperation('uninstall', ['/x', replacement.productCode]);
  const removed = await readState(replacement);
  await record('removed', removed);
  assertRemovedMsiState(removed, initial);
  await retained();
  console.log(
    `Verified MSI install, file/shortcut repair, actual-version upgrade, OS URI dispatch, removal and retained user data. Evidence: ${evidence}`,
  );
} finally {
  console.log(
    `MSI fixture logs and user data are retained on this disposable runner: ${evidence}, ${initial.profileDirectory}`,
  );
  // Never force-remove product state, registry keys or profiles to hide failures.
}
