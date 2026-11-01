import { copyRuntimeDependencies } from './runtime-dependencies.mjs';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { resolve } from 'node:path';
await esbuild({
  entryPoints: {
    main: 'apps/desktop/src/main.ts',
    preload: 'apps/desktop/src/preload.ts',
    'git-service': 'apps/desktop/src/git-service.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', '@parcel/watcher'],
  target: 'node24',
  outdir: 'apps/desktop/dist',
  outExtension: { '.js': '.cjs' },
});
await vite({
  root: resolve('packages/ui'),
  base: './',
  build: { outDir: resolve('apps/desktop/dist/renderer'), emptyOutDir: true },
  worker: { format: 'es' },
});

await copyRuntimeDependencies(resolve('apps/desktop/dist/node_modules'));
