# 0067 — Worktree management

## Decision

The Git service owns worktree discovery and creation through `git worktree list --porcelain -z` and `git worktree add`. A separate Worktrees dialog is available from the toolbar and command catalogue. It shows the main/current checkout, branch or detached HEAD, commit, changed-file count, lock reason and stale registration information. Unavailable checkouts remain visible. Reading another checkout's status verifies that its Git common directory still belongs to the opened repository. Bare and unborn repositories keep their distinct states.

Paths come from Git or a main-process native directory picker. Renderer requests select a registered worktree by a service-derived identifier and inventory revision; they cannot supply an open path or creation destination. Opening rechecks inventory membership, availability and the common directory. The revision hashes Git's NUL-delimited inventory, including HEADs and lock/prune metadata. Status changes alone do not invalidate opening or creation because neither operation discards working files. Inventory reads are bounded to 256 entries and 4 MiB, with an 8 MiB status cap per worktree and the existing bounded process pool. Paths must round-trip through UTF-8; undecodable inventories fail explicitly rather than redirecting operations through replacement characters.

Creation offers a new branch at an explicit commit, an existing local branch at its reviewed tip, or detached HEAD at an explicit commit. Git validates branch names and commit existence. Existing branches are checked again against the reviewed OID, and Git's normal refusal to check out a branch already in use remains enabled. No force or branch-reset option is exposed. Main asks for an existing empty directory, with native directory creation available. The service canonicalizes it and refuses nonempty folders before invoking Git. Shared-repository writes use the existing common-directory queue and watcher suppression.

Creation does not change the current checkout or automatically open the new one. Refresh updates the inventory and branch controls; the user explicitly opens a listed checkout. Picker cancellation and errors preserve form choices. Git errors or cancellation may leave partial Git-created state; the application never attempts an automatic recursive deletion or branch rollback. Refresh and Git's own worktree tools remain the recovery path. External Git writers are outside the application's queue, so this is optimistic revalidation, not a filesystem transaction.

`rev-parse` metadata normally uses the existing single-query fast path. When newline-containing paths make its multi-value output ambiguous, the repository service reads the two path values separately. Worktree inventory itself always uses the NUL-delimited format.

## Scope and verification

This checkpoint implements list, create and open. Lock/unlock, safe removal, prune review, graph worktree WIP rows and other-checkout watch integration remain follow-up work; the worktree feature is not complete yet.

Native Git tests cover locked, missing, dirty, detached, bare and unborn checkouts, Unicode/newline paths, unknown/stale selections, empty-directory requirements, branch-tip revalidation, refusal of duplicate branch checkouts, detached creation and cancellation. IPC tests reject renderer-supplied paths, force options, malformed IDs and arbitrary revision expressions. Electron acceptance covers stale selection recovery, checkout switching, all three creation modes, native picker cancellation and failed creation with retained form choices. The current platform is Linux; these results do not establish macOS/Windows runtime acceptance.

## Reference

- [Git worktree commands and porcelain format](https://git-scm.com/docs/git-worktree)
