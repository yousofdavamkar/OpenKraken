# M5 progress — file inspection

M5 is in progress as of 2026-11-01. The verified implementation checkpoint is `e99aa4c`; a subsequent native regression test also covers merge-history traversal. M0–M4 retain their documented Linux acceptance scope. M6–M8 remain open. React 19.3.1 and TypeScript 7.0.2 are unchanged.

## Implemented

- Native, virtualized commit file lists with explicit merge-parent selection and raw filename bytes retained.
- Read-only commit comparisons in virtualized hunk, inline and split views, native whitespace filtering, word highlights and JavaScript/TypeScript syntax highlighting.
- Binary/submodule metadata, byte/line display guards and explicit large-file loading.
- UTF-8/BOM handling, bounded legacy encoding detection and a read-only encoding override.
- Bounded static PNG/JPEG/WebP previews, side-by-side images and adjustable opacity overlays.
- Native file history that preserves rename traversal across pages, appends older revisions and opens the corresponding historical filename.
- Native streaming blame, request-scoped IPC batches, virtualized attribution and cancellation.

## Verification

| Check                                               | Result                                                      |
| --------------------------------------------------- | ----------------------------------------------------------- |
| TypeScript build, ESLint and Prettier               | Passed                                                      |
| Full Vitest suite                                   | 210 tests passed across 35 files                            |
| Combined Electron suite with Gitea enabled          | 46 passed; one dedicated large-repository benchmark skipped |
| 50,000-line comparison open                         | 478.6 ms                                                    |
| 10,000-line blame first screen                      | 106.9 ms                                                    |
| 2,000-commit graph first paint                      | 238.3 ms                                                    |
| Next 5,000 graph commits including worker/layout/UI | 158.5 ms                                                    |
| 12,000-row graph scroll frame p95                   | 16.7 ms                                                     |

These timings are observations from the isolated Linux desktop suite on this machine. Tests also bound rendered DOM rows, verify native file contents/object attribution, cover encoding/raster guards, exercise rename paging and parser chunk boundaries, and verify that read-only inspection leaves repository state unchanged. The existing authentication, operation, staging, Undo and watcher desktop tests remain green. Packaging and cross-platform runtime verification have not been repeated for M5 yet.

## Remaining M5 work

- WIP editing with stale-content checks, encoding/working-tree-encoding handling, preserved file modes and reversible saves.
- Rich WIP comparisons while retaining the existing reviewed hunk/line staging semantics.
- Broader syntax-language support and a final accessibility/edge-case pass for file inspection.
- M5 completion verification and packaged smoke checks.

Blame currently accepts regular UTF-8 files up to 2 MiB/50,000 lines. File-history starting names must pass the Node UTF-8 argument boundary; history pages replay a bounded prefix to preserve native rename handling. Image previews exclude animated and active-content formats. Other display and decoding bounds are documented in [the file-inspection decision](../decisions/0024-file-inspection.md). This report is a progress checkpoint, not M5 completion or cross-platform release acceptance.
