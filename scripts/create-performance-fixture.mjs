import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

function performanceGitEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function performanceGit(cwd, args, input) {
  return execFileSync('git', args, {
    cwd,
    env: performanceGitEnvironment(),
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

// Synthetic scale, not a copy of Chromium's topology, paths or object distribution.
function* importData(commits, files) {
  let chunk = 'blob\nmark :1\ndata 5\nbase\n\n';
  let main = 0;
  let pendingMerge;
  for (let index = 1; index <= commits; index++) {
    const side = index % 1000 === 0;
    const mark = index + 1;
    const message = `Synthetic commit ${index}\n`;
    chunk += `commit refs/heads/${side ? 'topic' : 'main'}\nmark :${mark}\nauthor Fixture Author <author@example.test> ${1700000000 + index} +0000\ncommitter Fixture Author <author@example.test> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}`;
    if (index > 1) chunk += `from :${side ? main - 1 : main}\n`;
    if (!side && pendingMerge) {
      chunk += `merge :${pendingMerge}\n`;
      pendingMerge = undefined;
    }
    if (index === 1) {
      chunk += 'M 100644 :1 status-probe.txt\n';
      for (let file = 1; file < files; file++) {
        chunk += `M 100644 :1 src/group-${String(Math.floor(file / 100)).padStart(4, '0')}/file-${String(file).padStart(6, '0')}.txt\n`;
        if (chunk.length >= 65536) {
          yield chunk;
          chunk = '';
        }
      }
    } else if (index % 1000 === 1) {
      const content = `Revision ${index}\n`;
      chunk += `M 100644 inline status-probe.txt\ndata ${Buffer.byteLength(content)}\n${content}`;
    }
    chunk += '\n';
    if (side) pendingMerge = mark;
    else main = mark;
    if (chunk.length >= 65536) {
      yield chunk;
      chunk = '';
    }
  }
  yield chunk + 'done\n';
}

export async function createPerformanceFixture(destination, options = {}) {
  const commits = options.commits ?? 2000000;
  const files = options.files ?? 100000;
  if (
    !Number.isSafeInteger(commits) ||
    commits < 2 ||
    commits > 5000000 ||
    !Number.isSafeInteger(files) ||
    files < 1 ||
    files > 250000
  )
    throw new Error('Invalid fixture size');
  const root = resolve(destination);
  // Never reuse, empty or remove a caller's existing directory.
  await mkdir(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  const env = performanceGitEnvironment();
  const git = (...args) => performanceGit(repository, args);
  git('init', '--template=', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  const child = spawn('git', ['fast-import', '--quiet', '--done'], {
    cwd: repository,
    env,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Fixture import failed (${code}): ${stderr}`)),
    );
  });
  const input = pipeline(Readable.from(importData(commits, files)), child.stdin).catch((error) => {
    child.kill();
    throw error;
  });
  const results = await Promise.allSettled([completed, input]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  git('reset', '--hard', 'HEAD');
  git('commit-graph', 'write', '--reachable');
  const actualCommits = Number(git('rev-list', '--all', '--count'));
  const actualFiles = git('ls-files', '-z').split('\0').filter(Boolean).length;
  if (actualCommits !== commits || actualFiles !== files || git('status', '--porcelain'))
    throw new Error('Fixture native verification failed');
  const manifest = {
    format: 1,
    kind: 'openkraken-synthetic-scale',
    repository,
    commits: actualCommits,
    files: actualFiles,
    merges: Number(git('rev-list', '--all', '--min-parents=2', '--count')),
    head: git('rev-parse', 'HEAD'),
    refs: git('for-each-ref', '--format=%(refname)').split('\n'),
    git: git('--version'),
    statusProbe: 'status-probe.txt',
    topology:
      'One side commit every 1000 commits, merged by the next main commit; all other commits are linear.',
    content:
      'All paths share a five-byte blob except one probe changed every 1000 commits; this is a scale fixture, not Chromium content.',
  };
  await writeFile(join(root, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [destination, commits, files, ...extra] = process.argv.slice(2);
  if (!destination || extra.length)
    throw new Error(
      'Usage: node scripts/create-performance-fixture.mjs NEW_DIRECTORY [COMMITS] [FILES]',
    );
  console.log(
    JSON.stringify(
      await createPerformanceFixture(destination, {
        ...(commits === undefined ? {} : { commits: Number(commits) }),
        ...(files === undefined ? {} : { files: Number(files) }),
      }),
      null,
      2,
    ),
  );
}
