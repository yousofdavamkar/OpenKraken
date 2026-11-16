# 0128 — Recovering issue actions

GitHub, GitHub Enterprise and GitLab issue dialogs save the title, description or comment, GitLab visibility choices, and GitHub closing reason. The account identity, repository, action, issue number and requested state identify a draft. Creating an issue, commenting on issue #12, closing it and reopening it each have their own record. Main stores the records with Electron safeStorage and the same revision-checked file writer used for pull-request reviews. Nested GitLab project namespaces are supported.

**Draft saved locally** acknowledges the latest edit. The composer debounces saves for 250 ms. **Save and close** waits for the protected write. An exit before acknowledgment can lose the latest keystrokes. **Saved issue drafts** under **Provider accounts** lists the connected account's drafts and opens the original form without fetching provider data. Forgetting the account disables access until the same identity reconnects.

## Submission and recovery

The dialog restores fields and visibility choices. A new review is required before submission. After confirmation, the app records that the provider may receive the action, then sends the reviewed request. Cancelling during that local write prevents dispatch. A definite rejection restores the editable draft. A confirmed success clears the matching local record. A failure to clear it appears alongside the provider's confirmed outcome.

After a process exit or lost response, the marker opens the dialog with editing disabled. **Check existing results** reads the current issues, comments or issue state. The user can inspect the results, discard the local record, or explicitly return to the draft for another review when the requested state is still outstanding. Recovery and inspection do not send the action. A crash between marking and sending can also lead to inspection. A missing issue or comment in a result page cannot establish whether the provider received it.

If the OS cannot encrypt the submission marker for the current revision, a separate **Submit without crash recovery** choice allows the user to proceed. A changed, unreadable or unverified revision requires reopening the current copy. A failed save or discard keeps the dialog open so the user can copy their edits before closing.
