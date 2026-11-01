# 0014 — Remote management and transport boundaries

Remote management uses native `git remote` for add, rename, URL replacement and removal. Native rename updates tracking refs and branch remote settings. Removal requires a desktop confirmation explaining that it removes local tracking refs and has no Undo; it does not delete the server repository. Fetch and push URLs are shown separately, with push falling back to fetch when no explicit push URL exists. URL replacement follows Git's first-matching-URL behavior and preserves additional URLs.

A review token fingerprints effective Git configuration and remote-tracking refs. Mutations run on the common-directory write queue and refuse a stale token. Native Git owns its configuration/ref locks. This check does not make Git's multi-file remote commands atomic against concurrent external writers. Refresh after errors exposes any completed native changes.

Existing HTTP userinfo, URL passwords and query/fragment parameters are masked before crossing IPC. New endpoints reject embedded credentials, parameters and external transport-helper syntax. HTTPS, SSH, Git, file URLs, scp-style SSH endpoints and local paths are supported. Authentication belongs to native credential helpers or SSH agents; passwords are not stored as URLs. This slice does not initiate network connections.

Tests exercise the public repository service against real Git, including stale edits, existing configuration locks, native tracking rename/removal and credential masking. An Electron test adds a remote, edits its fetch URL and confirms its removal.

Reference: [Git remote documentation](https://git-scm.com/docs/git-remote).

## Fetch

Manual fetch uses an existing remote name, atomic ref updates, pruning, tag discovery, progress output, and no recursive submodule fetches. It runs on the repository write queue, supports process-group cancellation, and has a three-minute Git timeout. The desktop refreshes history after completion or failure. Local branches, index and worktree are not integrated by fetch.

Transport protocols are restricted to file, HTTP(S), SSH and Git; external helpers such as `ext::` cannot execute through this action. The runner enforces global TLS verification, and fetch additionally overrides configured URL-specific `http.*.sslVerify` settings. Native credential helpers and SSH agents remain available. Git errors mask URL credentials before delivery to the renderer. The per-session prompting bridge and automatic fetch policy remain separate work.

Tests fetch and prune refs/tags against a local bare repository, preserve working edits, reject option-like remote names and external transport helpers, and refuse a self-signed HTTPS server even with URL-specific TLS verification disabled. The certificate and key in `packages/test-fixtures/tls` are public localhost test fixtures, never used by the application. The desktop test fetches a branch before editing/removing its remote.

Reference: [Git fetch documentation](https://git-scm.com/docs/git-fetch).

## Automatic fetch

Automatic fetch is off by default, with per-repository intervals of 5, 15 or 30 minutes persisted in the local profile's renderer storage. A timer tick skips an open dialog, active operation, search or paging. It fetches configured remotes sequentially and refreshes history after completion; the existing Cancel action can interrupt it. Disabling the timer or leaving the repository cancels its active request. Failures appear as a status message, with the next attempt at the configured interval.

Background requests disable Git askpass, SSH askpass, and interactive Git Credential Manager prompting while retaining noninteractive credential-helper/agent access. Third-party credential helpers still execute as configured native programs. The Electron clock test verifies opt-in, dialog deferral, a real bare-remote fetch and interval persistence across reload. A native HTTP authentication fixture verifies that foreground askpass executes and background fetch suppresses the same helper.
