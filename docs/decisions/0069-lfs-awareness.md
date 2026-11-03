# 0069 — Git LFS awareness

## Decision

OpenKraken uses the installed Git LFS CLI for repository inventory. The **Git LFS** toolbar command and command-palette entry detect `git lfs version`, then read `git lfs ls-files --json` and `git lfs locks --cached --json`. Opening or refreshing this view does not install filters, fetch objects or refresh server locks. Git LFS 3 or newer is required for this inventory. A missing command is reported separately from a failing or unsupported installation; repository access and pointer comparisons remain available.

The service maps native file names, SHA-256 identities, sizes, checkout flags and local object availability into a bounded typed response. Git LFS returns `files: null` for an empty inventory; this is normalized to an empty list. Invalid or excessive file output fails visibly. Cached-lock failures retain the file inventory and report a separate error. Version output is capped at 4 KiB, file output at 16 MiB and lock output at 8 MiB; lists are capped at 10,000 entries. The UI initially renders 200 entries with an explicit control to reveal more. Repository reads use the existing process pool, cancellation and per-repository read queue.

Native checkout flags do not distinguish a pointer from a missing working file. The UI therefore labels a false flag **Pointer or missing working file**. Local object availability is independent of checkout state. Cached owner names and lock times are displayed as cached information, and server lock state remains unknown. An empty cache is not presented as proof that a file is unlocked. No lock owner is inferred from a file permission bit or the current Git author.

Commit and working-file comparisons recognize canonical UTF-8 Git LFS pointer metadata without requiring Git LFS or running a filter. Recognition is bounded to pointers below 1 KiB, with supported v1 version strings, ordered unique keys, SHA-256 identity and a nonnegative signed-64-bit size. Size remains a decimal string through IPC to avoid precision loss. Unknown ordered metadata keys are not rewritten. Empty files remain ordinary empty files because their contents alone do not identify LFS tracking. Malformed, noncanonical or unsupported pointers remain ordinary content. Recognition applies only to regular-file modes.

Pointer comparisons show object identity and size instead of treating pointer text as the object’s content. They do not hydrate objects or offer text blame for pointer metadata. Existing explicit staging and editing workflows remain unchanged.

## Reviewed object downloads

**Review download** selects a configured remote, shows its native Git LFS endpoint, configured include/exclude filters and known file identities, then requires explicit confirmation. The service resolves the selected endpoint through bounded `git lfs env` output, including named remote entries, and binds the review to effective Git configuration, that environment, HEAD/index contents, effective filter attributes, bounded `.lfsconfig` content, inventory and working-file metadata. Only a service-owned token crosses back for confirmation; the renderer cannot supply an endpoint, file path or transport override. Tokens expire after ten minutes and are consumed before the native invocation, including failed or cancelled invocations.

Confirmation repeats inspection under the repository’s write queue and runs native `git lfs pull` against the reviewed endpoint. Configured include/exclude filters still apply, so known files in the review are not a promise that every entry will be downloaded. Native checkout fills matching pointers and absent files while retaining modified content. The action does not move the parent HEAD or stage changes. It refreshes the repository afterward and reports that failures/cancellation may leave partial cache or checkout changes. There is no Undo for this action.

This transport increment supports HTTP(S) endpoints and basic HTTP transfers. Remote autodetection/search fallback and object-URL rewriting are disabled for the invocation. Standalone transfer agents and configured LFS extensions are refused. The selected server may still provide separate object-download URLs, which is disclosed in the review. Existing native credential-helper/askpass integration is connected, but no provider account token is automatically forwarded to LFS hosts. SSH, file and custom transports remain follow-up work.

TLS verification remains enabled, including overrides for URL-specific false settings. Git LFS’s X.509 errors are classified with other certificate failures. Native hash validation rejects corrupt content before replacing the pointer. Preflight refuses active operation markers, unmerged index stages, symlink/non-file checkout paths and redirected/oversized `.lfsconfig` files. File/config reads are bounded, cancellable and optimistic; they are not a transaction against external writers changing the repository after confirmation.

## LFS filters during ordinary Pull

The existing **Pull** flow fetches the upstream and integrates it using the selected fast-forward, merge or rebase policy. With native Git LFS filters already installed, that integration checks out incoming objects through Git's filter process. The service now retains the request's askpass environment during integration, so a filter can request credentials through the desktop dialog. It does not install or replace filters, override skip-smudge preferences, or force downloads in repositories without a configured filter. The separate reviewed LFS download remains available for pointer-only checkouts.

Saved-account pulls retain the same protected transport settings during integration as during fetch: credential helpers, HTTP headers/cookies, redirects and traces remain restricted, and askpass stays scoped to the reviewed repository URL. A separately authenticated LFS host may therefore require the Git credential helpers / SSH agent flow instead of the selected provider account. No credentials are added to the undo journal. Native certificate failures during integration use the transport error classification. Cancellation releases the Git process group and authentication scope; the normal Pull refresh exposes any partial checkout or operation state.

Native Linux fixtures cover authenticated fast-forward, merge and rebase checkouts, pointer retention in Git, full working-file contents, clean status, retained divergent local work, and undo/redo using the downloaded cache. A separate-host fixture proves saved-account integration does not fall back to a configured credential store or send the account token to that host. An untrusted HTTPS fixture proves certificate rejection before any HTTP request. Desktop fixtures cover repeated native authentication prompts for batch/object requests, successful checkout and cancellation before object download.

## Scope and remaining work

Local awareness, cached locks, reviewed HTTP(S) LFS pulls and ordinary Pull with installed native filters are implemented. The explicit LFS pull fixture downloads missing objects and preserves local edits. Feature 1.9 is **not complete**: current server lock refresh, the remaining reviewed-download transport modes and live-provider authenticated transport acceptance remain required. LFS setup/install and push behavior also need explicit treatment under the blueprint. Fresh authentication for checkout filters during other operations, including conflict continuation, remains unverified. Do not treat cached lock display as live locking support. Non-UTF-8 paths, cross-platform runtime acceptance and packaged LFS integration remain unverified.

Git LFS is an external prerequisite, not a bundled binary. Native tests run when Git LFS is on PATH; setting `OPENKRAKEN_LFS_TEST=1` requires it and fails rather than silently skipping. CI enables that requirement, verifies `git lfs version`, and installs the package in its Linux dependency step. The local acceptance binary is Git LFS 3.8.1, downloaded to an isolated cache and checked against the release SHA-256 manifest; it did not install global filters or hooks.

## Verification boundaries

Native service tests cover pointer/full-checkout/local-object states, Unicode/newline file names, missing CLI behavior, empty inventories and cached lock ownership without a second server request. Comparison tests cover valid and malformed pointers, ordered extension metadata, legacy v1 pointers and 64-bit sizes. Typed IPC rejects caller-selected paths, URLs and network options. Electron exercises pointer identity/size display and the local inventory, cached owners and refresh behavior. Broader milestone and release evidence is tracked in [M7 progress](../verification/m7-progress.md).

Additional native tests cover successful downloads, unchanged parent HEAD/index, preserved edits, configured exclusions, derived and overridden endpoints, stale/replayed reviews, pending/conflicted indexes, custom-program refusal, symlink guards, enforced TLS and corrupt-content retry. Electron tests exercise review dismissal/focus, stale configuration rejection, actual object checkout and cancellation against a stalled local HTTP endpoint. These are local Linux fixtures, not live-provider or cross-platform proof.

## References

- [Git LFS pointer specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
- [Git LFS file inventory](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-ls-files.adoc)
- [Git LFS cached and server locks](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-locks.adoc)
- [Git LFS pull](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-pull.adoc)

- [Git LFS checkout semantics](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-checkout.adoc)
- [Git LFS transfer configuration](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc)
- [Git LFS filter installation](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-install.adoc)
