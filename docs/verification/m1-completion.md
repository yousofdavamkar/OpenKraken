# M1 completion — persistent views, avatars and Linux qualification

Verified locally on Linux x64 on 2026-11-01. React 19.3.1, TypeScript 7.0.2 and Electron 45.2.1 remain pinned. This completes the requested M1 feature set and the specified full-Linux performance check, following the [graph report](m1.md) and [ref-view increment](m1-views.md).

## Delivered

- Canvas graph with virtualized accessible DOM cells, worker layout, stable colors, ref badges and WIP/stash projection.
- Append-only history paging from one retained Git stream, with bounded next-page read-ahead and unchanged earlier lanes.
- Worker search that dims nonmatches, separate unloaded-history search, keyboard ancestry navigation, selection, multi-select and details.
- Hide/solo/pin views, checkpoint refresh, and atomic per-repository view persistence across complete app restarts.
- Opt-in Gravatar photos with bounded memory/disk caches, offline reuse, cancellation, request coalescing and initials fallback.
- Bounded profile-owned history windows for faster reopen, with generation fingerprints, per-page validation and fallback to the live Git traversal.

The application does not write Git indexes or history-cache files into repositories. Initialization remains the only repository mutation in this milestone. Design details: [profile preferences/photos](../decisions/0007-profile-preferences-and-avatars.md) and [history cache/read-ahead](../decisions/0008-bounded-history-cache.md).

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm package` and `xvfb-run -a pnpm smoke:package` pass.
- **68 unit/property/integration tests across 12 files** pass. New coverage includes persisted views, avatar privacy/caching/failure behavior, cached history under a gated Git stream, exact continuation through 19,000 commits, missing cache pages, changed shallow boundaries/refs/configuration, corrupt records, eviction and divergent cached topology.
- **12 Electron tests pass; one opt-in benchmark skips in the default suite.** All six Canvas goldens remain unchanged. Tests cover the actual main/preload/Git-service/worker flow and full app restarts for preferences and offline avatars.
- Packaged Linux ASAR startup, hardened Electron fuses and renderer isolation pass. The bundle is local and unsigned.

## Real-repository performance

Both repositories use HEAD `46fec1c3029b552ec63b2d01af9d43a386f043ea` from [torvalds/linux](https://github.com/torvalds/linux). Host: Intel i7-9750H, Linux x64, Git 2.53.0, headless Electron through Xvfb. The OS file cache was **not cleared**.

The full clone contains **1,505,199 commits**, all reachable history from master, with no shallow boundary. It is a bare, single-branch, tag-free, `tree:0` filtered clone; file contents are unnecessary for this graph benchmark. Fixture preparation explicitly ran `git commit-graph write --reachable` before measurement. The application and benchmark do not create that index. Measurement uses a **fresh app profile** with no OpenKraken history cache.

The separate shallow fixture contains **87,206 commits** since 2026-01-01. Its measured run starts a new app process after a preceding process cached 17,000 commits and shut down. It has **no Git commit-graph**. This measures cached reopen, not cold startup.

| Measurement                              | Full Linux, fresh profile + Git commit-graph | Shallow Linux, cached reopen |              Gate |
| ---------------------------------------- | -------------------------------------------: | ---------------------------: | ----------------: |
| First 2,000 commits painted              |                                     311.5 ms |                     289.6 ms |           <500 ms |
| Next 5,000 commits, page 1               |                                     228.9 ms |                     229.4 ms |           <300 ms |
| Next 5,000 commits, page 2               |                                     198.3 ms |                     187.6 ms |           <300 ms |
| Next 5,000 commits, page 3               |                                     177.7 ms |                     169.6 ms |           <300 ms |
| Scroll frame p95 with 12,000 loaded rows |                                      16.8 ms |                      16.8 ms |      60 Hz target |
| Mounted history rows                     |                                           35 |                           35 |              <100 |
| Renderer working set after 17,000 rows   |                                    468.5 MiB |                    459.8 MiB | recorded, no gate |

Raw evidence: [full Linux measurement](m1-linux-complete.json) and [cached shallow measurement](m1-linux-recent-warm.json). A [second unchanged-build warm run](m1-linux-recent-warm-repeat.json) also passed: 322.3 ms first paint, 257.2 / 214.1 / 181.2 ms pages and 16.7 ms scroll frame p95. Paging includes service IPC, worker layout and UI state publication. Scrolling allows the existing 2 ms scheduling tolerance over a 60 Hz interval. Memory is a working-set snapshot, includes the renderer worker, and excludes Git child-process memory.

The initial full-history run met startup but missed paging (306/485/243 ms). Bounded read-ahead removed avoidable waiting for Git. Cache writes now yield between serialization batches. A subsequent warm run exposed an intermittent first-page delay (310 ms) from validation of later disk pages; incremental validation resolved that bottleneck without changing the assertions.

Reproduce with:

```sh
pnpm build
OPENKRAKEN_BENCH_REPO=/path/to/full-linux.git xvfb-run -a pnpm benchmark:graph
OPENKRAKEN_BENCH_REPO=/path/to/shallow-linux.git OPENKRAKEN_BENCH_WARM=1 xvfb-run -a pnpm benchmark:graph
```

The opt-in harness only reads the supplied repository and records its cache/index conditions. It saves metrics and a screenshot under `test-results/benchmark/`; later test runs replace those temporary artifacts, so the JSON evidence above is committed separately.

## Limits

An **uncached shallow** Linux repository still pays Git's initial ordered-walk cost and can exceed 500 ms. The earlier 1,205.9 ms result remains recorded in the historical report. The improvement covers full indexed history and validated cached reopen; it does not claim universal cold-cache latency. Ref/config/shallow changes invalidate the profile cache and restore the live-walk cost.

Refresh reloads the initial 2,000-commit window. View preferences persist, while selection and search remain session state. macOS and Windows execution and platform-specific packaging still need their release runners; signing and installers remain M8 work. Watchers and working-tree mutations belong to M2 and later milestones.
