# OpenKraken

An independent desktop Git client built from the reconstruction specification in `analysis/gitkraken/10-reconstruction-blueprint.md` and public Git/Electron documentation. No proprietary application code or assets are included.

M0's secure shell and Git service now support a Canvas commit graph with worker-based layout, append-only history paging, search, and keyboard navigation. The graph includes branch/tag badges and WIP/conflict rows, while text cells remain virtualized and accessible. Hide/solo/pin controls select Git traversal roots, and refresh reuses unchanged layout checkpoints. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Run

Requires Node.js 24+, pnpm 11.25.0, Git 2.38+ and Go 1.27.3+ to build the small native authentication helper. Go is not required to run a packaged app. `OPENKRAKEN_GO` can select the build compiler.

The terminal uses the native `node-pty` module. Building it from source requires Python, Make and a C++ compiler on Linux (for example `python3` and `build-essential`). These build tools are not needed by packaged apps. Its install scripts are explicitly allowed in `pnpm-workspace.yaml`.

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

For a headless Linux run, use `env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 xvfb-run -a pnpm test:e2e`. This keeps Electron keyboard tests on the virtual display when launching from a Wayland desktop. No `--no-sandbox` flag is needed or configured. E2E uses the developer Electron executable for Playwright inspection, checks actual renderer isolation/CSP, opens a deterministic repository through the native picker, and measures a <500 ms first paint for 2,000 commits. The gate includes Git service IPC and rendering, excludes human time in the picker, and verifies fewer than 100 mounted history rows. The M1 suite also gates 5,000-commit pages at <300 ms, compares six Canvas goldens, and records scrolling frame intervals on a 12,000-commit fixture. Results and screenshots are saved under `test-results/`.

`pnpm package` uses the root `package.json` release version and produces a local unsigned platform bundle under `release/`, enables ASAR integrity/ASAR-only loading, disables RunAsNode/Node options/Node CLI inspection, and reads the fuse bytes back to verify them. Native Linux builds can wrap this bundle in unsigned DEB/RPM/AppImage installers without changing its payload. Native macOS DMG and Windows MSI producers/verifiers are also implemented, with native execution pending. Signed update checks, verified downloads and supported AppImage installation/restart are implemented below; recovery of hung or interrupted updates, native installer acceptance, signing and distribution remain M8 work. macOS/Windows bundle execution is configured in CI but requires those runners to establish platform-specific evidence.

**Updates** supports user-initiated checks, package downloads and cancellation. The default build has no feed and makes no update requests. A publisher can embed `OPENKRAKEN_UPDATE_CONFIG` at build time as JSON with `feed` (HTTPS manifest URL) and `publicKey` (base64 Ed25519 SPKI DER). Runtime environment variables and renderer requests cannot change that trust configuration. Checks verify the release signature, product, channel, validity period and persistent release sequence; downloads must match the signed size and SHA-256. Requests omit credentials and referrers and refuse redirects. No repository or account data is sent. Closing the dialog allows a transfer to continue; quitting cancels it.

When a feed is configured, you can enable **Automatically check every 10 hours**. The preference is off by default, names the contacted server, and persists across restarts. Checks begin after a startup grace period and keep a saved deadline. The toolbar indicates an available version; downloading and installing still require your action. Turning the preference off stops scheduled requests while leaving a transfer you started running. Corrupt or externally changed preference storage disables automatic checks. See [ADR 0085](docs/decisions/0085-opt-in-automatic-update-checks.md).

For an owned, writable AppImage, a verified download offers **Install and restart**. Save work and finish active operations first. The restart helper must prove it can start before the app closes. Preparation failures leave the app open and the installed image unchanged. Native confirmation and the existing unsaved-editor prompt protect the restart; **Keep editing** leaves the original image installed. The replacement is reverified, the predecessor retained, and restart uses the same application filename and profile. Shutdown waits for the approved replacement rename. Startup confirms the installed version and syncs both directories before removing recovery files. If executing the replacement fails or it exits before confirmation, the helper can restore and launch the verified predecessor once, after its ordinary processes have exited. A recovery notice remains until dismissed. If startup takes longer than a minute, the helper keeps the replacement running and continues to watch it. If you close a stalled replacement before it confirms startup, the helper can reopen the previous version once the replacement and its ordinary descendants have exited. See [ADR 0084](docs/decisions/0084-appimage-desktop-update-handoff.md), [ADR 0086](docs/decisions/0086-appimage-startup-exit-recovery.md), [ADR 0087](docs/decisions/0087-appimage-restart-helper-preflight.md) and [ADR 0120](docs/decisions/0120-appimage-shutdown-and-confirmation.md).

For DEB, RPM, DMG, ZIP, MSI or an AppImage downloaded outside the in-place update flow, select **Save installer…** after verification. Choose a location in the native dialog and keep the package extension. After OpenKraken confirms the save, open the file with your operating system’s installer or archive utility. For a manually saved AppImage, grant execute permission before launching it. [Installer export decision](docs/decisions/0121-save-verified-installers.md)

Builds configured for the beta channel receive signed prereleases and use a separate default profile. The Updates dialog identifies the beta channel. [Preparing and testing a beta](docs/beta.md)

The offline publisher `node scripts/sign-update.mjs descriptor.json private-key.pem release.json` hashes the actual installer files and creates a signed manifest without uploading it. See [ADR 0082](docs/decisions/0082-signed-update-release-protocol.md) for descriptor fields, trust/retention bounds and remaining installation work. A trusted build can move feeds or rotate keys with the optional `migrateFrom` configuration. The app preserves release sequence history and asks for fresh automatic-check consent. Production feed/key configuration, code signing and native platform release acceptance are still required.

Linux packaging additionally requires Docker, or Podman selected with `OPENKRAKEN_CONTAINER_ENGINE=/path/to/podman`. It builds a cached Debian compiler image and rebuilds the staged terminal module against that baseline, preventing a newer build host's libc requirements from leaking into installers. The first packaging run needs network access to construct that compiler image. See [ADR 0075](docs/decisions/0075-linux-native-build-baseline.md).

```sh
pnpm package
pnpm installer --test-metadata --target deb
pnpm installer --test-metadata --target rpm
pnpm installer --test-metadata --target AppImage
OPENKRAKEN_XDOTOOL=xdotool xvfb-run -a pnpm smoke:installer release/installers/linux-x64/test/deb/manifest.json
OPENKRAKEN_XDOTOOL=xdotool xvfb-run -a pnpm smoke:installer release/installers/linux-x64/test/rpm/manifest.json
OPENKRAKEN_XDOTOOL=xdotool xvfb-run -a pnpm smoke:installer release/installers/linux-x64/test/AppImage/manifest.json
```

Installer generation needs native Linux x64/arm64; RPM additionally needs `rpmbuild`. Verification needs `dpkg-deb` for DEB or `rpm` and `bsdtar` for RPM (Ubuntu packages `rpm` and `libarchive-tools`). Substitute `linux-arm64` on that architecture. Always rebuild with `pnpm package` after changing app code. Test metadata uses a reserved address and `UNLICENSED`; these artifacts are not for distribution. To supply actual metadata, replace `--test-metadata` with `--metadata /absolute/path/release-metadata.json`, containing only `name`, `email`, `homepage` (HTTPS) and `license`. By default, the build produces unsigned artifacts. The repository currently has no project license or release maintainer configured.

To sign an RPM, add `--rpm-key /path/to/publisher.asc` to the RPM build command. Supply the publisher’s public OpenPGP certificate and make the matching signing key available to the RPM signer on the build host. The tests use GnuPG. The builder requires `rpmsign`, `rpmkeys`, `rpmdb` and `gpg`. With test metadata, the receipt is under `test-signed/rpm`. With release metadata, it is under `signed/rpm`. Pass the independently trusted public certificate to the verifier.

```sh
OPENKRAKEN_XDOTOOL=xdotool xvfb-run -a pnpm smoke:installer release/installers/linux-x64/test-signed/rpm/manifest.json --rpm-key /path/to/publisher.asc
```

On native macOS, run `pnpm package`, then `pnpm installer --test-metadata --target dmg`. Verify with `pnpm smoke:installer release/installers/darwin-arm64/test/dmg/manifest.json` (substitute `darwin-x64` on Intel). The verifier checks the mounted bundle, copies it to a disposable directory, detaches the image, and launches the copy. It leaves `/Applications` untouched. If attachment or detachment fails, it retains and reports the temporary directory; detach any remaining volume before removing that directory. Ad-hoc signature verification is required, but Developer ID signing, notarization, Gatekeeper and native runtime acceptance are still pending. See [ADR 0089](docs/decisions/0089-native-dmg-payload-and-copy-install.md).

Windows bundle packaging checks native ownership and access lists in addition to fuses. It rejects reparse points and payloads writable by principals other than the current user, Local System or Administrators; it does not rewrite permissions. Use a restricted build directory. Windows access checks and three native fixtures are configured in CI but still await native execution evidence. See [ADR 0090](docs/decisions/0090-windows-payload-access-control.md).

On native Windows x64, run `pnpm package`, `pnpm installer --test-metadata --target msi`, then `pnpm smoke:installer release/installers/win32-x64/test/msi/manifest.json`. The MSI targets the current user and owns the repository protocol registration; starting a plain bundle no longer registers its temporary path. Verification checks compiled installer metadata, extracts into a disposable directory, checks payload/DACLs/fuses and launches the app. It retains the extraction log and files on failure. This extraction check does not establish ordinary installation, upgrade or uninstall behavior; see [ADR 0091](docs/decisions/0091-native-msi-and-installer-owned-protocol.md).

Windows CI additionally builds a real newer-version fixture and runs `scripts/check-msi-lifecycle.mjs` for installation, file/shortcut repair, upgrade, OS URI delivery, removal and retained user data. This gate requires explicit disposable hosted-runner opt-in and refuses an existing installation or profile. Do not run it on a workstation or fake the runner markers. Logs and the fixture profile are preserved, including on failure. The lifecycle gate is implemented but has not been executed on Windows from this Linux workspace; native acceptance and signing remain pending. See [ADR 0092](docs/decisions/0092-disposable-msi-lifecycle-acceptance.md).

AppImage generation downloads checksum-pinned tools on its first run. Normal launch needs a working FUSE setup (`fusermount3`); `APPIMAGE_EXTRACT_AND_RUN=1` selects extraction mode when FUSE is unavailable. Both modes preserve the Chromium sandbox and require host support for it, system Git 2.38+, CA certificates and Electron's desktop libraries. The current native build baseline is Debian 13; older distributions and arm64 runtime compatibility are not certified. AppImage does not register a system launcher. See [ADR 0076](docs/decisions/0076-appimage-launch-and-verification.md).

The installer smoke verifies archive hashes, every extracted payload file/mode/link, Electron fuses and desktop launching, then runs the packaged UI/helper tests. Only verify locally built or independently authenticated artifacts: the adjacent manifest is not a signature. CI also runs `scripts/check-deb-lifecycle.sh` in a disposable Debian container and `scripts/check-rpm-lifecycle.sh` in a disposable Fedora container to check native installation, real version upgrades and removal. Build future-version fixtures with `node scripts/check-installer-upgrade.mjs deb` and `node scripts/check-installer-upgrade.mjs rpm`; each writes its own `release/installer-upgrade-<format>.json` pointer so the inputs stay separate. Both gates check launcher preservation and user-data retention. Do not run the lifecycle scripts on your workstation. See [ADR 0074](docs/decisions/0074-linux-installer-payload-verification.md), [ADR 0088](docs/decisions/0088-native-rpm-lifecycle-and-release-version.md) and [ADR 0093](docs/decisions/0093-debian-version-upgrade-acceptance.md) for the verification limits.

Generate sample repositories with `pnpm fixtures [output-directory]`. They include six graph topologies and a 2,200-commit performance fixture. Tests generate isolated temporary repositories and clean up afterward.

Crash reporting is off by default. The default build has no receiver configured. A publisher can set `OPENKRAKEN_SENTRY_DSN` during `pnpm build` or `pnpm package`; it must be an HTTPS Sentry DSN with a public key and project ID. The destination is fixed in that build. Users must separately opt in through **Crash reporting**, and changing the destination requires new consent. Reports contain only app version, OS family, architecture and process/failure categories; no code, paths, logs, dumps or account data are sent. Opted-in interrupted sessions can produce one unclean-exit summary on the next launch; this includes forced termination or power loss and does not prove a crash. JavaScript reports contain only a fixed failure category. This expanded behavior requires fresh consent from users of the earlier reporting format. Failures before reporting initialization and live-service/platform acceptance remain open. See [ADR 0077](docs/decisions/0077-opt-in-crash-summaries.md) and [ADR 0078](docs/decisions/0078-interrupted-session-and-javascript-reports.md) for privacy and verification limits.

## Benchmark a real repository

The opt-in benchmark needs an existing repository with more than 17,000 reachable commits. It measures first paint, three 5,000-commit pages, scrolling with 12,000 loaded rows, mounted commit/reference rows and Electron process memory. It records first-paint phase timings, repository HEAD, total reachable commit and reference counts, CPU, Git version and cache conditions alongside the measurements. The [M8 reference performance checkpoint](docs/verification/m8-reference-performance.md) retains the 50,000-ref startup failure and a reproducible isolated fixture.

```sh
pnpm build
OPENKRAKEN_BENCH_REPO=/path/to/linux.git pnpm benchmark:graph
# Headless Linux:
OPENKRAKEN_BENCH_REPO=/path/to/linux.git xvfb-run -a pnpm benchmark:graph
```

To measure a cached reopen after a complete app restart, set `OPENKRAKEN_BENCH_WARM=1` as well. The harness primes 17,000 commits before the measured launch and labels that condition in its JSON. The default always uses a fresh profile; it records whether the repository already has a Git commit-graph. It never creates one.

Set `OPENKRAKEN_BENCH_SOLO_REF` to a full ref name, such as `refs/heads/main`, to measure opening a saved solo view. Choose a ref with enough history for three full pages. The measurement records the ref and the harness checks the active view after timing.

Set `OPENKRAKEN_BENCH_FROM_REPO` to a different repository with more than 17,000 reachable commits to measure switching. The harness opens that repository, loads 17,000 commits and then opens the measured destination in the same window. The result records the source path and the number of commits loaded before the switch.

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

## Open a repository link

OpenKraken accepts `openkraken://repo?path=` followed by an encoded absolute local repository path. For example, `openkraken://repo?path=%2Fhome%2Fuser%2Fproject` proposes `/home/user/project`. An incoming link shows **Review repository link**; opening requires reviewing the path and choosing **Open repository**. Cancel leaves the current repository in place. A second link cannot replace a proposal already awaiting review.

Only local repository opening is supported. Relative/traversal paths, network/device paths on Windows, credential commands and extra URI fields are rejected. Linux installers advertise the handler, macOS bundles declare it, and packaged Windows launches request registration. Development runs do not register handlers; a portable AppImage needs desktop integration to receive links from a browser. Native Windows/macOS dispatch and OS handler selection remain unverified. See [ADR 0080](docs/decisions/0080-local-repository-links.md).

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

Commit messages save automatically to the local profile, separately for each checkout. **Draft saved locally** confirms persistence; acknowledged drafts survive app restart and renderer crashes. Normal and amend messages remain separate, and an amend draft restored against a different HEAD requires another review. Successful commits clear the submitted draft while retaining newer edits. Storage warnings leave text editable: copy it before restarting to investigate a failure. These files contain plaintext messages; edits still marked **Saving draft…** can be lost in a crash. See [local commit drafts](docs/decisions/0072-local-commit-drafts.md) for limits. File-editor and provider-composer drafts are not yet persisted this way.

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

For Bitbucket Cloud, select **Bitbucket Cloud** in **Provider accounts** and enter a scoped API token with `read:user:bitbucket`, `read:workspace:bitbucket` and `read:repository:bitbucket`. Pushing also requires `write:repository:bitbucket`. The host is fixed to `https://bitbucket.org`; no email address is needed. In the clone picker, choose a workspace first, then a repository. Both lists support paging, search, refresh and keyboard selection. Bitbucket issue browsing, OAuth and Data Center remain in development.

Bitbucket **Pull requests** requires `read:pullrequest:bitbucket`. Choose a workspace and repository, then filter Open, Merged, Declined, Superseded or All. Lists support paging, search, keyboard selection and automatic refresh. Details preserve fork/deleted-source information, commit references, queue status, open tasks and reviewer/participant states. Missing fields remain unavailable. Bitbucket files, comments, review submission, creation and merging remain in development.

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

For GitLab, **New merge request** creates from an already-pushed branch in the same project or a fork. Enter the source namespace/repository and branches, preview a native project or inherited template before replacing the description, then review and confirm the draft. The review shows the exact draft-prefixed title and both branch commits. Changed projects or tips require another preview; uncertain results offer an existing-merge-request check before returning to the draft. Creation drafts are not saved across app restarts.

For an open GitLab merge request, **Review MR merge** shows the project’s merge strategy, squash policy, permission and current branch commits. Choose squash, optional commit messages and whether to request source-branch removal, then review and separately confirm. Changes require a new review. Uncertain outcomes offer a read-only status check; automatic merging and merge trains remain in development.

For GitLab merge requests, **Approvals** shows the provider’s approval status, your eligibility, approving users and available rule summaries. **Approve merge request** and **Remove my approval** require review and confirmation against the current commit and approval state. Enter an approval password only when the project requires it; the field clears after each attempt. SAML re-authentication must be completed on GitLab. If a result is uncertain, **Check existing approval** reads the current state without repeating the write.

Merge queues/stacks, thread resolution, multi-line comment creation, repository creation/forking and other providers remain in development. A real OAuth application registration and live sign-in still require environment-specific verification. Existing Git credential helpers and SSH agents remain available for manual clone/fetch/push. See [M6 progress](docs/verification/m6-progress.md).

## Commands and keyboard shortcuts (M7 in progress)

Use **Commands** or **Ctrl/Cmd+P** to open the command palette. Search by action or alias, filter by category, move with arrow keys, and press Enter. Recently and frequently used commands rise in empty-search results. With a repository open, choose **Branches** to show a local or remote branch in the graph, or **Changed files** to open its staged or unstaged diff. Unavailable commands remain visible. Commands open the same review dialogs and use the same availability checks as their toolbar controls.

Use **Keybindings** to edit the JSON map. Missing entries inherit defaults; `null` disables a binding. `Mod` means Command on macOS and Control elsewhere. For example:

```json
{
  "version": 1,
  "bindings": {
    "app.commands": "Mod+Shift+P",
    "history.search": "Mod+Shift+F",
    "repository.open": null
  }
}
```

Apply validates conflicts, including inherited bindings on both platforms, before saving. The editor lists command IDs and active shortcuts. Restore defaults changes the draft; Apply saves it. Shortcuts pause in dialogs; action shortcuts also pause in text fields, except opening the palette or focusing commit search. The native Commands menu uses the same keymap and availability checks. Settings and usage are saved atomically in the profile’s `settings.json`; older renderer preferences migrate once. The rest of M7 remains open. See [M7 progress](docs/verification/m7-progress.md).

## Appearance

Open **Appearance** from the toolbar or command palette. Choose Dark, Light, or System and select **Apply**. System follows your device’s preference. Colors update the graph, dialogs and open editors while preserving drafts and undo history. The choice persists across restarts.

Choose **Custom** to edit a JSON theme. Start with a light or dark base and override any of the names listed under **Available color tokens**. Unspecified colors inherit the base. For example:

```json
{
  "version": 1,
  "name": "Evening",
  "base": "dark",
  "colors": {
    "background": "#142135",
    "text": "#e9efff",
    "graph1": "#f0a030"
  }
}
```

Colors accept CSS hex notation (`#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`). Invalid themes leave the current appearance active. Switching to a built-in theme keeps your saved custom theme available. Appearance shares the atomic profile settings file with keyboard shortcuts.

## Activity

Open **Activity** from the toolbar, command palette or native Commands menu to inspect the latest 500 recorded operations. Filter by action or outcome; **Show more activity** adds another 100 visible entries. Running, succeeded, failed, cancelled, needs-attention and unknown outcomes are distinct. Failed or cancelled operations can leave partial changes; inspect the repository or provider before retrying an unknown result.

The local profile's `activity.json` contains fixed operation names, times and outcomes. It excludes repository identities, paths, URLs, command/error output, file contents, messages and credentials. Background reads, automatic fetches and terminal commands are not recorded. History survives renderer reload and restart; **Clear completed activity** retains running entries. Storage failures leave operations usable and show a warning. Corrupt or externally changed history is preserved for manual inspection; close the app before moving the file and restarting. This summary is not a recovery journal. See [the activity decision](docs/decisions/0070-local-activity-log.md).

Native command supervision stops active Git commands and ordinary descendants if their Git service crashes. Linux fixtures verify a stalled fetch and a commit hook that ignores termination. Interrupted operations still have unknown outcomes and can leave partial changes; inspect before retrying. Detached programs, broader write recovery and macOS/Windows runtime acceptance remain outside this verification. See [native supervision](docs/decisions/0071-native-process-supervision.md).

If the Git service stops while a native document editor is open, the editor retains your text for copying and disables continuation of the interrupted request. **Discard unsaved draft** closes it explicitly; Escape keeps it open. Closing the app asks about unsaved changes. This recovery text stays only in the current renderer, so copy it before discarding or restarting. Authentication prompts are dismissed, and stale replies cannot resume the old request. See [interrupted native prompts](docs/decisions/0073-interrupted-native-prompts.md).

## Local diagnostics

**Diagnostics** shows local operational records and lets you select them for copying, refresh, or clear the logs. Records include app/runtime information, operation names, timings, outcomes and fixed failure categories. Request payloads, repository paths/content, credentials, URLs and native output are excluded. Logs are never uploaded automatically and are separate from opt-in crash reports.

Three rotating JSON files under the application's user-data `diagnostics/` directory retain at most 768 records. Clearing removes retained supported files but does not turn off subsequent logging. Unsafe, corrupt or externally changed storage stops logging for that session while Git operations remain usable; repair the files/permissions and restart to resume. See [ADR 0081](docs/decisions/0081-local-rotating-diagnostics.md) for retention and crash limits.

## Terminal (M7 in progress)

Open a repository and choose **Terminal** from the toolbar or command palette. The panel starts your default shell in that repository. **Hide terminal** keeps the session and scrollback; **Terminal** shows and focuses it again. Press **F6** to move keyboard focus to the terminal controls. **Close terminal** asks before ending a live shell. Changing the graph's repository does not change an existing shell's directory.

The terminal follows the selected application theme and provides screen-reader output. Its scrollback stays in memory; your shell still controls its own history files. Reloading or closing the app ends the session.

OSC 133 shell integration shows prompt readiness, a running command, and its last reported exit code. Bash 5.1+ on POSIX is configured automatically after reading your normal `.bashrc`, preserving existing prompt hooks and command status. Older Bash versions, disabled prompt expansion or read-only prompt settings keep a regular terminal without injected markers. Other shells can emit standard OSC 133 markers themselves; automatic setup for zsh, fish and PowerShell remains open. Markers are display hints and never suppress confirmation when closing a live shell. Linux Bash and packaged terminal acceptance are covered; macOS/Windows runtime acceptance remains open.

## Worktrees (M7 in progress)

Choose **Worktrees** from the toolbar or command palette to see registered checkouts, their branches or detached HEADs, changed-file counts, and lock/missing-folder information. **Open worktree** switches the application to that checkout. **Refresh worktrees** rereads changes made by another Git client.

Create a worktree on a new branch, an existing unused local branch, or a detached commit. Review the starting commit and choose an empty folder through the native picker. Creation leaves your current checkout unchanged; open the new worktree explicitly when ready. Errors and picker cancellation retain your choices.

**Lock worktree** protects a registered checkout from removal or pruning, including while its drive is offline; you can record a reason and explicitly unlock it later. **Remove worktree** reviews the folder before deleting a clean, inactive checkout and retains its branch. Changed, untracked or ignored files, in-progress Git operations, index flags that hide changes, and detached commits without a retaining ref must be resolved first. Main/current and locked worktrees cannot be removed. **Review cleanup** previews stale registrations before pruning. It retains locked registrations and branches, rechecks the review before execution, and explains the index/reflog recovery data being removed. Each other checkout has a graph row above its HEAD with clean/changed/unavailable status, branch and path. Detached checkout commits participate in history and search; rows arrive with their parent page and support keyboard ancestry navigation. Edits in other checkouts update graph status automatically while preserving loaded pages and selection. New registrations become watched, unavailable checkouts are polled for reconnection, and commits refresh history. Refresh also rereads checkout status. Worktree runtime acceptance is currently limited to Linux.

## Submodules (M7 in progress)

Choose **Submodules** from the toolbar or command palette to inspect registered repositories and their initialized descendants. The view shows recorded and checked-out commits, configured URLs, changed-file counts, and uninitialized/conflict/out-of-date states. **Open submodule** opens an initialized checkout after rechecking the reviewed inventory; refresh a stale selection before retrying.

Choose **Review update** to initialize missing checkouts and recursively check out recorded commits. Review the paths and configured sources, then explicitly enable local-file sources only when trusted. The service rechecks the review and protects changed, ignored, untracked, staged and unreferenced submodule work. Updates show progress and support cancellation; failures can leave partial changes, so refresh before retrying. There is no Undo for this action.

Choose **Review URL sync** to copy changed `.gitmodules` URLs into registered submodules and their selected remotes recursively. Review the current overrides before replacing them. Git resolves relative URLs using the parent’s default remote. This preserves local edits and checked-out commits without fetching or initializing modules. Failures can leave partial URL changes; review again before retrying. There is no Undo.

Linux fixtures cover discovery, opening, recursive initialization/update and URL synchronization with UTF-8 paths. Add/remove controls, live authenticated transport acceptance and cross-platform verification remain open; M7 is not complete.

On Linux, install `xdotool` and run `OPENKRAKEN_XDOTOOL=xdotool xvfb-run -a pnpm smoke:package` after packaging to test the native folder picker and packaged terminal in addition to renderer isolation and authentication/editor helpers. Linux CI runs this check.

## Git LFS (M7 in progress)

Choose **Git LFS** from the toolbar or command palette to see the installed version, tracked object identities and sizes, checkout state, local object availability and cached lock owners. **Refresh local state** rereads local information without downloading objects or contacting the lock server. Cached locks may be stale; an empty cache does not mean files are unlocked.

File comparisons identify canonical LFS pointers and show their object identity and size without downloading content. This also works when Git LFS is unavailable. The repository inventory requires Git LFS 3 or newer on PATH. Choose a remote and **Review download** to inspect its HTTP(S) LFS endpoint, file identities and download filters before fetching objects and filling unchanged pointers or missing files. Local edits are preserved. Downloads support cancellation; failures can leave partial changes, so refresh before retrying. SSH/file/custom transfers and live-provider authenticated transport acceptance remain in progress; see [the LFS decision](docs/decisions/0069-lfs-awareness.md).

For native LFS acceptance, install Git LFS and run `OPENKRAKEN_LFS_TEST=1 pnpm test` and `OPENKRAKEN_LFS_TEST=1 xvfb-run -a pnpm exec playwright test tests/e2e/lfs.test.ts tests/e2e/lfs-locks.test.ts tests/e2e/lfs-push.test.ts tests/e2e/lfs-setup.test.ts` on Linux. The opt-in flag fails when the CLI is missing; CI enables it. Omit `xvfb-run -a` on a desktop with an available display.

Choose **Refresh server locks** to query the selected remote. The result shows the endpoint and check time; ownership may change afterward. A failed or canceled query reports unknown server state and retains cached information. This action lists locks; it does not lock or unlock files. Opening the dialog and refreshing local state do not contact the server.

Ordinary **Pull** also downloads incoming LFS objects when native Git LFS filters are already installed. Authentication prompts and cancellation remain available during checkout. Saved-account pulls keep credentials scoped to the reviewed Git repository; use **Git credential helpers / SSH agent** if the LFS server needs separate credentials. Existing skip-smudge settings remain effective; use **Review download** to hydrate a pointer-only checkout explicitly.

Reviewed **Push** uploads LFS objects through an already-installed native pre-push hook before publishing the selected ref. Native authentication and cancellation are available. Rejected or canceled transfers may leave objects on the LFS server; review the destination before retrying. Linux fixtures cover authenticated basic uploads, rejection, cancellation/retry, missing local objects and certificate rejection. Saved-account LFS upload acceptance and packaged/cross-platform LFS verification remain open.

Choose **Review local setup** to install repository-local filters and native hooks with the existing CLI. Select **Leave pointers during checkout** to defer future content downloads. Review shows the affected configuration file and hook directory; filters use worktree-local scope when enabled, while hooks may be shared. Custom hooks/filters are preserved and require manual integration. Setup keeps existing files, tracking patterns and global configuration. If setup fails or is canceled, partial changes may remain; review again before retrying.
