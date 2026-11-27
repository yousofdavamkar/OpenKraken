import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  assertDisposableWindows,
  assertEmptyMsiState,
  assertMsiUpgradePair,
  assertInstalledMsiState,
  assertRemovedMsiState,
  assertMsiSmokeProfile,
} from './msi-lifecycle.mjs';

const runtime = {
  platform: 'win32',
  arch: 'x64',
  env: {
    OPENKRAKEN_DISPOSABLE_INSTALL_TEST: '1',
    GITHUB_ACTIONS: 'true',
    RUNNER_OS: 'Windows',
    RUNNER_ENVIRONMENT: 'github-hosted',
  },
};
const emptyState = () => ({
  betaRevisions: {},
  products: [],
  applicationExists: false,
  profileExists: false,
  shortcutExists: false,
  machineApplicationExists: false,
  machineShortcutExists: false,
  machineProtocolExists: false,
  userChoiceExists: false,
  protocol: { exists: false, keys: [], values: [] },
  installDirectory: 'C:\\Users\\fixture\\AppData\\Local\\Programs\\openkraken',
  profileDirectory: 'C:\\Users\\fixture\\AppData\\Roaming\\OpenKraken',
  shortcutPath:
    'C:\\Users\\fixture\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\OpenKraken.lnk',
});

test('MSI lifecycle accepts explicit disposable hosted Windows opt-in', () => {
  assertDisposableWindows(runtime);
  assertEmptyMsiState(emptyState());
});

test.each([
  'OPENKRAKEN_DISPOSABLE_INSTALL_TEST',
  'GITHUB_ACTIONS',
  'RUNNER_OS',
  'RUNNER_ENVIRONMENT',
])('MSI lifecycle requires the %s marker', (key) => {
  const missing = structuredClone(runtime);
  delete missing.env[key];
  expect(() => assertDisposableWindows(missing)).toThrow('MSI lifecycle requires');
});

test.each([
  'applicationExists',
  'profileExists',
  'shortcutExists',
  'machineApplicationExists',
  'machineShortcutExists',
  'machineProtocolExists',
  'userChoiceExists',
])('MSI lifecycle refuses a pre-existing %s', (key) => {
  expect(() => assertEmptyMsiState({ ...emptyState(), [key]: true })).toThrow(
    'MSI lifecycle refuses existing',
  );
});

test('MSI lifecycle refuses an existing or advertised related product', () => {
  expect(() =>
    assertEmptyMsiState({ ...emptyState(), products: [{ productCode: 'existing' }] }),
  ).toThrow('MSI lifecycle refuses existing');
});

test('MSI lifecycle refuses an incomplete native inventory', () => {
  const state = emptyState();
  delete state.machineProtocolExists;
  expect(() => assertEmptyMsiState(state)).toThrow('MSI lifecycle refuses existing');
});

test('MSI upgrade acceptance refuses a relabeled unchanged ASAR', () => {
  const current = {
    version: '0.1.0',
    productCode: '{C9637BA3-30FA-4570-9CD8-90F8DDD98645}',
    asarSha256: '1'.repeat(64),
  };
  const replacement = {
    ...current,
    version: '0.2.0',
    productCode: '{B5621CBE-11AF-4A09-8DB0-996A08D8595D}',
  };
  expect(() => assertMsiUpgradePair(current, replacement)).toThrow(
    'MSI upgrade needs a newer version, distinct product code and changed application bytes',
  );
});

test.each(['same-version', 'older-version', 'same-product', 'missing-digest'])(
  'MSI upgrade rejects %s',
  (change) => {
    const current = {
      version: '1.0.0',
      productCode: '{C9637BA3-30FA-4570-9CD8-90F8DDD98645}',
      asarSha256: '1'.repeat(64),
    };
    const replacement = {
      version: '1.1.0',
      productCode: '{B5621CBE-11AF-4A09-8DB0-996A08D8595D}',
      asarSha256: '2'.repeat(64),
    };
    assertMsiUpgradePair(current, replacement);
    if (change === 'same-version') replacement.version = current.version;
    if (change === 'older-version') replacement.version = '0.99.0';
    if (change === 'same-product') replacement.productCode = current.productCode.toLowerCase();
    if (change === 'missing-digest') delete replacement.asarSha256;
    expect(() => assertMsiUpgradePair(current, replacement)).toThrow('MSI upgrade needs');
  },
);

test('MSI lifecycle refuses a self-hosted runner even when installation is enabled', () => {
  expect(() =>
    assertDisposableWindows({
      platform: 'win32',
      arch: 'x64',
      env: {
        OPENKRAKEN_DISPOSABLE_INSTALL_TEST: '1',
        GITHUB_ACTIONS: 'true',
        RUNNER_OS: 'Windows',
        RUNNER_ENVIRONMENT: 'self-hosted',
      },
    }),
  ).toThrow('MSI lifecycle requires an explicitly enabled disposable hosted Windows x64 runner');
});

const identity = {
  version: '0.1.0',
  productCode: '{C9637BA3-30FA-4570-9CD8-90F8DDD98645}',
  componentCode: '{D7B9F689-75C0-4684-89B8-D73BAF386D60}',
};
function installedState() {
  const state = emptyState();
  const executable = `${state.installDirectory}\\openkraken.exe`;
  return {
    ...state,
    applicationExists: true,
    profileExists: true,
    shortcutExists: true,
    products: [{ ...identity, state: 5, componentPath: executable }],
    shortcut: { ...identity, feature: 'ProductFeature' },
    protocol: {
      exists: true,
      keys: ['', '\\DefaultIcon', '\\shell', '\\shell\\open', '\\shell\\open\\command'],
      values: [
        { path: '', name: '', kind: 'String', value: 'URL:OpenKraken repository' },
        { path: '', name: 'URL Protocol', kind: 'String', value: '' },
        { path: '\\DefaultIcon', name: '', kind: 'String', value: `"${executable}",0` },
        { path: '\\shell\\open\\command', name: '', kind: 'String', value: `"${executable}" "%1"` },
      ],
    },
  };
}

test('installed MSI evidence binds product, payload location, shortcut and quoted URI command', () => {
  assertInstalledMsiState(installedState(), emptyState(), identity);
});

test.each([
  ['old product remains after upgrade', (state) => state.products.push({ ...state.products[0] })],
  ['advertised rather than installed', (state) => (state.products[0].state = 1)],
  ['wrong version', (state) => (state.products[0].version = '0.0.0')],
  ['machine installation', (state) => (state.machineApplicationExists = true)],
  ['missing shortcut', (state) => (state.shortcutExists = false)],
  [
    'shortcut owned by old product',
    (state) => (state.shortcut.productCode = '{00000000-0000-0000-0000-000000000000}'),
  ],
  [
    'shortcut detached from executable',
    (state) => (state.shortcut.componentCode = '{00000000-0000-0000-0000-000000000000}'),
  ],
  [
    'unexpected executable path',
    (state) => (state.products[0].componentPath = 'C:\\other\\openkraken.exe'),
  ],
  ['changed native folder', (state) => (state.installDirectory = 'C:\\other')],
  ['unquoted URI command', (state) => (state.protocol.values[3].value = 'openkraken.exe %1')],
  [
    'extra registry value',
    (state) => state.protocol.values.push({ path: '', name: 'extra', value: 'x' }),
  ],
])('MSI acceptance rejects %s', (_label, mutate) => {
  const state = installedState();
  mutate(state);
  expect(() => assertInstalledMsiState(state, emptyState(), identity)).toThrow();
});

test('removal requires MSI-owned files and registration gone while keeping user data', () => {
  const state = { ...emptyState(), profileExists: true, userChoiceExists: true };
  assertRemovedMsiState(state, emptyState());
  for (const key of ['applicationExists', 'shortcutExists', 'machineProtocolExists']) {
    expect(() => assertRemovedMsiState({ ...state, [key]: true }, emptyState())).toThrow();
  }
  expect(() => assertRemovedMsiState({ ...state, profileExists: false }, emptyState())).toThrow();
  expect(() =>
    assertRemovedMsiState({ ...state, protocol: installedState().protocol }, emptyState()),
  ).toThrow();
});

test('persistent MSI smoke profile requires hosted opt-in and the native default location', () => {
  const native = {
    ...runtime,
    env: { ...runtime.env, APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' },
  };
  assertMsiSmokeProfile(emptyState().profileDirectory, 'a'.repeat(64), native);
  expect(() => assertMsiSmokeProfile('C:\\other', 'a'.repeat(64), native)).toThrow();
  expect(() => assertMsiSmokeProfile(emptyState().profileDirectory, '', native)).toThrow();
  expect(() =>
    assertMsiSmokeProfile(emptyState().profileDirectory, 'a'.repeat(64), {
      ...native,
      platform: 'linux',
    }),
  ).toThrow();
});

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'native read-only MSI inventory reports folders, products and protocol without installing',
  async () => {
    const { stdout } = await promisify(execFile)(
      join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'scripts/read-msi-state.ps1',
        '-UpgradeCode',
        '{8B1BEDFC-AAA5-5EFE-9437-351F2D7682D7}',
        '-ComponentCode',
        identity.componentCode,
      ],
      { timeout: 30000, windowsHide: true },
    );
    const state = JSON.parse(stdout.trim());
    // Read-only even on a developer's machine: no assertion that it is empty.
    expect(Array.isArray(state.products)).toBe(true);
    for (const key of Object.keys(emptyState()).filter((key) => key.endsWith('Exists')))
      expect(typeof state[key]).toBe('boolean');
    expect(state.profileDirectory).toBe(join(process.env.APPDATA, 'OpenKraken'));
    expect(state.installDirectory).toBe(join(process.env.LOCALAPPDATA, 'Programs/openkraken'));
    expect(typeof state.protocol.exists).toBe('boolean');
  },
  35000,
);

test.each([
  ['0.1.0', '0.2.0-beta.0', true],
  ['0.2.0-beta.9', '0.2.0-beta.10', true],
  ['0.2.0-beta.2147483647', '0.2.0', true],
  ['0.2.0-beta.10', '0.2.0-beta.9', false],
  ['0.2.0-beta.9', '0.2.0-beta.9', false],
  ['0.2.0', '0.2.0-beta.2147483647', false],
])('native upgrade fixture orders %s and %s', (first, second, newer) => {
  const pair = () =>
    assertMsiUpgradePair(
      { ...identity, version: first, asarSha256: '1'.repeat(64) },
      { productCode: identity.componentCode, version: second, asarSha256: '2'.repeat(64) },
    );
  if (newer) pair();
  else expect(pair).toThrow('MSI upgrade needs');
});
test('beta installation and removal check the revision stored outside ProductVersion', () => {
  const beta = { ...identity, version: '0.1.0-beta.0' };
  const state = installedState();
  expect(() => assertInstalledMsiState(state, emptyState(), beta)).toThrow('beta revision');
  state.betaRevisions = { '0.1.0': '0' };
  assertInstalledMsiState(state, emptyState(), beta);
  expect(() => assertInstalledMsiState(state, emptyState(), identity)).toThrow('beta revision');
  const stale = { ...emptyState(), betaRevisions: state.betaRevisions };
  expect(() => assertEmptyMsiState(stale)).toThrow('existing');
  expect(() => assertRemovedMsiState({ ...stale, profileExists: true }, emptyState())).toThrow(
    'beta revision',
  );
});
