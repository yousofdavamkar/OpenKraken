import { buildAskpass } from './build-askpass.mjs';
import { copyRuntimeDependencies } from './runtime-dependencies.mjs';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { join, resolve } from 'node:path';
import { cp } from 'node:fs/promises';
import { reportDestination } from '../apps/desktop/src/report-destination.ts';
import { updateConfiguration } from '../apps/desktop/src/update-protocol.ts';
const reporting = reportDestination(process.env.OPENKRAKEN_SENTRY_DSN ?? null);
const updates = updateConfiguration(JSON.parse(process.env.OPENKRAKEN_UPDATE_CONFIG ?? 'null'));
const output = resolve(process.argv[2] ?? 'apps/desktop/dist');
await buildAskpass(join(output, 'helpers'));
await esbuild({
  entryPoints: {
    main: 'apps/desktop/src/bootstrap.ts',
    preload: 'apps/desktop/src/preload.ts',
    'git-service': 'apps/desktop/src/git-service.ts',
    'terminal-service': 'apps/desktop/src/terminal-service.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', '@parcel/watcher', 'node-pty'],
  target: 'node24',
  define: {
    __OPENKRAKEN_SENTRY_DSN__: JSON.stringify(reporting?.dsn ?? null),
    __OPENKRAKEN_UPDATE_CONFIG__: JSON.stringify(updates),
  },
  outdir: output,
  outExtension: { '.js': '.cjs' },
});
await vite({
  root: resolve('packages/ui'),
  base: './',
  build: { outDir: join(output, 'renderer'), emptyOutDir: true },
  worker: { format: 'es' },
});

await copyRuntimeDependencies(join(output, 'node_modules'));
await cp('apps/desktop/shell-integration', join(output, 'shell-integration'), {
  recursive: true,
});
