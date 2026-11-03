import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { msiVersion, verifyMsiMetadata } from './msi.mjs';

const run = promisify(execFile);
const powershell =
  process.platform === 'win32'
    ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    : process.env.OPENKRAKEN_POWERSHELL;
const directories = [];
const projectXml = `<?xml version="1.0"?><Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Product>
    <Package InstallerVersion="500"/>
    <Property Id="ALLUSERS" Value="2"/><Property Id="MSIINSTALLPERUSER" Value="1"/>
    <Directory Id="APPLICATIONFOLDER"/>
    <Feature><ComponentGroupRef Id="ProductComponents"/></Feature>
    <ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER"><Component><File Id="mainExecutable" Name="openkraken.exe"/></Component></ComponentGroup>
  </Product></Wix>`;
async function projectFixture(xml = projectXml) {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-msi-project-'));
  directories.push(directory);
  const project = join(directory, 'project.wxs');
  await writeFile(project, xml);
  return project;
}
const prepare = (project) =>
  run(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    resolve('scripts/prepare-msi-project.ps1'),
    '-Project',
    project,
  ]);
const manifest = { version: '0.1.0', metadata: { name: 'Installer fixture' } };
function metadata() {
  return {
    properties: {
      ProductName: 'OpenKraken',
      ProductVersion: '0.1.0.0',
      Manufacturer: 'Installer fixture',
      UpgradeCode: '{8B1BEDFC-AAA5-5EFE-9437-351F2D7682D7}',
      ProductCode: '{C9637BA3-30FA-4570-9CD8-90F8DDD98645}',
      ALLUSERS: '2',
      MSIINSTALLPERUSER: '1',
    },
    summary: { template: 'x64;1033', wordCount: 10 },
    customActions: [],
    removedRegistry: [],
    conditions: [{ condition: 'NOT ALLUSERS OR (ALLUSERS = "2" AND MSIINSTALLPERUSER = "1")' }],
    files: [{ id: 'mainExecutable', name: 'openkraken.exe', component: 'mainComponent' }],
    shortcuts: [
      {
        id: 'startMenuShortcut',
        directory: 'ProgramMenuFolder',
        name: 'OpenKraken',
        component: 'mainComponent',
        target: 'ProductFeature',
        arguments: '',
        workingDirectory: 'APPLICATIONFOLDER',
      },
    ],
    components: [
      { id: 'OpenKrakenProtocol', attributes: '260', keyPath: 'OpenKrakenProtocolName' },
    ],
    registry: [
      {
        id: 'OpenKrakenProtocolName',
        key: 'Software\\Classes\\openkraken',
        name: '',
        value: 'URL:OpenKraken repository',
      },
      {
        id: 'OpenKrakenProtocolMarker',
        key: 'Software\\Classes\\openkraken',
        name: 'URL Protocol',
        value: '',
      },
      {
        id: 'OpenKrakenProtocolIcon',
        key: 'Software\\Classes\\openkraken\\DefaultIcon',
        name: '',
        value: '"[#mainExecutable]",0',
      },
      {
        id: 'OpenKrakenProtocolCommand',
        key: 'Software\\Classes\\openkraken\\shell\\open\\command',
        name: '',
        value: '"[#mainExecutable]" "%1"',
      },
    ].map((entry) => ({ ...entry, root: '1', component: 'OpenKrakenProtocol' })),
  };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test.skipIf(process.platform !== 'linux')(
  'MSI creation refuses a non-Windows host before reading a bundle',
  async () => {
    await expect(
      run(process.execPath, ['scripts/installers.mjs', '--test-metadata', '--target', 'msi']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Target msi requires native Windows x64'),
    });
  },
);

test('MSI metadata verifies a per-user package with owned, quoted protocol values', () => {
  verifyMsiMetadata(metadata(), manifest);
});

test.each(['0.1.0-beta.1', '256.0.0', '0.256.0', '0.1.65536', '01.2.3', '1.2', '1.2.3.4'])(
  'MSI refuses release versions that cannot round-trip: %s',
  (version) => {
    expect(() => msiVersion(version)).toThrow('MSI requires a stable release version');
  },
);

test.each([
  [
    'version',
    (info) => {
      info.properties.ProductVersion = '0.2.0.0';
    },
  ],
  [
    'machine scope',
    (info) => {
      info.properties.ALLUSERS = '1';
    },
  ],
  [
    'elevation',
    (info) => {
      info.summary.wordCount = 2;
    },
  ],
  [
    'custom launch action',
    (info) => {
      info.customActions.push({ id: 'runAfterFinish' });
    },
  ],
  [
    'architecture',
    (info) => {
      info.summary.template = 'Intel;1033';
    },
  ],
  [
    'missing scope guard',
    (info) => {
      info.conditions = [];
    },
  ],
])('MSI rejects changed %s', (_name, change) => {
  const info = metadata();
  change(info);
  expect(() => verifyMsiMetadata(info, manifest)).toThrow(
    'MSI identity, version, architecture, per-user policy or launch metadata differs',
  );
});

test.each([
  [
    'unquoted URL',
    (info) => {
      info.registry[3].value = '"[#mainExecutable]" %1';
    },
  ],
  [
    'machine registry',
    (info) => {
      info.registry[3].root = '2';
    },
  ],
  [
    'unowned registry',
    (info) => {
      info.registry[3].component = 'anotherComponent';
    },
  ],
  [
    'extra registry entry',
    (info) => {
      info.registry.push({ ...info.registry[0], id: 'extra' });
    },
  ],
])('MSI rejects %s registration', (_name, change) => {
  const info = metadata();
  change(info);
  expect(() => verifyMsiMetadata(info, manifest)).toThrow(
    'MSI repository protocol registration differs',
  );
});

test('MSI rejects a permanent protocol component that would survive uninstall', () => {
  const info = metadata();
  info.components[0].attributes = '276';
  expect(() => verifyMsiMetadata(info, manifest)).toThrow(
    'MSI protocol must have an uninstallable 64-bit registry key path',
  );
});

test('MSI rejects explicit registry deletion beyond its owned values', () => {
  const info = metadata();
  info.removedRegistry.push({ id: 'eraseUserClasses' });
  expect(() => verifyMsiMetadata(info, manifest)).toThrow(
    'MSI identity, version, architecture, per-user policy or launch metadata differs',
  );
});

test('MSI rejects a Start menu shortcut detached from its application component', () => {
  const info = metadata();
  info.shortcuts[0].component = 'unrelatedComponent';
  expect(() => verifyMsiMetadata(info, manifest)).toThrow(
    'MSI Start menu shortcut differs from the application',
  );
});

test.skipIf(!powershell)(
  'MSI project preparation adds an owned, quoted per-user protocol command',
  async () => {
    const project = await projectFixture();
    await prepare(project);
    const xml = await readFile(project, 'utf8');
    expect(xml).toContain('Software\\Classes\\openkraken\\shell\\open\\command');
    expect(xml).toContain('&quot;[#mainExecutable]&quot; &quot;%1&quot;');
    expect(xml).toContain('Root="HKCU"');
    expect(xml).toContain('InstallPrivileges="limited"');
    expect(xml).not.toContain('ForceDeleteOnUninstall');
  },
);

test.skipIf(!powershell).each([
  ['machine defaults', projectXml.replace('Id="ALLUSERS" Value="2"', 'Id="ALLUSERS" Value="1"')],
  ['unexpected executable', projectXml.replace('Name="openkraken.exe"', 'Name="other.exe"')],
  ['different builder schema', projectXml.replace('schemas/v4/wxs', 'schemas/unknown/wxs')],
  ['custom action', projectXml.replace('<Package', '<CustomAction Id="launch"/><Package')],
  [
    'DTD',
    projectXml.replace(
      '?><Wix',
      '?><!DOCTYPE Wix [<!ENTITY external SYSTEM "file:///unreadable">]><Wix',
    ),
  ],
])('MSI project preparation refuses %s without rewriting it', async (_name, xml) => {
  const project = await projectFixture(xml);
  await expect(prepare(project)).rejects.toThrow();
  expect(await readFile(project, 'utf8')).toBe(xml);
});
