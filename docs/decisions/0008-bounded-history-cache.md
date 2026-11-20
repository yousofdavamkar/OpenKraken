# 0008 — Bounded history cache and retained-stream read-ahead

Status: accepted.

## Problem and measured cause

Git's ordered walk took roughly one second before producing the first page of the shallow Linux fixture. A full Linux clone with a pre-existing Git commit-graph meets startup latency, but uncached shallow walks cannot use that acceleration. Reading the next page only after a UI request also leaves Git idle while the current page is laid out. Serializing an entire cache window at once introduced a second source of paging stalls.

## Decision

Keep one retained `rev-list --date-order` stream, pinned to the snapshot's explicit start OIDs. After delivering a page, read ahead at most one 5,000-commit page plus lookahead and the final input chunk, subject to the existing 64 MiB buffer limit. The next request consumes that buffer and continues the same traversal. Cancellation and Refresh still close the old stream. No skip/refetch traversal or repository index writes are introduced.

Cache up to 17,000 delivered commits per repository under the app profile. Store a 2,000-record prefix (8 MiB file cap) and three 5,000-record continuation pages (18 MiB each). Admit no more than 16 repository caches or 128 MiB of committed cache pages; evict the oldest written inactive entries after writes. Debounce writes for five seconds, flush on repository switches and graceful shutdown, and serialize in 100-record batches with event-loop yields. Cache writes are best effort; failure does not prevent Git reads. Crash recovery can lose the latest unflushed pages.

A generation fingerprint covers format version, Git version, effective Git configuration, traversal starts, stash OIDs, replacement refs, shallow/graft/alternate metadata and commit-graph file metadata. Environment overrides for shallow boundaries and replacements disable caching. Persist only the fingerprint, never the effective configuration text. Each page has a schema, offset and digest covering its records and continuation metadata. Invalid pages are cache misses.

On reopen, publish the small prefix first, then read continuation pages incrementally. Validate and hash decoded records in 100-record batches with event-loop yields so later pages cannot monopolize the Git service. The real retained Git traversal runs alongside it, revalidating and skipping cached OIDs/parents/stash markers before supplying later records. While the opening page is displayed, the native walk checks the rest of the cached topology. Matching cached records consume no additional buffer space. Once the walk catches up, ordinary page backpressure resumes. On a topology mismatch the cursor rejects further pages immediately, invalidates the cache and asks for Refresh, including while the native process exits. Cached data can be displayed before this replay finishes because its generation and digest have already been validated. Missing or corrupt middle cache pages fall back to the live walk at the last contiguous prefix. The cache changes neither Git ordering nor graph continuation.

## Performance envelope and verification

The full Linux benchmark uses a fresh app profile and an explicitly prepared Git commit-graph. The separate warm benchmark restarts the app after caching 17,000 commits from a shallow clone. Neither clears the OS file cache. These are distinct conditions, recorded in the measurement JSON; an uncached shallow repository can still exceed the 500 ms startup target. OpenKraken does not automatically build commit-graphs in users' repositories.

A 19,000-commit integration test gates the actual Git stream, verifies cached pages can be read independently, then joins the live stream with exactly Git's ordering and no duplicates. The same test removes a middle cache page and verifies recovery. Other tests cover shallow deepening, ref/config changes, damaged records, eviction and mismatch invalidation. The opt-in Electron benchmark retains the original 500 ms startup, 300 ms paging and 60 Hz scrolling gates.

## External graft files

Git can use a file selected by `GIT_GRAFT_FILE` to override commit parentage. Changing that file can change every displayed page while HEAD, refs and the repository's own graft metadata stay the same. The service bypasses cache reads and writes whenever the variable is set. An empty value tells Git to ignore the repository’s own graft file and can restore the entire ungrafted history. Removing the override makes the ordinary cache available again. A regression with an existing 32-commit prefix originally displayed all 32 when native Git reported one.

## Empty shallow and replacement settings

An empty `GIT_SHALLOW_FILE` ignores the repository’s shallow boundary. An empty `GIT_NO_REPLACE_OBJECTS` disables replacements. An empty `GIT_REPLACE_REF_BASE` can bring replacement refs outside the usual namespace into the native walk. The service bypasses the disk cache whenever any of these settings is present. It also skips the tentative unreplaced walk for custom replacement namespaces and shallow overrides, and uses direct native ref metadata for custom namespaces. Tests reopen a populated cache and compare ordered object IDs and parent lists with Git before, during and after each override.

## Pages that overlap the retained prefix

The next page after a restart can contain both previously cached commits and new records from Git. The cache appends the portion that extends its contiguous range, up to the 17,000-record limit, and records the continuation flag from that page. A test reopens 2,333 cached commits, requests a 5,000-commit page at offset 2,000 and then consumes the final 24 commits. All 7,024 records, their order and the end-of-history flag survive another restart.

## Writing history during a repository switch

Start flushing the displayed history while Git reads refs, working state and cache inputs for the next snapshot. Wait for that flush before loading the next cache because a flush can also evict older entries. On handoff, drain any commits delivered to the previous cursor during the switch. If the new snapshot fails, the previous cursor remains available. A regression holds the destination ref read open, observes the old prefix on disk, appends 100 commits to the displayed cursor and verifies those records survived the switch.

Serialize a page in batches of 100 commits and encode each batch as UTF-8. The digest and the file use the same bytes. Include the header, separators and footer in the page size check. Stop encoding later batches once a batch exceeds the file cap and remove any older copy of that oversized page. The on-disk format is unchanged. [Cache timing and compatibility measurements](../verification/m8-reference-performance.md#switching-with-17000-commits-loaded)

## Persisting an extended window

Each cache instance tracks the files it wrote and the pages its cursor accepted from disk. When paging extends the window, the writer can retain a file with the same offset, record count and continuation flag because the records in that instance are append-only. It checks the file’s device, inode, size, modification time and change time before skipping serialization. A changed or missing file is rebuilt from the retained commits on the next dirty flush. The next reader still validates the page schema and digest. A tail that the cursor declined contributes no reusable file.


## Leaving a pending cache read

A cancelled repository open releases its wait for the opening cache file and preserves the displayed cursor. A refresh, switch or service shutdown stops optional reads of later cache pages. The service still flushes any writes it owes. If the destination fails to open, the previous cursor can continue from Git. A late file open closes its descriptor, and a discarded page cannot append commits or invalidate the current history. Reads already in the operating system may settle after the request returns.

A cancelled switch or a failed destination releases its wait on an outgoing write. The original cache owns that write until it finishes. Its displayed cursor can serve subsequent pages in the meantime. A later successful switch or shutdown flushes the accumulated pages. The native handoff test holds the prefix write open, pages the original repository after cancellation or failure, and then checks the persisted prefix and tail.

## Restarting with a saved first page

On an initial open with disk caching enabled, the service can read and validate the first cache page while Git enumerates refs and resolves the current graph. It starts this read only when there is no previous cache writer in the service. Before use it checks the cache path, the file’s current device, inode, size, modification and change times, and the fingerprint computed from this opening. A replaced file goes through the ordinary cache reader. A fingerprint mismatch or missing page falls back to the native history. Later pages still start loading only after the opening prefix is accepted. Cancelling the open abandons the pending read. [Restart measurements](../verification/m8-reference-performance.md#reading-the-cached-first-page-during-ref-enumeration)
