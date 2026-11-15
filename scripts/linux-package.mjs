import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const architectures = {
  deb: { x64: 'amd64', arm64: 'arm64' },
  rpm: { x64: 'x86_64', arm64: 'aarch64' },
};

export function verifyLinuxPackageFields(fields, { target, arch, version, nativePackageVersion }) {
  const [name, architecture, nativeVersion] = fields;
  const expectedArch = architectures[target]?.[arch];
  if (
    !expectedArch ||
    fields.length !== 3 ||
    name !== 'openkraken' ||
    architecture !== expectedArch
  )
    throw new Error('Linux package name or architecture differs from the release');

  // FPM maps SemVer prerelease hyphens to tildes so a beta sorts below the final
  // release. An optional Debian revision or the RPM release follows the last dash.
  const withoutEpoch = nativeVersion.replace(/^0:/, '');
  const dash = withoutEpoch.lastIndexOf('-');
  const upstream = dash === -1 ? withoutEpoch : withoutEpoch.slice(0, dash);
  if (
    typeof version !== 'string' ||
    !version ||
    upstream !== version.replaceAll('-', '~') ||
    (target === 'rpm' && dash === -1) ||
    withoutEpoch.endsWith('-') ||
    (nativePackageVersion !== undefined && nativeVersion !== nativePackageVersion)
  )
    throw new Error('Linux package version differs from the release');
  return nativeVersion;
}

export async function verifyLinuxPackage(artifact, manifest, work) {
  let result;
  if (manifest.target === 'deb') {
    result = await run('dpkg-deb', [
      '--showformat=${Package}\t${Architecture}\t${Version}\n',
      '--show',
      artifact,
    ]);
  } else if (manifest.target === 'rpm') {
    const database = join(work, 'rpmdb');
    await mkdir(database, { recursive: true });
    result = await run('rpm', [
      '--dbpath',
      database,
      '-qp',
      '--qf',
      '%{NAME}\t%{ARCH}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\n',
      artifact,
    ]);
  } else throw new Error('Expected a DEB or RPM');
  return verifyLinuxPackageFields(result.stdout.trimEnd().split('\t'), manifest);
}
