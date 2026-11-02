# 0059 — Context-aware command palette

## Decision

The renderer owns a typed catalogue of command IDs and labels, grouped by domain. Each registered command delegates to its mounted action button. This preserves the existing disabled conditions, captured selection, review dialogs, and mutation handling. A missing or disabled button makes the command unavailable; execution checks again immediately before dispatch. Modal dialogs suppress palette shortcuts and command dispatch.

Ctrl/Cmd+P opens the palette, matching blueprint §6. Search uses fuzzysort over labels and aliases. Relevance is grouped into deterministic hundredth-score buckets, then ordered by frecency and label. Empty searches use frecency directly. Usage weights decay with a fourteen-day half-life and increment on invocation, not successful completion. Only known command IDs, bounded weights, and timestamps are persisted locally; no search text or repository information is stored. Invalid usage data is ignored.

The palette keeps focus in its search combobox, exposes a listbox and active descendant, supports arrow/Home/End navigation and Enter, and restores focus on dismissal. Category filtering narrows the domain. Unavailable actions remain discoverable and explain why they cannot run in the current context.

## Scope

The initial catalogue covers existing repository, reference creation, history integration, working-tree undo/redo/stashes, and provider controls. Dynamic branch/file search, customizable keymaps, and native accelerators are subsequent work. No arbitrary command or shell expression is evaluated.

## Evidence

The real Electron test exercises unavailable commands without a repository, category-filtered fuzzy search, dispatch into the existing clone dialog, modal suppression, persisted ranking across a complete restart, and Escape focus restoration.
