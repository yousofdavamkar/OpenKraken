# 0015 — Stashes and workspace recovery

Stash creation uses native Git with an isolated index under the existing index lock, raw file backups and the workspace undo journal. It accepts a message, selected literal paths, optional untracked content, or all staged changes. Ignored files are not included. Active operations, unresolved conflicts, submodule worktrees and stale HEAD/index reviews are refused. File and index backup limits remain those of the working-tree transaction layer.

A partial stash must exclude unrelated staged content. Native path-limited stash can also capture unrelated staged files in its trees. We therefore build a temporary index from HEAD plus only the selected staged entries, run native stash with NUL-delimited literal paths, then combine the resulting selected index entries with the original unselected index. The original index's conservative timestamp is retained during restoration. Both successful and failed native commands restore the unselected index entries before publishing.

Native staged-only stash cannot use `--pathspec-from-file`, and a staged-only path argument can affect other staged working files. We expose that mode as **all staged changes only**, without a pathspec, and reject subset requests. Ordinary partial stashes support the explicit file selection.

Undo restores the workspace/index while keeping the created stash. This avoids deleting a useful recovery copy and does not claim to undo a stash reflog operation. Later edits are protected by the existing undo fingerprints. Stash listing uses NUL-separated native reflog fields, with a list token, full object IDs and selectors; its output is bounded. The desktop refreshes the list even after a failed stash attempt because native Git may have saved a stash before failing to remove overlapping changes.

Tests verify literal selected paths, untracked content, workspace Undo, staged-only changes, stale index refusal and exclusion/preservation of unrelated staged work. An Electron flow selects files, creates a stash and restores the workspace with Undo.

Reference: [Git stash documentation](https://git-scm.com/docs/git-stash).
