# Native operation state and recovery controls

OpenKraken reads Git's native operation markers in the current worktree's Git directory. Rebase progress comes from `msgnum`/`end` or `next`/`last`; reopening the app does not require an application-owned operation record. Metadata reads use fixed names, bounded buffers, and reject symbolic links.

Continue, Skip, and Abort act on the inspected operation, not a renderer-supplied Git command. A review token includes native metadata, HEAD, the semantic index, and tracked working-file content. Changed reviews fail before execution. Merge supports Continue and Abort; rebase, cherry-pick and revert additionally support Skip. Mailbox and bisect state are displayed without recovery controls for now.

Native Git owns sequencer transitions, hooks, commit creation, and conflict stages. Writes use the private index under the real index lock and publish resulting conflict stages even if Git reports failure. Commit messages use Git's prepared message without launching an interactive editor. Skip and Abort require an explicit confirmation in the UI. Full operation Undo and interactive message editing are subsequent M4 slices.
