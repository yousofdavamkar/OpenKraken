import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { sha256 } from './package-security.mjs';

const run = promisify(execFile);
if (process.argv.length !== 3)
  throw new Error('Provide a new directory for the fixture public keys');
const publicDir = resolve(process.argv[2]);
await mkdir(publicDir, { mode: 0o700 });
const fixture = await mkdtemp(join(tmpdir(), 'openkraken-rpm-'));
const home = join(fixture, 'gpg');
const signed = resolve(`release/installers/linux-${process.arch}/test-signed/rpm`);
const unsigned = resolve(`release/installers/linux-${process.arch}/test/rpm`);
const trusted = join(publicDir, 'trusted.asc');
const unrelated = join(publicDir, 'unrelated.asc');
const verify = (manifest, key) =>
  run(process.execPath, [
    'scripts/verify-installer.mjs',
    manifest,
    ...(key ? ['--rpm-key', key] : []),
  ]);
async function reject(manifest, key, expected) {
  await assert.rejects(verify(manifest, key), (error) => {
    assert.match(error.stderr, expected);
    assert.doesNotMatch(
      error.stdout,
      /Installer payload, launch entry and Electron fuses verified/,
    );
    return true;
  });
}
try {
  await mkdir(home, { mode: 0o700 });
  const env = { ...process.env, GNUPGHOME: home };
  for (const [id, file] of [
    ['signer', trusted],
    ['unrelated', unrelated],
  ]) {
    const email = `${id}@example.invalid`;
    await run(
      'gpg',
      [
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        '--quick-gen-key',
        email,
        'rsa2048',
        'sign',
        '1d',
      ],
      { env },
    );
    const { stdout } = await run('gpg', ['--armor', '--export', email], { env });
    await writeFile(file, stdout);
  }
  await run(
    process.execPath,
    ['scripts/installers.mjs', '--target', 'rpm', '--test-metadata', '--rpm-key', trusted],
    { env },
  );
  await run('gpgconf', ['--kill', 'gpg-agent'], { env });
  await rm(home, { recursive: true });

  const source = join(signed, 'manifest.json');
  const receipt = JSON.parse(await readFile(source, 'utf8'));
  const packageFile = join(fixture, receipt.artifact.file);
  const manifest = join(fixture, 'manifest.json');
  await copyFile(join(signed, receipt.artifact.file), packageFile);
  await copyFile(source, manifest);

  // Retire the source path during verification, as a concurrent rebuild can.
  // The subsequent desktop smoke must launch the previously authenticated bytes.
  const smoke = verify(manifest, trusted);
  const lines = createInterface({ input: smoke.child.stdout });
  const retireSource = async () => {
    let retired = false;
    for await (const line of lines) {
      if (line.startsWith('Verified RPM signature against trusted certificate ')) {
        await rename(packageFile, join(fixture, 'previous.rpm'));
        retired = true;
      }
    }
    assert.ok(retired, 'Verifier did not authenticate the RPM');
  };
  const [{ stdout }] = await Promise.all([smoke, retireSource()]);
  process.stdout.write(stdout);
  await reject(source, undefined, /Verifying a signed RPM requires --rpm-key/);
  const failedSignature =
    /RPM signature or digest failed verification with the trusted certificate/;
  await reject(source, unrelated, failedSignature);
  const combined = join(fixture, 'combined.asc');
  await writeFile(combined, Buffer.concat([await readFile(trusted), await readFile(unrelated)]));
  await reject(source, combined, /Expected one OpenPGP public certificate/);

  await rename(join(fixture, 'previous.rpm'), packageFile);
  await writeFile(manifest, JSON.stringify({ ...receipt, signingFingerprint: '0'.repeat(40) }));
  await reject(manifest, trusted, /manifest signing fingerprint differs/);

  // Refresh the outer checksum for each invalid RPM to exercise native verification.
  async function writeReceipt() {
    receipt.artifact.size = (await stat(packageFile)).size;
    receipt.artifact.sha256 = await sha256(packageFile);
    await writeFile(manifest, JSON.stringify(receipt));
  }
  const handle = await open(packageFile, 'r+');
  try {
    const offset = receipt.artifact.size - 1;
    const byte = Buffer.alloc(1);
    assert.equal((await handle.read(byte, 0, 1, offset)).bytesRead, 1);
    byte[0] ^= 1;
    assert.equal((await handle.write(byte, 0, 1, offset)).bytesWritten, 1);
  } finally {
    await handle.close();
  }
  await writeReceipt();
  await reject(manifest, trusted, failedSignature);
  const unsignedReceipt = JSON.parse(await readFile(join(unsigned, 'manifest.json'), 'utf8'));
  await copyFile(join(unsigned, unsignedReceipt.artifact.file), packageFile);
  await writeReceipt();
  await reject(
    manifest,
    trusted,
    /RPM verified without the trusted signing key|RPM signature or digest failed verification/,
  );
  console.log('Signed RPM smoke passed and six invalid inputs were rejected');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
