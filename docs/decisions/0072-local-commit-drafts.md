# 0072 — Local commit drafts

Commit messages previously lived only in the mounted working-tree component. Closing the app, losing the renderer or switching repositories lost that text. Store a bounded draft for each opened checkout in the application's local profile through typed main-only IPC.

## Identity and contents

Main derives a file name from the SHA-256 hash of the canonical checkout path and Git directory supplied by a validated repository snapshot. The renderer supplies only an already-opened repository ID; it cannot supply a storage path. Main retains the latest 128 opened identities. Linked worktrees have separate drafts even when they share a common Git directory. Moving a checkout creates a different identity; automatic migration is not implemented.

Each file contains normal commit text, amend text, the amend toggle and reviewed HEAD, and the signing selection. Both text fields are limited to 65,536 UTF-16 code units; the native commit operation retains its separate 64 KiB UTF-8 limit and message validation. Persisted files are bounded to 1 MiB, including JSON escaping. Text is local plaintext, not encrypted; no provider tokens or file contents are added. Draft reads/saves do not enter the activity log.

Files live under `commit-drafts/` outside repositories. File names contain no literal repository paths. This hashing is an identity mechanism, not secrecy for repository paths. There is one file per saved checkout with no automatic eviction of user drafts. Empty drafts remain as tombstones so a cleared template does not unexpectedly return on restart.

## Persistence and concurrency

Writes are serialized in main, schema-validated, written to a private exclusive temporary file, flushed and atomically renamed. POSIX directories/files use initial modes 0700/0600. Leaf symlinks, redirected draft directories, non-regular or oversized files and malformed schemas are refused. A revision is the hash of the exact stored bytes; save compares it against current contents and rechecks the source before replacement. This catches stale concurrent saves and external changes, including changes to otherwise valid JSON. These optimistic filesystem guards do not isolate the profile from another process running as the user.

The UI coalesces edits after 250 ms, serializes its saves and shows saved status only after acknowledgment. Draft loading completes before editing is enabled; a storage failure then leaves an editable form and a persistent warning. Local text remains visible after failed saves. Keep a separate copy before restarting to investigate or repair unavailable storage. Cleanup/navigation attempts to flush pending edits, and normal app shutdown waits for admitted main-process writes within the existing shutdown deadline. A crash before acknowledgment can lose the newest edits; no power-loss durability or unlimited shutdown wait is claimed.

## Commit behavior

Normal and amend text remain separate. Toggling Amend retains edited text while HEAD is unchanged. Restoring an amend draft for an older HEAD disables submission until the user turns Amend off and on to review the current commit. Changing repositories, refreshes and reads never submit a commit.

A successful commit clears the submitted text and resets the previous HEAD's amend state when no newer edit was made during the operation. A successful amendment retains the separate normal draft. Failure, cancellation and uncertain results retain text. A crash between a completed Git write and its acknowledged draft-clear can restore a message already used by Git; users must inspect history before submitting it again. Draft persistence does not replace a write-recovery journal or reconcile native locks.

## Verification scope

Tests use the approved Electron UI and typed IPC boundaries with real Git and profile files. They cover acknowledged draft recovery after a forced renderer crash and app restart, successful clearing, failed hooks, newer edits during a blocked commit, normal/amend separation, changed-HEAD refusal, linked-worktree isolation, stale saves, unknown repository IDs, private file permissions, external changes and preservation of corrupt/symlinked storage. Strict contract tests reject arbitrary paths, unknown fields, invalid revisions and oversized text, and keep these routes out of the Git utility.

This increment covers commit-form drafts. Working-file, conflict-editor, native-editor and provider-composer drafts, broader crash recovery and macOS/Windows runtime acceptance remain separate work.
