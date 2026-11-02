# ADR 0052: GitLab merge-request pipelines and jobs

GitLab's merge-request pipeline list includes historical and merged-result pipelines. Display native statuses and each pipeline's commit; do not manufacture an aggregate pass/fail result or label every different SHA as obsolete.

Read pipelines and ordinary jobs in explicit pages of 100, capped at ten pages each. Job reads first revalidate pipeline membership on its selected merge-request page and pin its ID and SHA. Before and after reads, verify the merge-request identity, source/target projects and branches, and source SHA. Pipeline detail and every job must agree on pipeline identity, project, SHA and ref. Provider status can legitimately change during reads.

Minimal pipeline-list responses can omit project ID. Resolve details only within the merge request's target and source projects, falling back only after an explicit HTTP 404. Authorization, network and malformed-response errors never trigger discovery. Explicit project IDs must match one of those projects. Construct displayed URLs from the configured origin and the validated numeric project's namespace, ignoring provider-supplied URLs.

The renderer receives strict typed read contracts without credentials. Main handles them outside the Git utility process. Transport bounds, cancellation, conditional caching and provider cooldowns remain shared with the other GitLab reads.

Ordinary jobs exclude retried attempts. Trigger/bridge jobs, downstream traversal, logs, artifacts, job actions, and pipeline creation are separate capabilities, not implied by this view.

Public references: https://docs.gitlab.com/api/merge_requests/#list-merge-request-pipelines, https://docs.gitlab.com/api/pipelines/, https://docs.gitlab.com/api/jobs/#list-all-jobs-by-pipeline.
