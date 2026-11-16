# 0127 — Recovering pull-request reviews and comments

GitHub and GitHub Enterprise review, line-comment and reply composers save the review action, body, reviewed head and base commits, and whether a submission may have reached the provider. **Draft saved locally** acknowledges the latest edit after a 250 ms debounce. An exit before acknowledgment can lose newer keystrokes. **Keep draft and close** flushes pending edits. Explicit discard clears the reviewed record.

## Local storage and access

Main checks the connected account in the local manifest. Its identity includes provider, host and provider user ID. Case-insensitive repository owner and name, pull-request number and comment target distinguish documents. Line comments use the exact path, side and line. Replies use the thread ID. A change in either reviewed commit preserves the old text and prevents submission against the new commits.

Main encrypts each record with Electron safeStorage using the same OS protection as provider credentials. The protected contents include the repository, target and source commits. Files have hashed names and use the private atomic writer with revision checks. A record accepts up to 65,536 UTF-16 code units of review text and up to 1 MiB of encoded storage. On read, main checks the decrypted identity against its account directory and filename. A conflicting revision blocks the write. An unreadable record stays on disk and the inventory reports the read failure. A normal save re-encrypts the record.

**Saved review drafts** in pull-request details lists drafts for that PR, including comments whose original line is gone. The same control in **Provider accounts** lists the account’s local drafts without fetching a repository or pull request. The user can preview, copy or explicitly discard a record there. Forgetting the account removes its credential and disables draft access. Reconnecting the same provider identity restores access to the retained records.

## Interrupted submissions

Previewing or restoring text sends nothing. Explicit submission first marks the local record as potentially sent. This also covers approvals with empty review text. Once recorded, the composer sends the usual request with the reviewed commit IDs. Cancelling during the local write stops the submission before the network request starts. An acknowledged success clears the matching local revision. A definite rejection or pre-submission cancellation returns it to an editable draft.

After a crash or lost acknowledgment, that marker persists. The composer offers read-only inspection of submitted reviews or comments. The user must explicitly return to the draft and confirm again to send another request. Recovery itself sends zero writes. A crash between recording the marker and sending the request can also require inspection. An empty inspection result does not establish that the original submission failed.

If protection or profile storage fails, the editor reports the failure and retains the text on screen. The user can copy it and explicitly choose **Submit without crash recovery**. That choice cannot guarantee a recoverable record of the attempted submission. Other provider composers remain separate hardening work.
