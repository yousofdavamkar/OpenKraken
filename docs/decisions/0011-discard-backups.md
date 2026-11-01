# 0011 — Recoverable discard outside Git

M2 stores raw working-file content in the application profile, outside the repository. Unlike Git objects, these backups survive object pruning and preserve working encodings and filter output. Discard requires a review token covering HEAD, staged contents, file bytes, and modes. A changed selection requires a new review. Unresolved conflicts and submodule worktrees are refused by the service.

Tracked files return to their staged version using native Git restore. Untracked files move to application trash with their original path metadata; cross-device moves copy and sync before removing the source. Trash is retained independently of journal eviction. Undo/redo restores bytes, links and executable modes, verifies backup hashes, and refuses to replace edits made since the action. Parent symlinks are refused. A cancelled operation still records changes that occurred before cancellation.

Backups are bounded to 64 MiB per file, 128 MiB per operation, and 512 MiB of referenced content across at most 20 journal entries. Old unreferenced blobs are pruned only when no pending recovery record exists. Application trash is not automatically purged. Pending records preserve recovery material after uncertain failures; an interrupted-operation recovery interface remains part of M8 hardening.

Validation uses real repositories, binary bytes, links, permissions, stale confirmation and stale undo, staged-versus-working contents, conflict refusal, and an Electron confirmation/discard/undo flow. These guards do not provide a filesystem-wide lock against an editor racing the final file replacement.
