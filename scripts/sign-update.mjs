import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  updateEnvelopeLimit,
  updateSignatureContext,
  validateUpdateRelease,
} from '../apps/desktop/src/update-protocol.ts';

// Offline release producer: it never uploads, installs, or reads keys from the environment.
async function publish() {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    throw new Error('Usage: sign-update.mjs descriptor.json private-key.pem release.json');
  const [descriptorPath, keyPath, outputPath] = args.map((path) => resolve(path));
  const input = await readFile(descriptorPath, 'utf8');
  if (Buffer.byteLength(input) > 32 * 1024) throw new Error('Descriptor is too large');
  const descriptor = JSON.parse(input);
  if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length > 16)
    throw new Error('Invalid artifact list');
  const artifacts = [];
  for (const artifact of descriptor.artifacts) {
    if (
      typeof artifact !== 'object' ||
      artifact === null ||
      Object.keys(artifact).sort().join(',') !== 'arch,format,path,platform' ||
      typeof artifact.path !== 'string' ||
      artifact.path.length > 4096
    )
      throw new Error('Invalid artifact descriptor');
    const path = resolve(dirname(descriptorPath), artifact.path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > 2 * 1024 ** 3)
        throw new Error('Invalid artifact file');
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > before.size) throw new Error('Artifact changed during signing');
        hash.update(chunk);
      }
      const after = await file.stat();
      if (
        size !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error('Artifact changed during signing');
      artifacts.push({
        platform: artifact.platform,
        arch: artifact.arch,
        format: artifact.format,
        name: basename(path),
        size,
        sha256: hash.digest('hex'),
      });
    } finally {
      await file.close();
    }
  }
  const release = validateUpdateRelease({ ...descriptor, artifacts }, Date.now());
  const keyBytes = await readFile(keyPath);
  if (keyBytes.length > 16 * 1024) throw new Error('Invalid signing key');
  const key = createPrivateKey(keyBytes);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signing key required');
  const payload = Buffer.from(JSON.stringify(release));
  const signature = sign(null, Buffer.concat([Buffer.from(updateSignatureContext), payload]), key);
  const envelope =
    JSON.stringify({
      payload: payload.toString('base64'),
      signature: signature.toString('base64'),
    }) + '\n';
  if (Buffer.byteLength(envelope) > updateEnvelopeLimit) throw new Error('Release is too large');
  // Exclusive creation prevents accidentally replacing a previously published sequence.
  const output = await open(outputPath, 'wx', 0o644);
  try {
    await output.writeFile(envelope);
    await output.sync();
  } finally {
    await output.close();
  }
  console.log(
    JSON.stringify({
      publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
      sequence: release.sequence,
      version: release.version,
    }),
  );
}

try {
  await publish();
} catch {
  // Descriptor paths and signing material must not leak into logs on errors.
  console.error(
    'Update signing failed. Check the descriptor, key, artifact files and unused output path.',
  );
  process.exitCode = 1;
}
