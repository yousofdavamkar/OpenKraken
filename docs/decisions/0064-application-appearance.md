# 0064 — Application appearance

## Decision

Appearance shares the main-owned atomic profile writer with command preferences. `AppSettings` replaces the command-only store name. Appearance has its own revision so command usage and keymap saves cannot invalidate or overwrite an appearance draft. All writes retain both sections, use the same queue and file-size limit, and preserve the existing corrupt-file backup and failed-write behavior.

Version-one files may omit either section. A missing commands section remains eligible for one-time legacy keymap migration even if appearance has already been saved. Existing command-only profiles remain valid and receive the dark appearance default, preserving the application's existing presentation. Missing appearance defaults to dark with revision zero.

Main-only typed IPC reads appearance and saves a known dark/light/system mode with a revision check. The Git utility process cannot receive these requests. Main activates the native preference only after persistence succeeds, and restores it before creating the initial window. Renderer storage is not authoritative.

Native theme selection uses [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme): explicit light or dark overrides the OS preference; system follows it. Renderer theme styling will follow the resulting color scheme. User JSON tokens and their editor are subsequent parts of the theme implementation, not yet implemented at this native-settings checkpoint.

## Verification

Real Electron tests cover simultaneous appearance and keymap saves, stale appearance writes, native color-scheme changes, restart after clearing renderer storage, and importing legacy shortcuts into an appearance-only profile. The existing six command-settings regression tests continue to pass. Contract tests reject unknown modes, unsafe revisions and extra fields, and keep both appearance routes out of the utility process.

The native preference test resets [Playwright color-scheme emulation](https://playwright.dev/docs/api/class-page#page-emulate-media) to null on each launch. Otherwise Playwright's light emulation hides Electron's actual dark preference from the media query. Native behavior is currently verified on Linux; macOS and Windows still require acceptance.
