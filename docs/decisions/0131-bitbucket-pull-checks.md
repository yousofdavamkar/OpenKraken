# Bitbucket Cloud pull-request build and merge checks

OpenKraken reads build statuses and merge checks on demand from the selected pull request. Both reads use the account’s existing pull-request read permission and the main process’s authenticated Bitbucket transport. The renderer receives typed fields and requests refreshes through IPC.

Build results use the numbered statuses endpoint with up to 100 rows per page and a 100-page cap. Each row shows the vendor’s key, state and available name, description, ref and update time. Viewers can navigate either direction and refresh the visible page. The app verifies the destination repository identity and the reviewed source before and after each read. Abbreviated revisions and missing source fields retain their provider representation.

Merge checks use the dedicated mergeability endpoint, which also considers the current user’s permissions. The app compares both source and destination endpoints before and after reading. It displays each check’s reported outcome, requirement and blocking flag independently. Empty lists and unknown results retain their meaning. A mismatch between the reported collection size and the number of returned entries produces an error. Bitbucket can evaluate additional conditions during a merge.

The two views participate in the existing automatic refresh session. Closing a view cancels obsolete reads. Fixture tests exercise both main-process adapters and the Electron review flow, including a changing destination, an advisory failure and a blocking Git conflict.

[Bitbucket pull request statuses](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-pullrequests-pull-request-id-statuses-get) · [Bitbucket mergeability checks](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-pullrequests-pull-request-id-mergeability-checks-get)
