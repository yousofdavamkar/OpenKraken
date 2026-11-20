# 0068 — Submodule management

## Decision

The service discovers submodules from the parent index's gitlink entries, using `git ls-files --stage -z`. It reads `.gitmodules` with Git's NUL-delimited configuration output and includes disabled. Configuration-only paths cannot become open targets. The UI lists initialized descendants recursively beneath their parent; an uninitialized parent cannot expose descendants until its repository is available. This avoids parsing the human-oriented `git submodule status` output for filenames, including newline-containing paths.

Each entry shows its path, configured URL, recorded index commit, checked-out HEAD, initialization/availability, changed-file count and clean/modified/out-of-date/conflict state. Status explicitly includes nested-submodule changes. Conflict stages are retained even without a stage-zero gitlink. Configured URL means the value in `.gitmodules`, not an effective transport endpoint; discovery and opening perform no network operations. Updates separately review the configured sources and URL rewrites.

The service limits discovery to 256 entries and 16 nesting levels, index output to 16 MiB per repository, status output to 8 MiB, and `.gitmodules` to a regular file of at most 1 MiB. Git runs through the service's existing bounded process pool and cancellation support. Gitlink paths and configuration must round-trip through UTF-8; newline paths work with valid Git configuration names. Duplicate path/URL fields or two names for one path are refused. Missing configuration does not hide an existing gitlink.

Submodule paths must remain inside the parent checkout. Traversal refuses symbolic links in checkout path components and `.git` metadata. Git's canonical top-level path must match the selected directory, and a Git directory cannot point back to an ancestor. Config includes are disabled; a symlinked `.gitmodules` is refused. These are optimistic filesystem checks, not a transaction against external writers.

The renderer requests an entry by a service-derived path hash and reviewed inventory revision. The revision covers the displayed recursive inventory and inspected canonical checkout/Git-directory identities. Opening rereads the inventory, verifies selection and initialization, then rechecks the opened repository's canonical path and Git directory. The renderer cannot submit an arbitrary path, URL or Git option. Opening uses the normal repository snapshot, watcher and terminal-context transition.

The Submodules dialog is available from the toolbar and command catalogue. While the dialog is open and visible, repository notifications trigger a recursive inventory read. The dialog also checks five seconds after each completed read because edits inside an already dirty child can leave the parent’s Git status unchanged. A burst of notifications during a read schedules one more check. Returning to a visible window triggers a check immediately. Manual refresh remains available after an error. Bare repositories disable the control because this view reads checkout indexes.

Background checks use the read-only inventory operation and preserve keyboard focus. Opening an update or URL-sync review suspends observation so the user can inspect the same state until they act. Git revalidates the review at confirmation. Closing the dialog or starting a foreground action cancels any outstanding observation and discards its late reply.

## Reviewed recursive initialization and update

**Review update** produces a service-owned, single-use token with a ten-minute lifetime. It binds the recursive inventory, parent index, stored submodule HEADs/indexes and effective Git configuration. Confirmation rechecks these under the parent repository’s write queue. Tokens are consumed before invoking the mutating command, including on failure or cancellation. The renderer supplies only the token and an explicit local-file transport choice; paths and Git options remain service-owned.

The service invokes `git submodule update --init --recursive --checkout --jobs=1`, with literal top-level index paths. Checkout mode follows each parent’s recorded commit and overrides configured merge/rebase/custom update modes. No force or remote-tip mode is exposed. Recursive updates can discover additional descendants and source URLs after fetching; the review says so and explains partial completion and the absence of Undo. The application does not claim this is an atomic multi-repository transaction or a complete preview of future descendants.

Preflight refuses conflicted/unavailable modules, nonempty uninitialized destinations, pending Git operations and active submodule changes, including untracked/ignored files. It also scans stored metadata beneath the parent/common Git directories and initialized modules, including deinitialized repositories. Staged indexes, skip-worktree/assume-unchanged flags, and HEADs not retained by a local branch, tag or remote-tracking ref block the operation. Metadata reads explicitly select an available worktree so missing checkout directories do not prevent inspection of staged data. The scan rejects metadata symlinks and caps directories/depth/visited entries. These conservative guards may require preserving old, unused submodule data before updating current modules.

Git configuration reads include effective native includes and URL rewrites for the transport review; `.gitmodules` discovery still disables includes. Allowed protocols are HTTPS, HTTP, SSH and Git, with local file transports disabled unless the user opts in for this recursive operation. External helpers remain blocked even through URL rewriting. The existing runner enforces TLS verification, and command configuration also overrides discovered URL-specific `sslVerify=false` settings. Existing askpass, transport error redaction, progress and cancellation support are reused. Provider account tokens are not automatically forwarded to recursively discovered hosts.

The dialog focuses Cancel review, restores the update button on dismissal, disables conflicting controls during mutation, permits cancellation of a running update, and refreshes the repository snapshot afterward. Errors and cancellation explicitly tell the user to refresh before retrying because some modules may already have changed. Successful completion also refreshes the inventory. Manual refresh clears earlier review focus intent and restores the Refresh button after loading.

## Reviewed recursive URL synchronization

**Review URL sync** lists declared URLs, current registered overrides and the effective remote/URL-rewrite context. Confirmation runs native `git submodule sync --recursive` with literal top-level index paths. Git resolves relative declarations and selects child remotes from native branch configuration. Unregistered modules are skipped. This configuration-only action retains dirty files, staged content and checked-out commits, and does not fetch or initialize repositories. Transport protocols are disabled during the command.

A repository-bound, single-use token expires after ten minutes. The fingerprint covers recursive inventory, canonical Git/common directories, branch context, effective configuration and metadata for the local configuration, worktree configuration and `.gitmodules` files. Confirmation rechecks under the parent repository write queue and consumes the token before inspection/mutation. Leaf configuration symlinks and files over 1 MiB are refused; effective configuration output is bounded to 2 MiB per repository and review sources to 2,048 entries. These checks are optimistic and do not exclude concurrent external writers or make recursive writes atomic.

The dialog explains replacement of local overrides, configuration shared by linked worktrees, native relative-URL resolution, and possible partial writes on failure or cancellation. Cancel review receives focus; dismissal and completion restore the review button. A failed command requires a new review, and no Undo is offered. The service refreshes inventory after success and the renderer refreshes the repository snapshot after mutation.

## Scope and verification

Recursive discovery, status, guarded opening, reviewed recursive initialization/update and URL synchronization are implemented for Linux fixtures. Feature 1.8’s recursive init/update fixture is covered; this does not establish cross-platform or live authenticated-provider acceptance. Add/remove controls, non-UTF-8 paths and cross-platform runtime acceptance remain open.

Native Git tests cover initialized and uninitialized nested modules, dirty/out-of-date checkouts, stale and unknown selections, Unicode/newline paths, configuration-only paths, symlink refusal, parent-directory cycles, conflict stages, cancellation, bare-repository refusal, duplicate/redirected configuration and the inventory count bound. Typed IPC tests reject caller paths, URLs, force/recursive options and malformed identities. Electron acceptance lists a nested uninitialized module, refuses an old selection after an external edit, refreshes its dirty count and opens the reviewed child with its draft intact.

Additional native tests cover exact recorded commits, fetching newer recorded objects, literal wildcard paths, replay and stale-configuration refusal, dirty/ignored/hidden-index/detached work, preserved staged data in missing checkouts, local transport opt-in, TLS certificate rejection and blocked external-helper rewrites. Typed IPC tests reject arbitrary update paths/URLs/options and missing transport consent. Electron tests cover review dismissal/focus, stale reviews, nested initialization and cancellation of a stalled HTTP fetch. Live authenticated providers, platform-specific credential prompts and packaged update flows remain unverified.

Seven native synchronization tests cover recursive updates with dirty/staged work retained, relative URLs and branch-selected remotes, skipped unregistered modules, credential redaction, stale declarations/remotes/branches, foreign/replayed tokens, native config-lock failure/retry and configuration symlink refusal. Strict IPC rejects caller paths/URLs/options. Electron acceptance covers review dismissal/focus, stale reviews, write failure/retry, unchanged HEAD/index/local edits and zero requests to the declared HTTP endpoint. These fixtures do not establish cross-platform or packaged acceptance.

## References

- [Git submodule commands](https://git-scm.com/docs/git-submodule)
- [Git index listing and NUL output](https://git-scm.com/docs/git-ls-files)
- [Git configuration files and NUL output](https://git-scm.com/docs/git-config)

- [Git transport environment controls](https://git-scm.com/docs/git)
