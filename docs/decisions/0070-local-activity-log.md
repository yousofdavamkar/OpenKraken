# 0070 — Local operation activity

## Decision

Main records a bounded operation history outside repositories in the profile's `activity.json`. The renderer may read the history or clear completed entries through strict IPC. It cannot submit entries, descriptions, file locations or arbitrary metadata. Git-service events cannot impersonate the main-owned activity notification.

Each entry contains a generated identity, a fixed action identifier, start/finish times and a fixed outcome. Labels come from the shared action catalogue. Requests, command output, error messages, paths, URLs, file contents, commit text, account identifiers and credentials never enter this file. The history intentionally does not identify repositories. No telemetry or external transmission is introduced.

The catalogue covers repository opening/creation/cloning, foreground Git mutations and transfers, worktree/submodule/LFS operations, provider content writes, explicit provider-account connection/disconnection, and appearance/keymap saves. Saved-account Git calls use the underlying Git action. Background reads, previews, automatic fetches, terminal commands, sign-in polling and command-usage recording are excluded. This is an operation summary, not an audit of external filesystem changes or every desktop request.

## Outcomes and persistence

Only validated requests admitted by the main request limit are recorded; duplicate or over-capacity requests do not create operations. The capacity slot remains held through log persistence. An operation is recorded as running before dispatch. A confirmed IPC result records success, failure or cancellation; an active Git operation or returned warning requires attention. Service exits/timeouts and explicit uncertain provider outcomes are unknown. Entries still running when the app starts also become unknown. Neither unknown nor cancelled means that no changes occurred. The UI explains partial effects and asks the user to inspect the repository/provider before retrying; the activity log never repeats an operation.

The newest 500 entries are retained, preferentially evicting completed entries. Writes are serialized, schema-validated and replaced atomically using a private temporary file, file fsync and rename. The saved file uses mode 0600 on POSIX. Reads reject leaf symlinks, non-regular files, files above 256 KiB, duplicate identities and unsupported schemas. An external content change prevents replacement. These are optimistic checks within the user's profile, not filesystem isolation from another process running as that user.

Logging starts asynchronously and does not delay native dispatch. Normal request completion waits for queued log writes; logging failure leaves the operation's actual result intact and surfaces a storage warning. Interrupted writes can leave recent activity absent. The file is not a write-ahead recovery journal, and it cannot establish whether an interrupted external write committed. Native Git/provider review and recovery rules remain authoritative.

Clearing removes only entries that were completed when requested. Running operations and newly started operations remain. The clear is serialized with persistence, and failed clearing retains history with a visible error. Corrupt, unreadable, redirected or externally changed files remain untouched; session activity remains available. To recover storage, close the app, inspect or move the profile's activity file, and restart. No automatic backup copies of cleared history are created.

## Desktop behavior and verification

Activity is available from the toolbar, command palette and native command menu. It updates while open, filters by action/outcome, and initially displays 100 entries with explicit increments of 100. Closing restores the invoking button. Updates do not dismiss action errors, and clearing does not change repository data.

Electron tests exercise persistence through renderer reload/app restart, privacy of stored bytes, completed-history clearing, native hook failure, picker cancellation, failed merge versus staging in a pending merge, background-request exclusion, duplicate-request refusal, service interruption, retention of running entries, interrupted entries on startup, the 500-entry cap, visible paging, POSIX permissions, external/corrupt-file preservation and symlink refusal. IPC tests reject renderer log injection, arbitrary action/outcome strings, free text and excessive result inventories.

The service-crash fixture exposed a separate shutdown defect: with no live Git service, cleanup completed during the original `will-quit` event and the immediate repeat quit was ignored. Deferring the final quit to the next event-loop turn fixes the minimized idle-service crash case and the activity interruption case. A killed utility still cannot reap its native subprocesses; the transport fixture is explicitly closed during teardown. Native descendant cleanup after abrupt service death remains an M8 hardening item.
