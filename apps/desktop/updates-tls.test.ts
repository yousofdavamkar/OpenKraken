import { expect, test } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.skipIf(process.platform !== 'linux')(
  'real HTTPS requires trusted TLS, refuses redirects and verifies signed downloads',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-update-tls-'));
    const run = promisify(execFile);
    const cert = join(root, 'cert.pem');
    const key = join(root, 'key.pem');
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ]);
      const signingKeys = generateKeyPairSync('ed25519');
      const now = Date.now();
      const payload = Buffer.from(
        JSON.stringify({
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
              name: 'OpenKraken.AppImage',
              size: 7,
              sha256: 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
            },
          ],
        }),
      );
      const envelope = JSON.stringify({
        payload: payload.toString('base64'),
        signature: sign(
          null,
          Buffer.concat([Buffer.from('OPENKRAKEN-UPDATE-V1\n'), payload]),
          signingKeys.privateKey,
        ).toString('base64'),
      });
      let mode: 'valid' | 'redirect' | 'corrupt' = 'valid';
      const received: {
        url: string;
        cookie?: string;
        authorization?: string;
        referrer?: string;
      }[] = [];
      server = createServer(
        { key: await readFile(key), cert: await readFile(cert) },
        (request, response) => {
          received.push({
            url: request.url!,
            cookie: request.headers.cookie,
            authorization: request.headers.authorization,
            referrer: request.headers.referer,
          });
          if (mode === 'redirect') {
            response.writeHead(302, { Location: '/unexpected' });
            response.end();
          } else if (request.url === '/stable/release.json') response.end(envelope);
          else if (request.url === '/stable/OpenKraken.AppImage')
            response.end(mode === 'corrupt' ? 'fixturn' : 'fixture');
          else {
            response.writeHead(404);
            response.end();
          }
        },
      );
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing TLS fixture address');
      const configuration = {
        feed: `https://127.0.0.1:${address.port}/stable/release.json`,
        publicKey: signingKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      };
      await build({
        entryPoints: [resolve('apps/desktop/src/updates.ts')],
        outfile: join(root, 'updates.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
      });
      await writeFile(
        join(root, 'runner.cjs'),
        `
      const { Updates } = require('./updates.cjs');
      (async () => {
        const updater = new Updates(process.argv[2], ${JSON.stringify(configuration)},
          { version: '0.1.0', platform: 'linux', arch: 'x64' });
        try {
          let state = await updater.check();
          if (state.phase === 'available') state = await updater.download('AppImage');
          console.log(JSON.stringify(state));
        } finally { await updater.close(); }
      })().catch(() => { process.exitCode = 1; });
    `,
      );
      const invoke = async (name: string, trust = true) => {
        const env = { ...process.env };
        delete env.NODE_TLS_REJECT_UNAUTHORIZED;
        delete env.NODE_EXTRA_CA_CERTS;
        if (trust) env.NODE_EXTRA_CA_CERTS = cert;
        const result = await run(process.execPath, [join(root, 'runner.cjs'), join(root, name)], {
          env,
          timeout: 15000,
        });
        return JSON.parse(result.stdout);
      };
      expect(await invoke('untrusted', false)).toMatchObject({ phase: 'error', error: 'network' });
      expect(received).toHaveLength(0);
      expect(await invoke('valid')).toMatchObject({ phase: 'verified', downloaded: 7 });
      expect(await readFile(join(root, 'valid/artifact.ready'), 'utf8')).toBe('fixture');
      expect(received.map(({ url }) => url)).toEqual([
        '/stable/release.json',
        '/stable/OpenKraken.AppImage',
      ]);
      for (const request of received)
        expect(request).toMatchObject({
          cookie: undefined,
          authorization: undefined,
          referrer: undefined,
        });
      mode = 'redirect';
      expect(await invoke('redirect')).toMatchObject({ phase: 'error', error: 'network' });
      expect(received.map(({ url }) => url)).not.toContain('/unexpected');
      mode = 'corrupt';
      expect(await invoke('corrupt')).toMatchObject({ phase: 'error', error: 'integrity' });
      await expect(readFile(join(root, 'corrupt/artifact.ready'))).rejects.toThrow();
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
