# M8 large-history and watcher-warm status checkpoint

The Linux x64 synthetic scale gates pass after removing a duplicate index fingerprint from working-state reads. **M8 remains incomplete:** the separate 50,000-ref first-paint gate still fails, and cross-platform/release acceptance remains open. All measurements below are retained in [m8-scale-performance.json](m8-scale-performance.json).

## Comparing a restarted graph with native Git

The platform matrix times three restarts of full Linux history with 50,000 distinct ref targets. A separate restarted traversal checks every page against Git even if the timing gate fails.

The traversal also compares the complete ordered reference list returned through the desktop bridge with native Git. Its digest includes names, direct object IDs and types, recursively peeled IDs and types, upstream names and tracking counts, and the HEAD marker. Git's `cat-file` resolves each distinct annotated object once, including tags that end at a tree or blob. The test reports separate ref and history digests. This comparison runs outside the timed graph benchmark.

Set `OPENKRAKEN_BENCH_WARM=1` when running the traversal against a scale fixture. The first Electron process loads 17,000 commits and quits. The test checks that the profile contains four contiguous pages under the expected repository ID and that they share a cache key. A second process then compares every displayed commit ID and ordered parent list with native Git through the last page. The JSON result includes the number of commits persisted before restart. The annotated-ref CI job exercises this mode with the one-annotation fixture.

```sh
OPENKRAKEN_BENCH_WARM=1 bash scripts/run-scale-test.sh traversal "$fixture/repository.git" test-results/restarted-traversal
```

To test an existing 17,000-commit window after a branch moves, set `OPENKRAKEN_TRAVERSAL_PROFILE` to the Electron profile that saved the window at the same repository path. The traversal copies its four history pages into a temporary profile, preserves their timestamps and compares the entire current history against Git. Supplying a saved profile skips the warm-up launch.

```sh
OPENKRAKEN_TRAVERSAL_PROFILE="$saved_profile" bash scripts/run-scale-test.sh traversal "$fixture/repository.git" test-results/changed-history-traversal
```

To check a repository switch as well, set `OPENKRAKEN_BENCH_FROM_REPO` to a different fixture with at least 17,001 commits. The test opens that source, loads 17,000 commits there, then opens the destination through the desktop bridge. It checks the canonical destination path before comparing every page with Git. With `OPENKRAKEN_BENCH_WARM=1`, the destination already has a saved 17,000-commit window.

## Native desktop CI gates

The scale job now runs separately on Ubuntu x64, Ubuntu ARM64, macOS and Windows. Each runner opens the synthetic checkout, the three synthetic 50,000-ref distributions, full Linux history and full Linux history with 50,000 distinct ref targets. Each opening gate uses three fresh profiles and checks the initial 2,000 commits, displayed reference count, three appends and scrolling. The full Linux fixtures also include one annotated tag among 50,000 distinct targets and 49,999 aliases of a three-level annotation pointing to an independent root. Each runner compares every page of the full Linux fixtures and the synthetic checkout with native Git. Job artifacts use the runner label so a failed measurement can be inspected independently.

Local Linux x64 verification used Git 2.53.0, fresh profiles and retained OS caches. The fixture generator created a new bare repository with 50,000 distinct targets over full Linux history at `46fec1c3029b552ec63b2d01af9d43a386f043ea`.

| Full Linux history      | First paint, three runs (ms) | Nine 5,000-commit appends (ms) | Graph frame p95 (ms) |
| ----------------------- | ---------------------------- | ------------------------------ | -------------------- |
| One ref                 | 324.2, 344.5, 333.8          | 155.2–233.5                    | 16.8                 |
| 50,000 distinct targets | 710.8, 741.1, 724.7          | 178.1–232.9                    | 16.7–16.8            |

The one-ref gate passed. All three distinct-target runs failed the 500 ms first-paint assertion and retained their phase timings. The 302-page traversal matched every ordered ID and parent list across 1,505,199 commits. Across three status runs on the 100,000-file checkout, all 30 clean and dirty reads met 300 ms (174.0–223.3 ms). External edits appeared in 855.2–868.2 ms. The workflow passed actionlint locally. Hosted runner execution and native measurements on ARM64, macOS and Windows remain open. [Per-run graph timings](m8-opening-experiments.csv)

On the two annotated-ref fixtures, CI also restarts the app after loading 17,000 commits and runs the graph gate in three profiles. Before each timed reopen, the harness reads the saved prefix and three tails from the closed app's profile. It verifies their cache key, contiguous offsets and page lengths and records the total in `cache.persistedCommits`. The OS file cache remains populated. A missing or short window fails setup before the first-paint timer starts. After the three cached appends, End selects the last loaded row. ArrowDown loads the first live page and selects its first row. ArrowUp must return to the previous row's commit ID. The report records this fourth append separately in `firstLiveAppendMs` with the same 300 ms limit. [Graph results](m8-progress.md#fresh-profile-graph-opening-with-annotated-refs)

## Fixture and measurement boundaries

The disposable fixture has **2,000,000 reachable commits, 100,000 tracked files, 1,999 genuine merges and two branch tips**, with a complete checkout and native commit graph. HEAD is `606403fd8ea711764e0ca26ada7fc10bbbde974a`. HEAD alone reaches 1,999,999 commits; the final topic tip supplies the remaining commit and is included in the app's history roots. The graph harness records the HEAD-only count in `commits` and the count from `git rev-list --count --all` in `commitsFromAllRefs`. It collects both after the timed interactions.

This is a history/path-count scale fixture, not Chromium contents or its topology. Most commits reuse a tree. Files share a five-byte blob except one probe updated every thousand commits. It does not model large blobs, extensive ignored trees, submodules or real Chromium checkout cost. See [ADR 0100](../decisions/0100-large-history-and-warm-status-gates.md).

Measurements used Git 2.53.0, Linux x64 and an Intel Core i7-9750H. Each app used a fresh profile; OS caches were not cleared. Runs were sequential, with no concurrent build or test suite. The status benchmark waits for native watcher readiness and records one explicit warm-up separately. It retains all five clean and five dirty samples per profile, measuring renderer request through validated working-state response, including revision/operation/commit metadata and IPC. Debounce and UI paint are measured separately through external edit to enabled staging controls.

## Results

| Gate                                     |      Before fingerprint reuse |                   Final build |                    Budget |
| ---------------------------------------- | ----------------------------: | ----------------------------: | ------------------------: |
| Graph first paint, three profiles        |                447.0–464.5 ms |                439.7–447.7 ms |                   <500 ms |
| 5,000-commit pages, nine samples         |                116.4–163.0 ms |                113.2–167.8 ms |                   <300 ms |
| Scroll frame p95                         |                       16.8 ms |                  16.7–16.8 ms | Existing 60 fps tolerance |
| Warm status, 30 clean/dirty samples      | **323.8–517.8 ms (all fail)** | **200.9–249.3 ms (all pass)** |                   <300 ms |
| External edit to visible staging control |              872.4–1,384.9 ms |                900.1–921.1 ms |                 <1,500 ms |

Each graph run passed every existing first-paint/page/scroll/mounted-row assertion. Each final status run passed all ten response-time assertions, native status/HEAD checks, preserved commit-count check and observer latency assertion. The fixture was restored and verified clean after every status run. No measured sample was discarded, threshold increased or native metadata omitted.

A supervised native profile found two identical index/HEAD fingerprints per working-state read, each costing about **74–96 ms**. The response now reuses one fingerprint for its revision and operation token; operation metadata/conflict images remain fresh, and mutation checks still reread native state. The bare-repository path retains its existing separate operation inspection. See [ADR 0101](../decisions/0101-one-fingerprint-per-working-state.md). The original warm-status benchmark, rather than the isolated profile, establishes the complete request improvement.

Raw record groups are `m8-synthetic-graph`, `m8-warm-status`, `m8-warm-status-single-fingerprint` and `m8-synthetic-graph-final`. Logs are `/tmp/openkraken-m8-{synthetic-graph,warm-status,warm-status-single-fingerprint,synthetic-graph-final}.log`; artifacts are under the matching `test-results/` directories. The three baseline status runs exited 1. Both graph cohorts and the three final status runs exited 0. The isolated profile is `/tmp/openkraken-m8-status-fingerprint-profile.log`; its temporary instrumentation was removed before the final build.

## Regression verification

The final increment passed **792 native/unit tests in 99 files** with Git LFS enabled and 14 platform/tool-dependent skips, **56 focused native tests on Git 2.38.0**, and **33 selected Electron tests**. Six graph goldens passed unchanged. Typechecking/build and full ESLint/Prettier passed. Native rebase tests exercise working-state tokens, stale-review rejection and continuation; the bare-token regression first exposed and then verified the compatibility correction. The initial build failure on optional operation fields was corrected with explicit test guards.

Logs: `/tmp/openkraken-m8-scale-{unit,git238,final-lint,e2e}.log` and `/tmp/openkraken-m8-status-{bare-red,fingerprint-verified,fingerprint-build,fingerprint-build-verified}.log`. Package/installer artifacts, the complete desktop suite, Windows/macOS/ARM64 runtime checks and remote CI were not rerun. The synthetic passes do not close the outstanding release or other milestone scope.

## Watcher-baseline follow-up

After reusing snapshot refs for the initial watcher baseline ([ADR 0104](../decisions/0104-snapshot-reference-watcher-baseline.md)), the three-run graph cohort measured **492.3 / 436.4 / 700.1 ms** first paint. The first two passed; the third **failed the unchanged 500 ms gate**. Its snapshot, worker and paint phases were all longer than the other two runs. All nine pages and all scroll checks passed. The cause of the 700.1 ms result is **unexplained**; the earlier all-passing checkpoint is not a substitute for this failing sample.

A predetermined follow-up alternated three pairs of old/new utility bundles while retaining identical main/preload/renderer/helper files, fresh profiles and the same fixture. The baseline utility was compiled from commit `d99d2cc`; the candidate includes the watcher change committed as `82dbde8`. Each build ran once per pair, baseline then candidate, with no builds or other suites during measurements. First paint was:

| Pair | Baseline | Candidate |
| ---- | -------: | --------: |
| 1    | 455.7 ms |  451.1 ms |
| 2    | 463.2 ms |  444.8 ms |
| 3    | 472.1 ms |  491.6 ms |

All six paired runs passed their existing first-paint, paging, scrolling and mounted-row gates. These comparisons do not show a consistent regression, establish a synthetic-fixture speedup, or explain away the 700.1 ms failure. No sample was replaced or threshold changed. The candidate utility bundle was restored and its bytes compared after the experiment. Bundle SHA-256 values and execution order/exit codes are retained under `m8-watcher-pair-manifest` in the raw JSON.

All three watcher-warm status runs passed: **30 clean/dirty responses at 202.3–263.9 ms**, with external edit to visible staging controls at **904.1–916.1 ms**. The fixture was restored and checked clean after each run. Normal watcher fingerprints continue to read native refs; this change only reuses the initial snapshot's refs.

Records are `m8-watcher-seed-scale`, `m8-watcher-seed-status` and `m8-watcher-pair-{1,2,3}-{baseline,candidate}`. Corresponding artifacts are under `test-results/`; logs are `/tmp/openkraken-m8-watcher-seed-{scale,status}.log` and `/tmp/openkraken-m8-watcher-pair-{1,2,3}-{baseline,candidate}.log`. OS caches were not cleared. The initial graph cohort exited 1; all status and paired commands exited 0. These are local Linux x64 development-build measurements, not cold-cache, packaged, cross-platform or release acceptance. M8 remains incomplete.

## Reproduce

Generate a new, nonexisting directory. The generator refuses existing destinations and does not modify a real repository:

```bash
node scripts/create-performance-fixture.mjs /absolute/new/openkraken-scale
pnpm build
OPENKRAKEN_BENCH_REPO=/absolute/new/openkraken-scale/repository GIT_NO_LAZY_FETCH=1 \
  xvfb-run -a pnpm exec playwright test tests/e2e/benchmark.test.ts \
  --repeat-each=3 --reporter=list --output=test-results/scale-graph
OPENKRAKEN_STATUS_BENCH_FIXTURE=/absolute/new/openkraken-scale/fixture.json \
  xvfb-run -a pnpm exec playwright test tests/e2e/status-benchmark.test.ts \
  --repeat-each=3 --reporter=list --output=test-results/scale-status
```

Use the project's configured Go toolchain for the helper build. The generator accepts optional commit/file counts for development tests; the acceptance defaults remain two million commits and 100,000 files. The CI scale-performance job uses these defaults, builds once, runs both gates sequentially and retains logs/metrics even on failure. Remote CI execution is not verified by this local result.
