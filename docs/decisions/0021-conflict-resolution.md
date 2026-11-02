# Conflict documents and recoverable resolution

Conflict documents come from native unmerged index stages, matched using raw NUL-delimited path bytes. Stage 1 is base, 2 is ours, and 3 is theirs. Missing stages represent additions or deletions. During rebase these are Git's stage meanings: ours is the rebased destination, theirs is the replayed commit.

Text editing is restricted to regular UTF-8 files without NUL, at most 2 MiB per version/output. Binary, oversized and symlink versions remain available as whole-side choices. Native checkout-index applies the selected stage (including working-tree filters), then native add stages the result. An absent side or explicit deletion removes the path and its stages. Submodule choices update the gitlink only; they never check out or delete submodule working files.

A review token covers HEAD/index revision, native operation metadata, stages and raw working-file images. Resolution rechecks it under the index lock. Text writes use the validated backup path layer and atomic file replacement. Resolution is journaled with before/after index and working bytes; Undo restores conflict stages and raw contents and refuses newer changes. Raw backup limits apply, and a pending record preserves recovery material after an uncertain failure. These are optimistic checks, not a filesystem-wide editor lock.

The native fixture corpus covers text edits, add/add, delete/modify, binary, rename/modify and submodules. Public Git stages, working files and Undo results are the acceptance seam.
