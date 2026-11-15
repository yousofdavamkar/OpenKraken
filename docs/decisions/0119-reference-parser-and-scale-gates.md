# 0119. Batch reference records and gate both reference distributions

Git sends eight NUL-terminated fields per reference. The parser reads complete groups from each decoded chunk and retains the remaining fields until the next read. The UTF-8 decoder carries incomplete code points and checks the byte limit for each field. The regression test cuts a stream of three different reference records at every byte boundary, including within a UTF-8 name, a SHA-256 target and a peeled tag.

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
