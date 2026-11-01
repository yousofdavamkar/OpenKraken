import { packager } from '@electron/packager';
import {
  flipFuses,
  getCurrentFuseWire,
  FuseVersion,
  FuseV1Options,
  FuseState,
} from '@electron/fuses';
import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const staging = resolve('release/staging');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp('apps/desktop/dist', join(staging, 'dist'), { recursive: true });
await writeFile(
  join(staging, 'package.json'),
  JSON.stringify({
    name: 'openkraken',
    productName: 'OpenKraken',
    version: '0.1.0',
    main: 'dist/main.cjs',
  }),
);
const outputs = await packager({
  dir: staging,
  out: 'release',
  name: 'OpenKraken',
  executableName: 'openkraken',
  electronVersion: '45.2.1',
  asar: true,
  overwrite: true,
});
for (const output of outputs) {
  const binary =
    process.platform === 'darwin'
      ? join(output, 'OpenKraken.app')
      : join(output, process.platform === 'win32' ? 'openkraken.exe' : 'openkraken');
  const values = {
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  };
  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: process.platform === 'darwin',
    ...values,
  });
  const wire = await getCurrentFuseWire(binary);
  for (const [key, enabled] of Object.entries(values))
    if (wire[key] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE))
      throw new Error(`Fuse ${key} verification failed`);
  console.log(`Packaged and verified fuses: ${output}`);
}
