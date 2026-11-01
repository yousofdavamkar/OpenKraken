# 0006 — Compact vertical graph spans and cooperative indexing

Status: accepted.

## Evidence and decision

The recent Linux-history benchmark exposed a wide-frontier cost that linear fixtures did not exercise. One 5,000-commit page expanded to 2,001,994 edge objects across as many as 453 lanes. Layout serialization alone took about 2.7 seconds, and the Electron renderer reached about 1.8 GB working set after loading 17,000 commits.

Keep the explicit per-row allocator representation as an independent verification mode. The production worker uses compact vertical spans for unchanged pass-through lanes and per-row edges for actual endpoints and branch/merge transitions. A target-to-column index avoids scanning every live lane for each compact row. Checkpoints retain the same lane continuation state. Refresh clips spans around the changed row interval; viewport rendering looks up overlapping 500-row buckets and clips offscreen columns.

The explicit mode shares immutable pass-edge objects across rows. Structured cloning preserves that sharing. Property tests expand the compact spans and compare every edge with the explicit mode, including pinned histories, appends and checkpoint refresh. The existing image goldens remain unchanged.

MiniSearch indexing runs in batches of 25 documents between worker messages. Searches flush outstanding documents before answering. This keeps long real-world commit messages from monopolizing the worker between layout requests. The renderer still receives a completed layout before indexing finishes.

## Git traversal limitation

The benchmark clone has 87,206 commits and a shallow boundary at 2026-01-01. Profiling measured about 0.95–1.0 seconds in repository open/snapshot, before layout. The existing retained `rev-list --date-order` traversal and child-before-parent ordering remain unchanged.

Git documents that ordered walks may require visiting the entire graph, and that commit-graph acceleration is unavailable with shallow boundaries. See [Git commit-graph design](https://git-scm.com/docs/commit-graph). The measurements are consistent with this limitation; they do not establish performance for a full, indexed Linux repository.

The real-history paging and scrolling gates now pass, while its first-paint gate remains failing. Keep that failure visible. Further startup work needs a separate cache/index design or an agreed performance envelope; this increment does not write commit-graph files into users' repositories or change traversal order to improve a timing result.
