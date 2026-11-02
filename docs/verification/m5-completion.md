# M5 completion — diff, blame, history and editor

M5's file-inspection workflows and Linux acceptance criteria are complete as of 2026-11-01 at implementation commit `518368b`. M6–M8 remain open. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Implemented

- Virtualized commit file lists with explicit merge-parent selection and native rename metadata.
- Commit, staged and unstaged comparisons in hunk, inline and split views; native whitespace filtering, bounded word highlights and filename-based syntax support.
- Binary/submodule metadata, static PNG/JPEG/WebP previews and opacity overlays, encoding detection/override, and explicit byte/line guards.
- Paged file history preserving native rename traversal and historical filenames; streaming, virtualized blame with cancellation.
- CodeMirror WIP drafts, explicit saves with encoding/BOM/line-ending preservation, stale-content protection and repository Undo/Redo.
- Unsaved-draft review on editor close, window close and application Quit; cancelling Quit preserves the repository service.
- Keyboard-accessible read-only comparison panes. Returning from a rich WIP view to line staging obtains fresh exact native hunks and a review token.

## Verification

| Check                                                              | Result                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| TypeScript build, ESLint and Prettier                              | Passed                                                      |
| Full Vitest suite                                                  | 221 tests passed across 38 files                            |
| Combined Electron suite with Gitea enabled                         | 51 passed; one dedicated large-repository benchmark skipped |
| 50,000-line comparison open                                        | 340.5 ms (budget <1,000 ms)                                 |
| 10,000-line blame first screen                                     | 149.4 ms (budget <300 ms)                                   |
| 2,000-commit graph first paint                                     | 256.0 ms                                                    |
| Next 5,000 graph commits including worker/layout/UI                | 165.1 ms                                                    |
| 12,000-row graph scroll frame p95                                  | 16.7 ms                                                     |
| Linux platform bundle and hardened fuse verification               | Passed                                                      |
| Packaged renderer isolation and native askpass/editor helper modes | Passed                                                      |

Native tests cover canonical clean-filter and working-tree-encoding behavior, staged renames/deletions, arbitrary-byte patch reconstruction, large unchanged prefixes, Shift-JIS/UTF-16 decoding, binary/raster guards, history paging, attribution, cancellation and optimistic save guards. Desktop tests exercise view switching, whitespace controls, images, history across renames, bounded DOM rows, Python syntax, keyboard/read-only behavior, local and repository Undo, stale drafts and native close/Quit choices. Inspection tests verify that repository state is unchanged. Existing graph, transport, staging, watcher and integration tests remain green. Timings are isolated Linux observations on this development machine.

## Supported bounds and later work

Comparison defaults are 2 MiB/10,000 lines; explicit loading permits at most 20 MiB/250,000 lines. Images exclude animated and active-content formats and have independent dimension limits. Encoding detection is heuristic and can be overridden for display. WIP editing accepts round-trippable regular text files up to 2 MiB/50,000 logical lines; mixed line endings require an explicit save format. A stale draft remains open for copying or review; reload requires closing and reopening it.

Blame currently accepts regular UTF-8 files up to 2 MiB/50,000 lines. History pages replay a bounded prefix to preserve rename handling, capped at a 10,000-entry offset. Native path arguments require UTF-8 starting names. Conflicts use the existing conflict editor; unstaged submodule comparisons await M7's submodule controls. Git-canonical comparison contents can differ from the raw encoding saved by the editor. External filesystem writers are guarded optimistically, not locked atomically.

macOS/Windows runtime evidence still requires their configured runners. The Linux artifact is an unsigned platform bundle; release installers, signing, updates and broader security/accessibility hardening remain later milestone work. This report establishes M5's Linux scope, not completion of the whole roadmap.

Decisions: [file inspection](../decisions/0024-file-inspection.md), [working-file editor](../decisions/0025-working-file-editor.md).
