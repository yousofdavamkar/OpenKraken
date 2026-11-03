# 0012 — Repository observation and targeted refresh

M2 uses Parcel's native Node-API watcher on the worktree, private git directory, and common git directory. Git object storage and redundant worktree `.git` traversal are excluded. Worktree events debounce at 300 ms and Git metadata at 120 ms. Events are hints: native Git status and ref fingerprints determine which observable domains changed, so ignored-file noise does not publish UI updates. We do not blindly ignore directory names such as `node_modules`, which may contain tracked files.

A private probe in the Git directory must generate an event within one second. Missing native support, a failed probe, or observer errors switch to 750 ms polling with a visible indicator. A baseline is captured before the initial repository snapshot; subscriptions start after delivery and recheck that baseline to close the startup race. App writes pause observation and schedule a check afterward, retaining changes from external writers during that interval. Linked worktrees observe both private HEAD/index and shared refs. Only the active repository retains subscriptions.

Events have a fixed typed channel, validate in main and preload, and expose only a subscribe/unsubscribe callback to the renderer. Status updates fetch fresh working state and update the existing graph generation, preserving loaded pages, selection, and the history cursor. Ref/config/operation changes use the existing full snapshot refresh. The UI coalesces events while paging or writing. Window-focus refresh is on by default and configurable; its non-sensitive preference is stored locally in the renderer until general settings are consolidated in M7.

The native dependency and its installed runtime dependency closure are copied into the build. Native binaries are unpacked from ASAR; scripts are packaged inside ASAR. Parcel's optional source-build install script is disabled because supported release runners use the published Node-API binaries. Production packaging and Electron tests exercise this arrangement.

Tests cover path classification, external edit/add/commit latency below 1.5 seconds, paused writes, self-test polling fallback, linked worktrees, bare repos, preserved paged history, and the real Electron bridge. Performance depends on filesystem and repository size; polling on slow network storage is a fallback, not a universal 1.5 second guarantee. Large ignored directory trees can still cost native subscriptions even though their changes do not cause renderer updates.

Public API reference: [Parcel watcher](https://github.com/parcel-bundler/watcher).

## Other worktrees

M7 extends the active repository's observer to its registered checkouts, as described in [worktree management](0067-worktree-management.md). Membership is verified before subscription, and subscriptions reconcile after registration changes. Availability and changed-file counts use a separate `worktreeStatus` event domain so status updates preserve loaded history. Missing checkouts are polled for reconnection. The active repository still owns the lifecycle: switching or closing releases its checkout subscriptions. Watcher Git processes use a three-reader pool.

## User actions during background refresh

Background reads keep existing working-action controls available and mark their activity separately from user mutations. If a click arrives while a background read owns the state, the action waits for it instead of being discarded. Ref-bearing undo now performs an explicit full refresh (currently all Undo/Redo actions use this path): a quick delete/undo pair can return the watcher to its baseline while an intermediate snapshot is still visible. Watch notifications alone cannot repair that case. Pure status events continue to preserve the loaded history window.
