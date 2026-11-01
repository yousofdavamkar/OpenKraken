# 0003 — Pure lane layout and M0 verification

Accepted 2026-11-01. Source: blueprint §§4.2–4.3, roadmap graph invariants.

Represent edge geometry with an upper half for incoming/end edges, a lower half for start/merge/branch edges, and whole-row pass edges. Every segment includes the awaited parent ID, enabling tests to trace each parent path continuously. First-parent continuation preserves color; allocations cycle ten colors. Free root lanes immediately, trim trailing empty lanes, and reuse internal holes. Prefer a free lane to the right for additional parents. Stash inputs project to their first parent. Pinning and delayed lane reuse are deferred options.

The allocator clones its checkpoint input, returns only new rows, and saves checkpoints every 500 rows. It assumes a deduplicated child-before-parent DAG, as produced by Git. Unloaded parents remain boundary lanes. A Web Worker entrypoint is supplied for M1's canvas view. M0 displays a virtualized plain commit list, as requested; it does not yet render the graph or load more history.

Fixtures are authored independently with fast-import and ordinary Git commands. Fixed names, timestamps, content and graph topology make results reproducible. Golden snapshots use message labels rather than platform-sensitive object IDs. Fixtures cover linear, merge, octopus, criss-cross, orphan and stash graphs. Random DAG tests independently trace segments, check ordering/cell uniqueness/frontier width, and compare paged versus one-shot layout. Parser tests vary byte chunking and include raw filenames and malformed streams.

The first-paint gate measures from the open request (with the native picker stubbed in tests) through service IPC, React rendering and two animation frames. It runs against 2,200 synthetic commits, displaying 2,000, and enforces <500 ms. This is a repeatable local/CI measurement, not certification of an unspecified mid-range laptop or linux.git. E2E checks Node globals, actual window security preferences, CSP eval blocking and bounded DOM rows. Package-time checks inspect the flipped fuse bytes; OS enforcement/signing remains release validation.
