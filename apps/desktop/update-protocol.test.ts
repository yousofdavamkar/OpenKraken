import { expect, test } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { updateConfiguration, verifyUpdateRelease } from './src/update-protocol.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const now = Date.now();
const release = {
  schemaVersion: 1,
  product: 'org.openkraken.desktop',
  channel: 'stable',
  sequence: 1,
  version: '0.2.0',
  issuedAt: now - 1000,
  expiresAt: now + 86400000,
  artifacts: [
    {
      platform: 'linux',
      arch: 'x64',
      format: 'AppImage',
      name: 'OpenKraken-0.2.0-linux-x64.AppImage',
      size: 7,
      sha256: createHash('sha256').update('fixture').digest('hex'),
    },
  ],
};
function envelope(value: unknown, privateKey = keys.privateKey) {
  const bytes = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: bytes.toString('base64'),
    signature: sign(
      null,
      Buffer.concat([Buffer.from('OPENKRAKEN-UPDATE-V1\n'), bytes]),
      privateKey,
    ).toString('base64'),
  });
}
const config = () =>
  updateConfiguration({ feed: 'https://updates.example.test/stable/release.json', publicKey })!;

test('a pinned Ed25519 key authenticates release identity, freshness and artifact digests', () => {
  const verified = verifyUpdateRelease(envelope(release), config(), now);
  expect(verified.release).toEqual(release);
  expect(verified.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(() =>
    verifyUpdateRelease(
      envelope(release, generateKeyPairSync('ed25519').privateKey),
      config(),
      now,
    ),
  ).toThrow();
  const tampered = JSON.parse(envelope(release));
  tampered.payload = Buffer.from(JSON.stringify({ ...release, version: '9.0.0' })).toString(
    'base64',
  );
  expect(() => verifyUpdateRelease(JSON.stringify(tampered), config(), now)).toThrow();
  for (const bad of [
    { ...release, product: 'other-product' },
    { ...release, channel: 'beta' },
    { ...release, issuedAt: now + 600000 },
    { ...release, expiresAt: now - 1 },
    { ...release, expiresAt: now + 31 * 86400000 },
    { ...release, sequence: 0 },
    { ...release, version: '02.0.0' },
    { ...release, version: '0.2.0-beta.1' },
    { ...release, artifacts: [release.artifacts[0], release.artifacts[0]] },
    ...[
      '../evil.AppImage',
      'https://evil.test/evil.AppImage',
      'evil%2fupdate.AppImage',
      'OpenKraken.exe',
    ].map((name) => ({ ...release, artifacts: [{ ...release.artifacts[0], name }] })),
    { ...release, artifacts: [{ ...release.artifacts[0], platform: 'win32' }] },
    { ...release, artifacts: [{ ...release.artifacts[0], url: 'https://evil.test' }] },
  ])
    expect(() => verifyUpdateRelease(envelope(bad), config(), now)).toThrow();
});

test('release configuration accepts only HTTPS and an exact Ed25519 public key', () => {
  expect(updateConfiguration(null)).toBeNull();
  for (const feed of [
    'http://updates.example.test/release.json',
    'file:///release.json',
    'https://user:secret@example.test/release.json',
    'https://example.test/release.json?token=private',
    'https://example.test/release.json#fragment',
  ])
    expect(() => updateConfiguration({ feed, publicKey })).toThrow();
  expect(() =>
    updateConfiguration({ feed: config().feed, publicKey: publicKey + 'junk' }),
  ).toThrow();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
  expect(() => updateConfiguration({ feed: config().feed, publicKey: rsa })).toThrow();
  expect(() =>
    updateConfiguration({ feed: config().feed, publicKey, allowInsecure: true }),
  ).toThrow();
});

test('bounded canonical envelopes reject alternate encodings and malformed signatures', () => {
  const valid = JSON.parse(envelope(release));
  for (const raw of [
    ' '.repeat(49 * 1024),
    '{',
    JSON.stringify({ ...valid, algorithm: 'none' }),
    JSON.stringify({ ...valid, payload: valid.payload + '\n' }),
    JSON.stringify({ ...valid, signature: valid.signature + '\n' }),
    JSON.stringify({ ...valid, signature: Buffer.alloc(63).toString('base64') }),
    JSON.stringify({ ...valid, payload: Buffer.alloc(33 * 1024).toString('base64') }),
    envelope({ ...release, extra: 'ignored?' }),
    envelope({ ...release, artifacts: [{ ...release.artifacts[0], size: 2 ** 32 }] }),
  ])
    expect(() => verifyUpdateRelease(raw, config(), now)).toThrow();
  expect(() => verifyUpdateRelease(envelope(release), config(), NaN)).toThrow();
});

test('build channel and signed channel must match even when the signing key is shared', () => {
  const stable = config();
  const beta = updateConfiguration({ ...stable, channel: 'beta' })!;
  const candidate = { ...release, channel: 'beta', version: '0.2.0-beta.2' };
  expect(verifyUpdateRelease(envelope(candidate), beta, now).release).toEqual(candidate);
  expect(() => verifyUpdateRelease(envelope(candidate), stable, now)).toThrow();
  expect(() => verifyUpdateRelease(envelope(release), beta, now)).toThrow();
  for (const version of [
    '0.2.0',
    '0.2.0-beta',
    '0.2.0-beta.01',
    '0.2.0-beta.2+local',
    '0.2.0-rc.1',
  ])
    expect(() => verifyUpdateRelease(envelope({ ...candidate, version }), beta, now)).toThrow();
  expect(updateConfiguration({ ...stable, channel: 'stable' })).toEqual(stable);
});
