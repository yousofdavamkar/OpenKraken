# M3 progress — branching and remotes

M3 is complete on Linux; see the [completion report](m3-completion.md). M4–M8 remain pending.

Implemented and exercised against real Git and Electron:

- Branch creation, checkout, rename, deletion and upstream settings, with guarded Undo.
- Local lightweight/annotated/signed tags and reviewed deletion.
- Remote add/rename/URL edits/removal, stale-review checks and credential masking.
- Manual fetch and opt-in 5/15/30-minute automatic fetch, cancellation and enforced TLS verification.
- Pull with persisted fast-forward-only/merge/rebase policy, guarded upstream/revision checks, and native conflict stages.
- Reviewed branch/tag push, separate push URLs, upstream setup and explicit force-with-lease.
- Reviewed server branch/tag deletion protected by the exact server tip.
- Stash listing and creation: selected literal paths, optional untracked files and staged-only mode; workspace Undo retains the stash.
- Stash apply/pop with optional staged-state restoration, conflicted-pop preservation, reviewed drop and message editing.
- Clone with shallow history, a branch/tag, on-demand blobs and sparse directories; bounded transport progress and cancellation.
- Native askpass helper over a private Unix socket or Windows named pipe, typed username/password and SSH confirmation prompts, cancellation and existing credential-helper/agent compatibility.

All M3 feature slices and the final Linux verification pass are complete. Automatic fetch now doubles failed retry delays up to one hour and resets after success. The [Gitea HTTPS/SSH acceptance test](m3-gitea.md) passes, including encrypted SSH keys and host-key consent and changed-key refusal. The current push/deletion dialogs require a single push URL per remote.

Final M3 regression: 132 Vitest tests passed, 28 Electron tests passed (including Gitea) and the dedicated large-repository benchmark was skipped. Type checking, lint, build, Linux packaging and packaged renderer/native-helper smoke checks passed. The Windows helper cross-compiles; runtime behavior still needs a Windows runner. The graph suite measured 237.3 ms first paint, 158.4 ms for a 5,000-commit page, and 16.8 ms p95 scrolling on this Linux run. These are local results, not macOS/Windows verification.

Decisions and detailed limits: [reference actions](../decisions/0013-reference-actions.md), [remotes/transports](../decisions/0014-remotes-and-transports.md), [stashes](../decisions/0015-stashes.md), [clone](../decisions/0016-clone.md), [authentication](../decisions/0017-authentication-helper.md), [pull](../decisions/0018-pull-policy.md).

Pull follow-up: seven native Git cases pass, including an upstream change during fetch; the desktop preference/refresh test passes across a renderer reload. The Gitea flow also passes an authenticated HTTPS pull. Pull integration preserves native conflict/abort state; workspace Undo and in-app conflict controls are M4 work.
