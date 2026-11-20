# Reviewed direct GitLab merging

Date: 2026-11-02

## Decision

GitLab uses project-configured `merge`, `rebase_merge` (semi-linear history) or `ff` strategies. It does not accept GitHub's per-request merge-method choice. The review displays the project strategy and its `never`, `always`, `default_on` or `default_off` squash setting, plus the provider's permission and detailed merge status. Optional pipeline, merge-after and discussion-policy metadata remain explicit; unavailable metadata is not fabricated.

The dialog uses the merge request’s squash setting until the user edits it. Refreshing preserves an edited choice while policy allows it. A required or forbidden squash setting takes effect immediately. If the project later allows a choice again, the dialog restores the user’s edit.

Read the exact canonical target project, native merge request, source branch and current target branch. Branch endpoints validate their names and commits. Re-read the merge request after branch reads to reject metadata changes during the snapshot. The current target tip is distinct from the target tip recorded in the historical diff. Review binds the authenticated account, origin, merge-request/project identity, normalized snapshot, both actual branch tips, squash/removal choices and exact optional commit messages. Confirmation clears cached reads and repeats this review. Changed state or options require another review.

Require an open, non-draft request, explicit current-user merge permission, matching source SHA, non-archived target and `mergeable` detailed status. Existing automatic merges and future merge-after dates are refused. Project squash requirements are enforced, and fast-forward merges cannot specify an inapplicable merge-commit message. GitLab remains authoritative for all protected-branch, approval, CI and other server rules; the client does not attempt to reproduce the server's eligibility engine.

A single PUT carries the reviewed source `sha`, explicit squash/removal choices and `auto_merge: false` plus the older `merge_when_pipeline_succeeds: false` parameter. Custom merge/squash messages are included only when explicitly chosen and applicable. This workflow never schedules an automatic merge or merge train. The server's source-SHA condition does not condition the target SHA, strategy or other policy: a change after the last check remains possible and is disclosed in confirmation.

## Source branch removal

Removal defaults off and requires an explicit selection. The snapshot records both native removal flags. If the merge request is already configured to remove the source (`force_remove_source_branch`), the user must acknowledge removal here or change that setting on GitLab. This is a conservative client rule, not a claim that the flag is an administrator policy. Removing a default or protected source branch is refused by this workflow. A successful merge does not prove that asynchronous branch removal finished; the result says removal was requested rather than claiming the branch was deleted.

## Results and recovery

The desktop saves edited merge options and both message fields locally. After an interrupted submission, the recovered draft offers a status check. [Merge draft recovery](0130-provider-merge-drafts.md)

Only HTTP 200 with a validated, merged acknowledgment is completion. Validate global/local/project identity, source and target branches, reviewed source SHA, selected squash mode and merged timestamp. A still-open or scheduled response, foreign identity, malformed body or ambiguous transport failure is uncertain. Fast-forward or other responses may omit result commit hashes; these remain unavailable rather than being inferred. Known provider rejection statuses are distinct from uncertain outcomes, and writes are never automatically repeated.

The desktop freezes reviewed choices and messages, retains them after stale/error/cancelled attempts, and offers keep/discard when leaving unsent edits. Uncertainty permits only read-only merge-request inspection before an explicit return to review. Inspection works even if the source branch was removed. Observed state is not proof of which request caused it. Closing after success or uncertainty refreshes the parent list. Closed-request buttons are disabled without unmounting an existing dialog during a background state change.

## Verification and scope

ProviderService/MSW coverage includes self-managed SHA-conditional merging, current target tips, project/message/branch changes, permissions, drafts, automatic-merge and time gates, squash rules, protected/default-source constraints, native strategy handling, absent result hashes, foreign/inconsistent reads, refusal versus uncertainty and cancellation before/after dispatch without retrying. Strict IPC requires a review, validates message applicability and rejects automatic-merge or arbitrary method fields.

Electron coverage exercises actual-tip and policy display, frozen messages, changed-target refusal, cancellation, keep-editing, exact conditional payloads, uncertain-result inspection without another PUT, successful merge and list refresh. Live GitLab merges, server-specific rules and actual remote source-branch removal remain unverified. Automatic merging, merge trains and merge queues need separate reviewed workflows.

## Public references

- [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request)
- [GitLab project settings API](https://docs.gitlab.com/api/projects/)
- [GitLab branches API](https://docs.gitlab.com/api/branches/)
