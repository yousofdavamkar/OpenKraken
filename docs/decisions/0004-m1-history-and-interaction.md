# 0004 — M1 history, rendering, search and navigation

Accepted 2026-11-01. Implements the requested Canvas, paging, search and keyboard work from blueprint §§4.1–4.4 and the read-only interaction spec.

History uses one retained `rev-list --date-order --parents --stdin` per active repository, with immutable start OIDs and stdout backpressure at page boundaries. There is no `--skip`, increasing max-count, or refetch of earlier pages. A page is addressed by a random cursor ID and expected commit offset; concurrent/duplicate/stale pages fail explicitly. Refresh and repository switches close the previous cursor. Page cancellation terminates its process group and requires refresh. Idle time does not count toward the 30-second active page deadline. Streams retain at most one requested page plus an OS stdout chunk, with a 64 MiB retained-record cap; a 1 GiB total-output ceiling fails explicitly rather than silently truncating history. Initial pages contain 2,000 commits; subsequent requests allow up to 5,000.

Stash rows are inserted immediately above their base when that base arrives in the retained walk. This guarantees children precede parents despite timestamp skew and works across page boundaries without loading full history. Stash index/untracked parents remain hidden. Dirty/conflicted working state is represented as a synthetic row immediately above HEAD, with a first-parent edge to HEAD. These rows do not change Git page offsets.

The worker owns lane continuation, 500-row checkpoints and an incremental MiniSearch index. Layout replies are posted before deferred indexing so display is not held up by tokenization; any search request flushes pending documents first. Appends return only new graph rows; generation/offset checks reject stale work. Refresh resets the worker, using the spec's correct off-thread full-layout fallback; suffix checkpoint reuse is deferred until a larger refresh workload justifies it. The UI paints one viewport-sized, device-pixel-ratio-aware Canvas graph column and virtualizes DOM text cells at 28 px. Search dims edges/nodes and text without removing or moving rows.

Loaded-history search uses case-insensitive token-prefix AND matching across summary/body/author/email/OID. The explicit all-history search uses Git's literal, case-insensitive message/author matching, plus unambiguous hexadecimal object prefixes, capped at 100 results. Those results can open read-only details without forcing thousands of intervening rows into the graph. Search does not mutate the history cursor. Query and generation guards discard late responses. Git full-history literal matching and indexed token-prefix matching are labeled separately in the UI.

ArrowUp/Down move one row; Shift+Down follows the first parent and Shift+Up chooses the nearest loaded child. Home/End select the first/last loaded row. h selects HEAD, Shift+H its upstream. Ctrl/Cmd-click toggles selection; Shift-click selects a contiguous anchor range; Ctrl/Cmd+A selects loaded rows; Escape clears selection. Enter opens read-only details; diff views remain M5. Navigation can load more pages to reach a parent or HEAD without changing previously loaded graph rows. A focusable ARIA grid keeps the active row scrolled into view and exposes selected state. Ctrl/Cmd+F focuses search; search fields retain normal text-editing keys.

This delivery does not add hide/solo/pin, network avatars, tabs, or full M1 release certification on linux.git. Existing synthetic fixture and security checks remain required; new tests cover retained paging, stale/cancelled requests, worker/search state, Canvas geometry, interaction, and Electron rendering/performance.

Responses are validated once at the utility-to-main trust boundary with the shared Zod result schema. Main and preload then forward the typed result without additional parse-and-copy passes. Page arrays are frozen before a single store assignment, avoiding thousands of Immer proxy writes while preserving previous row identities.

If a normal branch reaches a stash object, its actual commit DAG takes precedence: it is displayed once as an ordinary merge, rather than adding a duplicate projected stash row. Standalone stash overlay rows still link only to their base. Duplicate reflog entries for the same stash OID produce one overlay node.

## Object ID lookup in the active graph

The history cursor retains the exact start OIDs selected when the graph opened. A hash lookup can return a captured tip directly after resolving it to a commit. For other resolved commits, subtract the ancestry of all captured tips from the queried commit's ancestry in one native revision walk. An empty result means the commit is visible in the open graph. Pass the resolved OID and all excluded OIDs on standard input and limit output to one commit. Commits made visible only by a new ref enter the search scope when the graph refreshes. Message and author matches still contribute to the same results. [Git revision-set semantics](https://git-scm.com/docs/git-rev-list#_description)

When an object ID resolves to a visible commit, put that commit first and fill the remaining results with text matches ordered by commit time. Deduplicate before applying the 100-result limit so an older commit can still be found when many newer messages cite its ID.

## Keyboard navigation across a page boundary

Down on the last loaded row selects the first appended row when more history exists. A jump can wait for the page already loading under the pointer or request another page if its target lies farther back. A newer navigation request, a changed selection, or a different snapshot cursor supersedes the pending jump. A failed or cancelled page that adds no rows ends the jump.
