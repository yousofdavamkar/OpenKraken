# 0009 — Working-tree transactions and a profile-owned undo journal

Status: accepted, M2 implementation in progress.

Whole-file staging and unstaging use literal, NUL-delimited original path bytes. Only currently reported status paths are accepted; renames include the original path. Unborn HEAD uses index-only removal. Git runs the actual add/restore operations, preserving native filters and attributes.

Acquire the real worktree's `index.lock`, copy its index into a private profile-owned temporary index, and disable split-index storage in that copy so backups are self-contained. An explicit trusted runner option selects this alternate index; shell and renderer environment overrides remain prohibited. Git commands update only the temporary index. Persist before/after snapshots in the profile journal, then publish the new real index by syncing and renaming the held lock. Linked worktrees retain separate indexes and journals while sharing the service's write queue.

Undo and redo compare HEAD and semantic index fingerprints before restoring anything. They preserve independent working-file edits and reject external HEAD/index changes. No custom refs or reflog markers are created. Git objects referenced by index backups must still exist; this is not an archival backup service. Keep up to 20 journal entries, cap index snapshots at 32 MiB and the journal at 128 MiB. Refuse oversized operations before publishing their index. A pending backup is written before mutation and preserved if an interrupted operation cannot be safely classified.

The UI presents staged/unstaged lists with per-file and all-file controls, plus Undo/Redo. Operations use the typed bridge and the common-directory write queue; the renderer never supplies command lines or absolute filesystem paths.

References: [Git add](https://git-scm.com/docs/git-add), [Git restore](https://git-scm.com/docs/git-restore), [Git update-index](https://git-scm.com/docs/git-update-index).

## Commit and amend

Use native `git commit --file=- --cleanup=verbatim`; hooks, `core.hooksPath`, filters and configured GPG/SSH signing remain Git's responsibility. Expose inherit/on/off signing choices and preload the configured message template or current commit message for amend. Refuse stale HEAD/index revisions, empty messages, and in-progress merge/rebase operations (their completion UI belongs to M4). Preserve drafts after errors. Git gets 120 seconds for hooks/pinentry; the main-process deadline is 180 seconds.

Undo/redo for commit and amend uses compare-and-swap `update-ref`, preserving independent worktree changes and staging state. An initial commit can return to an unborn branch. If cancellation arrives after Git moves HEAD, finish the journal/index bookkeeping before reporting cancellation so Undo remains available. Missing Git objects cause undo to fail before changing the real index or HEAD.

Verification covers exact trailing newlines, native hook rejection, stale staged revisions, cancellation during a post-commit hook, and an SSH-signed commit accepted by `git verify-commit`. Signing uses a temporary test key; no personal credentials are accessed.
