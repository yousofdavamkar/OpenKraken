# 0064 — Application appearance

## Decision

Appearance shares the main-owned atomic profile writer with command preferences. `AppSettings` replaces the command-only store name. Appearance has its own revision so command usage and keymap saves cannot invalidate or overwrite an appearance draft. All writes retain both sections, use the same queue and file-size limit, and preserve the existing corrupt-file backup and failed-write behavior.

Version-one files may omit either section. A missing commands section remains eligible for one-time legacy keymap migration even if appearance has already been saved. Existing command-only profiles remain valid and receive the dark appearance default, preserving the application's existing presentation. Missing appearance defaults to dark with revision zero.

Main-only typed IPC reads appearance and saves a known dark/light/system/custom mode with a revision check. The Git utility process cannot receive these requests. Main activates the native preference only after persistence succeeds, and restores it before creating the initial window. Renderer storage is not authoritative.

Native theme selection uses [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme): explicit light or dark overrides the OS preference; system follows it. An Appearance dialog and catalogue command save these preferences. Main publishes validated appearance changes only after persistence; utility-origin appearance events are discarded. The renderer honors explicit modes and listens to the native media query for system mode.

Shared named color tokens cover application surfaces, text, state indicators, diff lines, syntax and graph lanes. Each existing dark CSS color retains its value; light mode supplies a corresponding palette. Tokens become CSS variables. Canvas receives the active lane palette and background and repaints without changing graph topology, paging or selection. The toolbar wraps its controls within the window rather than widening the document.

Custom themes are version-one JSON objects with a bounded name, a light/dark base, and optional known color tokens. Missing tokens inherit the base palette. Colors accept only three-, four-, six- or eight-digit CSS hex values; arbitrary CSS, URLs and unknown fields are rejected in both renderer and main. The editor caps input at 32,768 characters. Saving a built-in mode retains the custom theme for later use. Renderer mounting waits for the initial appearance read so saved colors apply before the first application frame; failed reads retain the default.

Main also sets the BrowserWindow background from the resolved palette, including at startup and on system changes. CSS hex alpha is RGBA, whereas Electron hex alpha is ARGB. Main expands the validated hex value to an explicit functional `rgba(...)` string before passing it to Electron, preserving RGB channels for transparent colors.

CodeMirror views share a theme extension whose compartment changes the dark/light facet in place. CSS variables supply editor and syntax colors. Theme changes do not recreate editor views or their documents, selections, focus or undo history. The subscription is removed when each view is destroyed. Working-file editors, local comparisons and provider patch views use this same extension.

## Verification

Real Electron tests cover simultaneous appearance and keymap saves, stale appearance writes, native color-scheme changes, restart after clearing renderer storage, and importing legacy shortcuts into an appearance-only profile. The existing six command-settings regression tests continue to pass. Contract tests reject unknown modes, unsafe revisions and extra fields, and keep both appearance routes out of the utility process.

The native preference test resets [Playwright color-scheme emulation](https://playwright.dev/docs/api/class-page#page-emulate-media) to null on each launch. Otherwise Playwright's light emulation hides Electron's actual dark preference from the media query. Native behavior is currently verified on Linux; macOS and Windows still require acceptance.

Rendered acceptance switches light/dark through the Appearance dialog, verifies computed surface colors and Canvas node colors, preserves row identities and lanes, and checks for document overflow. The six existing dark Canvas snapshots pass unchanged. Light graph screenshots are also visually inspected.

An editor acceptance test simulates a system color-scheme change while an unsaved Python draft is open, verifies the editor's new background and retained focus, then undoes and redoes the edit. It also confirms the disk file was not changed. The light editor screenshot is visually inspected.

Custom-theme acceptance covers inherited colors, Canvas recoloring, invalid JSON color rejection, persistence after clearing renderer storage, native base selection, alpha color channel order, and returning to a built-in theme. A failed native save retains the active theme and editable draft; restoring the settings file allows retry. Contract tests reject invalid versions, bases, names, colors and extra fields. The alpha regression reproduced an incorrect native `#345680` background for CSS `#12345680` before the conversion fix.
