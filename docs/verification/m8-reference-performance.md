# M8 reference performance checkpoint

The sidebar now mounts a bounded set of reference controls on large repositories. **The 50,000-reference first-paint gate remains failing.** No budget was changed. Raw measurements, including the initial full-Linux outlier and all five later samples, are retained in [m8-reference-performance.json](m8-reference-performance.json).

## Saved views with 10,000 hidden tags

The maximum-size saved hidden list exposed repeated linear membership scans during both traversal and badge construction. With 10,000 tags hidden on the 50,000-distinct-ref fixture, the baseline took **13,908.2 ms** to paint. Of that, 10,116.8 ms was inside snapshot preparation and 3,267.4 ms was between renderer publication and paint. The unfiltered baseline in the same pair took 1,344.2 ms.

The service and renderer now index the saved names once per view (`a93dbc5`). Three filtered runs after that change alone took 1,136.3–1,376.9 ms. Three unfiltered controls took 1,129.0–1,273.7 ms, with one 300.7 ms page. The following history parser change (`506d7dd`) reuses the streaming UTF-8 decoder while retaining the byte limit and callback behavior. See [ADR 0111](../decisions/0111-graph-view-membership-and-history-decoding.md).

On 22,615,101 bytes of `rev-list` output from 17,000 Linux commits, six alternating-order parser samples took **193.9–234.7 ms** before and **113.9–129.1 ms** after the decoder change. Each received the same 64 KiB chunks after one warm-up per parser. All complete parsed arrays had SHA-256 `9a112556899ddfdf20d3f07fa4249a39bbfbdb37ec7f0f2c07af9185c7bc179d` over their JSON serialization. These numbers isolate parsing. End-to-end startup times overlap for the indexed implementations.

| Final cohort (three runs each)               | First paint (ms) | 5,000-commit pages (ms) | Scroll p95 (ms) |
| -------------------------------------------- | ---------------- | ----------------------- | --------------- |
| 50,000 distinct targets, 10,000 tags hidden  | 1,167.9–1,172.0  | 207.8–270.0             | 16.7–16.8       |
| 50,000 distinct targets, default view        | 1,098.5–1,162.8  | 216.0–274.6             | 16.8            |
| 50,000 refs at the same target, default view | 968.4–1,040.9    | 227.9–267.8             | 16.7–16.8       |
| Full Linux with one ref                      | 373.1–408.5      | 240.3–305.9             | 16.8            |
| Synthetic two-million-commit repository      | 482.1–583.5      | 120.1–195.2             | 16.7–16.8       |

Every large-ref first paint still exceeded 500 ms. All 27 pages on the three large-ref cohorts passed. The single-ref Linux cohort missed one page budget at 305.9 ms. Synthetic first paints were 583.5, 502.8 and 482.1 ms. All scroll samples passed. The earlier isolated outliers and these misses remain in the record.

[Per-run measurements](m8-graph-view-samples.csv) cover the original pair (`base`), the indexed-view intermediate runs (`final`) and the combined changes (`history`, `shared`, `linux`, `synthetic`). Each fresh-profile Electron run was sequential with uncleared OS caches and no simultaneous tests or builds. To reproduce the filtered cohort, add `OPENKRAKEN_BENCH_HIDDEN_TAGS=1` to the distinct-target benchmark command below. It seeds the first 10,000 tags into the disposable profile and checks the sidebar's hidden state after timing.

## Original baseline and bounded sidebar

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

## Direct-first enumeration and serialized snapshots

The next startup trace measured **1,404.1 ms** first paint, including two identity reads around three direct-metadata pages. In a subsequent instrumented JSON-response probe, first paint measured **1,295.7 ms**, and the main-reply-to-renderer-receipt interval fell from about **223 ms to 114 ms**. These separate samples identify useful boundaries but do not isolate serialization from run-to-run variation. Raw records are retained under `m8-startup-profile` and `m8-startup-json`.

The final reader starts with one complete direct-format enumeration. Ordinary refs need no additional identity or metadata reads; annotated refs retain bounded detail reads, consistency checks and native compatibility fallback. The repository store also selects the existing validated JSON bridge mode, already used for append-only pages. See [ADR 0098](../decisions/0098-direct-first-reference-enumeration.md) and [ADR 0099](../decisions/0099-serialized-repository-snapshots.md). No product-used fields, history roots or validation boundaries were removed.

With temporary instrumentation removed, three sequential fresh-profile runs measured **1,169.0 / 1,186.8 / 1,200.3 ms** first paint and **429.4–439.6 ms** snapshots. All nine 5,000-commit pages passed at **206.4–266.3 ms**; scroll p95 was **16.8 ms** in each run. Each mounted 32 history rows and seven reference controls. Renderer working set was about **558–562 MiB**. These combined changes improve the preceding 1,400.1–1,505.5 ms checkpoint, but **all three first-paint gates still fail the unchanged 500 ms budget**.

The fixture, native Git, host and cache conditions are unchanged. OS caches were not cleared. Benchmarks ran sequentially after the build and focused tests completed, with no concurrent builds or test suites. Raw records are retained under `m8-direct-first`; logs are `/tmp/openkraken-m8-direct-first-benchmark.log`, and artifacts are under `test-results/m8-direct-first/`. Each failed benchmark is retained rather than replaced with a passing threshold. This increment does not establish watcher-warm status, Chromium-sized or cross-platform performance, nor resolve the earlier full-Linux outlier.

## Utility transport follow-up

A subsequent probe serialized the snapshot between the Git utility and main while retaining main's response validation. It measured **1,250.4 ms** first paint, **441.6 ms** snapshot time and passing paging/scrolling. This single probe did not improve on the preceding 1,169.0–1,200.3 ms samples, so the transport experiment was reverted. It is retained as `m8-utility-json-probe`, with log `/tmp/openkraken-m8-utility-json-probe.log`; it is not part of the implementation and does not establish a general serialization regression. The renderer-side serialized response from ADR 0099 remains in use.

The additional two-million-commit/100,000-file synthetic graph and watcher-warm status gates are recorded separately in [m8-scale-performance.md](m8-scale-performance.md). They do not replace or relax this still-failing 50,000-ref first-paint gate.

## Renderer reference indexes

A 100 µs sampling profile around repository opening attributed about **56 ms** of renderer self time to sidebar construction/filtering and **26 ms** to badge grouping. The instrumented run measured **1,259.3 ms** first paint; it is diagnostic evidence, not an uninstrumented acceptance sample. The raw CPU profile is under `test-results/m8-renderer-profile/`, and its benchmark record is retained as `m8-renderer-profile`.

The sidebar now groups refs in one pass, skips case normalization for empty queries and locates the focused row only when focus exists. Badge grouping now uses target-local label/kind indexes while preserving ordered output and all ref names. A separate regression exposed **8,438.9 ms** grouping 50,000 distinct badges at one target. Five post-change isolated samples took **18.7–54.1 ms** for a shared target and **17.7–21.2 ms** for distinct targets, with every full ref name/order compared. Those timings measure the helper only, not DOM rendering of 50,000 badges. See [ADR 0102](../decisions/0102-linear-reference-presentation-indexes.md).

Three final uninstrumented runs on the unchanged distinct-target 50,000-ref fixture measured **1,235.3 / 1,133.4 / 1,180.5 ms** first paint. The post-publication paint interval was **132.9–144.1 ms**, compared with **159.5–169.7 ms** in the preceding direct-first samples. Service/snapshot variation left overall startup overlapping the previous range; these samples do not establish a clear total first-paint improvement. **All three still fail the unchanged 500 ms gate.** All nine pages passed at **183.5–262.1 ms**, scroll p95 was **16.7–16.8 ms**, and reference controls remained bounded.

Raw records are `m8-renderer-index` and `m8-badge-index-profile`. Logs: `/tmp/openkraken-m8-renderer-index-benchmark.log`, `/tmp/openkraken-m8-renderer-profile.log` and `/tmp/openkraken-m8-badge-index-profile.json`. Fresh profiles, uncleared OS caches and sequential runs without concurrent builds/tests were retained. The temporary profiler test and isolated probe script were removed. Verification passed 793 native/unit tests (14 platform/tool-dependent skips), 23 selected desktop tests with six unchanged graph goldens, typechecking/build and full lint. The desktop regression also covers Unicode/ASCII filtering, whitespace reset, accessible positions and a focused rename dialog surviving offscreen scrolling. Full native-platform/installer acceptance and other scale/status cohorts were not rerun.

## Bounded badges at a shared target

A second isolated bare fixture points all **50,000 refs at the same commit**, retaining the same complete Linux history and HEAD. It exposed a separate rendering problem: the visible commit row constructed every badge. The baseline measured **15,290.5 ms** first paint, including **14,420.5 ms** after state publication. Paging still passed at **233.9–249.1 ms**, and scroll p95 was **16.7 ms**.

Commit rows now show at most three badge previews and a total-ref button when overflow exists. Tooltips also contain at most three full names, including when thousands of remotes are grouped into one branch badge. The button opens a searchable, virtualized modal containing every full name in the current graph view. It preserves graph selection, updates on ref refresh, survives its originating row scrolling away, and restores focus on Close/Escape. See [ADR 0103](../decisions/0103-bounded-commit-reference-previews.md).

Three final runs on that shared-target fixture measured **1,004.5 / 1,019.2 / 1,063.7 ms** first paint, with **145.2–169.6 ms** after publication. All nine pages passed at **202.9–280.0 ms**, and scrolling passed at **16.7–16.8 ms p95**. This removes the large unbounded-rendering cost; **all three first-paint checks still fail the unchanged 500 ms gate**.

A separate three-run regression cohort on the original distinct-target fixture measured **1,142.1 / 1,208.3 / 1,170.6 ms** first paint, overlapping the previous **1,133.4–1,235.3 ms** range. Its nine pages passed at **208.1–268.9 ms**, and scroll p95 remained **16.7–16.8 ms**. All six final runs mounted 32 history rows and seven sidebar reference controls. No overall startup improvement is claimed for the distinct-target case.

Both cohorts used fresh profiles and uncleared OS caches; they ran sequentially with no concurrent builds or test suites. Raw records are `m8-shared-ref-baseline`, `m8-shared-ref-bounded` and `m8-commit-refs-distinct` in the JSON, with the new fixture manifest under `m8-shared-ref-fixture`. Logs are `/tmp/openkraken-m8-shared-ref-{baseline,bounded}.log` and `/tmp/openkraken-m8-commit-refs-distinct.log`; corresponding directories under `test-results/` retain measurements, screenshots and failure traces. All failed gates are retained. These runs do not establish cold-cache, packaged or cross-platform performance.

Verification passed **793 native/unit tests** (14 existing platform/tool-dependent skips), **24 selected desktop tests** with six unchanged graph goldens, typechecking/build and full ESLint/Prettier. The two new desktop cases cover canonical names, merged remotes, annotated tags, Unicode filtering, empty results, whitespace reset, native Home/End scrolling, external deletion and focus/lifecycle behavior. Their initial unbounded-rendering regression failed before the change. Logs are `/tmp/openkraken-m8-commit-refs-{red,green,keyboard,build,types,lint,unit,e2e}.log`. The dialog screenshot was visually inspected. Other platform, package, full-suite and synthetic/status acceptance was not rerun in this increment.

The shared-target repository is `.test-fixtures/refs-50000-shared-wt5fwj3d/repository.git`. To reproduce it, use the isolated-clone recipe below, replacing the `commits.slice(1).map(...)` update-ref input with:

```js
Array.from({ length: 49999 }, (_, index) => {
  const kind = index < 5000 ? 'heads' : index < 10000 ? 'remotes/fixture' : 'tags';
  return `create refs/${kind}/shared-${String(index).padStart(5, '0')} 46fec1c3029b552ec63b2d01af9d43a386f043ea`;
}).join('\n') + '\n';
```

Keep the original `master` ref, pack refs and write the fixture's own commit graph as before. It borrows source objects but makes no reference changes to the source. The fixture manifest verifies **1,505,199 commits**, **50,000 refs** and the expected HEAD. Use `--repeat-each=3` for each final benchmark cohort.

## Initial watcher reference baseline

A temporary boundary trace on the distinct-target fixture measured **1,209.5 ms** first paint. Its phases included **125 ms** establishing the watcher baseline, **424 ms** reading the snapshot, **153 ms** transferring the utility result to main, **62 ms** validating it, and **53 ms** decoding JSON in the renderer. These wall-clock boundary timings are diagnostic, instrumented samples rather than acceptance results. The complete trace and benchmark are retained as `m8-startup-phase-traces` and `m8-startup-phases`.

A [Node V8 serializer](https://nodejs.org/api/v8.html#serialization-api) probe preserved main's response validation but encoded the utility snapshot as bytes. It measured **1,201.3 ms** first paint; encoding/transfer took **75 ms** and main decoding **77 ms**, leaving essentially the same combined transfer cost. This did not establish an improvement. The probe was removed, and its record is retained as `m8-binary-probe`. Logs are `/tmp/openkraken-m8-{startup-phases,binary-probe}.log`. No binary transport or temporary timing instrumentation remains in the implementation.

The retained change reuses the initial snapshot's complete ordered refs for the watcher's first reference fingerprint. All other baseline reads finish before snapshot capture; later checks still enumerate native refs and close the subscription race. Failed initial snapshots discard their watcher before retry. The regression initially observed two native ref enumerations and now observes one. See [ADR 0104](../decisions/0104-snapshot-reference-watcher-baseline.md).

Three uninstrumented distinct-target runs measured **1,088.6 / 1,085.7 / 1,112.8 ms** first paint, compared with the preceding **1,142.1–1,208.3 ms** cohort. Service response time was **847.7–867.9 ms**, including **455.4–457.8 ms** snapshot reads. All nine pages passed at **191.6–258.6 ms**; scroll p95 was **16.7–16.8 ms**.

Three shared-target runs were more variable: **918.2 / 1,117.0 / 1,224.5 ms**, compared with the prior **1,004.5–1,063.7 ms** cohort. Their snapshot times varied from **283.2 to 436.2 ms**. These samples do **not** establish an overall startup improvement for the shared-target fixture or explain its variation. All nine pages passed at **203.6–284.9 ms**; scroll p95 was **16.7–16.8 ms**. **All six final first-paint checks still failed the unchanged 500 ms gate.**

Both cohorts used fresh profiles, uncleared OS caches and sequential runs without concurrent builds/tests. Raw records and artifacts are `m8-watcher-seed` and `m8-watcher-seed-shared`; logs are `/tmp/openkraken-m8-watcher-seed-{benchmark,shared}.log`. No failing or variable sample was discarded. These measurements do not establish cold-cache, packaged or cross-platform acceptance.

Verification passed **799 native/unit tests** (14 existing platform/tool-dependent skips), **13 watcher tests on native Git 2.38.0**, **41 selected Electron tests** with six unchanged graph goldens, typechecking/build and full ESLint/Prettier. Native tests compare complete seeded/fresh fingerprints, tracking states, tags/stashes, checkout/bare/linked repositories and handoff/closure cases. Desktop coverage includes repair/retry after an initial missing-object failure and subsequent native changes. Evidence is `/tmp/openkraken-m8-watcher-seed-{red-final,green,coverage,build,unit,git238,types-final,lint,e2e}.log`. The duplicate-read regression initially failed; test setup/type-target errors were corrected and retained in the earlier logs. Other native-platform/package and full-suite acceptance was not run.

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
