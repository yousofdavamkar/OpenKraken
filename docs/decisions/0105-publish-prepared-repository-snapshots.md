# 0105 — Publish repository snapshots only after preparation succeeds

## Context

A failed repository switch kept the previous repository visible but closed its watcher before the replacement snapshot finished. A desktop regression reproduced missing native branch updates after the failure, even though the status still said the repository was watched.

Snapshot preparation also retired the published history cursor and changed the active cache before reading the replacement's first page. Native regressions with a missing commit parent and a cancelled first-page read left the previous snapshot's cursor stale. A later automatic refresh could hide this problem, so the desktop regression must request another page immediately after the failure.

## Decision

Prepare a new watcher without replacing or closing the current watcher. Prime the candidate around the new snapshot as in ADR 0104. Adopt it and retire the previous watcher only after the snapshot succeeds; close a failed candidate while preserving the previous watcher and its scheduled startup. A successful switch still retires the old watcher and starts the new subscriptions through the existing delayed handoff.

Prepare the history cursor and cache locally. Keep the published cursor and cache until the candidate's first page and any requested view-preference save succeed. Check cancellation before retiring the published state. On preparation failure, close and drain the candidate's native traversal and leave the published cursor/cache available. On success, close the prior cursor, flush its remaining cache records, and install the candidate. Old cursor identities then become stale as before.

Serialize snapshot preparation across repositories through a single-reader queue, while retaining the existing per-repository read/write queues. The application owns one active history; at most one published traversal and one candidate traversal are retained during replacement. Other repository reads and paging retain their existing paths. Snapshot elapsed time includes the new queue wait.

This is a publication boundary for observed state, not a rollback of Git writes or an atomic filesystem snapshot. It preserves an otherwise valid published cursor; an already-cancelled or stale cursor still requires refresh. Native Git state can change externally, a saved preference may already have been written when cancellation arrives, and later history pages can still fail if repository objects become unreadable. Existing revision checks, watcher reconciliation, errors and stale-cursor guards remain necessary.

## Verification

The desktop test first failed because a branch created after an unsuccessful switch never appeared. It now covers both a missing ref object and a readable commit whose parent is missing. The current repository remains visible and pageable immediately after failure, receives later native branch/file updates, and can switch successfully after the destination is repaired. Refresh-on-focus is disabled in the regression so focus events cannot conceal broken observation.

Native tests first reproduced stale cursors after failed switch, failed refresh and first-page cancellation. They now compare the retained tail and persisted cache against native Git history, cover cancellation during and just after the first-page read, and force a preference-save failure after a 12,000-commit traversal starts. The failed candidate's native process must settle before the request rejects. A successful later refresh must invalidate the old cursor and allow paging through the new one.

No IPC surface, graph layout, page size, validation policy, performance budget or Git data is changed. Release and large-reference performance gates remain separate from these recovery checks.
