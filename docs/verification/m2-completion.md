# M2 — Working tree and commits

M2 is implemented. React 19.3.1, TypeScript 7.0.2 and Electron 45.2.1 remain pinned. M3–M8 are still outstanding; this report does not claim overall product completion.

## Shipped

- Stage/unstage files, hunks, or selected lines using native Git and literal byte-preserving paths. Stale previews are rejected before applying a patch. Binary, rename, conflict and non-UTF-8 previews explain their whole-file fallback.
- Reviewed discard with raw content backups outside Git, recoverable application trash for untracked files, and guarded persistent undo/redo. Discard leaves staged content intact.
- Commit/amend with exact messages, templates, native hooks, configured GPG/SSH agents, failure output, preserved drafts, and undo/redo. SSH signing is tested with a temporary key and verified using Git.
- Native repository watching, a probe self-test, polling fallback, refresh classification, configurable focus refresh, and typed subscription events. Status updates preserve loaded graph pages; ref changes reload the initial history window.

Design decisions: [transactions](../decisions/0009-working-tree-transactions.md), [partial staging](../decisions/0010-partial-staging.md), [discard backups](../decisions/0011-discard-backups.md), and [repository observation](../decisions/0012-repository-observation.md).

## Verification on Linux x64

| Check                                              | Result                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm test`                                        | 89 tests passed in 15 files                                           |
| Random selected-line staging                       | 10,000 seeded cases checked against real Git trees in both directions |
| `pnpm typecheck` / `pnpm lint`                     | Passed                                                                |
| Default Electron suite                             | 16 passed; opt-in benchmark skipped                                   |
| Six Canvas golden screenshots                      | Passed without replacing baselines                                    |
| Packaged shell and fuse smoke                      | Passed                                                                |
| External edit → usable stage control               | 614.5 ms                                                              |
| External `git add` → usable unstage control        | 374.3 ms                                                              |
| External commit → updated history and clean status | 423.6 ms                                                              |

[Raw watcher latency](m2-watcher-latency.json) records one Electron run. The 1.5 second gate also covers native service tests, private/shared directories in linked worktrees, and bare repositories. Polling fallback is tested with a deliberately silent observer.

The full Linux repository regression benchmark contains 1,505,199 commits and uses a pre-existing Git commit-graph with a fresh application profile. First paint was 374.9 ms; 5,000-commit pages were 296.2 / 255.6 / 240.9 ms; scroll frame p95 was 16.8 ms with 12,000 rows loaded and 34 DOM rows mounted. [Raw benchmark](m2-linux-complete.json) includes the machine and cache conditions. These meet the M1 gates, though the first page is close to the 300 ms limit. The general Electron run overlapped packaging and recorded 33.3 ms p95; the dedicated performance run was isolated and passed.

## Limits and next work

Partial staging deliberately follows Git's replacement-block ordering. Large files are guarded rather than silently truncated into writable previews. Discard caps, trash retention, and interrupted-operation backups are documented in ADR 0011. The recovery UI belongs to M8. The native watcher can be expensive for unusually large ignored directory trees; slow/network filesystems may exceed the measured latency. macOS/Windows checks require their CI runners, and no cross-platform result is claimed here.

M3 adds branches/tags/stashes, remotes, authentication helpers and clone. Later milestones add merge/rebase/conflicts, richer diff/history/editor tools, integrations, productivity features, and release hardening.
