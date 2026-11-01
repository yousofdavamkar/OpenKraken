# M1 ref views and checkpoint refresh verification

Historical increment report. The [M1 completion report](m1-completion.md) records the subsequent persistence, avatar and performance work.

Verified locally on Linux x64, 2026-11-01. React 19.3.1, TypeScript 7.0.2 and Electron 45.2.1 remain pinned. This continues the [Canvas and paging increment](m1.md).

## Delivered

- Hide, solo and pin buttons for commit refs, plus Reset graph view. Filtering changes Git start points, preserves shared ancestry, and scopes message, author and hash search. Tags resolve to peeled commit targets; stash visibility controls its projected history. The sidebar retains all refs so hidden ones can be restored.
- A reserved first-parent lane that remains column zero across pages and converging branches, without phantom edges above the pinned tip. The reservation ends at its root.
- Worker refresh from the checkpoint preceding the first topology change. Stable prefixes and converged suffixes are reused; metadata-only changes still update search. Ref choices, loaded selection and the query survive refresh.
- A regression test for truncation at a checkpoint: subsequent paging resumes from the new window, not the previous longer history. Worker retention stores topology rather than duplicate message bodies.
- HEAD/upstream navigation respects excluded refs and can still select loaded shared commits.
- An opt-in read-only Electron benchmark for existing large repositories, with repository and host metadata, first paint, three page measurements, scrolling, mounted DOM rows and process memory.

Design details and refresh-window semantics are in [ADR 0005](../decisions/0005-graph-views-and-refresh.md).

## Validation

`pnpm test`: **57 tests passed across 8 files**. Tests cover actual Git traversal roots and search, tags, stashes, detached HEAD, pinning and connected edges on 300 random DAGs, checkpoint prefix/suffix reuse, metadata updates, stale generations, truncation, append continuation, selection and query preservation.

`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm package`, and `xvfb-run -a pnpm smoke:package` pass. Packaging reads back the hardened Electron fuses; the ASAR smoke test verifies startup and renderer isolation.

`xvfb-run -a pnpm exec playwright test`: **10 passed, 1 opt-in benchmark skipped (14.7 s)**. Final default-suite measurements: 2,000-commit first paint **257.5 ms**, next 5,000 commits **193.0 ms**, 12,000-row scrolling **16.7 ms frame p95**.

The Electron suite exercises the sidebar controls through the real Git service and graph worker, retains the six committed Canvas goldens, and checks search and keyboard behavior. Golden captures suppress only the DOM grid's focus outline in screenshot CSS; production focus styling remains enabled.

The benchmark harness was first verified with a 20,000-commit linear fixture: first paint **279 ms**, 5,000-row pages **214.1 / 181.2 / 165.1 ms**, 12,000-row scrolling **16.8 ms frame p95**, **36 mounted rows**. These are synthetic measurements, with the OS cache not cleared, on an Intel i7-9750H. They are not Linux-history certification.

## Real Linux-history benchmark

The full commit-only Linux clone did not complete within the download attempts. The measured fallback is a **shallow** clone of [torvalds/linux](https://github.com/torvalds/linux), with commits since 2026-01-01: **87,206 reachable commits**, HEAD `46fec1c3029b552ec63b2d01af9d43a386f043ea`. This is real merge history, not the full Linux exit-criteria dataset. No full-history certification is claimed.

The initial real-history run exposed repeated pass-edge objects and blocking search indexing. Compact spans, indexed lane lookup and cooperative indexing fix those costs; see [ADR 0006](../decisions/0006-compact-graph-passages.md). The compact model is checked against the explicit allocator on the fixture corpus and 300 random DAGs, with and without pins. A regression test checks that unchanged pass edges remain shared across structured cloning.

| Measurement                         | Before optimization | After optimization |                    Budget |
| ----------------------------------- | ------------------: | -----------------: | ------------------------: |
| First 2,000 commits painted         |          1,614.9 ms |         1,205.9 ms | <500 ms — **still fails** |
| 5,000-commit page 1                 |          3,684.5 ms |           290.4 ms |                   <300 ms |
| 5,000-commit page 2                 |          3,374.0 ms |           252.3 ms |                   <300 ms |
| 5,000-commit page 3                 |          2,881.9 ms |           249.3 ms |                   <300 ms |
| 12,000-row scrolling frame p95      |             18.2 ms |            16.8 ms |              60 Hz target |
| Mounted history rows                |                  35 |                 35 |                      <100 |
| Renderer working set after 17k rows |           1,777 MiB |            496 MiB |         recorded, no gate |

The table records the final run; [the recorded measurement JSON](m1-linux-recent.json) preserves its console values. An earlier run of the same optimized build measured 1,145.2 ms first paint and 235.1–256.8 ms pages. Both runs passed paging/scrolling and failed first paint. Final trace and screenshot are under `test-results/benchmark/`.

Host: Intel i7-9750H, Linux x64, Git 2.53.0. OS cache was not cleared. Each measurement used a new app process. Process memory includes the renderer's worker, excludes Git child processes, and is a working-set snapshot rather than peak memory.

**The opt-in benchmark remains red on first paint.** Profiling isolates roughly 0.95–1.0 seconds in Git repository open/snapshot before layout. Git's commit-graph acceleration is unavailable in shallow repositories; see the [public Git design documentation](https://git-scm.com/docs/commit-graph). Startup performance in this case and qualification on full linux.git remain open M1 work. The 500 ms assertion is unchanged.

## Limits

Refresh reloads the initial 2,000 commits, even if more pages were previously loaded. Reuse is limited to equal row indices and equal continuation state; shifted rows are rebuilt. Per-repository view choices currently last for the active repository session; disk persistence remains to be implemented. Optional network avatars remain M1 work.

macOS and Windows execution, signing and platform-specific ASAR integrity enforcement still require their release runners. The local package is unsigned.
