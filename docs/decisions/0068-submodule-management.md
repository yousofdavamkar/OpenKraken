# 0068 — Submodule management

## Decision

The service discovers submodules from the parent index's gitlink entries, using `git ls-files --stage -z`. It reads `.gitmodules` with Git's NUL-delimited configuration output and includes disabled. Configuration-only paths cannot become open targets. The UI lists initialized descendants recursively beneath their parent; an uninitialized parent cannot expose descendants until its repository is available. This avoids parsing the human-oriented `git submodule status` output for filenames, including newline-containing paths.

Each entry shows its path, configured URL, recorded index commit, checked-out HEAD, initialization/availability, changed-file count and clean/modified/out-of-date/conflict state. Status explicitly includes nested-submodule changes. Conflict stages are retained even without a stage-zero gitlink. Configured URL means the value in `.gitmodules`, not an effective transport endpoint; this increment performs no network operations.

The service limits discovery to 256 entries and 16 nesting levels, index output to 16 MiB per repository, status output to 8 MiB, and `.gitmodules` to a regular file of at most 1 MiB. Git runs through the service's existing bounded process pool and cancellation support. Gitlink paths and configuration must round-trip through UTF-8; newline paths work with valid Git configuration names. Duplicate path/URL fields or two names for one path are refused. Missing configuration does not hide an existing gitlink.

Submodule paths must remain inside the parent checkout. Traversal refuses symbolic links in checkout path components and `.git` metadata. Git's canonical top-level path must match the selected directory, and a Git directory cannot point back to an ancestor. Config includes are disabled; a symlinked `.gitmodules` is refused. These are optimistic filesystem checks, not a transaction against external writers.

The renderer requests an entry by a service-derived path hash and reviewed inventory revision. The revision covers the displayed recursive inventory and inspected canonical checkout/Git-directory identities. Opening rereads the inventory, verifies selection and initialization, then rechecks the opened repository's canonical path and Git directory. The renderer cannot submit an arbitrary path, URL or Git option. Opening uses the normal repository snapshot, watcher and terminal-context transition.

The Submodules dialog is available from the toolbar and command catalogue. Refresh rereads external changes; an open error remains in the dialog so the user can refresh and retry. Bare repositories disable the control because this view reads checkout indexes.

## Scope and verification

This increment implements recursive discovery, status and guarded opening. It does **not** complete feature 1.8: recursive initialization/update, transport authentication and review of resulting writes remain required follow-up work. Add/remove/sync controls, automatic refresh of this dialog, non-UTF-8 paths and cross-platform runtime acceptance also remain open.

Native Git tests cover initialized and uninitialized nested modules, dirty/out-of-date checkouts, stale and unknown selections, Unicode/newline paths, configuration-only paths, symlink refusal, parent-directory cycles, conflict stages, cancellation, bare-repository refusal, duplicate/redirected configuration and the inventory count bound. Typed IPC tests reject caller paths, URLs, force/recursive options and malformed identities. Electron acceptance lists a nested uninitialized module, refuses an old selection after an external edit, refreshes its dirty count and opens the reviewed child with its draft intact.

## References

- [Git submodule commands](https://git-scm.com/docs/git-submodule)
- [Git index listing and NUL output](https://git-scm.com/docs/git-ls-files)
- [Git configuration files and NUL output](https://git-scm.com/docs/git-config)
