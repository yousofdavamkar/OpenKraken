# 0126 — Recovering native Git editor drafts

When Git opens a text editor during a reviewed rebase or operation action, OpenKraken saves edits in the local profile after a 250 ms debounce. **Draft saved locally** means main acknowledged that revision. A crash can lose keystrokes made since the last acknowledgment. Saving and continuing flushes a pending edit and sends the reviewed answer to Git.

## Storage and identity

Main registers the document against the pending operation's checkout and the prompt ID from the Git service. It accepts a document inside that checkout's Git directory. Each prompt has a separate record, even when two prompts edit the same path. The filename derives from the canonical checkout path, Git directory and prompt ID. The record contains the relative document path, a SHA-256 digest of its starting text, the edited text and a timestamp. Moving a checkout changes its identity.

The private `native-editor-drafts` directory holds plaintext and can contain sensitive repository content. Records use the [shared atomic writer](0124-working-file-draft-recovery.md) and revision checks. The editor accepts up to 1 MiB of UTF-8 text. JSON escaping can enlarge the stored copy, so records have a 7 MiB limit.

## Recovering and clearing text

After a restart, **Saved file drafts** offers a read-only preview and a confirmed discard for the opened checkout. Recovery works while Git's index is locked. After a service interruption, the open editor also lets the user continue typing, keep the draft or discard it.

A new prompt for the same checkout and document offers earlier drafts for review. If the starting text matches and the selected revision matches the preview, **Use a copy of this draft** copies the text into the editor. The user still reviews it and chooses whether to send it to Git. A changed starting document leaves the earlier text available for manual copying. Reusing an earlier draft preserves its original record.

An accepted editor reply closes the prompt. The Git service then checks the document, writes the answer, syncs the file and closes it. Only after those steps does it acknowledge the written text's digest to main. Main clears the matching prompt revision on that acknowledgment or on an explicit discard or accepted editor cancellation. An external edit that causes Git's write to fail, or a crash before confirmation, leaves the acknowledged recovery copy available. Recovering text does not resume the Git command. An interrupted rebase can leave an index lock that requires separate attention.
