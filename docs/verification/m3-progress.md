# M3 progress — branching and remotes

M3 is in progress. M0–M2 are complete; M4–M8 remain pending.

Implemented and exercised against real Git and Electron:

- Branch creation, checkout, rename, deletion and upstream settings, with guarded Undo.
- Local lightweight/annotated/signed tags and reviewed deletion.
- Remote add/rename/URL edits/removal, stale-review checks and credential masking.
- Manual fetch and opt-in 5/15/30-minute automatic fetch, cancellation and enforced TLS verification.
- Reviewed branch/tag push, separate push URLs, upstream setup and explicit force-with-lease.
- Stash listing and creation: selected literal paths, optional untracked files and staged-only mode; workspace Undo retains the stash.
- Stash apply/pop with optional staged-state restoration, conflicted-pop preservation, reviewed drop and message editing.
- Clone with shallow history, a branch/tag, on-demand blobs and sparse directories; bounded transport progress and cancellation.

Remaining for M3: pull preferences/integration, the per-session HTTPS/SSH prompting bridge, and the complete local-bare plus Gitea HTTPS/SSH acceptance suite. Native credential helpers and SSH agents already run through Git; the desktop prompt bridge is not implemented yet. Remote deletion of server branches/tags also remains beyond the implemented local deletion flow. The current push dialog requires a single push URL per remote.

Latest full regression after clone: 120 Vitest tests passed, 23 Electron tests passed and the dedicated large-repository benchmark was skipped. Type checking, lint and build passed. The graph suite measured 287.6 ms first paint, 210.6 ms for a 5,000-commit page, and 16.7 ms p95 scrolling on this Linux run. These are local results, not macOS/Windows verification.

Decisions and detailed limits: [reference actions](../decisions/0013-reference-actions.md), [remotes/transports](../decisions/0014-remotes-and-transports.md), [stashes](../decisions/0015-stashes.md), [clone](../decisions/0016-clone.md).
