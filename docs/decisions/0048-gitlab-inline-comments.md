# GitLab inline comments

Date: 2026-11-02

## Decision

Single-line text discussions use GitLab's native three-SHA diff position. The request retains both old and new paths, including renames. Removed lines carry only an old line number, added lines only a new number, and unchanged context carries both numbers. Displayed patch rows and file line numbers remain distinct.

A portable unified-hunk parser is shared by the renderer and main process. It maps complete hunks, including zero-count ranges, later hunks, CRLF and no-final-newline markers. Hunk counts must match; overlapping, overflowing or malformed ranges yield no writable locations. Headers and no-newline markers are never comment targets. This parser is exposed alongside the provider contract and imports no native Git or Node code.

The file's source page is a bounded lookup hint, not authority. Review resolves the account/project/merge request, revalidates all three diff SHAs before and after reading that page, refuses duplicate or mismatched file paths, and verifies that the exact selected coordinate pair exists. Omitted, collapsed, oversized or locally truncated patches cannot create new inline comments. It also rechecks merge-request metadata after the file read. Preview displays the current selected text and native position, and binds the entire normalized file and action into the review revision. Confirmation repeats these checks before one POST. Freshness checks do not make the paged diffs API atomic; the posted position itself remains pinned to its three SHAs.

Gitbeaker sends the position as multipart fields. Absent old/new sides are omitted, never sent as zero or null. The response must identify the selected merge request and exactly acknowledge the paths, three SHAs, text coordinates and lack of a multiline range. A misplaced or malformed acknowledgment is uncertain and never triggers an automatic retry. GitLab may normalize note text, so response text remains authoritative for display.

The existing discussion composer provides preview/confirmation, draft retention and read-only inspection after uncertainty. Review and result notes reuse the virtualized discussion viewer. Inline posting does not change a local repository.

## Verification and remaining scope

ProviderService/MSW fixtures assert exact multipart fields for removed, added, context and later-hunk lines; source-page lookup; rename paths; fresh SHA/patch guards; complete-hunk validation; ambiguity refusal; and uncertain misplaced acknowledgments. Strict IPC keeps these writes out of the Git utility service. Electron acceptance selects removed, added, context and later-hunk rows, reviews a first-page file after loading page two, checks the exact multipart write, preserves a draft when the target SHA changes, refuses no-newline markers as targets and inspects an uncertain posted comment without a duplicate write.

Multiline, file-level and image-position creation, suggestions, editing/deletion, historical-version selection, approval reviews and durable drafts remain separate work. Live GitLab posting is unverified.

## Public references

- [GitLab Discussions API](https://docs.gitlab.com/api/discussions/)
- [Git patch format](https://git-scm.com/docs/diff-format)
