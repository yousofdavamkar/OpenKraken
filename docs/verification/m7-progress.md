# M7 progress — productivity and polish

M7 is in progress as of 2026-11-02 at implementation checkpoint `ad67696`. M6 continues to have the gaps recorded in [M6 progress](m6-progress.md); M7 and M8 are not complete. React 19.3.1 and TypeScript 7.0.2 remain pinned.

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
- An on-demand xterm panel starts the user's default shell in the opened repository through a dedicated `node-pty` utility process. Main owns the working directory and accepts only session-scoped, bounded input, sizing and acknowledgment messages. Output backpressure pauses the PTY until rendering catches up. Hiding preserves the session; F6 reaches controls; the toolbar restores focus. Closing a live session requires confirmation, and reload/window closure ends the utility. A missing shell reports a recoverable error. Renderer isolation and the existing Git service remain in place.
- OSC 133 markers show prompt, command-running and reported exit-code state without granting any authority to shell output. Bash 5.1+ receives a bundled rcfile that first sources the user's `.bashrc` and preserves scalar/array prompt hooks, PS0, dynamic PS1, DEBUG traps, `$?` and PIPESTATUS. Older Bash or incompatible prompt settings keep the normal terminal. Other shells can provide their own standard markers; automatic integration for those shells remains open.
- Worktrees are listed with main/current, branch/detached, commit, dirty-file, lock and missing-folder state. A registered checkout can be opened by a validated ID and inventory revision. Creation supports a new branch, an unused existing local branch or detached HEAD at an explicit commit, with an empty destination chosen through the native folder picker. Shared-repository writes use the existing queue and watcher suppression. Creation keeps the current checkout unchanged; cancellation/errors retain form choices. Newline-containing repository metadata uses an unambiguous fallback read.
- Reviewed lock/unlock actions support offline worktrees and bounded lock reasons. Removal retains branches, refuses main/current/locked or unavailable checkouts, and checks ignored/untracked/modified files, index flags that can conceal edits, ongoing Git operations and unreferenced detached commits. Reviews remain open on failure; cancellation and success restore focus, and removal review initially focuses Cancel.

- Worktree cleanup shows Git’s bounded dry-run report before pruning stale registrations. Repository-bound, expiring tokens and a fixed cutoff bind confirmation to the reviewed inventory and metadata fingerprint. Confirmation rechecks detached HEAD retention and consumes the token before execution. Locked/live checkouts and branches remain; the UI explains that registration index/reflog recovery data is removed.

- History pages use a typed JSON response format, serialized in main after validation, to avoid copying thousands of nested objects through renderer IPC and the isolated-world bridge. Existing request validation, cancellation, cursor checks, append-only layout and performance budgets remain in place.

## Verification

The latest prune increment (`ad67696`) passed **526 unit tests across 68 files on its first full run**, **seven targeted desktop tests** (five worktree flows and two native-menu regressions), typechecking, build and full ESLint/Prettier checks. The cleanup review screenshot was visually inspected. Packaging, performance and the complete desktop suite were not rerun for this increment. The earlier intermittent GitLab fixture failure did not occur; its cause remains unconfirmed.

The preceding worktree management increment (`baab017`) passed **521 unit tests across 68 files on its first full run**, **six targeted desktop tests** covering the four worktree flows and two native-menu regressions, typechecking, build and full ESLint/Prettier checks. The worktree management screenshot was visually inspected. No packaging, performance or full desktop-suite rerun was performed for this dialog/service increment. The earlier intermittent GitLab fixture failure did not occur in this run, but its cause remains unconfirmed.

The preceding creation/opening increment (`4a363c7`) passed **20 targeted desktop tests** covering worktrees, command menus, command preferences and the graph, including all six visual goldens. Paging measured **142.9 ms** and scrolling frame p95 **16.8 ms**. **515 unit tests across 68 files passed on a full rerun**. The first full run had one GitLab stale-file fixture failure (`PROVIDER_REQUEST` instead of `STALE_PROVIDER_MERGE`); its isolated nine-test suite and the subsequent full run passed. This resembles the previously recorded GitLab fixture failure, but its cause remains unconfirmed. No test timeout or performance threshold was relaxed. Typechecking, build, full ESLint/Prettier checks passed, and the worktree dialog screenshot was visually inspected. Packaging and the complete desktop suite were not rerun for that increment.

The preceding OSC 133 increment (`2e48cb0`) passed **all 10 terminal acceptance tests**, **509 unit tests across 67 files**, typechecking, build, full ESLint/Prettier checks, Linux packaging/fuse checks and the packaged native terminal smoke check. The packaged screenshot was visually inspected. No broader desktop suite or performance rerun was performed for that terminal-only increment.

At the preceding full-suite checkpoint (`8c68b88`), **117 desktop tests passed and one opt-in real-repository benchmark was skipped**, exit 0, with Gitea enabled. That run covers command availability, fuzzy search, keyboard remapping, native menus, modal suppression, restart persistence, corrupt-file recovery, serialized IPC, escaped-keymap repair, all six appearance acceptance tests, and the four terminal foundation acceptance tests.

Targeted terminal acceptance passed alongside appearance, native command-menu and working-editor regressions. Four terminal tests cover native shell input and sizing, UI focus and session preservation, missing-shell recovery, bounded output and session cleanup. The existing serialized IPC and escaped-keymap regressions continue to pass in the full run.

`pnpm test`: **509 tests passed across 67 files** on both terminal checkpoints, on their first full attempts. The earlier theme checkpoint had one GitLab fixture request failure, followed by passing isolated and full reruns; its cause remains unconfirmed, as does the latest worktree-run failure described above. TypeScript project checking, build, full ESLint and repository Prettier checks passed. Linux packaging and fuse verification passed at the terminal checkpoints. Packaged ASAR smoke acceptance passed, including renderer isolation, native askpass/editor helpers, the real Linux directory picker, and the packaged terminal.

The full desktop run at `8c68b88` measured:

| Measurement                                    |   Result |        Budget |
| ---------------------------------------------- | -------: | ------------: |
| 2,000-commit first paint                       | 250.2 ms |      < 500 ms |
| 5,000-commit page, worker layout and UI update | 151.8 ms |      < 300 ms |
| 12,000-row scrolling, frame p95                |  16.8 ms | 60 fps target |
| 50,000-line comparison opening                 | 346.8 ms |    < 1,000 ms |
| 10,000-line blame, first screen                | 132.2 ms |      < 300 ms |

### Worktree acceptance

Sixteen native Git tests exercise main/current, locked, missing, dirty, detached, bare and unborn checkouts; Unicode/newline paths; unknown/stale selection refusal; and a registered directory replaced by an unrelated repository. Creation tests check empty destinations, explicit commits, new/existing/detached modes, moved branch tips, duplicate branch checkout refusal, unchanged original HEAD and cancellation. Management coverage includes offline locking/unlocking, lock reasons, refusal to remove main/current/locked checkouts, ignored and untracked files, tracked edits hidden behind either index flag, unreferenced detached commits and a clean-index pending merge. Successful removal retains the branch tip. IPC coverage rejects renderer paths, force fields, malformed IDs, symbolic revision expressions and oversized/NUL-containing reasons.

Five Electron tests cover stale-list recovery, explicit opening, creation in all three modes, picker cancellation and nonempty-folder recovery, lock/unlock review, canceled removal, a file created after review, clean removal with branch retention, and focus restoration after cancellation and success. Graph and command-palette regressions passed at the creation checkpoint; native-menu regressions passed again with management.

Prune coverage checks live/locked checkout and branch retention, consumed/foreign/expired tokens, changed metadata, restored checkouts, detached HEAD retention before preview and confirmation, and malformed registrations omitted by the normal list. The Electron flow cancels review, refuses confirmation after an external lock, completes a fresh review and verifies empty-cleanup controls and focus. IPC checks reject caller-supplied paths, cutoffs, reports, candidates and force flags.

This proves list/create/open/lock/unlock, guarded removal and reviewed pruning behavior on Linux. It does not prove graph WIP rows, other-checkout watching, non-UTF-8 worktree paths or macOS/Windows runtime acceptance. Prune revalidation is optimistic; external Git writers are not locked out.

### Terminal acceptance

Native tests verify separate Git/PTY utility processes, the opened repository as the shell working directory, terminal resize, exit status and refusal of stale sessions or unknown repositories. The output test pauses without acknowledgments, then receives a complete one-megabyte stream after resuming. Closing a foreground command reaps the shell; reload removes the utility. UI tests retain hidden scrollback, restore focus, support F6 navigation, confirm close, and recover from a missing default shell without blocking repository refresh.

The OSC 133 tests cover markers split between PTY output chunks, BEL/ST terminators, malformed exit codes, prompt transitions, close confirmation despite completion markers, and state cleanup on exit and restart. Linux Bash fixtures exercise scalar, array and exported-array prompt commands, dynamic prompt replacement, PS0, DEBUG traps, failed commands, pipeline status, hiding and native exit. Compatibility fixtures retain a usable shell with disabled prompt expansion or read-only PS1, including `set -eu`.

The Linux packaged smoke check uses the native picker and the actual packaged PTY. It confirms shell output, native X11 Ctrl+P delivery as byte 16, Bash prompt markers from the unpacked rcfile, a reported command failure, native exit status, and panel closure. The terminal screenshot is visually inspected. These results do not establish macOS/Windows or other-shell runtime acceptance.

### Appearance acceptance

Native tests cover independent command/appearance revisions, concurrent saves, stale-save refusal, restart after renderer-storage removal, and migration from an appearance-only profile. UI tests verify dark/light Canvas colors without moving rows, system changes with an open editable draft and intact undo/redo, and custom themes with inherited tokens and native alpha color conversion. A failed settings write leaves the active palette and draft intact, and a subsequent retry succeeds. Invalid custom versions, names, bases, colors and unknown fields are rejected. Light graph/editor and custom-theme screenshots were visually inspected. Existing dark graph snapshots pass unchanged.

### Paging investigation

The previous checkpoint failed paging at 340 ms and three isolated repeats at 432, 511 and 342 ms. A pre-menu `b6f1fb6` comparison on the same host produced 351, 250 and 259 ms; the native-menu build then produced 714, 509 and 545 ms. Main-process profiling showed no meaningful menu-update cost. The worker bundles were identical. These observations did not establish the menus as the cause.

Serializing in preload initially passed at 212, 206 and 203 ms, but a later run failed twice under contention and warmed same-app comparisons were mixed. The original object-transport control also failed twice (456 and 409 ms, with one 281 ms pass). The final implementation serializes earlier, in main, avoiding nested-object copies through both renderer IPC and contextBridge. Three end-to-end repeats passed at 208, 221 and 207 ms; paired same-app comparisons favored main serialization overall, with variation between individual samples. The subsequent full-suite paging gate passed at 230 ms; the theme checkpoint passed at 136.5 ms and the current terminal checkpoint passed at 151.8 ms. No timing limit was relaxed. Diagnostic test files and the baseline worktree were removed.

These are Linux fixture measurements. CPU contention still affects timings, the dedicated real-repository benchmark was not run, and cross-platform performance remains unverified. The earlier diff/blame timing failures and investigations remain in the previous checkpoint logs; this clean full-suite result does not replace broader M8 regression requirements.

Latest prune logs are `/tmp/openkraken-worktree-prune-final-{unit,lint,types}.log`, `/tmp/openkraken-worktree-prune-build.log`, `/tmp/openkraken-worktree-prune-ui-green.log` and `/tmp/openkraken-worktree-prune-menu.log`. Native and UI red/green evidence remains under `/tmp/openkraken-worktree-prune-*.log`.

Management logs are `/tmp/openkraken-worktree-management-final-{unit,lint,build,e2e}.log` and `/tmp/openkraken-worktree-management-core-security.log`. Red/green evidence for lock, removal, hidden index flags, detached commits, pending merges and review focus remains under `/tmp/openkraken-worktree-*.log`.

Creation/opening logs are `/tmp/openkraken-worktrees-final-{unit,unit-recheck,lint,build,e2e}.log`; the isolated GitLab rerun is `/tmp/openkraken-worktrees-gitlab-recheck.log`. Focused core, UI, newline-path and creation red/green evidence remains under `/tmp/openkraken-worktrees-*.log`. One UI test initially used a label selector containing dropdown option text; selecting the accessible combobox fixed the test without changing application behavior.

Terminal integration logs are `/tmp/openkraken-osc-bash-final.log`, `/tmp/openkraken-osc-bash-fallback-build.log` and `/tmp/openkraken-osc-final-{unit,lint,package,smoke}.log`. Red/green evidence for split markers, exported prompt arrays and errexit-compatible fallback remains under `/tmp/openkraken-osc-*.log`.

Logs for the preceding full-suite checkpoint are `/tmp/openkraken-terminal-final-{unit,typecheck,lint,e2e,package,smoke}.log`. Focused terminal logs remain under `/tmp/openkraken-terminal-*.log`. The prior theme checkpoint is recorded in `/tmp/openkraken-theme-final-{unit,unit-recheck,typecheck,lint,e2e,package,smoke}.log`. Theme-specific logs are `/tmp/openkraken-custom-theme-*.log` and `/tmp/openkraken-appearance-*.log`. Prior paging/settings checkpoint logs remain at `/tmp/openkraken-paging-settings-{unit,lint,package,smoke,full-e2e}.log`. Targeted and diagnostic logs remain under `/tmp/openkraken-serialized-*.log`, `/tmp/openkraken-paging-*.log`, and `/tmp/openkraken-settings-escaped-*.log`. Previous native command logs remain under `/tmp/openkraken-command-{settings,menu,native}-*.log`.

## Remaining M7 scope

- Broader command coverage, including dynamic branch/file domains and contextual commands. Native accelerators are implemented; this is not an Atom selector keymap interpreter. Other older preferences (for example graph view settings) still need consolidation into the main settings store.
- Automatic shell integration for zsh, fish and PowerShell, plus terminal runtime acceptance on macOS/Windows. Standard OSC 133 consumption and automatic Bash 5.1+ integration are implemented. The initial terminal supports one session; broader terminal workflows remain future work.
- Graph worktree WIP rows and other-checkout watch integration. List/create/open/lock/unlock, guarded removal and reviewed pruning are implemented for UTF-8 paths; non-UTF-8 worktree paths and cross-platform runtime acceptance remain open. Submodule UI and LFS awareness remain open.
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
- [0065 — Integrated terminal](../decisions/0065-integrated-terminal.md)
- [0066 — Terminal shell integration](../decisions/0066-terminal-shell-integration.md)
- [0067 — Worktree management](../decisions/0067-worktree-management.md)
