# M4 completion — merge, rebase and conflicts

M4's operation workflows and Linux acceptance criteria are complete as of 2026-11-01, at implementation commit `10bf30c`. M5–M8 remain open. React 19.3.1 and TypeScript 7.0.2 are unchanged.

## Implemented

- Native merge (ff, ff-only, no-ff, squash), rebase, cherry-pick and revert, including explicit mainline selection for merge commits.
- Operation detection and native progress, reviewed Continue/Skip/Abort, conflict counts and prepared commit messages.
- Reviewed soft/mixed/hard reset with guarded Undo/Redo and raw-file backups for hard reset.
- Three-way conflict resolution with a diff3 worker, per-chunk/per-line choices, editable output, automatic clean merge and configured native merge-tool launch.
- Ref-to-ref dragging with a reviewed merge/rebase action menu and guarded branch checkout.
- On-demand native merge prediction without changing HEAD, index or working files.
- Integration Undo/Redo restoring local HEAD, index and working files, including pull and app-started operations completed after conflict resolution/restart.
- Interactive rebase review with ordering, pick/reword/edit/squash/fixup/drop, native editor helper, edit-stop amendment, persistent reviewed plans, and additional Git document review through scoped prompts.

## Verification

| Check                                                       | Result                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| TypeScript build, ESLint and Prettier                       | Passed                                                      |
| Full Vitest suite                                           | 194 tests passed across 28 files                            |
| Combined Electron suite with Gitea enabled                  | 40 passed; one dedicated large-repository benchmark skipped |
| 2,000-commit first paint                                    | 234.7 ms                                                    |
| Next 5,000 commits including worker/layout/UI               | 184.4 ms                                                    |
| 12,000-row scroll frame p95                                 | 16.7 ms                                                     |
| Linux platform bundle and hardened fuse verification        | Passed                                                      |
| Packaged renderer isolation and native askpass/editor modes | Passed                                                      |
| Windows helper cross-compilation                            | Passed; runtime not executed here                           |

The native conflict corpus covers add/add, delete/modify, binary, rename/modify, executable modes and submodules. Interactive-rebase tests cover reorder, squash/fixup chains, reword, drop, edit-stop amendment, conflict/restart continuation, invalid/stale plans and additional editor Save/Cancel/refusal paths. Integration inverses verify native refs, trees and file bytes, preserve unrelated later edits, refuse overlapping edits and missing historical blobs, and retire intermediate resolution entries. A full-suite failure exposed a foreground clone error being cleared by background refresh; a focused regression reproduces and verifies the fix, and the combined suite now passes.

## Supported bounds and later work

Tracked work must be clean before starting integrations; users can stage/commit or use the existing stash workflow first. Interactive rebase reviews linear ancestor ranges of 1–500 commits and at most 2 MiB of plan/message data. Conflict text editing is bounded to 2 MiB/10,000 lines per side; binary and oversized files use whole-side choices. The fallback Git editor accepts regular UTF-8 files up to 1 MiB inside the repository's Git metadata and rejects redirected/out-of-scope paths.

Integration Undo requires clearing skip-worktree/assume-unchanged flags, does not undo fetched server state, and does not invent a starting snapshot for externally started operations. Abort has no inverse; completed integration Undo cannot recover skipped resolution edits. Hard reset's bounded backup layer currently refuses submodules and file/directory transitions. Pending records retain evidence after uncertain failures; crash-recovery UI and failure-injection hardening remain M8 work. These guards are optimistic checks rather than atomic transactions with arbitrary external filesystem writers.

macOS and Windows runtime evidence still requires the configured CI runners. The Linux package is an unsigned platform bundle; release installers, signing and updates remain M8 work. M5 will add the richer CodeMirror diff/editor presentation, encoding/image handling, streamed blame and paged file history.

Decisions: [operation state](../decisions/0019-operation-state.md), [reset](../decisions/0020-reset.md), [conflicts](../decisions/0021-conflict-resolution.md), [integration Undo](../decisions/0022-integration-undo.md), [interactive rebase](../decisions/0023-interactive-rebase.md).
