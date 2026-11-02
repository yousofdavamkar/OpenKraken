# M7 progress — productivity and polish

M7 is in progress as of 2026-11-02 at implementation checkpoint `f1f1667`. M6 continues to have the gaps recorded in [M6 progress](m6-progress.md); M7 and M8 are not complete. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Implemented

- A typed command catalogue groups repository, references, history, working-tree, provider, and settings actions by domain. The palette opens with Ctrl/Cmd+P, fuzzy-searches labels and aliases with fuzzysort, filters categories, supports keyboard navigation, and persists bounded frequency/recency weights in main-owned profile settings.
- Commands use existing mounted controls and their enabled conditions. Missing or disabled controls stay discoverable but cannot execute. Dispatch checks availability again and uses existing review dialogs and action handlers. The catalogue does not introduce new Git or provider write paths.
- Palette dismissal restores prior focus; an invoked action owns subsequent focus. Input composition and repeated Enter cannot execute commands. Open dialogs suppress global command shortcuts.
- A JSON keymap editor validates known command IDs, version/schema/size, shortcut syntax, reserved keys, and collisions with inherited defaults on both macOS and Windows/Linux. Explicit null unbinds. Apply persists before activating the map; invalid saved data falls back to defaults and stays available for repair. Restore defaults edits the draft before Apply.
- Native command menus and accelerators use the shared catalogue and saved keymap. Sender-validated context updates mirror availability; modal, revision and typing checks run again before existing actions execute. Native input suppresses repeat/composition, and reload restores context without retaining stale enabled commands.
- Main-owned atomic `settings.json` persistence includes one-time legacy migration, revision-checked keymap saves, serialized usage updates, failed-write retention, and explicit backup repair of damaged settings.
- Commit search is part of the catalogue, with overridable Mod+F. Its previous hard-coded global handler is removed. Action shortcuts pause in text editors; opening the palette and focusing commit search remain available outside dialogs.
- Assigned bindings appear in palette rows, button tooltips, and the keymap editor's active shortcut table. No query, repository path, token, arbitrary code, selector, or shell command is stored or executed by the keymap.

## Verification

At this checkpoint, the thirteen targeted real Electron tests pass. They cover unavailable commands, fuzzy category search, existing-dialog dispatch and modal suppression, ranking across restart, keymap validation and persistence, corrupt-preference repair, keyboard option navigation, repository availability updates, cancellation without ref changes, typing context, commit-search remapping, focus transfer, and composing/repeated Enter. Native menu tests additionally cover assigned/unbound accelerators, menu availability and clicks, repeat suppression, single invocation and renderer reload. Settings tests cover persistence after clearing renderer storage, one-time migration, main-side conflict/stale-write rejection, reopening the latest revision, corrupt-file preservation/backup repair, and failed writes.

`pnpm test`: **506 tests passed across 67 files**. TypeScript project checking, build, full ESLint and repository Prettier checks passed. The thirteen targeted command/settings/menu tests pass. The corrected asynchronous avatar-preference test also passes three repeats.

**The latest full desktop run is not green:** 104 passed, one dedicated real-repository benchmark skipped, and one paging timing failure (340 ms against 300 ms), exit 1. Gitea was enabled. Linux packaging, fuse verification, and packaged ASAR smoke acceptance passed, including renderer isolation and native askpass/editor helpers. The initial full run exposed a graph shortcut test that used CDP input instead of native accelerator input; this was corrected without changing its assertions. Another run exposed an asynchronous checkbox assumption in the avatar test; the test now waits for the persisted checked state.

Performance acceptance is sensitive to host contention and has not been waived. During a load spike (18.1 load average on 12 logical CPUs), the 50k-line comparison missed its 1,000 ms limit. An isolated pre-menu baseline also missed that gate (1,216 ms), followed by passing repeats. A temporary native-build probe measured 647 ms end to end, 501 ms click to paint and 12 ms renderer JavaScript. A later full run passed the diff gate but missed the 300 ms blame gate; three isolated blame repeats passed at 166, 138 and 139 ms. The temporary probe and baseline worktree were removed. Production timing limits and diff/blame code remain unchanged. The final full run passed first paint (257 ms), large comparison (616 ms), and blame (127 ms), but paging failed. Three isolated paging repeats also failed at 432, 511 and 342 ms. Their response stages took 216–283 ms, worker stages 86–138 ms, and UI updates 40–90 ms. Paging performance remains unresolved; contention is evidence to investigate, not proof that the code is free of a regression. A clean regression result is required before claiming all desktop checks pass.

Logs are retained under `/tmp/openkraken-command-{settings,menu,native}-*.log`, including all full-run failures, baseline comparison, probe, and isolated repeats. The paging follow-up should compare the pre-menu commit on the same host and inspect native menu-context update costs before changing production behavior or any budget.

## Remaining M7 scope

- Resolve the paging performance failure and establish a clean complete desktop regression run.

- Broader command coverage, including dynamic branch/file domains and contextual commands. Native accelerators are implemented; this is not an Atom selector keymap interpreter. Other older preferences (for example graph view settings) still need consolidation into the main settings store.
- Theme tokens, light/dark/system selection, and validated user JSON themes.
- Integrated xterm terminal, PTY utility host, and OSC 133 integration.
- Worktree/submodule UI and LFS awareness.
- Onboarding, activity log, toasts, a complete accessibility pass, and i18n scaffolding.
- Optional git-flow and consent-gated BYO-key AI remain optional, not implemented.

Cross-platform keyboard execution and packaging remain unverified on macOS/Windows. M8 release requirements (signed updates/installers, opt-in crash reporting, security review, beta evidence, and broader regression gates) remain open. Existing Linux security/package checks do not establish release completion.

## Decisions

- [0059 — Context-aware command palette](../decisions/0059-command-palette.md)
- [0060 — Validated renderer keymaps](../decisions/0060-json-keybindings.md)

- [0061 — Main-owned atomic command preferences](../decisions/0061-main-command-preferences.md)
- [0062 — Native command menu and accelerators](../decisions/0062-native-command-accelerators.md)
