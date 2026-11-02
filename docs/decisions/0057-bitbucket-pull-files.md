# ADR 0057: Bitbucket Cloud pull-request files and diffs

Use the native PR diffstat and diff redirects, with manual redirect handling confined to these two main-process reads. Accept only the fixed Cloud API origin, selected destination repository, pinned source/destination commit pair (including source-qualified fork revisions), topic=true, and an optional matching from_pullrequest_id. Reject credentials, fragments, duplicate or unrecognized query parameters, another repository/revision, and further redirects. Pagination reconstructs bounded requests locally instead of following response links.

The renderer sends full 40/64-character revisions and repository UUIDs, never a URL or token. Re-read repository-bound PR details before and after each operation. Abbreviated revisions and deleted source repositories remain readable as detail metadata but cannot open this comparison. Refreshed revisions clear the file selection and diff. This first implementation supports current topic comparisons; historical versions and other redirect formats are explicitly rejected rather than guessed.

Read at most 100 files per page and 100 pages; deduplicate displayed paths. Preserve native status, old/new paths and line counts. Fetch the selected patch on demand after checking membership on its claimed page. Transport responses are capped at 4 MiB; displayed patches at 262,144 characters with an explicit truncation indicator. Accept plain-text UTF-8 only; do not interpret returned HTML or download file links. Empty/binary patches have no invented text. Use existing cancellation, cooldown, encrypted account vault and bounded authenticated ETag cache.

Public references:

- https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/ (PR diff/diffstat redirects)
- https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commits/ (source-first comparisons, topic diffs, path filtering, diffstat)
- https://support.atlassian.com/bitbucket-cloud/kb/find-list-of-changed-files-within-a-pull-request/ (repository-qualified comparison URLs)

Verification uses ProviderService with MSW, strict main-only IPC contracts and real Electron UI fixtures. These fixtures do not establish live account or every historical Bitbucket redirect-format compatibility.
