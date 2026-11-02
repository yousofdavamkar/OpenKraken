# GitLab merge-request browsing and native detail data

Date: 2026-11-02

## Decision

GitLab merge requests share the bounded, virtualized request list with GitHub pull requests. Repository selection carries the account's provider type explicitly, including for self-managed hosts. GitLab exposes separate Open, Closed, Merged, Locked and All filters. Closed does not include merged requests. The GitHub filters retain their existing behavior, and its adapter rejects GitLab-only filters.

Each read revalidates the protected account, resolves the exact full project path to a numeric project ID, and then reads the project-scoped merge-request endpoint. Both `project_id` and `target_project_id` must match that resolved project; detail `iid` must match the selected local number. Provider-supplied web and pagination URLs are ignored. Display URLs are constructed from the configured HTTPS origin and validated namespace/project/local number.

Gitbeaker uses explicit offset pages of 100 records, `scope=all`, descending update order and one HTTP dispatch per SDK operation. All-state reads omit `state`, using GitLab's documented default; the SDK type only models explicit state filters. Other filters must match every returned row. Pages are capped at 100 (10,000 loaded records), and a full final page reports the limit. Pagination can require an extra empty read. Pages append and deduplicate by local number; search covers loaded results and keyboard selection remains virtualized. Scheduled refresh re-reads every loaded page and the selected detail through the existing complete-batch polling coordinator.

## Detail model

GitLab details use a separate typed `providerMergeRequest` request/result. They do not fabricate the GitHub model's commit, file, addition or deletion statistics. `changes_count` is preserved as an exact or lower-bound count, or unavailable while preparing. Empty/null diff references are unavailable; partial or malformed references are rejected. The merge base, source head and target head at the diff version remain distinct. The current source SHA is retained separately, so a new source tip does not silently replace a diff revision. A deleted source project remains null.

The UI displays the native merge status, rather than interpreting `has_conflicts=false` as permission or readiness to merge. It shows preparing diffs and unavailable counts explicitly, retains full source/target revisions, renders descriptions as literal text and provides cancellable refresh/retry. The GitLab detail panel does not expose GitHub-specific review, creation or merge controls.

The transport retains the existing isolated partition, cookie omission, TLS verification, redirect refusal, per-call endpoint checks, response size limits, cancellation, conditional cache and main-enforced server cooldowns. No renderer result carries tokens or response headers. Provider reads remain outside the Git utility-service contract.

## Evidence and remaining scope

ProviderService/MSW tests exercise project binding, namespace encoding, local numbers, manual pages, native states, bounds, missing/approximate metadata, malformed revisions, cancellation and sanitized errors. Typed IPC tests reject traversal selectors and private credential fields. Electron acceptance exercises real main/preload/UI routing, append/deduplication, search, keyboard navigation, native filters, literal descriptions, pending diffs, scheduled refresh of loaded pages and selected details, retry and cancellation on close. Existing GitHub browsing remains covered separately.

This is a browsing slice. GitLab files, discussions, review actions, creation/templates, merging, pipelines and issues remain further integration work. Live GitLab and actual OS keychain acceptance remain unverified.

## Public references

- [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/)
- [GitLab merge-request diff versions](https://docs.gitlab.com/user/project/merge_requests/versions/)
