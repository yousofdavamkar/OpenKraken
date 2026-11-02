# OpenKraken

An independent desktop Git client built from the reconstruction specification in `analysis/gitkraken/10-reconstruction-blueprint.md` and public Git/Electron documentation. No proprietary application code or assets are included.

M0's secure shell and Git service now support a Canvas commit graph with worker-based layout, append-only history paging, search, and keyboard navigation. The graph includes branch/tag badges and WIP/conflict rows, while text cells remain virtualized and accessible. Hide/solo/pin controls select Git traversal roots, and refresh reuses unchanged layout checkpoints. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Run

Requires Node.js 24+, pnpm 11.25.0, Git 2.38+ and Go 1.27.3+ to build the small native authentication helper. Go is not required to run a packaged app. `OPENKRAKEN_GO` can select the build compiler.

```sh
pnpm install --frozen-lockfile
pnpm start
```

Open a repository with the toolbar or initialize an empty folder. External changes refresh automatically, with polling fallback and configurable refresh on focus. Cancel aborts pending Git work. `OPENKRAKEN_GIT` optionally selects a Git executable; system Git is the fallback. The working-tree panel supports file/hunk/line staging, commit/amend, reviewed discard, and persistent undo/redo.

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

See the [M0 report](docs/verification/m0.md), [M1 graph report](docs/verification/m1.md), [ref-view follow-up](docs/verification/m1-views.md), and [M1 completion report](docs/verification/m1-completion.md), and [M2 completion report](docs/verification/m2-completion.md) for recorded results and limits.

On headless Linux, use `xvfb-run -a pnpm test:e2e`. No `--no-sandbox` flag is needed or configured. E2E uses the developer Electron executable for Playwright inspection, checks actual renderer isolation/CSP, opens a deterministic repository through the native picker, and measures a <500 ms first paint for 2,000 commits. The gate includes Git service IPC and rendering, excludes human time in the picker, and verifies fewer than 100 mounted history rows. The M1 suite also gates 5,000-commit pages at <300 ms, compares six Canvas goldens, and records scrolling frame intervals on a 12,000-commit fixture. Results and screenshots are saved under `test-results/`.

`pnpm package` produces a local unsigned platform bundle under `release/`, enables ASAR integrity/ASAR-only loading, disables RunAsNode/Node options/Node CLI inspection, and reads the fuse bytes back to verify them. Release installers, signing and update distribution remain M8 work. macOS/Windows execution is configured in CI but requires those runners to establish platform-specific evidence.

Generate sample repositories with `pnpm fixtures [output-directory]`. They include six graph topologies and a 2,200-commit performance fixture. Tests generate isolated temporary repositories and clean up afterward.

## Benchmark a real repository

The opt-in benchmark needs an existing repository with more than 17,000 reachable commits. It measures first paint, three 5,000-commit pages, scrolling with 12,000 loaded rows, mounted DOM rows and Electron process memory. It records repository HEAD, total reachable commit count, CPU, Git version and cache conditions alongside the measurements.

```sh
pnpm build
OPENKRAKEN_BENCH_REPO=/path/to/linux.git pnpm benchmark:graph
# Headless Linux:
OPENKRAKEN_BENCH_REPO=/path/to/linux.git xvfb-run -a pnpm benchmark:graph
```

To measure a cached reopen after a complete app restart, set `OPENKRAKEN_BENCH_WARM=1` as well. The harness primes 17,000 commits before the measured launch and labels that condition in its JSON. The default always uses a fresh profile; it records whether the repository already has a Git commit-graph. It never creates one.

Results and a screenshot are attached under `test-results/benchmark/`. This benchmark skips during the normal suite unless the environment variable is set. It does not clone, fetch or change Git refs, objects, the index or working files. The watcher self-test briefly creates and removes a private probe in the Git directory.

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

**Hide** removes a ref as a history start point; shared ancestry remains if another visible ref reaches it. **Solo** shows one ref’s ancestry. **Pin** keeps its first-parent chain in column zero and makes that ref visible. **Reset graph view** clears these choices. Views, selection and search survive Refresh. Hidden, solo and pinned refs are saved per repository and survive app restarts. Refresh reloads the first 2,000 commits and reuses unchanged layout rows.

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

Enable **Author photos** to request Gravatar images for visible authors. This is off by default; enabling it sends hashed email addresses to Gravatar. Photos are cached locally and remain available offline. Disabling the option cancels requests and restores initials.

## M1 status and limits

M1 is implemented: Canvas graph, append-only paging, search, keyboard/selection controls, persisted hide/solo/pin views, checkpoint refresh and cached author photos. The full 1.5-million-commit Linux fixture passes the performance gates with a pre-existing Git commit-graph and a fresh app profile. Cached reopen also passes on the shallow Linux fixture; see the [completion report](docs/verification/m1-completion.md) for exact conditions and evidence.

An uncached shallow repository can still exceed the 500 ms first-paint target. The profile cache accelerates subsequent opens without modifying repositories. Refresh reloads the initial 2,000-commit window. macOS/Windows execution remains to be verified on their runners.

M0–M5 are implemented for the verified Linux scope: working-tree operations, watchers, guarded Undo/Redo, branching, remotes, merge/rebase/conflict workflows, file comparisons, blame, history and WIP editing. Provider integrations, productivity features and release hardening remain M6–M8. See the [M4 completion report](docs/verification/m4-completion.md) and [M5 completion report](docs/verification/m5-completion.md) for evidence and supported bounds.

Public references: [Git status](https://git-scm.com/docs/git-status), [for-each-ref](https://git-scm.com/docs/git-for-each-ref), [rev-list](https://git-scm.com/docs/git-rev-list), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).

## Working tree

Use **Stage** or **Unstage** for an entire file, or **View** to select individual hunks and lines. Commit drafts remain available after a hook or signing failure. **Amend last commit** loads the existing message; signing uses your Git configuration or the explicit selection in the form. Native hooks and configured signing agents run normally.

**Discard** first shows the affected file and backup size. Tracked files return to their staged version; untracked files move to recoverable application trash. **Undo** and **Redo** refuse to overwrite edits or index/HEAD changes made after the recorded action. Backups live in the application profile, not the repository. See the M2 report for limits and recovery details.

## Branches and remotes

Create, switch, rename and delete branches, configure upstreams, and create or delete local tags. Reference actions use guarded Undo. Stashes support selected paths, untracked files, staged-only creation, apply/pop, message editing and reviewed drop. Workspace Undo after stash creation retains the stash copy.

Use **Manage remotes** for URLs, fetch, remote removal or reviewed server branch/tag deletion. Push first reviews the destination tip; replacing history requires an explicit force-with-lease selection. Server deletions also use an exact lease and have no Undo. **Pull** saves a per-repository fast-forward-only, merge or rebase preference. Commit or stash tracked edits before pulling; the operation panel offers conflict resolution and reviewed Continue/Skip/Abort actions when applicable.

**Clone** supports shallow history, a selected branch/tag, sparse directories and on-demand blobs. Git credential helpers and SSH agents remain supported. Native authentication prompts use a private local socket; changed SSH host keys stop the connection and show a dedicated diagnostic. TLS verification stays enabled. Automatic fetch is opt-in, avoids foreground work and dialogs, and backs off failed attempts up to one hour.

See the [M3 completion report](docs/verification/m3-completion.md) and [transport acceptance report](docs/verification/m3-gitea.md). To run its disposable Linux Gitea container fixture after building, use `OPENKRAKEN_GITEA_TEST=1 xvfb-run -a pnpm exec playwright test tests/e2e/gitea.test.ts`; Docker is the default engine, with `OPENKRAKEN_CONTAINER_ENGINE` available for Podman.

## File inspection and editing

Open commit details and select a changed file to compare it with its parent; merge commits offer parent selection. Hunk, inline and split views share native Git changes, whitespace controls and word highlighting. Supported raster images offer side-by-side and overlay views. Large files require explicit loading within fixed byte/line limits; the encoding selector changes display only. **File history** follows renames across pages, and **Blame** streams attribution for supported UTF-8 files.

From a staged or unstaged file, choose **View**, then **Full comparison** for the same rich views. **Select lines to stage/unstage** requests a fresh review of the exact changes before staging. **Edit** opens a working-file draft with filename-based syntax highlighting, local text Undo/Redo and explicit save. Saves preserve supported encodings and line endings, refuse stale file/index state, and participate in repository Undo. Closing an unsaved draft or quitting the app asks whether to keep editing or discard it.

## Provider accounts (M6 in progress)

Use **Provider accounts** for GitHub browser sign-in or a GitHub/GitHub Enterprise personal access token. Browser sign-in requires your application client ID with device flow enabled: enter the displayed code at GitHub and authorize the requested access. Private repository access is an explicit option. **Cancel GitHub sign-in** or closing the dialog retires the local authorization session.

For a personal access token, enter an HTTPS host origin and the token. Both flows validate the account before storing credentials with operating-system protection; Linux plaintext storage is refused. **Verify** checks the connected identity and refreshes expiring device credentials when possible. Account metadata remains available offline; **Forget** removes the local connection without revoking tokens remotely.

In **Clone**, choose **Browse provider repositories**, select an account and load its repository pages. Search filters loaded results; the list supports arrow keys and Enter. Choosing a repository fills its canonical HTTPS URL and enables **Use saved provider account for HTTPS authentication**. Uncheck that option to use existing Git credential helpers instead. Editing the URL clears the account selection. Saved-account clones refuse Git URL rewrites and HTTP redirects and do not save the provider token in Git configuration or credential helpers.

In **Manage remotes**, **Fetch authentication** lets you choose a saved account for foreground HTTPS fetches. It defaults to Git credential helpers / SSH agent. Reload remotes if their settings or tracking refs change; the app checks the reviewed target again before contacting the server. Automatic fetch retains its existing noninteractive authentication.

**Push authentication** also offers saved accounts. Review shows the configured push destination and tips, then locks the account choice. A rejected push can be retried with explicit force-with-lease; a changed remote tip requires a new review. **Review again** reloads remote metadata.

**Pull authentication** offers saved accounts with a separate review of the branch, upstream, HTTPS fetch URL and integration policy. Changes to the reviewed branch, index or remote settings require another review. The existing fast-forward-only, merge/rebase and Undo behavior remains available.

**Delete branch or tag** in Manage remotes also offers saved-account authentication. Review resolves the push URL and exact server tip; deletion needs a separate confirmation and refuses a tip changed since review. Closing the review leaves the server ref intact.

**Issues** opens a repository's open, closed or all-state issue list. Search loaded titles, authors, labels and assignees, use the keyboard to open details, and read paged comments. Pull requests are excluded from this list. Refresh and retry are available; changing repositories or closing the panel cancels reads. **New issue**, **Write issue comment** and **Close/Reopen issue** provide a review and separate confirmation. Changed issues require a fresh review, drafts survive errors, and uncertain results can be inspected without automatic retries.

**Pull requests** opens a repository picker and paged PR list. Filter by state, search loaded PRs, use the keyboard to open details, and refresh or retry results. Descriptions display as text; changing repositories or closing the panel cancels pending requests.

**Files** shows paged changed files, rename metadata and read-only provider patches; missing or truncated patches are labeled. **Reviews** lists submitted reviews. **Write review** previews a comment, approval or request for changes before sending, checks the displayed commits again and preserves the draft on errors. If the outcome is uncertain, check the submitted reviews before trying again. Review drafts are not saved across app restarts.

**Comments** groups inline discussions and shows outdated locations and diff context. Reply to an existing thread, or select a line in a file patch and choose **Comment on selected line**. Both flows preview the target and text before sending; uncertain results require checking existing comments before retrying.

**New pull request** creates a PR from already-pushed branches in the selected repository or a fork. Choose the source and target, preview a repository template before replacing the description, then preview the branch commits and confirm creation. Draft status and maintainer edit permission are explicit choices. Changed commits require another preview; uncertain results offer an existing-PR check before retrying.

**Checks** shows the provider's combined CI status and paged check runs/commit statuses for the displayed head. Refresh checks to see updates. If the head changes, refresh PR details first. Results are capped at 1,000 contexts with a virtualized, keyboard-scrollable list; missing or unreadable results are never shown as success.

**Review PR merge** loads current branches and repository merge settings. Choose merge, squash or rebase when available, review the commits and optional message, then confirm. Changed commits, retargeted branches or disabled methods require another preview. The provider enforces branch rules; uncertain results offer a merge-status check without automatic retries. This is a direct merge of the selected PR.

Merge queues/stacks, thread resolution, multi-line comment creation, repository creation/forking and other providers remain in development. A real OAuth application registration and live sign-in still require environment-specific verification. Existing Git credential helpers and SSH agents remain available for manual clone/fetch/push. See [M6 progress](docs/verification/m6-progress.md).
