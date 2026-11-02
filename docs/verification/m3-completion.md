# M3 completion — branching and remotes

M3's feature scope and Linux acceptance suite are complete as of 2026-11-01, at implementation commit `74fd11a`. M4–M8 remain open. React 19.3.1 and TypeScript 7.0.2 are unchanged.

## Implemented

- Branch create/checkout/rename/delete/upstream and local tags, with guarded reference Undo.
- Stash push for selected paths, untracked and staged-only work; apply/pop, reviewed drop and message editing.
- Remote CRUD, manual fetch, opt-in automatic fetch with failure backoff, and explicit pull policies.
- Reviewed branch/tag pushes, upstream setup, separate push URLs, explicit force-with-lease and leased server-ref deletion.
- HTTPS credentials and encrypted SSH keys through the native askpass helper, with existing native credential helpers/agents supported. The helper uses a private Unix socket or Windows named pipe and expiring operation capabilities.
- SSH host-key consent and changed-key refusal. TLS verification remains enabled; answers are not persisted by the application.
- Clone with branch/tag, shallow, sparse and partial-filter options, bounded progress and cancellation.

## Verification

| Check | Result |
| --- | --- |
| TypeScript build, ESLint and Prettier | Passed |
| Full Vitest suite | 132 tests passed |
| Combined Electron suite with Gitea enabled | 28 passed; one dedicated large-repository benchmark skipped |
| 2,000-commit first paint | 237.3 ms |
| Next 5,000 commits, including worker/layout/UI | 158.4 ms |
| 12,000-row scroll frame p95 | 16.8 ms |
| Linux platform bundle and hardened fuse verification | Passed |
| Packaged renderer isolation and unpacked native-helper execution | Passed |
| Windows native helper cross-compilation | Passed; runtime not executed here |

The [Gitea fixture](m3-gitea.md) runs Gitea 1.26.4 in a rootless container, with HTTPS verified against a test CA and SSH using an encrypted Ed25519 key. It drives desktop clone, push review/rejection, pull, host-key refusal/acceptance and changed-key diagnostics. Bare-remote tests additionally exercise exact leases, stale reviews, separate push URLs, tags, clone options and transport cancellation. Pull fixtures cover ff-only/merge/rebase, conflicts and native abort, dirty/stale/detached/missing-upstream guards, and an upstream change during fetch. Automatic-fetch tests cover backoff and successful recovery with real HTTP/Git transports.

## Limits and next milestone

macOS and Windows runtime evidence still requires their configured CI runners. Packaging is currently an unsigned platform bundle; release installers, signing and updates belong to M8. No cross-platform execution is claimed by the Linux results.

Push and deletion require one push URL per remote. Automatic fetch is disabled by default. Pull requires clean tracked work and leaves conflicts in native Git state. Pull workspace Undo, operation continuation/abort controls and conflict resolution are M4 work. Stash apply/pop do not yet have workspace Undo; stash creation's Undo deliberately keeps the saved stash. Server writes have no Undo. Cancellation cannot promise rollback of updates already accepted by a server.

Decisions: [references](../decisions/0013-reference-actions.md), [transports](../decisions/0014-remotes-and-transports.md), [stashes](../decisions/0015-stashes.md), [clone](../decisions/0016-clone.md), [authentication](../decisions/0017-authentication-helper.md), [pull](../decisions/0018-pull-policy.md).
