# M8 reference performance checkpoint

The sidebar now mounts a bounded set of reference controls on large repositories. **The 50,000-reference first-paint gate remains failing.** No budget was changed. Raw measurements, including the initial full-Linux outlier and all five later samples, are retained in [m8-reference-performance.json](m8-reference-performance.json).

Both fixtures contain the full Linux history at `46fec1c3029b552ec63b2d01af9d43a386f043ea`: 1,505,199 commits, not shallow, with a Git commit graph. The original bare repository has one branch. The second is an isolated shared-object bare clone with 50,000 refs targeting distinct recent commits: the original branch, 5,000 additional branches, 5,000 remote-tracking refs and 39,999 tags. The original repository's refs and objects were not changed. Objects are tree-filtered; this measures history/ref behavior, not checkout or blob-heavy operations.

Measurements used Linux x64, Git 2.53.0 and an Intel Core i7-9750H. Each app used a fresh profile; OS caches were **not cleared**. Main benchmark runs were sequential without concurrent builds or test suites. Memory is Electron's reported renderer working set, not a total-system measurement.

| Fixture/run                               |       First paint | 5,000-commit pages                    |        Scroll p95 | Mounted refs | Renderer working set |
| ----------------------------------------- | ----------------: | ------------------------------------- | ----------------: | -----------: | -------------------: |
| Full Linux, initial                       |   600.0 ms (fail) | 266.1 / 233.6 / 221.3 ms              |           16.8 ms | Not recorded |              486 MiB |
| Full Linux, repeat                        |          376.9 ms | 283.7 / 243.5 / 235.1 ms              |           16.8 ms | Not recorded |       See raw record |
| Full Linux, predetermined five-run sample |    343.3–371.8 ms | All below 300 ms                      | All below 18.7 ms | Not recorded |      See raw records |
| 50,000 refs, eager sidebar                | 8,728.6 ms (fail) | 1,099.1 / 1,694.9 / 1,130.5 ms (fail) |   166.7 ms (fail) |       50,000 |            2,690 MiB |
| 50,000 refs, bounded sidebar              | 1,929.2 ms (fail) | 247.2 / 198.2 / 202.9 ms              |           16.7 ms |            7 |              624 MiB |

The bounded-sidebar run spent 1,665.7 ms before the snapshot response, including 1,058.8 ms inside the snapshot operation, followed by 66.6 ms in worker layout, 45.5 ms publishing state and 151.4 ms before paint. Temporary service instrumentation measured `for-each-ref` at 852.9 ms. A separate native enumeration probe measured 847.1 ms for about 7 MB of output. These probes were removed after diagnosis. The initial 600 ms single-ref outlier is unexplained; subsequent successful samples do not prove it fixed.

An alternate JSON bridge response measured 1,884.6 ms first paint and did not resolve the startup gate. That experiment was reverted; it is not part of the implementation or the bounded-sidebar record above. The first large-ref harness attempt failed while collecting full reference names into Node's default output buffer; metadata collection now counts one dot per ref. That failed harness attempt is not a valid benchmark record.

## Reproduce the isolated fixture

Start with a local full-history bare Linux clone containing only `refs/heads/master` at the revision above. Run this from the repository root after setting `LINUX_SOURCE` to that clone's absolute path. The original must remain available because the fixture borrows its objects. All reference writes and commit-graph generation below target the new temporary clone.

```bash
LINUX_SOURCE=/absolute/path/to/linux.git node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
const source = process.env.LINUX_SOURCE;
const git = (cwd, args, input) => execFileSync('git', args, {
  cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
}).trim();
if (git(source, ['for-each-ref', '--format=%(refname)']) !== 'refs/heads/master')
  throw new Error('Expected a single master ref');
if (git(source, ['rev-parse', 'HEAD']) !== '46fec1c3029b552ec63b2d01af9d43a386f043ea')
  throw new Error('Unexpected source revision');
if (git(source, ['rev-parse', '--is-shallow-repository']) !== 'false')
  throw new Error('Expected full history');
mkdirSync('.test-fixtures', { recursive: true });
const repository = join(mkdtempSync(resolve('.test-fixtures/refs-50000-')), 'repository.git');
git(process.cwd(), ['clone', '--bare', '--shared', source, repository]);
const commits = git(repository, ['rev-list', '--max-count=50000', 'HEAD']).split('\n');
if (commits.length !== 50000) throw new Error('Insufficient history');
git(repository, ['update-ref', '--stdin'], commits.slice(1).map((oid, index) => {
  const kind = index < 5000 ? 'heads' : index < 10000 ? 'remotes/fixture' : 'tags';
  return `create refs/${kind}/benchmark-${String(index).padStart(5, '0')} ${oid}`;
}).join('\n') + '\n');
git(repository, ['pack-refs', '--all']);
git(repository, ['commit-graph', 'write', '--reachable']);
console.log(repository);
JS
```

Build once, then run the benchmark with the printed fixture path. On a headless Linux host:

```bash
pnpm build
OPENKRAKEN_BENCH_REPO=/absolute/path/to/new/repository.git GIT_NO_LAZY_FETCH=1 \
  xvfb-run -a pnpm exec playwright test tests/e2e/benchmark.test.ts \
  --reporter=list --output=test-results/reference-benchmark
```

The expected current result for this fixture is a first-paint failure with passing paging, scrolling and mounted-row bounds. Each run records phase timings, environment/cache metadata, a screenshot and raw JSON. The benchmark performs no Git writes; the observer briefly creates and removes its private self-test probe. Do not run performance samples alongside builds or other suites.

The desktop regression covers 1,000 added branches, filtering to a distant reference, keyboard activation, access to tags at the end of the list, and a focused rename dialog surviving offscreen scrolling and completing a real native branch rename. Small-repository graph visual goldens remain unchanged. This checkpoint does not establish Chromium-sized synthetic history, watcher-warm status budgets, cold OS cache behavior, cross-platform performance or M8 completion.
