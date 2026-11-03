# 0064 — Application appearance

## Decision

Appearance shares the main-owned atomic profile writer with command preferences. `AppSettings` replaces the command-only store name. Appearance has its own revision so command usage and keymap saves cannot invalidate or overwrite an appearance draft. All writes retain both sections, use the same queue and file-size limit, and preserve the existing corrupt-file backup and failed-write behavior.

Version-one files may omit either section. A missing commands section remains eligible for one-time legacy keymap migration even if appearance has already been saved. Existing command-only profiles remain valid and receive the dark appearance default, preserving the application's existing presentation. Missing appearance defaults to dark with revision zero.

Main-only typed IPC reads appearance and saves a known dark/light/system mode with a revision check. The Git utility process cannot receive these requests. Main activates the native preference only after persistence succeeds, and restores it before creating the initial window. Renderer storage is not authoritative.

Native theme selection uses [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme): explicit light or dark overrides the OS preference; system follows it. An Appearance dialog and catalogue command save these preferences. Main publishes validated appearance changes only after persistence; utility-origin appearance events are discarded. The renderer honors explicit modes and listens to the native media query for system mode.

Shared named color tokens cover application surfaces, text, state indicators, diff lines, syntax and graph lanes. Each existing dark CSS color retains its value; light mode supplies a corresponding palette. Tokens become CSS variables. Canvas receives the active lane palette and background and repaints without changing graph topology, paging or selection. The toolbar wraps its controls within the window rather than widening the document. User JSON themes remain a subsequent part of the implementation.

CodeMirror views share a theme extension whose compartment changes the dark/light facet in place. CSS variables supply editor and syntax colors. Theme changes do not recreate editor views or their documents, selections, focus or undo history. The subscription is removed when each view is destroyed. Working-file editors, local comparisons and provider patch views use this same extension.

## Verification

Real Electron tests cover simultaneous appearance and keymap saves, stale appearance writes, native color-scheme changes, restart after clearing renderer storage, and importing legacy shortcuts into an appearance-only profile. The existing six command-settings regression tests continue to pass. Contract tests reject unknown modes, unsafe revisions and extra fields, and keep both appearance routes out of the utility process.

The native preference test resets [Playwright color-scheme emulation](https://playwright.dev/docs/api/class-page#page-emulate-media) to null on each launch. Otherwise Playwright's light emulation hides Electron's actual dark preference from the media query. Native behavior is currently verified on Linux; macOS and Windows still require acceptance.

Rendered acceptance switches light/dark through the Appearance dialog, verifies computed surface colors and Canvas node colors, preserves row identities and lanes, and checks for document overflow. The six existing dark Canvas snapshots pass unchanged. Light graph screenshots are also visually inspected.

An editor acceptance test simulates a system color-scheme change while an unsaved Python draft is open, verifies the editor's new background and retained focus, then undoes and redoes the edit. It also confirms the disk file was not changed. The light editor screenshot is visually inspected.
