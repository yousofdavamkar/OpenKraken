import { beforeEach, expect, test, vi } from 'vitest';

const { execFile, sign } = vi.hoisted(() => ({ execFile: vi.fn(), sign: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('@electron/osx-sign', () => ({ sign }));

import {
  notarizeDiskImage,
  signMacBundle,
  signDiskImage,
  verifyDmgReceipt,
} from './mac-signing.mjs';

const fingerprint = 'AB'.repeat(20);
beforeEach(() => {
  vi.resetAllMocks();
  execFile.mockImplementation((_bin, _args, _options, callback) => callback(null, ''));
});

test('the staged app uses the selected identity and limits JIT to Electron processes', async () => {
  const app = '/build/OpenKraken.app';
  await signMacBundle(app, fingerprint);
  const [options] = sign.mock.calls[0];
  expect(options).toMatchObject({
    app,
    identity: fingerprint,
    type: 'distribution',
    platform: 'darwin',
  });
  const helper = app + '/Contents/Frameworks/openkraken Helper';
  for (const path of [app, helper + '.app', helper + ' (Renderer).app'])
    expect(options.optionsForFile(path)).toMatchObject({
      hardenedRuntime: true,
      entitlements: expect.stringMatching(/mac-jit\.plist$/),
    });
  for (const path of [
    helper + ' (GPU).app',
    helper + ' (Plugin).app',
    app + '/Contents/Resources/pty.node',
  ])
    expect(options.optionsForFile(path)).toMatchObject({
      hardenedRuntime: true,
      entitlements: expect.stringMatching(/mac-empty\.plist$/),
    });
});

test('a timestamped image must pass the pinned Apple requirement before signing returns', async () => {
  const path = '/build/OpenKraken.dmg';
  await signDiskImage(path, fingerprint);
  const calls = execFile.mock.calls.map(([bin, args]) => [bin, ...args]);
  expect(calls).toEqual([
    [
      '/usr/bin/codesign',
      '--force',
      '--sign',
      fingerprint,
      '--timestamp',
      '--identifier',
      'org.openkraken.desktop.dmg',
      path,
    ],
    [
      '/usr/bin/codesign',
      '--verify',
      '--strict',
      '-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf = H"' +
        fingerprint +
        '" and identifier "org.openkraken.desktop.dmg"',
      path,
    ],
  ]);
  execFile.mockImplementation((_bin, args, _options, callback) =>
    callback(args.includes('--verify') ? new Error('certificate mismatch') : null, ''),
  );
  await expect(signDiskImage(path, fingerprint)).rejects.toThrow('certificate mismatch');
});

const id = '451195da-66b4-46c6-93de-5a68c960027d';
const image = '/build/OpenKraken.dmg';
function notaryTools(status, failure) {
  execFile.mockImplementation((_bin, args, _options, callback) => {
    if (args.includes(failure)) return callback(new Error('Apple tool failed'));
    callback(null, { stdout: JSON.stringify({ status, id }) });
  });
}

test('notarization waits for acceptance and checks the signed, stapled image', async () => {
  notaryTools('Accepted');
  await expect(notarizeDiskImage(image, 'Release Account', fingerprint)).resolves.toBe(id);
  const calls = execFile.mock.calls.map(([bin, args]) => [bin, ...args]);
  expect(calls).toEqual([
    [
      '/usr/bin/xcrun',
      'notarytool',
      'submit',
      image,
      '--keychain-profile',
      'Release Account',
      '--wait',
      '--output-format',
      'json',
    ],
    ['/usr/bin/xcrun', 'stapler', 'staple', image],
    ['/usr/bin/codesign', '--verify', '--strict', expect.stringContaining(fingerprint), image],
    ['/usr/bin/xcrun', 'stapler', 'validate', image],
    [
      '/usr/sbin/spctl',
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      image,
    ],
  ]);
});

test.each(['Invalid', 'In Progress', 'Rejected'])(
  'a %s submission never reaches stapling',
  async (status) => {
    notaryTools(status);
    await expect(notarizeDiskImage(image, 'Release', fingerprint)).rejects.toThrow(id);
    expect(execFile).toHaveBeenCalledTimes(1);
  },
);

test.each(['submit', 'staple', '--verify', 'validate', '--assess'])(
  'a failed %s cannot produce a notarization receipt',
  async (step) => {
    notaryTools('Accepted', step);
    await expect(notarizeDiskImage(image, 'Release', fingerprint)).rejects.toThrow(
      'Apple tool failed',
    );
    expect(execFile.mock.calls.at(-1)[1]).toContain(step);
  },
);

test('an independently required notarization cannot be removed from the receipt', () => {
  const signed = { signed: true, signingFingerprint: fingerprint };
  verifyDmgReceipt({ ...signed, notarySubmissionId: id }, fingerprint, true);
  expect(() => verifyDmgReceipt(signed, fingerprint, true)).toThrow('notarized DMG');
  expect(() => verifyDmgReceipt({ ...signed, notarySubmissionId: '' }, fingerprint)).toThrow(
    'notarized DMG',
  );
  expect(() => verifyDmgReceipt({ signed: false, notarySubmissionId: id }, undefined)).toThrow(
    'notarized DMG',
  );
});
