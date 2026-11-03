# 0103 — Bounded commit reference previews

## Context

Linear badge grouping alone does not bound graph rendering. A full Linux-history fixture with 50,000 refs on one commit took 15,290.5 ms to first paint because the visible row rendered every badge. A single grouped branch badge can also contain thousands of canonical remote names in its tooltip. The blueprint does not prescribe an overflow interaction for either case.

## Decision

Show at most three badge previews per commit. If there are more badges, or any grouped badge has more than three full names, add a button with the total number of references. Preview tooltips contain at most three full names plus the remaining count. Small rows keep their existing badge presentation. Preserve every name and the existing grouping order, local/remote combination and annotated-tag target behavior.

The button opens a native modal dialog outside the virtualized graph rows. It lists all canonical names associated with that commit in the current graph view, with a trimmed, locale-aware case-insensitive filter. Hidden/solo graph-view rules continue to determine the input; this is not a second unfiltered repository-wide ref browser. Reference operations remain in the sidebar.

Virtualize the list with fixed 32-pixel rows and six overscan rows. Expose the list name, total matching count and each mounted item's position and set size. Make the scroll container focusable for native keyboard scrolling. Full names remain selectable text, with horizontal scrolling when necessary. Only mounted items enter the accessibility tree; filtering is the way to directly reach names outside the rendered range.

Opening the dialog must not change graph selection or open commit details. Focus starts in the filter. Escape and Close restore focus to the opener when it is still mounted, otherwise to the graph viewport. The dialog survives scrolling its originating row away, reflects same-repository ref refreshes, and closes when the repository changes. Explicitly close the native dialog before restoring focus.

## Verification and limits

Desktop regressions cover bounded previews/list items, merged remote names, peeled tags, Unicode filtering, whitespace reset, no matches, Home/End scrolling, external deletion, offscreen lifecycle and focus restoration. A second case covers overflow caused by one grouped badge even when the total badge count is only three. Existing small-repository graph goldens remain unchanged.

The full snapshot still contains every ref. This change bounds DOM and tooltip construction; it does not make snapshot enumeration, validation, transfer or filtering independent of ref count. The unchanged 500 ms desktop first-paint gate and raw measurements are recorded in the [performance report](../verification/m8-reference-performance.md). Passing the interaction regressions does not establish that performance gate or cross-platform acceptance.
