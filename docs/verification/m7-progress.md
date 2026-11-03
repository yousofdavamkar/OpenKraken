# M7 progress — productivity and polish

M7 is in progress as of 2026-11-02 at implementation checkpoint `3287fc4`. M6 continues to have the gaps recorded in [M6 progress](m6-progress.md); M7 and M8 are not complete. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Implemented

- A typed command catalogue groups repository, references, history, working-tree, provider, and settings actions by domain. The palette opens with Ctrl/Cmd+P, fuzzy-searches labels and aliases with fuzzysort, filters categories, supports keyboard navigation, and persists bounded frequency/recency weights in main-owned profile settings.
- Commands use existing mounted controls and their enabled conditions. Missing or disabled controls stay discoverable but cannot execute. Dispatch checks availability again and uses existing review dialogs and action handlers. The catalogue does not introduce new Git or provider write paths.
- Palette dismissal restores prior focus; an invoked action owns subsequent focus. Input composition and repeated Enter cannot execute commands. Open dialogs suppress global command shortcuts.
- A JSON keymap editor validates known command IDs, version/schema/size, shortcut syntax, reserved keys, and collisions with inherited defaults on both macOS and Windows/Linux. Explicit null unbinds. Apply persists before activating the map; invalid saved data falls back to defaults and stays available for repair. Restore defaults edits the draft before Apply.
- Native command menus and accelerators use the shared catalogue and saved keymap. Sender-validated context updates mirror availability; modal, revision and typing checks run again before existing actions execute. Native input suppresses repeat/composition, and reload restores context without retaining stale enabled commands.
- Main-owned atomic `settings.json` persistence includes one-time legacy migration, revision-checked keymap saves, serialized usage updates, failed-write retention, and explicit backup repair of damaged settings. Reader and writer byte limits also accommodate maximally escaped legacy keymaps, preserving repair across restart.
- Commit search is part of the catalogue, with overridable Mod+F. Its previous hard-coded global handler is removed. Action shortcuts pause in text editors; opening the palette and focusing commit search remain available outside dialogs.
- Assigned bindings appear in palette rows, button tooltips, and the keymap editor's active shortcut table. No query, repository path, token, arbitrary code, selector, or shell command is stored or executed by the keymap.
- Appearance offers dark, light, system and custom JSON themes through the toolbar and command palette. Main-owned revision-checked persistence shares the atomic profile writer with commands; an appearance-only profile still permits legacy keymap migration. Saved appearance applies before the first application frame and restores the native window preference.
- Shared tokens recolor application surfaces, Canvas lanes, syntax, and CodeMirror views. System changes update open editors in place, retaining drafts, focus and undo history. Toolbar controls wrap within the window. Custom themes inherit a light/dark base and accept only known tokens with CSS hex values; invalid input or failed writes retain the active theme. Electron receives explicit RGBA values to preserve CSS alpha color channel order.

- History pages use a typed JSON response format, serialized in main after validation, to avoid copying thousands of nested objects through renderer IPC and the isolated-world bridge. Existing request validation, cancellation, cursor checks, append-only layout and performance budgets remain in place.

## Verification

At this checkpoint, **113 desktop tests passed and one opt-in real-repository benchmark was skipped**, exit 0, with Gitea enabled. The full run covers command availability, fuzzy search, keyboard remapping, native menus, modal suppression, restart persistence, corrupt-file recovery, serialized IPC, escaped-keymap repair, and all six appearance acceptance tests.

Targeted acceptance also passed: twelve graph/menu/IPC tests and six settings tests. The IPC test checks Unicode, quotes, backslashes and multiline Git text, remaining-page order, stale-offset errors, invalid requests/formats, and equivalence with the object response. The settings regression first reproduced an unreadable file after migrating a 32,768-character control-character keymap, then passed through migration, restart, explicit repair and another restart.

`pnpm test`: **508 tests passed across 67 files** on the final implementation. An initial run had one GitLab fixture request failure; that file passed all nine tests in isolation and the subsequent full run passed all 508 tests. No GitLab code was changed, and the cause of that one-off failure is unconfirmed. TypeScript project checking, build, full ESLint and repository Prettier checks passed. Linux packaging and fuse verification passed. Packaged ASAR smoke acceptance passed, including renderer isolation and native askpass/editor helpers.

The final full desktop run measured:

| Measurement                                    |   Result |        Budget |
| ---------------------------------------------- | -------: | ------------: |
| 2,000-commit first paint                       | 262.4 ms |      < 500 ms |
| 5,000-commit page, worker layout and UI update | 136.5 ms |      < 300 ms |
| 12,000-row scrolling, frame p95                |  16.7 ms | 60 fps target |
| 50,000-line comparison opening                 | 493.2 ms |    < 1,000 ms |
| 10,000-line blame, first screen                | 290.5 ms |      < 300 ms |

### Appearance acceptance

Native tests cover independent command/appearance revisions, concurrent saves, stale-save refusal, restart after renderer-storage removal, and migration from an appearance-only profile. UI tests verify dark/light Canvas colors without moving rows, system changes with an open editable draft and intact undo/redo, and custom themes with inherited tokens and native alpha color conversion. A failed settings write leaves the active palette and draft intact, and a subsequent retry succeeds. Invalid custom versions, names, bases, colors and unknown fields are rejected. Light graph/editor and custom-theme screenshots were visually inspected. Existing dark graph snapshots pass unchanged.

### Paging investigation

The previous checkpoint failed paging at 340 ms and three isolated repeats at 432, 511 and 342 ms. A pre-menu `b6f1fb6` comparison on the same host produced 351, 250 and 259 ms; the native-menu build then produced 714, 509 and 545 ms. Main-process profiling showed no meaningful menu-update cost. The worker bundles were identical. These observations did not establish the menus as the cause.

Serializing in preload initially passed at 212, 206 and 203 ms, but a later run failed twice under contention and warmed same-app comparisons were mixed. The original object-transport control also failed twice (456 and 409 ms, with one 281 ms pass). The final implementation serializes earlier, in main, avoiding nested-object copies through both renderer IPC and contextBridge. Three end-to-end repeats passed at 208, 221 and 207 ms; paired same-app comparisons favored main serialization overall, with variation between individual samples. The subsequent full-suite paging gate passed at 230 ms; the current theme checkpoint passed at 136.5 ms. No timing limit was relaxed. Diagnostic test files and the baseline worktree were removed.

These are Linux fixture measurements. CPU contention still affects timings, the dedicated real-repository benchmark was not run, and cross-platform performance remains unverified. The earlier diff/blame timing failures and investigations remain in the previous checkpoint logs; this clean full-suite result does not replace broader M8 regression requirements.

Logs for this checkpoint are `/tmp/openkraken-theme-final-{unit,unit-recheck,typecheck,lint,e2e,package,smoke}.log`. Theme-specific logs are `/tmp/openkraken-custom-theme-*.log` and `/tmp/openkraken-appearance-*.log`. Prior paging/settings checkpoint logs remain at `/tmp/openkraken-paging-settings-{unit,lint,package,smoke,full-e2e}.log`. Targeted and diagnostic logs remain under `/tmp/openkraken-serialized-*.log`, `/tmp/openkraken-paging-*.log`, and `/tmp/openkraken-settings-escaped-*.log`. Previous native command logs remain under `/tmp/openkraken-command-{settings,menu,native}-*.log`.

## Remaining M7 scope

- Broader command coverage, including dynamic branch/file domains and contextual commands. Native accelerators are implemented; this is not an Atom selector keymap interpreter. Other older preferences (for example graph view settings) still need consolidation into the main settings store.
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
- [0063 — Serialized history page responses](../decisions/0063-serialized-history-page-responses.md)
- [0064 — Application appearance](../decisions/0064-application-appearance.md)
