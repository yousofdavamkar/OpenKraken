# 0130 — Recover merge messages and check interrupted submissions

GitHub, GitHub Enterprise and GitLab keep one merge draft per connected account, target repository and request number. The draft contains the editable options and messages. Confirmation, provider permissions and reviewed revisions are transient. Reopening loads the current provider state and requires a fresh review before submission. GitLab applies the current project squash policy to the saved choice.

Main stores the encrypted record under the account's profile directory. Writes use the existing revision check, synchronized temporary file and rename. The two GitLab messages may each contain 65,536 UTF-16 code units. A 2 MiB encrypted file limit accommodates expansion from JSON escaping and base64. Saving reports success after the write completes. An abrupt exit during the 250 ms edit debounce can lose the last change.

**Saved merge drafts** in Provider accounts lists request numbers and lets the user read or discard text locally even if a request has closed or the provider is offline. Opening merge review fetches current metadata. Disconnecting the account removes access until the same identity reconnects. Credentials and the saved messages stay out of the inventory response.

Before sending a confirmed merge, the dialog records that the outcome may be unknown. A crash between saving that marker and sending the request can also leave an uncertain draft. Recovery never resubmits it. The user can inspect the provider's current status. An open request needs an explicit return to editing, fresh review and confirmation. A confirmed merge or a read showing that the request has merged clears the local copy. A provider rejection keeps edited fields available.

Cancelling while the marker is being saved prevents dispatch. If encryption is unavailable, a separate **Merge without crash recovery** confirmation permits that attempt. A conflicting revision requires reopening the current draft. If the provider acknowledges a merge and the app exits before cleanup, the earlier marker continues to direct the user to the status check.
