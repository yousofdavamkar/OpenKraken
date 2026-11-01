# 0013 — Guarded local reference actions

The first M3 slice creates branches at an explicit commit and creates lightweight, annotated, or signed tags. It also deletes reviewed local tags. Creation never forces replacement of an existing name. Names pass Git's ref validation; target commits and reviewed deletion targets are full object IDs. Tag annotations use stdin and verbatim cleanup. Signing uses the configured native agent and requires an annotation.

Reference deltas extend the existing profile undo journal. Undo/redo checks the recorded HEAD/index and the affected refs, then uses a Git ref transaction with expected old object IDs. Changed or missing refs cause refusal instead of replacing another writer's work. Undo refuses to change a branch used by a linked worktree. Bare repositories support these ref-only actions without publishing a worktree index. Reference objects removed by Git garbage collection cannot be recreated from an OID alone; Git refuses that undo, preserving the current refs.

The dialogs show the target commit or reviewed tag object. Deletion explicitly concerns only the local tag. The service uses the common-directory write queue and observer pause window. Branch checkout, rename, deletion, upstream settings and remotes are subsequent M3 slices.

Validation: real Git branch/tag/undo flows, exact annotation bytes, stale ref refusal, invalid names, linked-worktree protection, a bare-repository fixture, and an Electron create/delete/undo flow.

Public references: [Git branch](https://git-scm.com/docs/git-branch), [Git tag](https://git-scm.com/docs/git-tag), and [Git update-ref transactions](https://git-scm.com/docs/git-update-ref).

## Checkout and its inverse

Branch checkout uses native `git switch --no-guess` with the isolated index, without force or discard flags. The reviewed tip must still match before switching, and active merge/rebase/sequencer operations block the action. Native Git protects tracked and untracked work and enforces linked-worktree occupancy.

Checkout undo switches back through Git instead of copying every file in the repository. It checks the recorded index and HEAD and requires the previous branch tip to remain unchanged. New nonconflicting working edits survive; conflicting edits cause Git to refuse. Detached and unborn previous HEADs use native detached/orphan switch modes. Pending undo records preserve recovery information if hooks or cancellation change the result. A failed post-checkout hook still records an already-completed initial switch so the user can undo it.

The checkout slice is validated with different trees, later untracked and conflicting tracked edits, moved previous branches, detached/unborn heads, a failing native hook, and the Electron switch/undo flow. Branch rename/delete/upstream and remote operations remain subsequent work.

## Branch rename

Rename uses native `git branch --move`, including the current branch, and journals both ref names and their local branch settings. The destination must have neither a ref nor existing branch settings. Branches used by a different worktree are refused. Undo reverses the native rename after verifying both refs, HEAD/index and the exact affected configuration entries. Settings for similarly named branches (including names with dots) are outside the scope and remain unchanged. Configuration entries are recorded as bytes, preserving non-UTF-8 values and multiline descriptions without decoding them for comparison.
