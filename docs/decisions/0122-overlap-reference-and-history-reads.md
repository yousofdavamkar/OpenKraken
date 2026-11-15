# 0122. Start the first history page during reference enumeration

On cold opens of repositories with many packed refs, complete ref enumeration and the first 2,000 commits each account for a substantial part of the delay before the graph appears. Git can usually enumerate direct object IDs while it resolves types, upstreams and tracking information for the sidebar.

For an unfiltered initial snapshot, a packed-refs file of at least 512 KiB allows a native `git rev-parse --all` read for tentative object IDs. This size is a scheduling hint. Git supplies the IDs in its native ref order and includes loose refs. The utility deduplicates IDs in order, includes the opened HEAD and starts a bounded history cursor with replacements disabled. It requests one first page plus lookahead. If the full snapshot inputs arrive while the optional enumeration is still running, the utility cancels that enumeration. An 8 MiB output limit bounds the optional read.

The full ref records, peeled tags, graph view, worktree heads and stash overlays determine the published snapshot. The utility adopts the early cursor only when the complete ordered roots match, the history cache supplies no seed, and there are no stash overlays, replacement refs, shallow boundaries or grafts. A failed or mismatched walk is closed before the ordinary walk starts. A failed snapshot also closes any unpublished cursor. The adopted cursor continues at its existing offset for subsequent pages.

Filtered views, refreshes, known shallow repositories, explicit graft/shallow/replacement settings and existing disk prefixes use the ordinary path. A stale disk prefix can therefore suppress this optimization for one open. Loose-only repositories and repositories using an alternative ref backend can use the ordinary path regardless of ref count.

[Desktop scale measurements](../verification/m8-reference-performance.md#overlapping-reference-enumeration-and-history)
