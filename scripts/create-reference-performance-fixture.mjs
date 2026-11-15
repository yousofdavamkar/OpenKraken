import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performanceGit as git } from './create-performance-fixture.mjs';

// Keep the source's object store in place for the lifetime of the benchmark.
export async function createReferenceFixture(source, destination, mode, count = 50000) {
  if (
    !['shared', 'grouped', 'distinct'].includes(mode) ||
    !Number.isSafeInteger(count) ||
    count < 2 ||
    count > 50000
  )
    throw new Error('Invalid reference fixture dimensions');
  const original = await realpath(source);
  const root = join(await realpath(dirname(resolve(destination))), basename(resolve(destination)));
  if (root === original || root.startsWith(original + sep))
    throw new Error('Reference fixture must be outside its source repository');
  const objects = git(original, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  if (/[\r\n]/.test(objects)) throw new Error('Unsupported alternate object directory');
  const format = git(original, ['rev-parse', '--show-object-format']);
  const refsPerTarget = { shared: count, grouped: 100, distinct: 1 }[mode];
  const targetCount = Math.ceil(count / refsPerTarget);
  const commits = git(original, ['rev-list', '--max-count=' + targetCount, 'HEAD']).split('\n');
  if (commits.length !== targetCount) throw new Error('Insufficient source history');

  await mkdir(root);
  const repository = join(root, 'repository.git');
  git(root, [
    'init',
    '--bare',
    '--template=',
    '-b',
    'main',
    '--object-format=' + format,
    repository,
  ]);
  await writeFile(join(repository, 'objects/info/alternates'), objects + '\n', { flag: 'wx' });
  const commands = [`create refs/heads/main ${commits[0]}`];
  for (let index = 1; index < count; index++) {
    const group = index <= count / 10 ? 'heads' : index <= count / 5 ? 'remotes/fixture' : 'tags';
    const name = `refs/${group}/benchmark-${String(index - 1).padStart(5, '0')}`;
    commands.push(`create ${name} ${commits[Math.floor(index / refsPerTarget)]}`);
  }
  git(repository, ['update-ref', '--stdin'], commands.join('\n') + '\n');
  git(repository, ['pack-refs', '--all']);
  git(repository, ['commit-graph', 'write', '--reachable']);
  const targets = git(repository, ['for-each-ref', '--format=%(objectname)']).split('\n');
  const head = git(repository, ['rev-parse', 'HEAD']);
  const distinctTargets = new Set(targets).size;
  if (head !== commits[0] || targets.length !== count || distinctTargets !== commits.length)
    throw new Error('Native reference fixture verification failed');
  const manifest = { mode, repository, head, refs: targets.length, distinctTargets };
  await writeFile(join(root, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [source, destination, mode, ...extra] = process.argv.slice(2);
  if (!source || !destination || !mode || extra.length)
    throw new Error(
      'Usage: node scripts/create-reference-performance-fixture.mjs SOURCE NEW_DIRECTORY shared|grouped|distinct',
    );
  console.log(JSON.stringify(await createReferenceFixture(source, destination, mode), null, 2));
}
