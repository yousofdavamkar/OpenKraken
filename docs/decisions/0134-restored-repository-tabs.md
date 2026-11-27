# 0134 — Restoring repository tabs after a restart

Parity row 1.5 requires that a restart restores the repository tabs and the selected tab. OpenKraken keeps its tab list in the main process and saves it to `repository-tabs.json` in the profile. The renderer can only read the list or close a tab by repository id.

A tab is recorded only when a request opens a repository. That covers the picker, initialization, clone, an accepted repository link, a worktree, a submodule and switching tabs. The opened repository becomes the active tab. Refreshes and other operations that return a snapshot leave the list alone, so they cannot add back a tab the user closed. The list keeps at most 16 tabs; when it is full, the oldest inactive tab is dropped. A tab's id is the SHA-256 of its canonical path, the same derivation the Git service uses, so a saved tab and a reopened repository share one id.

After a restart, the saved tabs are listed in their saved order and the welcome screen is shown. Selecting a tab sends `reopenRepository` with its id. The main process resolves the id against repositories opened in this session first, then against the saved list. The Git service validates the path again on every open. If a saved repository was moved or deleted, selecting its tab shows the usual open error, and the tab stays until the user closes it.

Saved tabs are not opened automatically at launch. Opening a path from a profile file without a user action is a different trust decision from the reviewed links in ADR 0080. Existing restart workflows also expect the welcome screen after a restart. The active tab is still saved, so reopening it at launch can be added later behind its own decision.

Writes follow the settings store (ADR 0061). Each write is serialized, written to a temporary file with mode 0600, synced and then renamed into place. If the file changed on disk since it was read, it is not overwritten. A damaged file is copied to `repository-tabs.corrupt-<uuid>.json` before the next save replaces it. Saving is best effort: if a write fails, the tabs for this session stay usable, and the tab strip shows a warning that they may not be restored. Quitting waits for pending tab writes.

The file stores absolute local repository paths only. It holds no repository content, credentials or remote URLs, and the app never sends it anywhere.

## Limits

- Parity row 1.5 is met only in part: the selected tab is saved but not opened at launch.
- One window. Inactive tabs keep no in-memory repository state; switching reopens the repository through the existing history cache. The "switching takes < 100 ms" acceptance target was not measured.
- Reopening the last closed tab, reordering tabs, tab groups and tab keyboard shortcuts are not implemented.
- Verified on Linux x64 only.
