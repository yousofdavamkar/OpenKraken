# 0014 — Remote management and transport boundaries

Remote management uses native `git remote` for add, rename, URL replacement and removal. Native rename updates tracking refs and branch remote settings. Removal requires a desktop confirmation explaining that it removes local tracking refs and has no Undo; it does not delete the server repository. Fetch and push URLs are shown separately, with push falling back to fetch when no explicit push URL exists. URL replacement follows Git's first-matching-URL behavior and preserves additional URLs.

A review token fingerprints effective Git configuration and remote-tracking refs. Mutations run on the common-directory write queue and refuse a stale token. Native Git owns its configuration/ref locks. This check does not make Git's multi-file remote commands atomic against concurrent external writers. Refresh after errors exposes any completed native changes.

Existing HTTP userinfo, URL passwords and query/fragment parameters are masked before crossing IPC. New endpoints reject embedded credentials, parameters and external transport-helper syntax. HTTPS, SSH, Git, file URLs, scp-style SSH endpoints and local paths are supported. Authentication belongs to native credential helpers or SSH agents; passwords are not stored as URLs. This slice does not initiate network connections.

Tests exercise the public repository service against real Git, including stale edits, existing configuration locks, native tracking rename/removal and credential masking. An Electron test adds a remote, edits its fetch URL and confirms its removal.

Reference: [Git remote documentation](https://git-scm.com/docs/git-remote).
