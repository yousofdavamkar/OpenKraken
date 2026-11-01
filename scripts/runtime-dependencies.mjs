import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { cp, mkdir, readFile } from 'node:fs/promises';
// Keep native Node-API addons as packages instead of bundling dynamic requires.
export async function copyRuntimeDependencies(target) {
  async function copy(name, from, destination) {
    const require = createRequire(join(from, 'package.json'));
    let manifest;
    try {
      manifest = require.resolve(`${name}/package.json`);
    } catch {
      return false;
    }
    const source = dirname(manifest),
      out = join(destination, name);
    await mkdir(dirname(out), { recursive: true });
    await cp(source, out, {
      recursive: true,
      dereference: true,
      filter: (path) => path === source || !path.startsWith(join(source, 'node_modules')),
    });
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies ?? {}))
      if (!(await copy(dependency, source, join(out, 'node_modules'))))
        throw new Error(`Missing runtime dependency ${dependency}`);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {}))
      await copy(dependency, source, join(out, 'node_modules'));
    return true;
  }
  if (!(await copy('@parcel/watcher', resolve('packages/git-core'), target)))
    throw new Error('Missing native watcher package');
}
