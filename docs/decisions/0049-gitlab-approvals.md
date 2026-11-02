# GitLab merge-request approvals

Date: 2026-11-02

## Decision

Approval status uses the project-scoped `/approvals` resource. It preserves the provider's overall approval flag, current-account eligibility and recorded approval, approving users, optional required/remaining counts, password-requirement hint and unmet/invalid rule summaries. Community Edition omits several Enterprise fields; missing values remain unavailable. The app does not infer approval requirements from the number of approving users. These users may not satisfy any rule, and the provider's overall flag has edition-dependent semantics.

Every read validates the exact project and merge request before and after loading approval data. Any supplied global/local/project IDs must match. Approving users have distinct positive IDs, and the current account's presence must agree with `user_has_approved`. Arrays are bounded to 1,000 entries, rule IDs must be unique within their collection, and names/dates/counts are validated. No avatars, emails, arbitrary links or deprecated approver-group details enter the renderer.

Review binds the canonical origin, authenticated account ID, requested action, displayed source SHA and complete normalized snapshot. Confirmation clears cached reads and repeats the review. A changed head, approval, rule summary or merge-request state requires a new review. Approval requires an open merge request, current eligibility and no already-recorded approval; removal requires the current account to have an approval. Removal changes only that account's approval, never resets others.

Approval always sends the reviewed SHA as the provider's conditional `sha` parameter. GitLab has no corresponding SHA condition for unapproval; a change between its final check and dispatch remains possible. Responses must acknowledge the requested current-account state and any returned target IDs. One dispatch, bounded transport, cache invalidation, refusal of redirects and explicit uncertain-result handling are shared with discussion writes. No automatic retry follows a failed or uncertain write.

## Re-authentication

An approval password is an optional transient input only to the approval write. It never enters preview/read contracts, results, review hashes, profile persistence or the credential vault. A reported password requirement prevents dispatch when none was supplied. The response's deprecated password flag is treated as a hint, not a complete project authentication-policy API. Server validation remains authoritative. SAML-enforced re-authentication cannot be completed through the password API and must be performed on GitLab.

The desktop must clear the password after every submission attempt and on close, and offer read-only status inspection after an uncertain result. It must not equate an observed current state with proof that a particular request caused it.

## Evidence and remaining scope

ProviderService/MSW tests cover Community/Enterprise fields, self-managed endpoints, exact SHA/password delivery, own-approval removal, changed snapshots and heads, unavailable permissions, foreign targets, inconsistent users, duplicate/bounded data, sanitized refusal/uncertainty and cancellation without retries. Strict IPC rejects missing reviews, invalid heads, reset-all actions and passwords in reads or removals.

Rule administration and full per-rule eligibility configuration are not part of this workflow. Live GitLab writes and actual project SAML behavior remain unverified.

## Public reference

- [GitLab merge-request approvals API](https://docs.gitlab.com/api/merge_request_approvals/)
