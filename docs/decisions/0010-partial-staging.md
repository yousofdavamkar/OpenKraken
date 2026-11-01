# 0010 — Reviewed partial patches

Status: accepted.

Generate previews with native Git diff, disabling external diff programs and textconv while retaining Git's normal clean conversion. Untracked previews use an isolated intent-to-add index; this can create Git's empty blob object, but does not change refs, the real index or working files. Preserve conservative index timestamps when copying: a fresh timestamp can incorrectly make Git trust cached stats for same-timestamp file edits. A regression explicitly exercises that case.

The renderer sends line IDs and an opaque digest, never an executable Git command or a raw patch. Under the repository write lock, regenerate the file diff, reject stale digests, and derive a patch from the selected changed lines. Apply with `git apply --cached --recount --unidiff-zero --whitespace=nowarn`. Undo uses the existing index journal. Reverse selection unstages changes without touching the working file.

Selection follows unified-patch order: unselected removals become context and unselected additions are omitted. In an adjacent replacement block, retained old lines therefore precede selected new lines. A whole-hunk selection retains the complete replacement. The UI explains this behavior; do not infer undocumented old/new line pairings inside an unanchored replacement block.

Keep text previews under 2 MiB and 10,000 lines, with a virtualized modal view, per-line checkboxes and per-hunk controls. Binary files, symlinks, type changes, unresolved conflicts, renames, mode-only changes, non-UTF-8 filenames and non-UTF-8 diff bytes use whole-file controls. Explicitly refuse lossy decoding rather than introducing replacement characters into staged content. Native Git clean filters and working-tree encodings remain authoritative.

Verification includes 10,000 seeded random file edits and line selections in both directions. Generate independent expected trees from replacement-block semantics, apply the actual generated patches with Git, and compare cached diffs and tree IDs against those expected trees. Other tests cover new/deleted files, disjoint hunks, no-final-newline markers, clean filters, stale previews, conservative stat checks, and the full Electron dialog flow.

Reference: [Git apply](https://git-scm.com/docs/git-apply).
