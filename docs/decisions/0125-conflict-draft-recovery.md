# 0125 — Recovering conflict resolution drafts

Opening a conflict reads its recovery copy from the local profile. Main derives the filename from the checkout path, Git directory and original path bytes. Conflict drafts use the private `conflict-drafts` directory. A working-file draft for the same path can coexist with a conflict draft. Both appear under **Saved file drafts** for that checkout, and conflict entries carry a “conflict resolution” label.

## What survives a restart

A record contains the reviewed conflict token, the complete output text and the choices made for each edited chunk. Each choice records the chunk index and which lines the user selected from each side. An explicit choice of zero lines resolves that chunk to empty output. An absent choice leaves it unresolved. Manual editing switches to a text draft. The output can include all three stage texts and conflict markers while the user is still choosing lines. The local 40 MiB record limit accommodates JSON escaping. Staging retains the native 2 MiB UTF-8 output limit.

On reopening, the editor compares the saved token with the current preview, including the Git stages and working-file image. The merge worker reconstructs the chunks. The editor checks the saved line counts and rendered output before restoring the interactive choices. If the chunks differ, the saved text remains available for manual review. A changed conflict token blocks staging from that draft. The user can copy the text or explicitly discard the draft and reopen the conflict.

## Writes and cleanup

Edits use the 250 ms debounce and private atomic writer described in [the working-file recovery decision](0124-working-file-draft-recovery.md). “Draft saved locally” acknowledges a profile write. Closing the conflict dialog flushes pending edits. A failed save leaves the current output in the dialog so the user can copy it. Local recovery records are plaintext and can contain sensitive repository contents.

A successful native resolution clears its recovery copy. A rejected resolution keeps it. If Git succeeds and the application dies before the clear, the copy remains available in **Saved file drafts**. This panel also works after an external merge abort. Previewing a draft leaves the Git index and working tree untouched. The user can remove the local copy after reviewing it.
