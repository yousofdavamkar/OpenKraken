# 0094 — Bounded reference sidebar

A 50,000-reference Linux history fixture exposed an eager sidebar: all 50,000 reference controls mounted together, even though the commit grid was already virtualized. First paint took 8.73 seconds, renderer working set reached about 2.63 GiB and scrolling p95 reached 166.7 ms. Paging also exceeded its existing budget.

Use the existing TanStack virtualizer for repositories with at least 100 references. Keep the existing grouped layout for smaller repositories. Measure variable-height rows, retain group headings and render a small overscan. A case-insensitive reference-name filter makes every reference reachable without mounting every action. Retain a focused row outside the visible range so scrolling cannot discard its active action dialog. Keep the existing reference actions, graph controls and drag handlers.

This bounds mounted UI, not reference data: the full authoritative snapshot and all history roots remain intact. The filtered list still scans the reference array when its query or snapshot changes. The backend still enumerates every reference, including its existing metadata. Do not relax first-paint or paging budgets to accommodate that cost.

Extend the opt-in repository benchmark with reference count, mounted reference count and first-paint phase timings. Service time includes opening, observer initialization, snapshot work and transport; the separately reported snapshot duration is a subset, not an additional phase. Preserve failed measurements alongside passing samples. Native Git enumeration remains the main measured startup cost for the large-reference fixture; the sidebar correction alone does not close that gate.

See the [performance report](../verification/m8-reference-performance.md) for the dataset, measurements, reproduction and remaining limits.

## Measuring several refs together

The virtualizer measures up to four adjacent refs from one section together. The first block in a section includes its heading. A transparent CSS grid item spans each mounted block so the browser reports its total height, including wrapped controls and inline errors. A spacer covers skipped blocks when scrolling or retaining a focused action. Each reference remains a separately keyed list item with its own position in the filtered result. Keeping those items under one parent lets React preserve a focused control when newly inserted refs shift it into a different block.

The desktop regression resizes the last ref in a block and checks that the next ref stays adjacent. It opens a rename dialog there, inserts an earlier branch through Git, and checks that the original draft and input focus survive the watcher's refresh. [Measurements](../verification/m8-reference-performance.md#reference-sidebar-measurements-and-commit-badge-grouping)

## Indexing reference sections

Index each contiguous run of a reference kind by its start and end in the snapshot. For a nonempty filter, index the matching names in their original order. Arrange the runs in sidebar section order, keep the heading on the first run of each kind and carry the list position across run boundaries. A binary search locates the range containing a virtual block. This avoids copying every group of four refs on open and keeps distinct namespaces under a single “Other refs” heading. [Memory and timing measurements](../verification/m8-reference-performance.md#retained-memory-in-a-50000-ref-sidebar)

## Keeping a review open across layout changes

A repository with 99 references uses grouped sections. Adding a branch switches it to the virtualized list at 100. The old row-owned rename dialog unmounted during that switch and discarded its draft. The sidebar now owns its reference review for the lifetime of the open repository. Keep the originally reviewed object ID for submission, retain the reviewed row while virtualized and restore keyboard focus to the current action button on cancellation. Removing the reviewed ref dismisses its dialog. Creating another ref with the same name starts a fresh review.

A desktop test adds and removes a real branch while the rename field is focused, checks the typed name in both layouts, and submits the rename through Git. It also cancels after the opening button has been replaced and removes a branch while its review is open.
