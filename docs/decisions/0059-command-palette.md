# 0059 — Context-aware command palette

## Decision

The renderer owns a typed catalogue of command IDs and labels, grouped by domain. Each registered command delegates to its mounted action button. This preserves the existing disabled conditions, captured selection, review dialogs, and mutation handling. A missing or disabled button makes the command unavailable; execution checks again immediately before dispatch. Modal dialogs suppress palette shortcuts and command dispatch.

Ctrl/Cmd+P opens the palette, matching blueprint §6. Search uses fuzzysort over labels and aliases. Relevance is grouped into deterministic hundredth-score buckets, then ordered by frecency and label. Empty searches use frecency directly. Usage weights decay with a fourteen-day half-life and increment on invocation, not successful completion. Only known command IDs, bounded weights, and timestamps are persisted locally; no search text or repository information is stored. Invalid usage data is ignored.

The palette keeps focus in its search combobox, exposes a listbox and active descendant, supports arrow/Home/End navigation and Enter, and restores focus on dismissal. Category filtering narrows the domain. Unavailable actions remain discoverable and explain why they cannot run in the current context.

## Scope

The initial catalogue covers existing repository, reference creation, history integration, working-tree undo/redo/stashes, and provider controls. The palette also supports repository-specific branches and changed files. Customizable keymaps and native accelerators are described in ADRs 0060 and 0062. No arbitrary command or shell expression is evaluated.

## Evidence

The real Electron test exercises unavailable commands without a repository, category-filtered fuzzy search, dispatch into the existing clone dialog, modal suppression, persisted ranking across a complete restart, and Escape focus restoration.

## Repository results

The Branches category searches local and remote short names across the full snapshot. Choosing one applies the sidebar's solo graph view and focuses commit history. A full ref name can also be pasted into search. Each result exposes its full name as an accessible description, including when a local branch has the same short name as a remote branch. The Changed files category follows the working tree's live status. Each side of a partially staged file opens its own existing diff action, addressed by repository ID, side and the byte-preserving Git path.

Each category displays up to 50 matches and reports the total when there are more. The action checks its repository and target again when invoked. Repository-specific rows stay out of the native command catalogue, shortcut bindings and usage settings.
