# 0006 — Compact vertical graph spans and cooperative indexing

Status: accepted.

## Evidence and decision

The recent Linux-history benchmark exposed a wide-frontier cost that linear fixtures did not exercise. One 5,000-commit page expanded to 2,001,994 edge objects across as many as 453 lanes. Layout serialization alone took about 2.7 seconds, and the Electron renderer reached about 1.8 GB working set after loading 17,000 commits.

Keep the explicit per-row allocator representation as an independent verification mode. The production worker uses compact vertical spans for unchanged pass-through lanes and per-row edges for actual endpoints and branch/merge transitions. A target-to-column index avoids scanning every live lane for each compact row. Checkpoints retain the same lane continuation state. Refresh clips spans around the changed row interval; viewport rendering looks up overlapping 500-row buckets and clips offscreen columns.

The explicit mode shares immutable pass-edge objects across rows. Structured cloning preserves that sharing. Property tests expand the compact spans and compare every edge with the explicit mode, including pinned histories, appends and checkpoint refresh. The existing image goldens remain unchanged.

MiniSearch indexing runs in batches of 25 documents between worker messages. Searches flush outstanding documents before answering. This keeps long real-world commit messages from monopolizing the worker between layout requests. The renderer still receives a completed layout before indexing finishes.

## Sending layout rows to the renderer

The worker transfers two unsigned 32-bit buffers for node and edge records. A page-local string table carries each node or edge target ID once, including synthetic working-tree IDs. Each node records the end of its edges, and the renderer derives its row index from the reply offset. Passages, checkpoint indices and refresh reuse counts travel alongside the buffers. The renderer reconstructs the existing Canvas row objects before publishing the page. The worker retains its own checkpoints for subsequent appends.

## Git traversal limitation

The benchmark clone has 87,206 commits and a shallow boundary at 2026-01-01. Profiling measured about 0.95–1.0 seconds in repository open/snapshot, before layout. The existing retained `rev-list --date-order` traversal and child-before-parent ordering remain unchanged.

Git documents that ordered walks may require visiting the entire graph, and that commit-graph acceleration is unavailable with shallow boundaries. See [Git commit-graph design](https://git-scm.com/docs/commit-graph). The measurements are consistent with this limitation; they do not establish performance for a full, indexed Linux repository.

The real-history paging and scrolling gates now pass, while its first-paint gate remains failing. Keep that failure visible. Further startup work needs a separate cache/index design or an agreed performance envelope; this increment does not write commit-graph files into users' repositories or change traversal order to improve a timing result.

## Failed worker dispatch and unreadable replies

When posting a graph request throws synchronously, the renderer removes that request and clears its timeout. The worker can still serve its current generation. A delivered browser `messageerror` cannot identify a usable reply, so the renderer closes that worker and rejects its pending requests immediately. Refresh can then create a new worker. An Electron regression injects a dispatch failure, retries Refresh, advances past the old timeout and checks paging and search on the recovered graph.

The renderer checks the lengths of packed node and edge records, the node and edge target IDs, and each node’s edge boundary before publishing a layout. A truncated reply can arrive after the worker has advanced the generation. The renderer retires that worker and settles every waiting request. The Electron regression refreshes the graph after a truncated append, then loads and searches another page.

The renderer also checks each reply against its pending request. Reset and append must return the requested offset and every submitted commit ID in order. A refresh may reuse a prefix and tail, but those ranges plus its returned rows must cover the requested history exactly. The whole-row regression drops the final complete node and its edges, leaving a decodable message. The displayed 2,000 commits survive the error, and Refresh recovers paging and search.

## Sending commits to the worker

Reset, append and refresh send each commit’s ID, ordered parents, stash marker, summary, body, author name and author email. The renderer keeps the display metadata, including the committer and timestamps. On a replay of the same real history through the Electron renderer and graph worker, median round-trip time fell from 20.4 to 17.9 ms for 2,000 commits and from 50.0 to 45.2 ms for a 5,000-commit append. Both paths produced identical graph rows, edges and passages. [Desktop measurements](../verification/m8-reference-performance.md#filtered-history-and-graph-worker-input)
