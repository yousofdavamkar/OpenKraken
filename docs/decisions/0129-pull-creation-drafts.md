# 0129 — Recovering pull and merge request creation

OpenKraken keeps one creation draft per connected account and target repository. It saves the source owner and repository, source and target branches, title, description, draft flag and maintainer-edit choice. The shared protected draft store encrypts the record using Electron safeStorage and checks its revision before replacing or deleting it.

Edits are saved after a 250 ms pause. **Draft saved locally** acknowledges the write, and **Save and close** waits for it. An exit before acknowledgment can lose the latest edit. A default branch arriving during editing is saved with the other fields if the user has yet to edit the target branch. Opening a recovered draft preserves its target branch and offers an explicit template lookup.

**Provider accounts → Saved creation drafts** opens the form offline. Each submission requires a fresh branch preview. On confirmation the composer saves a marker before sending the request. Cancelling while that write is pending stops dispatch. A definite rejection restores editing. A confirmed creation clears the matching revision. If cleanup fails, the form shows both the confirmed result and a warning about the local copy.

After a lost response or process exit during submission, the recovered fields are read-only. The user can check existing requests, discard the local copy or explicitly return to the draft after inspection. A crash between saving the marker and sending the request also enters this flow. A missing result on one provider page cannot establish whether creation succeeded.

If the current revision matches but OS encryption is unavailable, the user can explicitly submit without crash recovery. A stale or unreadable revision requires reopening and reviewing the saved copy. Electron tests exercise real process exits against simulated GitHub, GitHub Enterprise and GitLab responses and a test encryption backend.
