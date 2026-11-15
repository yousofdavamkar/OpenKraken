import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The caller supplies the trusted certificate independently of the package manifest. */
export async function authenticateRpm(artifact, certificate, work, { sign = false } = {}) {
  // Snapshot the certificate once so GnuPG and RPM inspect the same bytes.
  const trusted = join(work, 'trusted-rpm-key.asc');
  await writeFile(trusted, await readFile(certificate), { flag: 'wx', mode: 0o600 });
  const keyring = join(work, 'public-keyring');
  await mkdir(keyring, { mode: 0o700 });
  const { stdout } = await run('gpg', [
    '--batch',
    '--no-options',
    '--homedir',
    keyring,
    '--with-colons',
    '--show-keys',
    trusted,
  ]);
  const records = stdout.split('\n').map((row) => row.split(':'));
  const primary = records.findIndex(([type]) => type === 'pub');
  const fingerprint = records[primary + 1]?.[9];
  if (
    records.filter(([type]) => type === 'pub' || type === 'sec').length !== 1 ||
    primary < 0 ||
    records[primary + 1]?.[0] !== 'fpr' ||
    !/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(fingerprint ?? '')
  )
    throw new Error('Expected one OpenPGP public certificate for RPM signing');

  const database = join(work, 'rpmdb');
  await mkdir(database, { mode: 0o700 });
  const isolated = ['--dbpath', database, '--define', '_keyring rpmdb'];
  if (sign) {
    await run('rpmsign', [
      ...isolated,
      '--define',
      `_gpg_name ${fingerprint}`,
      '--define',
      `_openpgp_sign_id ${fingerprint}`,
      '--addsign',
      artifact,
    ]);
  }
  await run('rpmdb', [...isolated, '--initdb']);
  const check = [...isolated, '--define', '_pkgverify_level all', '--checksig', artifact];
  // Some RPM versions accept an unsigned package on its digests alone. Require
  // the same check to fail without a key and succeed with just the supplied key.
  const verifiedWithoutKey = await run('rpmkeys', check).then(
    () => true,
    (error) => {
      if (error.code !== 1) throw error;
      return false;
    },
  );
  if (verifiedWithoutKey) throw new Error('RPM verified without the trusted signing key');
  await run('rpmkeys', [...isolated, '--import', trusted]);
  try {
    await run('rpmkeys', check);
  } catch (cause) {
    if (cause.code !== 1) throw cause;
    throw new Error('RPM signature or digest failed verification with the trusted certificate', {
      cause,
    });
  }
  return fingerprint;
}
