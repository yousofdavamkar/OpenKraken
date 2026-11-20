import { beforeEach, expect, test, vi } from 'vitest';

const { execFile, sign } = vi.hoisted(() => ({ execFile: vi.fn(), sign: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('@electron/osx-sign', () => ({ sign }));

import { signMacBundle, signDiskImage } from './mac-signing.mjs';

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
