# 0102 — Linear reference grouping and on-demand sidebar focus lookup

## Context

A renderer CPU profile on the 50,000-ref fixture attributed roughly 56 ms of self time to sidebar row construction/filtering and 26 ms to badge grouping. The sidebar normalized every ref name even with an empty query and built a complete name-to-row map before any row was focused.

Badge grouping also searched the existing badge array for every ref sharing a target. A regression with 50,000 distinct branch labels at one commit measured **8,438.9 ms** in that function. This is an algorithmic problem separate from the existing fixture, whose refs point to distinct recent commits.

## Decision

Group sidebar refs in one pass into the same fixed kind buckets. Skip per-name case normalization for an empty/whitespace-only query. Preserve locale-aware case-insensitive filtering for nonempty input, native order within each kind, group headings, positions and total match counts. Find the currently focused ref's row only when a focus identity exists; retain the existing range rule that keeps its row and dialog mounted while offscreen. Do not prebuild a full focus index.

Index badge identities by kind and label within each target. Allocate this additional map only when a target receives a second ref, so distinct targets avoid thousands of unnecessary inner maps. Keep the ordered badge arrays for rendering and append full ref names to an existing badge. Local/remote branches still combine only when target and short branch name match; tags remain separate, and peeled tag targets are preserved.

The 50,000-collocated-ref regression checks all names/order and uses a generous one-second function-level guard to catch quadratic behavior. This guard does not replace the desktop's 500 ms first-paint budget. The native desktop sidebar test covers Unicode/ASCII case-insensitive queries, whitespace reset, accessible counts/positions, distant-ref keyboard activation, and a rename dialog surviving offscreen scrolling.

No ref, graph root or control is removed. This change fixes grouping computation; it does not establish acceptable rendering of 50,000 visible badges on a single row. The existing first-paint gate remains unchanged and failing. Raw application measurements, rather than isolated helper timings, determine overall startup performance.
