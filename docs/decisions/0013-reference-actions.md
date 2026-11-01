# 0013 — Guarded local reference actions

The first M3 slice creates branches at an explicit commit and creates lightweight, annotated, or signed tags. It also deletes reviewed local tags. Creation never forces replacement of an existing name. Names pass Git's ref validation; target commits and reviewed deletion targets are full object IDs. Tag annotations use stdin and verbatim cleanup. Signing uses the configured native agent and requires an annotation.

Reference deltas extend the existing profile undo journal. Undo/redo checks the recorded HEAD/index and the affected refs, then uses a Git ref transaction with expected old object IDs. Changed or missing refs cause refusal instead of replacing another writer's work. Undo refuses to change a branch used by a linked worktree. Bare repositories support these ref-only actions without publishing a worktree index. Reference objects removed by Git garbage collection cannot be recreated from an OID alone; Git refuses that undo, preserving the current refs.

The dialogs show the target commit or reviewed tag object. Deletion explicitly concerns only the local tag. The service uses the common-directory write queue and observer pause window. Branch checkout, rename, deletion, upstream settings and remotes are subsequent M3 slices.

Validation: real Git branch/tag/undo flows, exact annotation bytes, stale ref refusal, invalid names, linked-worktree protection, a bare-repository fixture, and an Electron create/delete/undo flow.

Public references: [Git branch](https://git-scm.com/docs/git-branch), [Git tag](https://git-scm.com/docs/git-tag), and [Git update-ref transactions](https://git-scm.com/docs/git-update-ref).
