# OpenKraken

An independent desktop Git client built from the reconstruction specification in `analysis/gitkraken/10-reconstruction-blueprint.md` and public Git/Electron documentation. No proprietary application code or assets are included.

M0 provides a secure Electron shell, a typed Git utility service, folder open/init/discovery, branches and tags with upstream counts, working-tree status, and a virtualized list of the first 2,000 commits. The graph package supplies a pure lane allocator, append-only checkpoints and a worker entrypoint; the UI graph view comes in M1.

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

See [the M0 verification report](docs/verification/m0.md) for recorded results and limits.

On headless Linux, use `xvfb-run -a pnpm test:e2e`. No `--no-sandbox` flag is needed or configured. E2E uses the developer Electron executable for Playwright inspection, checks actual renderer isolation/CSP, opens a deterministic repository through the native picker, and measures a <500 ms first paint for 2,000 commits. The gate includes Git service IPC and rendering, excludes human time in the picker, and verifies fewer than 100 mounted history rows. Results and a screenshot are saved under `test-results/`.

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

## Next: M1

Connect the graph worker to a Canvas graph column beside the existing DOM text columns. Add a retained Git history stream for paging, checkpoint-aware refresh, synthetic WIP/conflict rows, ref badges, hide/solo/pin, search dimming, selection and keyboard navigation. Validate scrolling and additional-page budgets on large real repositories. Watchers, staging, commits, credentials and an undo journal outside repositories belong to subsequent milestones.

Public references: [Git status](https://git-scm.com/docs/git-status), [for-each-ref](https://git-scm.com/docs/git-for-each-ref), [rev-list](https://git-scm.com/docs/git-rev-list), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).
