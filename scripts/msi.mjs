import { build, Platform, Arch } from 'electron-builder';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  comparePayload,
  payloadManifest,
  sha256,
  verifyFuses,
  verifyAsarUnpackedFile,
  verifyPackagedApplication,
} from './package-security.mjs';

const run = promisify(execFile);
// Freeze the builder's appId-derived upgrade identity across releases.
export const msiUpgradeCode = '8B1BEDFC-AAA5-5EFE-9437-351F2D7682D7';
const perUserCondition = 'NOT ALLUSERS OR (ALLUSERS = "2" AND MSIINSTALLPERUSER = "1")';

function nativeTool(name) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('MSI operations require native Windows x64');
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot))
    throw new Error('Windows system directory is unavailable');
  return join(process.env.SystemRoot, 'System32', name);
}

async function powershell(script, args) {
  return run(
    nativeTool('WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL(script, import.meta.url)),
      ...args,
    ],
    { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
}

export const windowsAskpassArchivePath = 'dist/helpers/openkraken-askpass.exe';
export const msiExecutables = [
  'openkraken.exe',
  'resources/app.asar.unpacked/' + windowsAskpassArchivePath,
];

export function windowsIdentity(target, fingerprint) {
  if (fingerprint === undefined) return undefined;
  if (target !== 'msi' || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint))
    throw new Error('--win-identity requires an MSI target and a SHA-256 certificate fingerprint');
  return fingerprint.toUpperCase();
}

export function windowsTimestamp(identity, url) {
  if (url === undefined) return undefined;
  const server = URL.canParse(url) ? new URL(url) : null;
  if (
    !identity ||
    server?.protocol !== 'https:' ||
    server.username ||
    server.password ||
    server.hash
  )
    throw new Error('--win-timestamp-url requires --win-identity and an HTTPS timestamp server');
  return server.href;
}

export function verifyMsiReceipt(manifest, identity, requireTimestamp) {
  if (
    manifest.signed !== Boolean(identity) ||
    manifest.signingFingerprint !== identity ||
    (identity ? typeof manifest.timestamped !== 'boolean' : manifest.timestamped !== undefined)
  )
    throw new Error('MSI signing receipt differs from the independently supplied --win-identity');
  if (requireTimestamp && !manifest.timestamped)
    throw new Error('Expected a timestamped MSI receipt');
}

export function authenticode(
  path,
  fingerprint,
  { sign = false, timestampUrl, requireTimestamp = false } = {},
) {
  return powershell('./windows-authenticode.ps1', [
    '-Path',
    path,
    '-Fingerprint',
    fingerprint,
    ...(sign ? ['-Sign'] : []),
    ...(timestampUrl ? ['-TimestampUrl', timestampUrl] : []),
    ...(requireTimestamp ? ['-RequireTimestamp'] : []),
  ]);
}

export function msiVersion(version) {
  const match =
    typeof version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(version);
  if (
    !match ||
    Number(match[1]) > 255 ||
    Number(match[2]) > 255 ||
    Number(match[3]) > 65535 ||
    (match[4] !== undefined && Number(match[4]) > 2147483647)
  )
    throw new Error(
      'MSI requires a stable or numbered beta release within Windows Installer limits',
    );
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

export async function buildMsi({
  root,
  prepackaged,
  work,
  version,
  metadata,
  testMetadata,
  signed = false,
}) {
  nativeTool('msiexec.exe');
  msiVersion(version);
  const beta = version.split('-beta.')[1];
  return build({
    projectDir: root,
    prepackaged,
    targets: Platform.WINDOWS.createTarget('msi', Arch.x64),
    publish: 'never',
    config: {
      appId: 'org.openkraken.desktop',
      productName: 'OpenKraken',
      executableName: 'openkraken',
      electronVersion: '45.2.1',
      buildNumber: '0',
      npmRebuild: false,
      publish: null,
      directories: { output: join(work, 'output'), buildResources: 'build-resources' },
      artifactName: `OpenKraken-${version}-win32-x64${testMetadata ? '-TEST-ONLY' : signed ? '' : '-unsigned'}.\${ext}`,
      extraMetadata: {
        name: 'openkraken',
        version,
        description: 'OpenKraken desktop Git client',
        author: { name: metadata.name, email: metadata.email },
        homepage: metadata.homepage,
        license: metadata.license,
      },
      win: {
        icon: 'build-resources/openkraken.png',
        signAndEditExecutable: false,
        signExecutable: false,
        forceCodeSigning: false,
      },
      msi: {
        oneClick: true,
        perMachine: false,
        runAfterFinish: false,
        createDesktopShortcut: false,
        createStartMenuShortcut: true,
        shortcutName: 'OpenKraken',
        upgradeCode: msiUpgradeCode,
        warningsAsErrors: true,
      },
      msiProjectCreated: async (project) => {
        await powershell('./prepare-msi-project.ps1', [
          '-Project',
          project,
          ...(beta === undefined ? [] : ['-BetaSequence', beta]),
        ]);
      },
    },
  });
}

export async function readMsiMetadata(artifact) {
  const { stdout } = await powershell('./read-msi-metadata.ps1', ['-Artifact', artifact]);
  return JSON.parse(stdout.trim());
}

export function verifyMsiMetadata(info, manifest) {
  const properties = info?.properties;
  if (
    !properties ||
    properties.ProductName !== 'OpenKraken' ||
    properties.ProductVersion !== msiVersion(manifest.version) ||
    properties.Manufacturer !== manifest.metadata.name ||
    properties.UpgradeCode?.toUpperCase() !== `{${msiUpgradeCode}}` ||
    !/^\{[A-F0-9]{8}-(?:[A-F0-9]{4}-){3}[A-F0-9]{12}\}$/i.test(properties.ProductCode ?? '') ||
    properties.ALLUSERS !== '2' ||
    properties.MSIINSTALLPERUSER !== '1' ||
    info.summary?.template !== 'x64;1033' ||
    (info.summary?.wordCount & 10) !== 10 ||
    !Array.isArray(info.customActions) ||
    info.customActions.length !== 0 ||
    !Array.isArray(info.removedRegistry) ||
    info.removedRegistry.length !== 0 ||
    !info.conditions?.some((entry) => entry.condition === perUserCondition) ||
    !info.files?.some(
      (entry) => entry.id === 'mainExecutable' && entry.name.split('|').at(-1) === 'openkraken.exe',
    ) ||
    !info.shortcuts?.some(
      (entry) =>
        entry.id === 'startMenuShortcut' &&
        entry.directory === 'ProgramMenuFolder' &&
        entry.name.split('|').at(-1) === 'OpenKraken',
    )
  )
    throw new Error(
      'MSI identity, version, architecture, per-user policy or launch metadata differs',
    );
  const main = info.files.find((entry) => entry.id === 'mainExecutable');
  const shortcut = info.shortcuts.find((entry) => entry.id === 'startMenuShortcut');
  if (
    !main.component ||
    shortcut.component !== main.component ||
    shortcut.target !== 'ProductFeature' ||
    shortcut.arguments !== '' ||
    shortcut.workingDirectory !== 'APPLICATIONFOLDER'
  )
    throw new Error('MSI Start menu shortcut differs from the application');
  const expected = [
    ['OpenKrakenProtocolName', 'Software\\Classes\\openkraken', '', 'URL:OpenKraken repository'],
    ['OpenKrakenProtocolMarker', 'Software\\Classes\\openkraken', 'URL Protocol', ''],
    [
      'OpenKrakenProtocolIcon',
      'Software\\Classes\\openkraken\\DefaultIcon',
      '',
      '"[#mainExecutable]",0',
    ],
    [
      'OpenKrakenProtocolCommand',
      'Software\\Classes\\openkraken\\shell\\open\\command',
      '',
      '"[#mainExecutable]" "%1"',
    ],
  ];
  const beta = manifest.version.split('-beta.')[1];
  if (beta !== undefined) verifyBetaPolicy(info, manifest.version, beta);
  else if (info.betaPolicy) throw new Error('Stable MSI contains a beta upgrade policy');
  if (
    !Array.isArray(info.registry) ||
    info.registry.length !== expected.length + Number(beta !== undefined)
  )
    throw new Error('MSI repository protocol registration differs');
  for (const [id, key, name, value] of expected) {
    const entries = info.registry.filter((entry) => entry.id === id);
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      entry.root !== '1' ||
      entry.key !== key ||
      entry.name !== name ||
      entry.value !== value ||
      entry.component !== 'OpenKrakenProtocol'
    )
      throw new Error('MSI repository protocol registration differs');
  }
  const component = info.components?.find((entry) => entry.id === 'OpenKrakenProtocol');
  if (
    !component ||
    component.keyPath !== 'OpenKrakenProtocolName' ||
    Number(component.attributes) !== 260
  )
    throw new Error('MSI protocol must have an uninstallable 64-bit registry key path');
}

function verifyBetaPolicy(info, version, beta) {
  const native = msiVersion(version);
  const key = 'Software\\OpenKraken\\Installer\\Beta\\' + version.split('-')[0];
  const value = info.registry?.find((row) => row.id === 'OpenKrakenBetaSequence');
  const component = info.components?.find((row) => row.id === 'OpenKrakenBeta');
  const search = info.betaPolicy?.registrySearch;
  const range = info.betaPolicy?.sameVersion;
  const condition = `Installed OR NOT OPENKRAKEN_SAME_CORE OR (OPENKRAKEN_INSTALLED_BETA <> "" AND OPENKRAKEN_INSTALLED_BETA <= ${beta})`;
  if (
    value?.root !== '1' ||
    value?.key !== key ||
    value?.name !== 'Sequence' ||
    value?.value !== beta ||
    value?.component !== 'OpenKrakenBeta' ||
    component?.keyPath !== value?.id ||
    Number(component?.attributes) !== 260 ||
    search?.key !== key ||
    search?.root !== '1' ||
    search?.name !== 'Sequence' ||
    search?.type !== '18' ||
    info.betaPolicy?.searchProperty !== 'OPENKRAKEN_INSTALLED_BETA' ||
    range?.code?.toUpperCase() !== `{${msiUpgradeCode}}` ||
    range?.min !== native ||
    range?.max !== native ||
    range?.language !== '' ||
    Number(range?.attributes) !== 770 ||
    !info.conditions?.some((row) => row.condition === condition)
  )
    throw new Error('MSI beta revision, upgrade detection or launch condition differs');
  for (const table of ['InstallExecuteSequence', 'InstallUISequence']) {
    const sequence = info.betaPolicy[table];
    if (!(
      Number(sequence?.FindRelatedProducts) > 0 &&
      Number(sequence.AppSearch) > Number(sequence.FindRelatedProducts) &&
      Number(sequence.LaunchConditions) > Number(sequence.AppSearch)
    ))
      throw new Error('MSI beta checks must run before launch conditions');
  }
}

export async function verifyMsi(source, manifest, identity, requireTimestamp = false) {
  verifyMsiReceipt(manifest, identity, requireTimestamp);
  const installer = nativeTool('msiexec.exe');
  await mkdir('release', { recursive: true });
  const temporary = await mkdtemp(resolve('release/msi-check-'));
  let safeToRemove = true;
  try {
    // Authenticate, inspect and extract the same bytes even if the output is rebuilt.
    const artifact = join(temporary, 'candidate.msi');
    await copyFile(source, artifact);
    if (
      (await stat(artifact)).size !== manifest.artifact.size ||
      (await sha256(artifact)) !== manifest.artifact.sha256
    )
      throw new Error('Installer checksum or size mismatch');
    const signatureOptions = { requireTimestamp: manifest.timestamped };
    if (identity) await authenticode(artifact, identity, signatureOptions);
    await verifyMsiMetadata(await readMsiMetadata(artifact), manifest);
    const extracted = join(temporary, 'extracted');
    await mkdir(extracted);
    // Administrative extraction does not register/install the product. Only
    // locally built or independently authenticated MSI files may be inspected.
    safeToRemove = false;
    await run(
      installer,
      [
        '/a',
        artifact,
        '/qn',
        '/norestart',
        'REBOOT=ReallySuppress',
        `TARGETDIR=${extracted}`,
        '/L*v',
        join(temporary, 'extract.log'),
      ],
      { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 },
    );
    const inventory = await payloadManifest(extracted);
    const executables = Object.entries(inventory).filter(
      ([path, entry]) =>
        entry.type === 'file' && (path === 'openkraken.exe' || path.endsWith('/openkraken.exe')),
    );
    if (executables.length !== 1) throw new Error('Expected one extracted MSI application');
    const executable = join(extracted, executables[0][0]);
    const directory = dirname(executable);
    comparePayload(manifest.payload, await payloadManifest(directory));
    if (identity) {
      for (const name of msiExecutables)
        await authenticode(join(directory, name), identity, signatureOptions);
      await verifyAsarUnpackedFile(join(directory, 'resources'), windowsAskpassArchivePath);
    }
    await verifyFuses(executable);
    verifyPackagedApplication(directory, manifest.version, manifest.source ?? null);
    console.log('MSI tables, extracted payload, Windows access and Electron fuses verified');
    const smoke = spawn(process.execPath, ['scripts/smoke-package.mjs', '--history'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        OPENKRAKEN_PACKAGE_DIRECTORY: directory,
        OPENKRAKEN_PACKAGE_EXECUTABLE: executable,
      },
    });
    await new Promise((resolve, reject) => {
      smoke.once('error', reject);
      smoke.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`MSI smoke failed: ${code ?? signal}`)),
      );
    });
    safeToRemove = true;
    console.log(
      'Verified extracted MSI desktop; install/upgrade/uninstall remains a separate gate',
    );
  } finally {
    if (safeToRemove) await rm(temporary, { recursive: true, force: true });
    else console.error(`Retained MSI verification files and log: ${temporary}`);
  }
}
