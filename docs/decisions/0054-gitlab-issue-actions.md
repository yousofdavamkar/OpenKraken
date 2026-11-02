# ADR 0054: Reviewed GitLab issue actions

Provide native issue creation, ordinary/internal note creation, and close/reopen through separate strict GitLab intent and confirmation contracts. Reuse the shared issue action dialog and result inspection. GitLab state changes use only `state_event`; they do not invent a GitHub closing reason. Creation explicitly sends issue type `issue` and the reviewed confidentiality flag. Note visibility is explicit.

Review binds configured origin, verified account identity, complete normalized intent, project identity/archive/issue-access metadata and the existing issue's full displayed snapshot. Confirmation reloads those values and rejects a changed review. Archived projects and known disabled issue access are refused. A locked conversation is displayed, not treated as proof that every member lacks permission; GitLab still enforces authorization. The API provides no atomic compare-and-set for these actions, so changes can still race after the final read.

GitLab executes quick actions in descriptions and comments. This plain-text workflow rejects lines beginning with slash-command syntax, including within fenced text, before dispatch. It does not silently rewrite content or execute extra state/visibility actions. Users can escape command-like text; a dedicated quick-action workflow is outside this slice.

Writes use the shared bounded transport, completed-status requirements, no implicit retry, cache invalidation, and rejection-versus-uncertainty handling. Creation acknowledgments must match title, description, state, project, issue type and confidentiality. Notes must match the reviewed issue identity, exact body, non-system status and requested visibility. State acknowledgments must match global/local issue identity, project, requested state and confidentiality. Missing, malformed, mismatched or interrupted acknowledgments after dispatch are uncertain, not successful.

The desktop freezes reviewed fields, preserves stale drafts, supports keep/discard and cancelled review, and offers read-only result inspection after uncertainty. Closing a successful or uncertain action refreshes the parent. These are session drafts; persistence and external-write crash recovery remain M8 work.

References: https://docs.gitlab.com/api/issues/, https://docs.gitlab.com/api/notes/, https://docs.gitlab.com/user/project/quick_actions/.
