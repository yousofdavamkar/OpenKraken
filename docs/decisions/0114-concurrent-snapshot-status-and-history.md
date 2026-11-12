# 0114. Reuse opening observations and prepare history alongside status

The first graph page depends on visible refs and linked worktree heads. Start the current checkout's full porcelain status scan alongside those reads. As soon as the traversal roots are available, prepare history and its first page. Publish the new cursor after status, history and any requested graph preference save succeed. A failed read cancels the outstanding work. Close the candidate cursor and keep the displayed cursor and cache available for paging.

For a fresh watcher, read the HEAD, operation, config, shallow and fetch metadata before requesting the snapshot. Hash the exact porcelain bytes as the snapshot parser consumes them. Seed checkout membership and other-checkout status from the snapshot's worktree list. This captures staged blob changes even when paths and status letters stay the same. A bare repository uses the digest of empty status output. Live checks still read Git after subscription to detect changes since capture.

Feed the ordered reference records into SHA-256 in bounded batches, flushing after a complete reference line. Maintain separate digests for all refs and for graph refs, which exclude tags. Preserve the original bytes for the native all-ref digest when names cannot round-trip through UTF-8.

The [startup measurements](../verification/m8-reference-performance.md#opening-status-and-history) cover the different effects on a large checkout and bare repositories.
