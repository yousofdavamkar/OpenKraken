# M7 progress — productivity and polish

M7 is in progress as of 2026-11-02 at implementation checkpoint `79085c2`. M6 continues to have the gaps recorded in [M6 progress](m6-progress.md); M7 and M8 are not complete. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Implemented

- A typed command catalogue groups repository, references, history, working-tree, provider, and settings actions by domain. The palette opens with Ctrl/Cmd+P, fuzzy-searches labels and aliases with fuzzysort, filters categories, supports keyboard navigation, and persists bounded frequency/recency weights locally.
- Commands use existing mounted controls and their enabled conditions. Missing or disabled controls stay discoverable but cannot execute. Dispatch checks availability again and uses existing review dialogs and action handlers. The catalogue does not introduce new Git or provider write paths.
- Palette dismissal restores prior focus; an invoked action owns subsequent focus. Input composition and repeated Enter cannot execute commands. Open dialogs suppress global command shortcuts.
- A JSON keymap editor validates known command IDs, version/schema/size, shortcut syntax, reserved keys, and collisions with inherited defaults on both macOS and Windows/Linux. Explicit null unbinds. Apply persists before activating the map; invalid saved data falls back to defaults and stays available for repair. Restore defaults edits the draft before Apply.
- Commit search is part of the catalogue, with overridable Mod+F. Its previous hard-coded global handler is removed. Action shortcuts pause in text editors; opening the palette and focusing commit search remain available outside dialogs.
- Assigned bindings appear in palette rows, button tooltips, and the keymap editor's active shortcut table. No query, repository path, token, arbitrary code, selector, or shell command is stored or executed by the keymap.

## Verification

At this checkpoint, the six targeted real Electron tests pass. They cover unavailable commands, fuzzy category search, existing-dialog dispatch and modal suppression, ranking across restart, keymap validation and persistence, corrupt-preference repair, keyboard option navigation, repository availability updates, cancellation without ref changes, typing context, commit-search remapping, focus transfer, and composing/repeated Enter.

`pnpm test`: 504 tests passed across 67 files. `pnpm build` (including TypeScript project checking), full ESLint, and repository Prettier checks passed. The full desktop suite with Gitea enabled passed: **98 passed, 1 skipped** (the separately invoked real-repository benchmark), exit 0. Linux packaging and fuse verification also passed. The packaged ASAR smoke check passed: renderer isolation and native askpass/editor helpers with hardened fuses.

Observed Linux performance: 2,000-commit first paint **247.9 ms**; 5,000-commit page including layout/UI **172.0 ms**; 12k-row scrolling frame p95 **16.7 ms**; 50k-line comparison **539.4 ms**; 10k-line blame first screen **141.1 ms**. These are fixture measurements on this host, not cross-platform evidence.

Logs: `/tmp/openkraken-m7-{commands,full-unit,lint,build,full-e2e,package,smoke}.log`.

## Remaining M7 scope

- Main-owned atomic settings persistence for command preferences (blueprint §5); the current renderer-local persistence is an interim step.
- Native menu accelerators and broader command coverage, including dynamic branch/file domains and contextual commands. Renderer shortcuts are implemented; this is not an Atom selector keymap interpreter.
- Theme tokens, light/dark/system selection, and validated user JSON themes.
- Integrated xterm terminal, PTY utility host, and OSC 133 integration.
- Worktree/submodule UI and LFS awareness.
- Onboarding, activity log, toasts, a complete accessibility pass, and i18n scaffolding.
- Optional git-flow and consent-gated BYO-key AI remain optional, not implemented.

Cross-platform keyboard execution and packaging remain unverified on macOS/Windows. M8 release requirements (signed updates/installers, opt-in crash reporting, security review, beta evidence, and broader regression gates) remain open. Existing Linux security/package checks do not establish release completion.

## Decisions

- [0059 — Context-aware command palette](../decisions/0059-command-palette.md)
- [0060 — Validated renderer keymaps](../decisions/0060-json-keybindings.md)
