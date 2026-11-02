# Native operation state and recovery controls

OpenKraken reads Git's native operation markers in the current worktree's Git directory. Rebase progress comes from `msgnum`/`end` or `next`/`last`; reopening the app does not require an application-owned operation record. Metadata reads use fixed names, bounded buffers, and reject symbolic links.

Continue, Skip, and Abort act on the inspected operation, not a renderer-supplied Git command. A review token includes native metadata, HEAD, the semantic index, and tracked working-file content. Changed reviews fail before execution. Merge supports Continue and Abort; rebase, cherry-pick and revert additionally support Skip. Mailbox and bisect state are displayed without recovery controls for now.

Native Git owns sequencer transitions, hooks, commit creation, and conflict stages. Writes use the private index under the real index lock and publish resulting conflict stages even if Git reports failure. Commit messages use Git's prepared message without launching an interactive editor. Skip and Abort require an explicit confirmation in the UI. Full operation Undo and interactive message editing are subsequent M4 slices.

Starting a merge or rebase requires an existing HEAD, clean tracked files, and the reviewed HEAD/index revision. Targets are exact commit IDs. Merge offers native `--ff`, `--no-ff`, and `--squash`; squash leaves staged changes for a separate commit. Rebase uses the merge backend, disables autostash and update-refs, and flattens merge commits. Native hooks and signing configuration remain effective. Untracked collisions are rejected by Git. The UI refreshes graph and status after success, conflict, cancellation, or failure.

Public command references: [git-merge](https://git-scm.com/docs/git-merge), [git-rebase](https://git-scm.com/docs/git-rebase). No application Undo is advertised for these initial operation controls; completed-operation journaling is still part of M4.

Cherry-pick and revert use one reviewed commit per request and preserve Git's default author/message behavior. Merge commits require an explicit mainline parent (one-based, checked against native parents); there is no silent first-parent choice. The UI explains that reverting a merge affects later merge results. Conflict recovery uses the same native sequencer controls. References: [git-cherry-pick](https://git-scm.com/docs/git-cherry-pick), [git-revert](https://git-scm.com/docs/git-revert).
