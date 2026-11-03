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

## Text-decoder follow-up

Reference parsing (`3694895`) now decodes each UTF-8 read once and splits the resulting text into fields. It preserves streaming codepoints, byte-based field limits, empty fields, truncated-record errors and the optional final newline. The original binary decoder remains in use for paths and all other existing consumers. All nine reference fields, including subjects and peeled object metadata, remain present.

An alternating-order comparison against `029afa1` consumed the same 7,077,281 bytes in 64 KiB chunks and compared **every field of all 50,000 parsed records** for equality. Across six runs per implementation, baseline parsing took 182.1–228.7 ms and the text decoder took 61.5–97.5 ms. The [comparison record](m8-reference-decoder.json) retains all samples and the full-record digest. These are isolated parser measurements, not application startup measurements.

Three sequential app runs after the decoder change measured **2,022.5 / 1,972.0 / 1,953.1 ms** first paint. All failed the unchanged 500 ms budget; all paging, scroll and mounted-row bounds passed. Snapshot time remained 1,073–1,085 ms. The parser optimization therefore establishes lower parsing cost, **not an observed first-paint improvement**. These app records are retained under `m8-text-decoder` in the raw benchmark file.

Native format probes measured identity-only enumeration near 32 ms, object type near 134–141 ms, peeling near 679–702 ms and subjects near 721–775 ms. Full-format enumeration remained about 784–823 ms. A four-way partition of this specific fixture produced byte-identical full output in about 342–350 ms, but it is not a general implementation: portable partitioning, consistent coverage of arbitrary refs and bounded command inputs still need design and tests. At that checkpoint, no parallel enumeration or reduced metadata format was shipped.

A separate utility-to-main JSON transport experiment measured 2,050.4 ms first paint and a 313.5 ms page; it was reverted. The earlier renderer-bridge experiment and this utility transport experiment are distinct. Neither bypassed main-process result validation. Temporary probes are removed after recording their results.

## Bounded native pagination

The next increment (`c59d3e8`) retains complete reference records and uses three native pages for repositories with at least 10,000 refs when Git supports `--start-after`. Identity checks before and after the pages detect observed ref/HEAD/upstream changes and select a single complete read on mismatch. Old Git, non-UTF-8 names and overly long markers retain the single-read path. The full-record pages share a 32 MiB output limit; cancellation and failure drain all jobs before the reader returns. See [ADR 0095](../decisions/0095-parallel-native-reference-reads.md).

Three sequential real-app runs measured **1,688.9 / 1,698.5 / 1,710.9 ms** first paint, with snapshot time **815.9–821.3 ms**, compared with 1,953.1–2,022.5 ms and 1,073–1,085 ms in the preceding decoder sample. Every page remained below 300 ms, scroll p95 was 16.7–16.8 ms, and seven reference rows were mounted. The unchanged **500 ms first-paint gate still fails in all three runs**. Records are retained under `m8-native-ref-pages` in the raw benchmark file. Profiles were fresh, OS caches were not cleared, and benchmarks ran sequentially without concurrent builds or suites.

A temporary boundary probe on the preceding implementation measured 135 ms from utility send to main receipt, 67.6 ms in main validation, and 239 ms from main reply to renderer receipt. The full snapshot still crosses both process/isolated-world boundaries; validation was not removed. A native four-page feasibility probe returned byte-identical output in 278–296 ms, but production uses three jobs plus identity checks to respect the existing process pool. Those isolated timings are not substituted for the app's measured first paint. Instrumentation was removed before the final build and benchmark.

## Selective object metadata

The next reader removes the unused `Ref.subject` field and reads peeled metadata only for actual annotated tags. The reference model in the blueprint does not include subjects, and no product consumer read the removed field; commit summaries and stash messages remain separate and unchanged. All names, targets, types, peeled targets/types, tracking counts, HEAD markers and history roots remain present. This supersedes the earlier decision to retain all nine native fields. See [ADR 0097](../decisions/0097-selective-reference-object-metadata.md).

Native format probes measured approximately 188–194 ms for direct type/tracking metadata, 758–903 ms with peeling, and 817–836 ms with peeling plus subjects. These isolated probes motivated the change but are not app timing evidence. Detail queries are bounded by name count/bytes, and repositories needing more than three detail batches use full native pages. Identity checks still reject incomplete or shifted native page coverage, including an observed mixed loose/packed-ref case, and fall back to a complete enumeration.

A fresh baseline measured **1,724.8 ms** first paint and **833.5 ms** snapshot time. An initial implementation probe measured 1,344.3 ms first paint. Three sequential final-build runs measured **1,428.5 / 1,400.1 / 1,505.5 ms** first paint, with **548.6–641.9 ms** snapshots. All first-paint checks still fail the unchanged **500 ms** gate. Every page passed at **200.8–288.3 ms**, scrolling p95 was **16.7–16.8 ms**, and the reference sidebar remained bounded. The sample establishes an improvement over the same-turn baseline, not completion of the startup gate or an explanation for every timing variation.

All measurements used the unchanged 50,000-ref fixture, fresh app profiles and uncleared OS caches; no builds or test suites ran concurrently with the app benchmarks. The baseline, probe and final samples are retained under `m8-ref-startup-baseline`, `m8-ref-metadata-probe` and `m8-selective-ref-metadata` in the raw JSON. Process-boundary transport/validation and renderer work remain substantial; no validation or timing threshold was removed. Other large-history/status/platform gates were not rerun by this measurement.

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
