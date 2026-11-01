# OpenKraken

An independent desktop Git client built from the reconstruction specification in `analysis/gitkraken/10-reconstruction-blueprint.md` and public Git/Electron documentation. No proprietary application code or assets are included.

M0's secure shell and Git service now support a Canvas commit graph with worker-based layout, append-only history paging, search, and keyboard navigation. The graph includes branch/tag badges and WIP/conflict rows, while text cells remain virtualized and accessible. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Run

Requires Node.js 24+, pnpm 11.25.0 and Git 2.38+.

```sh
pnpm install --frozen-lockfile
pnpm start
```

Open a repository with the toolbar or initialize an empty folder. Refresh rereads external changes. Cancel aborts pending Git work. `OPENKRAKEN_GIT` optionally selects a Git executable; system Git is the fallback. Initialization is the only repository mutation in this milestone.

React and React DOM are pinned to **19.3.1**, TypeScript to **7.0.2**, and Electron to **45.2.1**. TypeScript 7 checks all runtime packages, tests and tool configurations through project references.

## Verify

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm package
pnpm smoke:package
```

See the [M0 report](docs/verification/m0.md) and [M1 graph report](docs/verification/m1.md) for recorded results and limits.

On headless Linux, use `xvfb-run -a pnpm test:e2e`. No `--no-sandbox` flag is needed or configured. E2E uses the developer Electron executable for Playwright inspection, checks actual renderer isolation/CSP, opens a deterministic repository through the native picker, and measures a <500 ms first paint for 2,000 commits. The gate includes Git service IPC and rendering, excludes human time in the picker, and verifies fewer than 100 mounted history rows. The M1 suite also gates 5,000-commit pages at <300 ms, compares six Canvas goldens, and records scrolling frame intervals on a 12,000-commit fixture. Results and screenshots are saved under `test-results/`.

`pnpm package` produces a local unsigned platform bundle under `release/`, enables ASAR integrity/ASAR-only loading, disables RunAsNode/Node options/Node CLI inspection, and reads the fuse bytes back to verify them. Release installers, signing and update distribution remain M8 work. macOS/Windows execution is configured in CI but requires those runners to establish platform-specific evidence.

Generate sample repositories with `pnpm fixtures [output-directory]`. They include six graph topologies and a 2,200-commit performance fixture. Tests generate isolated temporary repositories and clean up afterward.

## Packages

| Path                     | Responsibility                                                   |
| ------------------------ | ---------------------------------------------------------------- |
| `apps/desktop`           | Main window, restricted preload, utility process, security tests |
| `packages/ipc-contract`  | Shared Zod schemas and request/result types                      |
| `packages/git-core`      | Git locator, runner, parsers, queues and repository registry     |
| `packages/graph`         | Lane allocation, continuation/checkpoints, worker and goldens    |
| `packages/ui`            | React, Zustand/Immer and TanStack Virtual repository browser     |
| `packages/test-fixtures` | Independently authored deterministic Git repositories            |
| `docs/decisions`         | Scope, protocol, graph and verification decisions                |

## Use the graph

The first page contains 2,000 commits. Scroll near the bottom or choose **Load more commits** to append up to 5,000 more from the same Git stream. Refresh starts a new history generation; cancellation closes the current stream, so refresh before resuming it.

Search loaded history with **Ctrl/Cmd+F**. Token-prefix matches cover commit messages, bodies, authors, emails and hashes; non-matches dim without moving. **Search all history** performs a separate literal message/author search (or hexadecimal hash lookup) and lets you open details for commits not loaded in the graph. Results are capped at 100 and labeled when truncated.

| Control                              | Action                               |
| ------------------------------------ | ------------------------------------ |
| ↑ / ↓, PageUp / PageDown             | Move through loaded rows             |
| Shift+↓ / Shift+↑                    | First parent / nearest loaded child  |
| Home / End                           | First / last loaded row              |
| h / Shift+H                          | HEAD / upstream HEAD                 |
| Click / Ctrl/Cmd-click / Shift-click | Single / toggle / range selection    |
| Ctrl/Cmd+A / Escape                  | Select loaded rows / clear selection |
| Enter / double-click                 | Open commit details                  |

## Remaining M1 work

Hide/solo/pin controls, optional network avatars, checkpoint-based refresh reuse and benchmarks on linux.git remain. Refresh currently uses a correct full reset in the worker. Watchers, staging, commits, credentials and an undo journal outside repositories belong to subsequent milestones. Diff viewing remains M5.

Public references: [Git status](https://git-scm.com/docs/git-status), [for-each-ref](https://git-scm.com/docs/git-for-each-ref), [rev-list](https://git-scm.com/docs/git-rev-list), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).
