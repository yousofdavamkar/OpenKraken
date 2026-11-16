# 0124 — Recovery for working-file edits

The working-file editor keeps a recovery copy in the local app profile. Edits enter a 250 ms debounce and writes run in order. “Draft saved locally” means the main process acknowledged the write. The newest edit can still be lost between a keystroke and acknowledgment. Reverting to the original document schedules removal immediately. Saving the working file continues to use its native Git operation and existing Undo history.

## Identity and storage

Main looks up the canonical checkout and Git directory from the opened repository ID. It derives the draft filename from those two paths and the original file path bytes. Linked worktrees and different files have independent records. The private `working-file-drafts` directory contains local plaintext, including edited text, path bytes, selected line endings and the original file token. Recovery copies can contain sensitive file contents.

Working-file and commit drafts share the private temporary-file write, flush, rename and revision check. Commit drafts keep their original filenames and disk format. Working documents accept up to 2,097,152 UTF-16 code units. The 13 MiB on-disk limit accommodates JSON escaping. Unreadable records and records changed externally are retained. The app shows storage failures in the editor, where the text can still be copied or saved to the working file.

## Reopening and clearing

Opening the editor reads the current file and recovery copy. A matching token permits an explicit Save. A different file or checkout token exposes the recovered text for copying and disables Save. In both cases, the working tree stays untouched until the user requests a native write. A crash between that write and clearing its recovery copy can leave the earlier draft in the profile.

**Saved file drafts** in the Working tree panel also opens a read-only copy, including when a file disappears from the status list or is deleted from disk. Listing runs on demand. Main checks the filename against the opened checkout and stored path bytes before returning a label. The panel returns only names until the user opens an entry. Closing a preview keeps its copy. Explicit discard removes the reviewed revision. A native discard of an active edited file drains admitted writes before clearing that session. A terminal's native close prompt can leave a read-only preview intact.

The recovery store retains drafts across renderer or app death. Moving a checkout changes its identity. As with commit drafts, filesystem errors or another process modifying the profile can prevent cleanup. Drafts from the intermediate format without stored path bytes can still be recovered by opening the corresponding file.
