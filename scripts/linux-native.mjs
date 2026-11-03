import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
async function run(engine, args) {
  const child = spawn(engine, args, { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Native Linux build failed: ${code ?? signal}`)),
    );
  });
}

export async function buildLinuxNative(staging) {
  if (process.platform !== 'linux') return;
  if (!['x64', 'arm64'].includes(process.arch))
    throw new Error('Native Linux packaging supports x64 and arm64 only');
  const platform = `linux/${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const engine = process.env.OPENKRAKEN_CONTAINER_ENGINE ?? 'docker';
  const dockerfile = resolve('build-resources/linux-native.Dockerfile');
  const fingerprint = createHash('sha256')
    .update(await readFile(dockerfile))
    .digest('hex')
    .slice(0, 16);
  const tag = `localhost/openkraken-native:${process.arch}-${fingerprint}`;
  try {
    await execute(engine, ['image', 'inspect', tag]);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        'Linux packaging needs Docker or OPENKRAKEN_CONTAINER_ENGINE pointing to Podman',
        { cause: error },
      );
    await run(engine, [
      'build',
      '--platform',
      platform,
      '--network=host',
      '--file',
      dockerfile,
      '--tag',
      tag,
      resolve('build-resources'),
    ]);
  }
  const { stdout } = await execute(engine, ['image', 'inspect', '--format', '{{.Id}}', tag]);
  const image = stdout.trim();
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(image))
    throw new Error('Invalid native build image identity');
  const native = join(staging, 'dist/node_modules/node-pty');
  await rm(join(native, 'build'), { recursive: true, force: true });
  const modules = resolve('node_modules');
  const gyp = relative(modules, require.resolve('node-gyp/bin/node-gyp.js'));
  if (gyp.startsWith('..')) throw new Error('node-gyp must be installed in the workspace');
  await run(engine, [
    'run',
    '--rm',
    '--platform',
    platform,
    '--network=none',
    ...(basename(engine).includes('podman') ? ['--userns=keep-id', '--cgroups=disabled'] : []),
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--volume',
    `${modules}:/tools:ro`,
    '--volume',
    `${resolve(native)}:/build:rw`,
    '--workdir',
    '/build',
    image,
    'node',
    `/tools/${gyp}`,
    'rebuild',
    '--nodedir=/usr',
    '--jobs=2',
  ]);
  console.log(`Built native terminal with Node-API 8 in Debian 13: ${image}`);
}
