import { expect, test } from 'vitest';
import { verifyLinuxPackageFields } from './linux-package.mjs';

test.each([
  ['deb', 'x64', 'amd64', '0.1.0', '0.1.0'],
  ['deb', 'arm64', 'arm64', '0.2.0-beta.2', '0.2.0~beta.2-37'],
  ['rpm', 'x64', 'x86_64', '0.1.0', '0:0.1.0-1'],
  ['rpm', 'arm64', 'aarch64', '0.2.0-beta.10', '0:0.2.0~beta.10-5.fc43'],
])(
  'matches %s metadata for %s and binds its full native version',
  (target, arch, nativeArch, version, nativePackageVersion) => {
    const manifest = { target, arch, version };
    const fields = ['openkraken', nativeArch, nativePackageVersion];
    expect(verifyLinuxPackageFields(fields, manifest)).toBe(nativePackageVersion);
    expect(verifyLinuxPackageFields(fields, { ...manifest, nativePackageVersion })).toBe(
      nativePackageVersion,
    );
    expect(() =>
      verifyLinuxPackageFields(fields, {
        ...manifest,
        nativePackageVersion: nativePackageVersion + '1',
      }),
    ).toThrow(/version/);
    expect(() =>
      verifyLinuxPackageFields(['other', nativeArch, nativePackageVersion], manifest),
    ).toThrow(/name/);
    expect(() =>
      verifyLinuxPackageFields(fields, { ...manifest, arch: arch === 'arm64' ? 'x64' : 'arm64' }),
    ).toThrow(/architecture/);
  },
);

test.each([
  ['deb', 'amd64', '0.2.1', '0.2.0'],
  ['deb', 'amd64', '1:0.2.0', '0.2.0'],
  ['deb', 'amd64', '0.2.0-beta.1', '0.2.0-beta.1'],
  ['rpm', 'x86_64', '1:0.2.0-1', '0.2.0'],
  ['rpm', 'x86_64', '0:0.2.0~beta.10-1', '0.2.0-beta.1'],
  ['rpm', 'x86_64', '0:0.2.0', '0.2.0'],
])('rejects %s native version %s %s for release %s', (target, arch, nativeVersion, version) => {
  expect(() =>
    verifyLinuxPackageFields(['openkraken', arch, nativeVersion], { target, arch: 'x64', version }),
  ).toThrow(/version/);
});
