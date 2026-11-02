# ADR 0053: GitLab issues and issue notes

Use GitLab's project issue and issue-note REST APIs through the existing bounded Gitbeaker transport. Resolve a nested repository path to an exact numeric project before reads, verify issue project/global/local identities, and construct display URLs from the configured origin and validated repository. Provider-supplied links, user avatars and raw error bodies do not cross the boundary.

The shared issue contracts accept a strict GitLab variant alongside the existing GitHub shape. Preserve confidentiality, native issue type, nullable discussion-lock metadata, due date and weight; do not invent a GitHub state reason. Notes retain system/activity status, internal/confidential flags and native note type. Missing optional note flags remain unknown. The note list is chronological and includes system notes; its count can differ from the provider's user-note count. It is a flat note view, not a reconstructed discussion-thread tree.

Pages use 100 results and manual continuation, capped at 100 issue/API note pages. The desktop's existing note display cap is ten pages (1,000 notes). Reject duplicate identities, wrong filters, malformed/oversized values and foreign notes. Notes bind to the selected issue's global ID, local IID and project, with pre/post identity and confidentiality checks. Title edits and new notes alone do not invalidate a read.

The issue panel shares virtualized lists, keyboard navigation, loaded-result search and optional scheduled refresh. Native GitLab issue writes require a separate reviewed implementation; they must not fall through to GitHub writes.

References: https://docs.gitlab.com/api/issues/ and https://docs.gitlab.com/api/notes/.
