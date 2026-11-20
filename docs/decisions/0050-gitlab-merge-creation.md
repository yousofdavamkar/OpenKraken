# GitLab merge-request creation and templates

Date: 2026-11-02

## Decision

Creation supports already-pushed branches in the same project or a fork, including nested namespaces and branch names. A separate GitLab review contract binds the authenticated account, origin, complete draft, exact numeric source/target project identities, archive state and both branch tips. Confirmation clears cached reads and repeats the preview; changes require another review. Equal tips, identical same-project branches and archived projects are refused. The provider remains authoritative about fork relationships, permissions and duplicate merge requests.

GitLab receives a single POST at the source project's merge-request endpoint with an explicit target project ID. The submitted title includes the draft prefix when requested; the review displays that exact title. A ready-for-review draft cannot carry a draft/WIP prefix. Maintainer collaboration is explicit. Source deletion is explicitly false; squash and other merge-time policy use GitLab's project defaults and require a later merge review.

GitLab creation has no conditional source/target SHA parameters. The final read and creation are not atomic. Acknowledgments validate project IDs, branch names, title, description, state, draft flag, collaboration and any populated source SHA. Null source SHA and unprepared diff fields are allowed for new requests. The API does not acknowledge the exact target branch tip; a concurrent update between preflight and creation remains possible. Only a completed 201 response is accepted, and all malformed or ambiguous acknowledgments and failures after dispatch remain uncertain. No automatic creation retry is made.

## Templates

Use GitLab's native project template API for project and inherited merge-request templates. Read at most 100 entries and expose at most 50, with an explicit limit indicator. Distinct bounded template keys are URL-encoded; path separators, dot segments and control characters are refused. Names and descriptions remain literal text.

The listing review binds the canonical project identity, origin, default branch and returned template entries. Preview revalidates the listing and selected key before loading at most 65,536 characters. It validates the returned name against the selected key/name. The API resolves inherited template precedence; duplicate ambiguous keys are refused. Unlike GitHub's pinned Git blobs, this API returns current template content. The UI says so, displays a preview, and requires a separate action to replace the description. Creation then binds the actual description text, independent of later template changes. A template error does not prevent manually writing a description.

## Desktop behavior and verification

The shared creation composer uses provider-specific IPC and labels. Reviewed fields are disabled until editing resumes. Changed branches preserve the draft, successful creation refreshes the list, and an uncertain result offers bounded read-only list inspection followed by an explicit return to the draft. Closing an unsent draft requires keep/discard; cancellation retires pending requests and does not close the parent browser. The composer now supports [recovery across restart](0129-pull-creation-drafts.md).

ProviderService/MSW tests cover self-managed fork endpoints, same-project creation, exact native payloads, project/tip/draft changes, archive/equal-tip refusal, asynchronous empty fields, rejected and uncertain results, cancellation before/after dispatch, template limits, malformed selections and stale listings. Strict IPC separates these operations from the private Git service. Electron acceptance exercises template preview/replacement, frozen review, changed-commit refusal, preserved text, exact fork creation, uncertain-result inspection, cancellation and draft discard alongside the existing GitHub creation flow.

Live GitLab writes, inherited-template behavior on a live server and server-specific permission configurations remain unverified. Rule administration and branch creation/suggestions remain separate work.

## Public references

- [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/#create-a-merge-request)
- [GitLab branches API](https://docs.gitlab.com/api/branches/#retrieve-a-repository-branch)
- [GitLab project templates API](https://docs.gitlab.com/api/project_templates/)
