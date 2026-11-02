# GitLab merge-request files and revision guards

Date: 2026-11-02

## Decision

GitLab changed files use the project-scoped merge-request diffs API through Gitbeaker. Each call explicitly fetches one offset page of at most 100 files. Pages append and deduplicate by new path; continuation is local, bounded to 30 pages/3,000 files, and never follows provider Link URLs. The UI always explains that GitLab's configured diff limits may omit files or patches, independently of the desktop's page limit.

The request includes all three displayed diff SHAs: merge base, source head and target start. Before fetching a file page, main revalidates the protected account and resolves and checks the selected project and merge request. It refuses missing/different diff references or a known source SHA ahead of the prepared diff. It repeats the project/detail checks after the file page and refuses any changed revisions or project identity. These are current-revision guards, not an atomic server snapshot: GitLab's paged diffs endpoint does not accept a revision selector. There is no claim that separate reads prevent a transient change and restoration between checks. Future reviewed writes must perform their own freshness and provider-condition checks.

A separate GitLab file contract preserves old/new paths and modes, added/removed/renamed/modified status, optional generated/collapsed/too-large flags and available text. Missing flags on older servers remain unknown, rather than being invented as false. GitLab does not supply the GitHub file model's blob SHA or line-count statistics here, so none are fabricated. Contradictory status flags and invalid metadata fail the whole page. File paths are display data and are never opened on disk by this panel.

The existing 4 MiB transport cap applies before decoding. Each patch is additionally capped at 262,144 characters for display with an explicit truncation flag. Null, missing and empty patch content display as unavailable text; this does not imply an unchanged file. The panel distinguishes provider-collapsed and provider-oversized patches, shows mode changes and previous paths, and renders text in a read-only, virtualized CodeMirror view without interpreting HTML.

## Desktop lifecycle

The Files section uses a virtualized list, keyboard navigation, append/deduplication, retry and manual refresh. A stale response clears files and selection and asks for a detail refresh. Changing sections or closing the panel cancels the active request. Scheduled refresh revalidates each loaded file page and preserves selection/scroll only within the same displayed revision. Detail refresh has higher priority; a changed source or any of the three diff SHAs resets the child file view before reading its new revision.

## Evidence and remaining scope

ProviderService/MSW tests cover page parameters, unsafe pagination links, rename/mode data, unavailable flags, patch truncation, page/metadata bounds, stale preflight and changes during a read. IPC tests require all three SHAs and bounded pages and keep these requests out of the Git utility-service contract. Electron acceptance covers literal read-only patches, all omission/truncation messages, paged keyboard selection, scheduled preservation/reset, stale clearing, error retry and cancellation.

GitLab inline discussions, review actions, creation/templates, merging, pipelines and issues remain further integration work. There is no new local Git write or provider write in this slice. Historical diff-version selection and fetching provider-collapsed patches are not yet exposed.

## Public references

- [GitLab merge-request diffs API](https://docs.gitlab.com/api/merge_requests/#list-merge-request-diffs)
- [GitLab diff limits](https://docs.gitlab.com/administration/diff_limits/)
