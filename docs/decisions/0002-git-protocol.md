# 0002 — Git streams, limits and repository access

Accepted 2026-11-01. Source: blueprint §2; public Git porcelain-v2, for-each-ref and rev-list manuals.

Use Git ≥2.38. Try an optional OPENKRAKEN_GIT path, then system Git. An unsupported or missing installation is an actionable error. Never run automatic maintenance, set safe.directory globally, or weaken TLS. Repository-related environment overrides are stripped so the shell cannot redirect a chosen folder elsewhere.

for-each-ref has no portable `-z` switch at the minimum version. Use nine fixed NUL-terminated fields and consume its trailing newline separately. Include peeled object type to exclude tags pointing at non-commit objects from history. History uses the documented rev-list commit header and twelve fixed fields; empty parent/body fields must not be treated as record separators. Include ISO dates to preserve timezone offsets. Git names/messages decode as UTF-8 for display; status paths retain base64 original bytes, including invalid UTF-8, for future filesystem operations.

Each process is limited to 32 MiB aggregate stdout/stderr, 2 MiB per NUL field, and 30 seconds. Limit failures are explicit rather than silently truncated. Streaming consumers avoid retaining raw stdout. Abort terminates the POSIX process group and escalates after 200 ms; Windows uses taskkill /T /F. Queued cancellation removes the job. Main allows eight requests and a 60-second service deadline. Shutdown aborts service requests before terminating the utility process.

A FIFO read/write queue is keyed by the common Git directory, with a four-reader ceiling, so linked worktrees share scheduling. A second four-process pool bounds total child processes, including discovery and metadata reads. Writers cannot be overtaken by later readers. M0's only write is explicit initialization of a selected folder, serialized by canonical path and rejected if metadata exists. Later writes must use the common-directory queue and test index.lock before mutation. External Git writers can still race reads; refresh requests a new snapshot.

Canonical paths identify repositories using SHA-256. Discovery has depth 2, skips symlinks and generated folders, and caps traversal at 5,000 directories. Permission failures are surfaced. Normal, bare, unborn, linked-worktree, shallow and sparse repositories are represented explicitly.

Initial history is capped at 2,000 commits plus a hasMore probe. Starts are visible commit refs plus HEAD. Read up to 200 stash reflog entries separately, showing only their first-parent links. Hidden stash implementation parents do not enter history. A topological merge preserves child-before-parent order even with skewed timestamps. Larger stash histories and Git stream paging remain M1 work.
