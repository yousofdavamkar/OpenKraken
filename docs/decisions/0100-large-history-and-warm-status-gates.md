# 0100 — Reproducible large-history and watcher-warm status gates

## Context

The M8 roadmap requires Chromium-sized synthetic history and watcher-warm status measurements as well as the full-Linux and 50,000-ref fixtures. It gives no exact synthetic topology or file count. Bare, tree-filtered history fixtures cannot establish working-tree status performance.

## Decision

Provide a deterministic, disposable generator with defaults of **2,000,000 commits and 100,000 tracked files**. Every thousandth commit branches from the penultimate main commit; the next main commit merges it. The default fixture has 1,999 merge commits and a final unmerged topic tip. Both branch tips are retained. A complete checkout and native commit graph are created. Native commands verify total reachable history, tracked-file count and clean status before writing the manifest.

The fixture represents history and path-count scale, not Chromium's contents or graph distribution. Paths share a five-byte blob except one status probe changed every thousand commits; most commits reuse a tree. This limits generation/storage cost and deliberately does not establish blob-heavy checkout, ignored-tree, submodule or large-content performance. The manifest records these limitations, exact counts, HEAD and native Git version.

Generate into a new directory only. Refuse existing destinations and invalid sizes; clear inherited Git-routing/configuration environment variables and use an empty template directory so fixture writes stay in the new repository. Import in bounded streaming chunks, wait for the native importer, and retain failed new directories for inspection. Never clean or reuse an existing checkout. Small native tests verify deterministic history, genuine diverging merge parents, complete checkout and refusal/redirection guards.

Reuse the existing graph benchmark and its unchanged 500 ms first-paint, 300 ms page and scrolling gates. Add an opt-in status benchmark accepting the generated manifest. Require a clean fixture and exact tracked probe contents before writing its one temporary edit. Restore it after app shutdown, including failure cleanup, and verify clean status afterward. The benchmark does not accept an arbitrary real working tree.

Measure status from renderer request initiation to the validated `workingState` response. This includes native status, revision, operation and commit metadata plus IPC, and excludes watcher debounce and UI paint. Establish native watcher readiness, record one explicit warm-up, then retain all five clean and five dirty samples against the **300 ms** budget. Separately measure external edit through visible enabled staging controls against the existing **1,500 ms** observer requirement. No measured outlier is discarded. Run three fresh profiles sequentially with OS caches uncleared and no concurrent builds/tests.

The ordinary desktop suite skips these opt-in large fixtures. Passing a synthetic run does not establish cold-cache, cross-platform or real Chromium behavior, resolve the separate 50,000-ref gate, or complete M8.

CI has a separate Linux scale-performance job. It builds once, generates and verifies the fixture, then runs graph and status samples sequentially. Both benchmark steps run after a successful build/fixture even if the other gate fails. Logs, manifest, all metrics and failure traces are uploaded; the generated Git database is not. Remote CI execution remains separate evidence from local acceptance.
