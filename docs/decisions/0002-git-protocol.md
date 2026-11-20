# 0002 — Git streams, limits and repository access

Accepted 2026-11-01. Source: blueprint §2; public Git porcelain-v2, for-each-ref and rev-list manuals.

Use Git ≥2.38. Try an optional OPENKRAKEN_GIT path, then system Git. An unsupported or missing installation is an actionable error. Never run automatic maintenance, set safe.directory globally, or weaken TLS. Repository-related environment overrides are stripped so the shell cannot redirect a chosen folder elsewhere. Concurrent requests share the in-flight lookup. A successful lookup lasts for the utility process lifetime. After a lookup failure, the next request probes again so the user can repair Git and retry in the same session.

for-each-ref has no portable `-z` switch at the minimum version. Use nine fixed NUL-terminated fields and consume its trailing newline separately. Include peeled object type to exclude tags pointing at non-commit objects from history. History uses the documented rev-list commit header and twelve fixed fields; empty parent/body fields must not be treated as record separators. Include ISO dates to preserve timezone offsets. Git names/messages decode as UTF-8 for display; status paths retain base64 original bytes, including invalid UTF-8, for future filesystem operations.

Reference fields use a text-specific NUL decoder: Node's streaming UTF-8 decoder preserves split codepoints, while a separate byte count enforces the existing field limit before decoding. Split each decoded read into fields instead of allocating and copying a Buffer for every field. Keep the original byte decoder for paths, retained binary fields and other existing consumers. Differential tests cover arbitrary bytes, including malformed UTF-8, and varied read boundaries. This reduces isolated reference parsing cost without changing any reference field or Git format; it has not closed the large-reference first-paint gate. See the [M8 performance report](../verification/m8-reference-performance.md).

Default process limits are 32 MiB aggregate stdout/stderr, 2 MiB per NUL field, and 30 seconds. Limit failures are explicit rather than silently truncated. Streaming consumers avoid retaining raw stdout. Abort terminates the POSIX process group and escalates after 200 ms; Windows uses taskkill /T /F. Queued cancellation removes the job. Main allows eight requests and uses a default 60-second service deadline. Full-history search has [separate deadlines](0004-m1-history-and-interaction.md). Shutdown aborts service requests before terminating the utility process.

A FIFO read/write queue is keyed by the common Git directory, with a four-reader ceiling, so linked worktrees share scheduling. A second three-process pool bounds service-scheduled child processes, including discovery and metadata reads. Writers cannot be overtaken by later readers. M0's only write is explicit initialization of a selected folder, serialized by canonical path and rejected if metadata exists. Later writes must use the common-directory queue and test index.lock before mutation. External Git writers can still race reads; refresh requests a new snapshot.

Canonical paths identify repositories using SHA-256. Discovery has depth 2, skips symlinks and generated folders, and caps traversal at 5,000 directories. Permission failures are surfaced. Normal, bare, unborn, linked-worktree, shallow and sparse repositories are represented explicitly.

Initial history is capped at 2,000 commits plus a hasMore probe. Starts are visible commit refs plus HEAD. Read up to 200 stash reflog entries separately, showing only their first-parent links. Hidden stash implementation parents do not enter history. A topological merge preserves child-before-parent order even with skewed timestamps. Larger stash histories and Git stream paging remain M1 work.

## Decoding the graph traversal header

The retained graph walk uses `rev-list --date-order --parents --no-abbrev-commit --format=… --stdin`. The first NUL terminates Git’s header, which contains the full commit ID and its ordered parent IDs. An empty second field keeps author, committer and message fields at the same offsets used by search and stash reads. Those reads use `git log` with explicit `%H` and `%P` fields. The public parser also accepts the earlier stream with both the header and the formatted IDs. The parser handles complete twelve-field records from each chunk and carries incomplete records across reads. [History stream measurements](../verification/m8-reference-performance.md#reading-ancestry-from-gits-traversal-header)

## Raw author and committer dates

Graph traversal, stash reflogs, commit search and exact-ID lookup ask Git for `%ad` and `%cd` with `--date=raw`. Each signature supplies a name, email and one field containing epoch seconds and the recorded numeric timezone. The parser keeps both offsets independently and decodes ten NUL-terminated fields per commit. These reads specify their date format even when the user has configured a different display preference. The existing twelve-field parser and its exported formats remain available for callers of the earlier protocol.

Converting an epoch-zero timestamp to a calendar date west of UTC can make Git abort the entire walk. Raw dates preserve the seconds and offset for that commit. They also avoid sending a formatted date alongside an existing timestamp for every author and committer. [Git date formats](https://git-scm.com/docs/git-rev-list)

## Repository paths in native output

Git emits a line feed after a repository path on POSIX. Repository discovery removes that one delimiter, preserving a carriage return in the directory name. Windows accepts CRLF output for both the individual and combined metadata queries. The POSIX regression opens two adjacent repositories distinguished by a final carriage return and checks the selected root, repository ID and first commit.

## Reading HEAD while opening a repository

The opening metadata query asks `git rev-parse` for the Git directory, common directory, bare and shallow flags, and verified HEAD. A committed HEAD adds a full SHA-1 or SHA-256 ID after the flags. An unborn HEAD returns exit status 1 and the metadata fields. The independent symbolic-ref query distinguishes an unborn branch from a detached commit. It runs alongside the metadata and sparse-checkout setting reads. Paths containing a newline still use separate directory queries. Tests exercise both an unborn branch and a detached commit in such a checkout.

## Nested annotated tags

Git 2.38 can return an intermediate tag in the dereferenced fields of `for-each-ref`. The reference reader resolves those remaining tag IDs with one bounded `cat-file --batch-check` request. Each input uses the captured object ID and the recursive `^{}` suffix. The ref retains the outer tag ID for identity and uses the final object ID and type for badges, graph roots and search. Tags ending at a tree or blob stay visible in the reference list. [Git revision syntax](https://git-scm.com/docs/gitrevisions) and [batch object information](https://git-scm.com/docs/git-cat-file).
