# 0135 — Resizable history columns

Parity row 2.14 requires adjustable commit history columns whose widths persist per repository. The Branch / tag, Commit, Author and Date columns now have resize handles. The graph keeps its lane-derived width, and the commit message takes the remaining space, with a 160 px minimum.

Each handle is a focusable vertical separator that reports its current, minimum and maximum width. You can drag it with the pointer, or move it 10 px with the arrow keys (50 px with Shift). Home or a double-click restores the default. Widths are clamped to fixed bounds: Branch / tag 60–480 px, Commit 56–240 px, Author 60–480 px and Date 60–320 px.

Widths are saved under `openkraken.history-columns.v1.<repository id>` in the renderer's local storage, the same way the per-repository automatic fetch interval is stored. Only widths that differ from the defaults are written. Each saved value is validated and clamped when read, so a missing or damaged entry falls back to the default widths, and a failed write leaves the current session's widths in place. These widths are layout preferences only; they hold no repository content.

The defaults reproduce the previous fixed layout, so the existing Canvas goldens are unchanged.

## Limits

- Columns cannot be reordered or hidden.
- The widths are not part of the main-process settings store; consolidating renderer preferences remains M7 work.
- Verified on Linux x64 only.
