import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  updateConfiguration,
  updateEnvelopeLimit,
  verifyUpdateRelease,
} from '../apps/desktop/src/update-protocol.ts';
import {
  readUpdateEnvelope,
  requestUpdateFile,
  verifyUpdateArtifact,
} from '../apps/desktop/src/update-transfer.ts';

async function verifyFeed() {
  const [configPath, envelopePath] = process.argv.slice(2);
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: node scripts/verify-update-feed.mjs build-config.json signed-release.json',
    );
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('TLS verification must be enabled');
  const config = updateConfiguration(JSON.parse(await readFile(configPath, 'utf8')));
  if (!config) throw new Error('The build has no update feed');
  const expected = verifyUpdateRelease(await readFile(envelopePath, 'utf8'), config, Date.now());

  async function checkManifest() {
    const signal = AbortSignal.timeout(30_000);
    const body = await requestUpdateFile(fetch, config.feed, signal);
    const text = await readUpdateEnvelope(body, updateEnvelopeLimit, signal);
    const served = verifyUpdateRelease(text, config, Date.now());
    if (served.digest !== expected.digest)
      throw new Error('The feed serves a different release than the signed candidate');
  }

  await checkManifest();
  for (const artifact of expected.release.artifacts) {
    const signal = AbortSignal.timeout(10 * 60_000);
    const url = new URL(artifact.name, config.feed);
    try {
      const body = await requestUpdateFile(fetch, url.href, signal, artifact.size);
      await verifyUpdateArtifact(body, artifact, signal);
    } catch (cause) {
      throw new Error(`Could not verify ${artifact.name}: ${cause.message}`, { cause });
    }
  }
  // A feed may advance or a candidate may expire while large installers download.
  await checkManifest();
  console.log(
    JSON.stringify({
      feed: config.feed,
      channel: expected.release.channel,
      version: expected.release.version,
      sequence: expected.release.sequence,
      publicKeySha256: createHash('sha256')
        .update(Buffer.from(config.publicKey, 'base64'))
        .digest('hex'),
      payloadSha256: expected.digest,
      issuedAt: expected.release.issuedAt,
      expiresAt: expected.release.expiresAt,
      artifacts: expected.release.artifacts,
    }),
  );
}

try {
  await verifyFeed();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
