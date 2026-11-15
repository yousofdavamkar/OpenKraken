# 0005 — Ref views and checkpoint refresh

Status: accepted. Complements 0004.

## Ref selection

Hide removes a ref from the Git start points; it does not exclude its ancestors if another visible ref reaches them. Solo selects exactly one ref, taking precedence over hidden preferences. Hiding the checked-out branch also removes its implicit HEAD start point; detached HEAD remains an independent root unless solo is active. Stash visibility controls the overlay and its base starts. Missing solo refs produce an empty view until cleared, rather than silently showing all history. Working-tree status remains available independently.

All-history search uses the cursor's immutable start points. Hash lookup checks reachability from those points as well. Pins resolve only visible commit refs (including peeled tags), and reserve column zero for their first-parent ancestry. A pending pin reserves space without drawing an edge above the tip. Pinning a different visible ref starts a new layout.

## Refresh

The graph worker retains topology and lane checkpoints every 500 rows. Refresh compares OIDs, parents and stash projection, resumes at the checkpoint preceding the first difference, and reuses a suffix only when row indices, remaining topology and complete lane continuation state match. Shifted row indices are rebuilt. Metadata changes rebuild the search index even when all layout rows can be reused. Generation checks reject stale refreshes and pages.

The UI refreshes the initial 2,000-commit window, matching the existing refresh behavior; it does not automatically reload every previously paged row. Views remain active on refresh. Sidebar preferences are held for the active repository session; disk persistence belongs with the per-repository settings store. No Git refs or configuration are written by these controls.

A working-state refresh can change staging, upstream counts or status flags while leaving every graph row intact. When HEAD and the worktree table match, compare the ordered list of displayed paths and whether any entry is conflicted. Those inputs determine the current checkout's synthetic row, including its searchable text. If they match, publish the new working state and status while keeping the loaded rows, layout, index and selection. A path, conflict or worktree change still goes through graph projection and search refresh.
