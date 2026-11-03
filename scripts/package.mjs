import { packager } from '@electron/packager';
import { flipFuses, FuseVersion } from '@electron/fuses';
import { packageFuses, verifyFuses } from './package-security.mjs';
import { buildLinuxNative } from './linux-native.mjs';
import { cp, mkdir, writeFile, rm, lstat, readdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const staging = resolve('release/staging');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp('apps/desktop/dist', join(staging, 'dist'), { recursive: true });
await buildLinuxNative(staging);
await writeFile(
  join(staging, 'package.json'),
  JSON.stringify({
    name: 'openkraken',
    productName: 'OpenKraken',
    version: '0.1.0',
    main: 'dist/main.cjs',
    desktopName: 'openkraken.desktop',
  }),
);
const outputs = await packager({
  dir: staging,
  out: 'release',
  name: 'OpenKraken',
  executableName: 'openkraken',
  electronVersion: '45.2.1',
  asar: {
    unpack: '**/*.node',
    unpackDir: 'dist/{helpers,node_modules/node-pty,shell-integration}',
  },
  overwrite: true,
});
for (const output of outputs) {
  if (process.platform === 'linux') {
    // Electron's ZIP permissions can be 0666/0777. Never ship an executable or
    // ASAR writable by other accounts, regardless of the builder's umask.
    async function normalizeModes(path) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      await chmod(path, info.isDirectory() || info.mode & 0o111 ? 0o755 : 0o644);
      if (info.isDirectory())
        for (const name of await readdir(path)) await normalizeModes(join(path, name));
    }
    await normalizeModes(output);
  }
  const binary =
    process.platform === 'darwin'
      ? join(output, 'OpenKraken.app')
      : join(output, process.platform === 'win32' ? 'openkraken.exe' : 'openkraken');
  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: process.platform === 'darwin',
    ...packageFuses,
  });
  await verifyFuses(binary);
  console.log(`Packaged and verified fuses: ${output}`);
}
