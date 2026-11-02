import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
/** Opt-in Linux container fixture. It binds only loopback and never changes system Git/SSH config. */
export async function startGitea(root: string) {
  if (process.platform !== 'linux')
    throw new Error('The Gitea container fixture requires Linux host networking');
  const engine = process.env.OPENKRAKEN_CONTAINER_ENGINE ?? 'docker';
  const image = process.env.OPENKRAKEN_GITEA_IMAGE ?? 'docker.io/gitea/gitea:1.26.4-rootless';
  const name = `openkraken-test-${randomUUID()}`;
  const httpsPort = await freePort(),
    sshPort = await freePort();
  const base = `https://127.0.0.1:${httpsPort}`;
  const config = join(root, 'gitea-config'),
    data = join(root, 'gitea-data');
  await mkdir(config, { recursive: true });
  await mkdir(data, { recursive: true });
  const certificate = resolve('packages/test-fixtures/tls/localhost-test.crt');
  const ca = await readFile(certificate);
  await copyFile(certificate, join(config, 'test.crt'));
  await copyFile(
    resolve('packages/test-fixtures/tls/localhost-test.key'),
    join(config, 'test.key'),
  );
  await writeFile(
    join(config, 'app.ini'),
    `APP_NAME = OpenKraken test\nRUN_MODE = prod\nRUN_USER = git\n[database]\nDB_TYPE = sqlite3\nPATH = /var/lib/gitea/data/gitea.db\n[repository]\nROOT = /var/lib/gitea/git/repositories\n[server]\nPROTOCOL = https\nHTTP_ADDR = 127.0.0.1\nHTTP_PORT = ${httpsPort}\nROOT_URL = ${base}/\nCERT_FILE = /etc/gitea/test.crt\nKEY_FILE = /etc/gitea/test.key\nSTART_SSH_SERVER = true\nSSH_LISTEN_HOST = 127.0.0.1\nSSH_LISTEN_PORT = ${sshPort}\nSSH_DOMAIN = 127.0.0.1\nSSH_PORT = ${sshPort}\nAPP_DATA_PATH = /var/lib/gitea\n[security]\nINSTALL_LOCK = true\n[service]\nDISABLE_REGISTRATION = true\n[actions]\nENABLED = false\n[log]\nMODE = console\nLEVEL = Warn\n`,
  );
  const credentials = { username: 'fixture-user', password: 'Fixture-password-17' };
  const authorization =
    'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  const api = (path: string, method = 'GET', body?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const input = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        base + '/api/v1' + path,
        {
          method,
          ca,
          headers: {
            ...(path === '/version' ? {} : { Authorization: authorization }),
            ...(input
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(input) }
              : {}),
          },
        },
        (response) => {
          let bytes = '';
          response.on('data', (chunk: Buffer) => {
            bytes += chunk;
            if (bytes.length > 1048576) req.destroy(new Error('Oversized fixture API response'));
          });
          response.on('end', () => {
            if (!response.statusCode || response.statusCode >= 300) {
              reject(new Error(`Gitea ${method} ${path}: ${response.statusCode}: ${bytes}`));
              return;
            }
            try {
              resolve(bytes ? JSON.parse(bytes) : null);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(3000, () => req.destroy(new Error('Fixture API timeout')));
      req.on('error', reject);
      req.end(input);
    });
  const stop = async () => {
    await exec(engine, ['rm', '--force', name], { timeout: 15000 });
  };
  try {
    await exec(
      engine,
      [
        'run',
        '--detach',
        '--name',
        name,
        '--network=host',
        ...(basename(engine).includes('podman') ? ['--userns=keep-id'] : []),
        `--user=${process.getuid!()}:${process.getgid!()}`,
        '--volume',
        `${config}:/etc/gitea`,
        '--volume',
        `${data}:/var/lib/gitea`,
        image,
      ],
      { timeout: 180000 },
    );
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await api('/version');
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!ready) {
      const logs = await exec(engine, ['logs', name]);
      throw new Error('Gitea did not start: ' + logs.stdout + logs.stderr);
    }
    await exec(
      engine,
      [
        'exec',
        name,
        'gitea',
        '--config',
        '/etc/gitea/app.ini',
        'admin',
        'user',
        'create',
        '--username',
        credentials.username,
        '--password',
        credentials.password,
        '--email',
        'fixture@example.test',
        '--must-change-password=false',
      ],
      { timeout: 30000 },
    );
    await api('/user/repos', 'POST', {
      name: 'fixture',
      private: true,
      auto_init: false,
      default_branch: 'main',
    });
    const key = join(root, 'encrypted key');
    const passphrase = 'Fixture-key-passphrase-23';
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', key]);
    await api('/user/keys', 'POST', {
      title: 'fixture key',
      key: await readFile(key + '.pub', 'utf8'),
    });
    const httpsUrl = `${base}/${credentials.username}/fixture.git`;
    const sshUrl = `ssh://git@127.0.0.1:${sshPort}/${credentials.username}/fixture.git`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const environment = {
      ...process.env,
      GIT_SSL_CAINFO: certificate,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_SSH_COMMAND: `ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=ask -o UserKnownHostsFile=${quote(join(root, 'known_hosts'))} -i ${quote(key)}`,
    };
    const push = async (source: string, destination = 'refs/heads/main', sourceRef = 'HEAD') => {
      await exec(
        'git',
        [
          '-c',
          `http.extraHeader=Authorization: ${authorization}`,
          'push',
          '--',
          httpsUrl,
          `${sourceRef}:${destination}`,
        ],
        { cwd: source, env: environment, timeout: 30000 },
      );
    };
    const tip = async (ref = 'refs/heads/main') => {
      const result = await exec(
        'git',
        [
          '-c',
          `http.extraHeader=Authorization: ${authorization}`,
          'ls-remote',
          '--refs',
          '--',
          httpsUrl,
          ref,
        ],
        { env: environment, timeout: 30000 },
      );
      return result.stdout.trim().split('\t')[0]!;
    };
    return { httpsUrl, sshUrl, credentials, passphrase, environment, push, tip, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
