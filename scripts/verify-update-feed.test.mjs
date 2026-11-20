import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
let directory, server, envelope, otherEnvelope;
const bodies = new Map([
  ['candidate.deb', Buffer.from('linux')],
  ['candidate.msi', Buffer.from('windows')],
]);
let mode;
const requests = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openkraken-feed-'));
  await run(process.execPath, [resolve('scripts/create-loopback-certificate.mjs'), directory]);
  const key = generateKeyPairSync('ed25519');
  await writeFile(
    join(directory, 'private.pem'),
    key.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  for (const [name, content] of bodies) await writeFile(join(directory, name), content);
  const now = Date.now();
  const descriptor = {
    schemaVersion: 1,
    product: 'org.openkraken.desktop',
    channel: 'beta',
    sequence: 3,
    version: '0.2.0-beta.3',
    issuedAt: now - 1000,
    expiresAt: now + 86400000,
    artifacts: [
      { platform: 'linux', arch: 'x64', format: 'deb', path: 'candidate.deb' },
      { platform: 'win32', arch: 'x64', format: 'msi', path: 'candidate.msi' },
    ],
  };
  async function publish(name, input) {
    await writeFile(join(directory, 'input.json'), JSON.stringify(input));
    await run(
      process.execPath,
      [resolve('scripts/sign-update.mjs'), 'input.json', 'private.pem', name],
      { cwd: directory },
    );
    return readFile(join(directory, name));
  }
  envelope = await publish('signed.json', descriptor);
  otherEnvelope = await publish('different.json', { ...descriptor, issuedAt: now - 2000 });
  server = createServer(
    {
      key: await readFile(join(directory, 'key.pem')),
      cert: await readFile(join(directory, 'cert.pem')),
    },
    (req, res) => {
      const path = req.url;
      requests.push(path);
      if (req.headers['accept-encoding'] !== 'identity') return res.writeHead(406).end();
      if (path === '/beta/release.json') {
        if (mode === 'wrong-signature') {
          const signed = JSON.parse(envelope);
          signed.signature = Buffer.alloc(64).toString('base64');
          return res.end(JSON.stringify(signed));
        }
        if (mode === 'stale' || (mode === 'rotation' && requests.length > 1))
          return res.end(otherEnvelope);
        return res.end(envelope);
      }
      const name = path.slice('/beta/'.length);
      if (name === 'candidate.msi') {
        if (mode === 'missing') return res.writeHead(404).end();
        if (mode === 'redirect')
          return res.writeHead(302, { Location: '/storage/package.msi' }).end();
        if (mode === 'corrupt') return res.end('WINDOWS');
        if (mode === 'short') {
          res.write('win');
          return res.end();
        }
      }
      res.end(bodies.get(name));
    },
  );
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const config = {
    channel: 'beta',
    feed: `https://127.0.0.1:${server.address().port}/beta/release.json`,
    publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
}, 90_000);
beforeEach(() => {
  requests.length = 0;
  mode = 'ok';
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (directory) await rm(directory, { force: true, recursive: true });
});

function check(trust = true) {
  const env = { ...process.env };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (trust) env.NODE_EXTRA_CA_CERTS = join(directory, 'cert.pem');
  else delete env.NODE_EXTRA_CA_CERTS;
  return run(
    process.execPath,
    [resolve('scripts/verify-update-feed.mjs'), 'config.json', 'signed.json'],
    { cwd: directory, env },
  );
}

test('a served release verifies every platform and checks the manifest again at the end', async () => {
  const { stdout } = await check();
  expect(JSON.parse(stdout)).toMatchObject({
    channel: 'beta',
    version: '0.2.0-beta.3',
    sequence: 3,
    artifacts: [{ name: 'candidate.deb' }, { name: 'candidate.msi' }],
  });
  expect(requests).toEqual([
    '/beta/release.json',
    '/beta/candidate.deb',
    '/beta/candidate.msi',
    '/beta/release.json',
  ]);
});
test.each(['missing', 'redirect', 'corrupt', 'short'])(
  'a %s installer on another platform fails the release check',
  async (failure) => {
    mode = failure;
    await expect(check()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('candidate.msi'),
      stdout: '',
    });
    expect(requests).not.toContain('/storage/package.msi');
  },
);
test.each(['stale', 'rotation'])(
  'a different signed payload fails the check (%s)',
  async (failure) => {
    mode = failure;
    await expect(check()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('different release'),
      stdout: '',
    });
    expect(requests.length).toBe(mode === 'stale' ? 1 : 4);
  },
);
test('an untrusted server certificate fails before requesting the manifest', async () => {
  await expect(check(false)).rejects.toMatchObject({ code: 1, stdout: '' });
  expect(requests).toEqual([]);
});

test('the hosted manifest must authenticate before the verifier requests any installer', async () => {
  mode = 'wrong-signature';
  await expect(check()).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: expect.stringContaining('signature is invalid'),
  });
  expect(requests).toEqual(['/beta/release.json']);
});
