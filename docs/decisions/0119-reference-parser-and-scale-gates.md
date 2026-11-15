# 0119. Batch reference records and gate both reference distributions

The direct Git query emits the full name, target ID, object type, upstream, tracking state and HEAD marker as six NUL-terminated fields. Reads that peel annotated tags also include the peeled ID and type, giving eight fields. The parser reads complete groups from each decoded chunk and retains the remaining fields until the next read. The UTF-8 decoder carries incomplete code points and checks the byte limit for each field. The regression test cuts a stream of three different reference records at every byte boundary, including within a UTF-8 name, a SHA-256 target and a peeled tag. The direct-format test applies the same byte cuts to a tracked branch and a tag and compares the results with their eight-field counterparts.

The scale job exercises two independent reference distributions because shared targets and distinct targets perform different amounts of native graph work. Both use the existing graph benchmark and budgets. Each bare fixture has its own refs and borrows its source's object directory. Keep that source in place while benchmarking. The generator creates a new directory and accepts a local repository as input. Its manifest records the checked reference count, unique target count and HEAD.

After building OpenKraken and generating the synthetic scale checkout, run these commands from the project root for each mode. Choose an unused destination directory for each fixture.

```sh
mode=distinct  # or shared
node scripts/create-reference-performance-fixture.mjs /path/to/scale/repository "/path/to/refs-$mode" "$mode"
OPENKRAKEN_BENCH_REPO="/path/to/refs-$mode/repository.git" GIT_NO_LAZY_FETCH=1 \
  xvfb-run -a pnpm exec playwright test tests/e2e/benchmark.test.ts --repeat-each=3 --workers=1 \
  --reporter=list --output="test-results/performance/refs-$mode"
```

[Source checkout generation](../verification/m8-scale-performance.md) · [Measured results](../verification/m8-reference-performance.md#reading-fixed-width-ref-records-in-batches)


## Full Linux history in CI

The scale job also opens the Linux kernel history at `46fec1c3029b552ec63b2d01af9d43a386f043ea`. On a cache miss it fetches commits from the upstream repository with a tree filter, then removes the remote. Only pack files are cached. Each run initializes a bare repository, checks that HEAD is the single branch at the pinned commit, verifies the non-shallow count of 1,505,199 commits and rebuilds and checks the commit graph. Three fresh Electron profiles run with lazy fetching disabled. Each measures first paint, three 5,000-commit appends and scrolling at 12,000 rows. Measurements and screenshots are uploaded under `performance/linux-history`. The synthetic checkout supplies the worktree and status measurements.
