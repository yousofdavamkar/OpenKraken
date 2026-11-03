# 0069 — Git LFS awareness

## Decision

OpenKraken uses the installed Git LFS CLI for repository inventory. The **Git LFS** toolbar command and command-palette entry detect `git lfs version`, then read `git lfs ls-files --json` and `git lfs locks --cached --json`. Opening or refreshing this view does not install filters, fetch objects or refresh server locks. Git LFS 3 or newer is required for this inventory. A missing command is reported separately from a failing or unsupported installation; repository access and pointer comparisons remain available.

The service maps native file names, SHA-256 identities, sizes, checkout flags and local object availability into a bounded typed response. Git LFS returns `files: null` for an empty inventory; this is normalized to an empty list. Invalid or excessive file output fails visibly. Cached-lock failures retain the file inventory and report a separate error. Version output is capped at 4 KiB, file output at 16 MiB and lock output at 8 MiB; lists are capped at 10,000 entries. The UI initially renders 200 entries with an explicit control to reveal more. Repository reads use the existing process pool, cancellation and per-repository read queue.

Native checkout flags do not distinguish a pointer from a missing working file. The UI therefore labels a false flag **Pointer or missing working file**. Local object availability is independent of checkout state. Cached owner names and lock times are displayed as cached information, and server lock state remains unknown. An empty cache is not presented as proof that a file is unlocked. No lock owner is inferred from a file permission bit or the current Git author.

Commit and working-file comparisons recognize canonical UTF-8 Git LFS pointer metadata without requiring Git LFS or running a filter. Recognition is bounded to pointers below 1 KiB, with supported v1 version strings, ordered unique keys, SHA-256 identity and a nonnegative signed-64-bit size. Size remains a decimal string through IPC to avoid precision loss. Unknown ordered metadata keys are not rewritten. Empty files remain ordinary empty files because their contents alone do not identify LFS tracking. Malformed, noncanonical or unsupported pointers remain ordinary content. Recognition applies only to regular-file modes.

Pointer comparisons show object identity and size instead of treating pointer text as the object’s content. They do not hydrate objects or offer text blame for pointer metadata. Existing explicit staging and editing workflows remain unchanged.

## Scope and remaining work

This increment implements local awareness and cached lock display. Feature 1.9 is **not complete**: reviewed object downloads and verification that pull fetches objects, current server lock refresh, and authenticated transport acceptance remain required. LFS setup/install and push behavior also need explicit treatment under the blueprint. Do not treat cached lock display as live locking support. Non-UTF-8 paths, cross-platform runtime acceptance and packaged LFS integration remain unverified.

Git LFS is an external prerequisite, not a bundled binary. Native tests run when Git LFS is on PATH; setting `OPENKRAKEN_LFS_TEST=1` requires it and fails rather than silently skipping. CI enables that requirement, verifies `git lfs version`, and installs the package in its Linux dependency step. The local acceptance binary is Git LFS 3.8.1, downloaded to an isolated cache and checked against the release SHA-256 manifest; it did not install global filters or hooks.

## Verification boundaries

Native service tests cover pointer/full-checkout/local-object states, Unicode/newline file names, missing CLI behavior, empty inventories and cached lock ownership without a second server request. Comparison tests cover valid and malformed pointers, ordered extension metadata, legacy v1 pointers and 64-bit sizes. Typed IPC rejects caller-selected paths, URLs and network options. Electron exercises pointer identity/size display and the local inventory, cached owners and refresh behavior. Broader milestone and release evidence is tracked in [M7 progress](../verification/m7-progress.md).

## References

- [Git LFS pointer specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
- [Git LFS file inventory](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-ls-files.adoc)
- [Git LFS cached and server locks](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-locks.adoc)
- [Git LFS pull](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-pull.adoc)
