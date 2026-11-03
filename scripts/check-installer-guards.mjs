import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const source = resolve(process.argv[2]);
const original = JSON.parse(await readFile(source, 'utf8'));
const dmgChecks = async () =>
  (await readdir('release')).filter((name) => name.startsWith('dmg-check-')).sort();
const existingDmgChecks = original.target === 'dmg' ? await dmgChecks() : [];
const fixture = join(dirname(source), `rejection-${randomUUID()}.json`);
try {
  const corruptArchive = structuredClone(original);
  corruptArchive.artifact.sha256 = '0'.repeat(64);
  await writeFile(fixture, JSON.stringify(corruptArchive));
  await assert.rejects(
    run(process.execPath, ['scripts/verify-installer.mjs', fixture]),
    (error) => {
      assert.match(error.stderr, /Installer checksum or size mismatch/);
      assert.doesNotMatch(error.stdout, /Packaged|verified/);
      return true;
    },
  );

  const corruptPayload = structuredClone(original);
  const helper = Object.keys(original.payload).find((key) =>
    key.endsWith('/helpers/openkraken-askpass'),
  );
  assert.ok(helper, 'Native helper must be represented in the artifact manifest');
  corruptPayload.payload[helper].sha256 = '0'.repeat(64);
  await writeFile(fixture, JSON.stringify(corruptPayload));
  await assert.rejects(
    run(process.execPath, ['scripts/verify-installer.mjs', fixture]),
    (error) => {
      assert.match(error.stderr, /Installer payload differs: .*helpers\/openkraken-askpass/);
      assert.doesNotMatch(error.stdout, /Packaged|verified/);
      return true;
    },
  );
  if (original.target === 'dmg') {
    const wrongVersion = structuredClone(original);
    wrongVersion.version = `${original.version}-mismatch`;
    await writeFile(fixture, JSON.stringify(wrongVersion));
    await assert.rejects(
      run(process.execPath, ['scripts/verify-installer.mjs', fixture]),
      (error) => {
        assert.match(
          error.stderr,
          /macOS bundle identity, version, executable or repository scheme differs/,
        );
        assert.doesNotMatch(error.stdout, /Packaged|verified/);
        return true;
      },
    );
    assert.deepEqual(
      await dmgChecks(),
      existingDmgChecks,
      'Rejected DMGs must detach and clean up',
    );
  }
  console.log('Archive and native-helper mismatches rejected before desktop launch');
} finally {
  await rm(fixture, { force: true });
}
