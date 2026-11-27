import { createHash, createPublicKey, verify } from 'node:crypto';
import { parse as parseVersion } from 'semver';
import { z } from 'zod';

export const updateEnvelopeLimit = 48 * 1024;
const payloadLimit = 32 * 1024;
export const updateSignatureContext = 'OPENKRAKEN-UPDATE-V1\n';

const channelSchema = z.enum(['stable', 'beta']);
const trustRootSchema = z.strictObject({
  feed: z.string().min(1).max(2048),
  publicKey: z.string().min(1).max(128),
});

const configurationSchema = z.strictObject({
  channel: channelSchema.optional(),
  ...trustRootSchema.shape,
  migrateFrom: trustRootSchema.optional(),
});

function base64(raw: string, limit: number): Buffer {
  if (raw.length > Math.ceil(limit / 3) * 4) throw new Error('Invalid update encoding');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== raw)
    throw new Error('Invalid update encoding');
  return bytes;
}

function validateTrustRoot(config: z.infer<typeof trustRootSchema>) {
  const url = new URL(config.feed);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== config.feed ||
    url.pathname.endsWith('/')
  )
    throw new Error('Updates require a canonical HTTPS feed without credentials or parameters');
  const der = base64(config.publicKey, 44);
  const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
  if (
    der.length !== 44 ||
    key.asymmetricKeyType !== 'ed25519' ||
    !key.export({ type: 'spki', format: 'der' }).equals(der)
  )
    throw new Error('Updates require an Ed25519 public key');
}

/** Both the active root and the optional predecessor are fixed in the trusted build. */
export function updateConfiguration(raw: unknown) {
  if (raw === null) return null;
  const config = configurationSchema.parse(raw);
  validateTrustRoot(config);
  if (config.migrateFrom) {
    validateTrustRoot(config.migrateFrom);
    if (
      config.migrateFrom.feed === config.feed &&
      config.migrateFrom.publicKey === config.publicKey
    )
      throw new Error('Update migration requires a different preceding feed or key');
  }
  // Existing stable profiles bind their watermark to the original two-field configuration.
  if (config.channel === 'stable') delete config.channel;
  return config;
}

export type UpdateConfiguration = NonNullable<ReturnType<typeof updateConfiguration>>;

export const updateArtifactSchema = z
  .strictObject({
    platform: z.enum(['linux', 'darwin', 'win32']),
    arch: z.enum(['x64', 'arm64']),
    format: z.enum(['AppImage', 'deb', 'rpm', 'dmg', 'zip', 'msi']),
    name: z
      .string()
      .max(180)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    size: z
      .number()
      .int()
      .min(1)
      .max(2 * 1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((artifact) => {
    const formats = { linux: ['AppImage', 'deb', 'rpm'], darwin: ['dmg', 'zip'], win32: ['msi'] };
    return (
      formats[artifact.platform].includes(artifact.format) &&
      artifact.name.endsWith(`.${artifact.format}`) &&
      !artifact.name.includes('..')
    );
  });

export const releaseVersionSchema = z
  .string()
  .max(100)
  .refine((value) => {
    const parsed = parseVersion(value);
    return parsed?.version === value && /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(value);
  });

const releaseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    product: z.literal('org.openkraken.desktop'),
    channel: channelSchema,
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    version: releaseVersionSchema,
    issuedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    artifacts: z.array(updateArtifactSchema).min(1).max(16),
  })
  .refine((release) => {
    if ((release.channel === 'beta') !== release.version.includes('-beta.')) return false;
    const identities = release.artifacts.map((a) => `${a.platform}/${a.arch}/${a.format}`);
    const names = release.artifacts.map((a) => a.name.toLowerCase());
    return new Set(identities).size === identities.length && new Set(names).size === names.length;
  });

export type UpdateRelease = z.infer<typeof releaseSchema>;
export type UpdateArtifact = UpdateRelease['artifacts'][number];

/** Shared by the publisher and verifier; no unsigned metadata reaches the updater. */
export function validateUpdateRelease(raw: unknown, now: number): UpdateRelease {
  const release = releaseSchema.parse(raw);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    release.issuedAt > now + 5 * 60_000 ||
    release.expiresAt <= now ||
    release.expiresAt <= release.issuedAt ||
    release.expiresAt - release.issuedAt > 30 * 86400_000
  )
    throw new Error('Update release is outside its validity period');
  return release;
}

const envelopeSchema = z.strictObject({ payload: z.string(), signature: z.string() });

export function verifyUpdateRelease(raw: string, configuration: UpdateConfiguration, now: number) {
  // Validate even when called by a publisher/test rather than the configured main process.
  const config = updateConfiguration(configuration)!;
  if (Buffer.byteLength(raw) > updateEnvelopeLimit) throw new Error('Update envelope is too large');
  const envelope = envelopeSchema.parse(JSON.parse(raw));
  const payload = base64(envelope.payload, payloadLimit);
  const signature = base64(envelope.signature, 64);
  const key = createPublicKey({
    key: Buffer.from(config.publicKey, 'base64'),
    type: 'spki',
    format: 'der',
  });
  if (
    signature.length !== 64 ||
    !verify(null, Buffer.concat([Buffer.from(updateSignatureContext), payload]), key, signature)
  )
    throw new Error('Update signature is invalid');
  const release = validateUpdateRelease(JSON.parse(payload.toString('utf8')), now);
  if (release.channel !== (config.channel ?? 'stable')) throw new Error('Update channel differs');
  return { release, digest: createHash('sha256').update(payload).digest('hex') };
}
