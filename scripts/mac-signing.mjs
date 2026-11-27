import { sign } from '@electron/osx-sign';
import { execFile } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function macIdentity(target, value) {
  if (value === undefined) return undefined;
  if (target !== 'dmg' || typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value))
    throw new Error('--mac-identity requires a DMG target and a 40-digit certificate fingerprint');
  return value.toUpperCase();
}

const submissionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function verifyDmgReceipt(manifest, identity, requireNotarization = false) {
  if (manifest.signed !== Boolean(identity) || manifest.signingFingerprint !== identity)
    throw new Error('DMG signing receipt differs from the independently supplied --mac-identity');
  if (requireNotarization || manifest.notarySubmissionId !== undefined) {
    if (
      !identity ||
      typeof manifest.notarySubmissionId !== 'string' ||
      !submissionId.test(manifest.notarySubmissionId)
    )
      throw new Error('Expected a notarized DMG receipt and a trusted --mac-identity');
  }
}

// osx-sign also discovers binary data files such as app.asar and Chromium packs.
// Seal these as resources in their enclosing bundle. Only Mach-O code and code
// bundles need their own signature.
const machHeaders = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);
export function isMacCode(path) {
  if (statSync(path).isDirectory()) return /\.(app|framework)$/.test(path);
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && machHeaders.has(header.toString('hex'));
  } finally {
    closeSync(fd);
  }
}

export function signMacBundle(app, identity) {
  return sign({
    app,
    identity,
    platform: 'darwin',
    type: 'distribution',
    ignore: [(path) => !isMacCode(path)],
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile(file) {
      // The main process, generic utility helper and renderer host V8.
      const jit = file === app || / Helper(?: \(Renderer\))?\.app$/i.test(basename(file));
      return {
        hardenedRuntime: true,
        entitlements: resolve('build-resources', jit ? 'mac-jit.plist' : 'mac-empty.plist'),
      };
    },
  });
}

export function verifyMacSignature(path, identity, identifier) {
  const fingerprint = macIdentity('dmg', identity);
  if (!fingerprint) throw new Error('Missing trusted Developer ID fingerprint');
  const requirement = [
    'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    `certificate leaf = H"${fingerprint}"`,
    `identifier "${identifier}"`,
  ].join(' and ');
  return run('/usr/bin/codesign', ['--verify', '--strict', '-R=' + requirement, path], {
    timeout: 180_000,
  });
}

export async function signDiskImage(path, identity) {
  const identifier = 'org.openkraken.desktop.dmg';
  await run(
    '/usr/bin/codesign',
    ['--force', '--sign', identity, '--timestamp', '--identifier', identifier, path],
    { timeout: 180_000 },
  );
  await verifyMacSignature(path, identity, identifier);
}

export async function verifyNotaryTicket(path) {
  await run('/usr/bin/xcrun', ['stapler', 'validate', path], { timeout: 180_000 });
  await run(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', path],
    { timeout: 180_000 },
  );
}

export async function notarizeDiskImage(path, profile, identity) {
  const { stdout } = await run(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      path,
      '--keychain-profile',
      profile,
      '--wait',
      '--output-format',
      'json',
    ],
    { encoding: 'utf8' },
  );
  const { status, id } = JSON.parse(stdout);
  if (typeof id !== 'string' || !submissionId.test(id))
    throw new Error('Apple returned an invalid notarization submission ID');
  if (status !== 'Accepted')
    throw new Error(
      `Notarization ${id} returned ${status}. Read the submission log with xcrun notarytool log.`,
    );
  await run('/usr/bin/xcrun', ['stapler', 'staple', path], { timeout: 180_000 });
  await verifyMacSignature(path, identity, 'org.openkraken.desktop.dmg');
  await verifyNotaryTicket(path);
  return id;
}
