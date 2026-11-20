import { win32 } from 'node:path';
import assert from 'node:assert/strict';
import { msiVersion } from './msi.mjs';

const guid = /^\{[A-F0-9]{8}-(?:[A-F0-9]{4}-){3}[A-F0-9]{12}\}$/i;

// These guards prevent accidental workstation use. They are not a sandbox or
// proof against deliberately forged environment variables.
export function assertDisposableWindows(runtime = process) {
  if (
    runtime.platform !== 'win32' ||
    runtime.arch !== 'x64' ||
    runtime.env.OPENKRAKEN_DISPOSABLE_INSTALL_TEST !== '1' ||
    runtime.env.GITHUB_ACTIONS !== 'true' ||
    runtime.env.RUNNER_OS !== 'Windows' ||
    runtime.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    throw new Error(
      'MSI lifecycle requires an explicitly enabled disposable hosted Windows x64 runner',
    );
}

export function assertMsiSmokeProfile(profile, token, runtime = process) {
  assertDisposableWindows(runtime);
  assert.ok(
    runtime.env.APPDATA && win32.isAbsolute(runtime.env.APPDATA),
    'Native roaming profile is unavailable',
  );
  assert.ok(
    samePath(profile, win32.join(runtime.env.APPDATA, 'OpenKraken')),
    'MSI smoke must use the native default profile',
  );
  assert.match(token ?? '', /^[a-f0-9]{64}$/, 'MSI smoke requires a fixture retention token');
}

const presenceFields = [
  'applicationExists',
  'profileExists',
  'shortcutExists',
  'machineApplicationExists',
  'machineShortcutExists',
  'machineProtocolExists',
  'userChoiceExists',
];

export function assertEmptyMsiState(state) {
  if (
    !state ||
    !state.betaRevisions ||
    Object.getPrototypeOf(state.betaRevisions) !== Object.prototype ||
    Object.keys(state.betaRevisions).length !== 0 ||
    !Array.isArray(state.products) ||
    state.products.length !== 0 ||
    presenceFields.some((key) => state[key] !== false) ||
    state.protocol?.exists !== false ||
    !Array.isArray(state.protocol.keys) ||
    state.protocol.keys.length !== 0 ||
    !Array.isArray(state.protocol.values) ||
    state.protocol.values.length !== 0
  )
    throw new Error(
      'MSI lifecycle refuses existing or uncertain OpenKraken installation, registration or user data',
    );
  for (const key of ['installDirectory', 'profileDirectory', 'shortcutPath'])
    if (typeof state[key] !== 'string' || !win32.isAbsolute(state[key]))
      throw new Error('MSI lifecycle requires native absolute fixture paths');
}

function samePath(actual, expected) {
  return (
    typeof actual === 'string' &&
    win32.normalize(actual).toLowerCase() === win32.normalize(expected).toLowerCase()
  );
}

function assertFixturePaths(state, initial) {
  for (const key of ['installDirectory', 'profileDirectory', 'shortcutPath'])
    assert.ok(samePath(state[key], initial[key]), `MSI native folder changed: ${key}`);
  for (const key of ['machineApplicationExists', 'machineShortcutExists', 'machineProtocolExists'])
    assert.equal(state[key], false, `MSI changed machine state: ${key}`);
  assert.equal(state.profileExists, true, 'MSI must retain user data');
}

export function assertInstalledMsiState(state, initial, identity) {
  assertFixturePaths(state, initial);
  assert.equal(state.applicationExists, true);
  assert.equal(state.shortcutExists, true);
  assert.equal(state.products?.length, 1, 'Exactly one related MSI product must remain');
  const product = state.products[0];
  assert.equal(product.productCode?.toUpperCase(), identity.productCode.toUpperCase());
  assert.equal(product.state, 5, 'MSI product must be installed locally');
  const [core, revision] = identity.version.split('-beta.');
  assert.deepEqual(
    state.betaRevisions,
    revision === undefined ? {} : { [core]: revision },
    'Installed beta revision differs',
  );
  assert.ok(
    [core, msiVersion(identity.version)].includes(product.version),
    'Installed MSI version differs',
  );
  const executable = win32.join(initial.installDirectory, 'openkraken.exe');
  assert.ok(samePath(product.componentPath, executable), 'MSI executable key path differs');
  assert.equal(state.shortcut?.productCode?.toUpperCase(), identity.productCode.toUpperCase());
  assert.equal(state.shortcut?.componentCode?.toUpperCase(), identity.componentCode.toUpperCase());
  assert.equal(state.shortcut?.feature, 'ProductFeature');
  assert.equal(state.protocol?.exists, true);
  assert.deepEqual(
    [...state.protocol.keys].sort(),
    ['', '\\DefaultIcon', '\\shell', '\\shell\\open', '\\shell\\open\\command'].sort(),
  );
  const expected = [
    { path: '', name: '', kind: 'String', value: 'URL:OpenKraken repository' },
    { path: '', name: 'URL Protocol', kind: 'String', value: '' },
    { path: '\\DefaultIcon', name: '', kind: 'String', value: `"${executable}",0` },
    { path: '\\shell\\open\\command', name: '', kind: 'String', value: `"${executable}" "%1"` },
  ];
  assert.equal(state.protocol.values.length, expected.length);
  for (const entry of expected)
    assert.deepEqual(
      state.protocol.values.filter(
        (value) => value.path === entry.path && value.name === entry.name,
      ),
      [entry],
      'Installed URI registration differs',
    );
}

export function assertRemovedMsiState(state, initial) {
  assertFixturePaths(state, initial);
  assert.deepEqual(state.betaRevisions, {}, 'An MSI beta revision remains');
  assert.deepEqual(state.products, [], 'An installed or advertised MSI product remains');
  assert.equal(state.applicationExists, false, 'MSI application directory remains');
  assert.equal(state.shortcutExists, false, 'MSI shortcut remains');
  assert.deepEqual(
    state.protocol,
    { exists: false, keys: [], values: [] },
    'MSI protocol registration remains',
  );
  // Windows may create a URL-association UserChoice during OS dispatch. It is
  // not MSI-owned; never erase it merely to make this fixture pass.
}

export function assertMsiUpgradePair(current, replacement) {
  const first = msiVersion(current.version).split('.').map(Number);
  const next = msiVersion(replacement.version).split('.').map(Number);
  const revision = (version) => Number(version.split('-beta.')[1] ?? 2147483648);
  const difference =
    next.map((part, index) => part - first[index]).find((part) => part !== 0) ??
    revision(replacement.version) - revision(current.version);
  if (
    difference <= 0 ||
    !guid.test(current.productCode) ||
    !guid.test(replacement.productCode) ||
    current.productCode.toUpperCase() === replacement.productCode.toUpperCase() ||
    !/^[a-f0-9]{64}$/.test(current.asarSha256) ||
    !/^[a-f0-9]{64}$/.test(replacement.asarSha256) ||
    current.asarSha256 === replacement.asarSha256
  )
    throw new Error(
      'MSI upgrade needs a newer version, distinct product code and changed application bytes',
    );
}
