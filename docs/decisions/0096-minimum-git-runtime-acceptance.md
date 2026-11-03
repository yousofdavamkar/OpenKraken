# 0096 — Execute compatibility gates with the minimum Git runtime

## Context

The roadmap requires Git 2.38 and current Git coverage. Simulating an unknown-option result verifies fallback control flow, but does not establish that native Git 2.38 accepts the application's commands or returns compatible data. The large-reference reader now makes this distinction particularly relevant.

## Decision

Build the exact minimum, Git 2.38.0, into an isolated test prefix using `scripts/build-minimum-git.sh`. Download the official source archive over HTTPS and check its pinned SHA-256 from the [kernel.org checksum manifest](https://www.kernel.org/pub/software/scm/git/sha256sums.asc) before extraction. Refuse an existing prefix. Keep HTTP/TLS support; omit Git's GUI and gettext translations. This is a compatibility fixture, not a bundled product Git or a recommendation to install an old release for ordinary use. The system Git remains unchanged.

A separate Linux CI job selects this executable through both `PATH` (fixtures and native tests) and `OPENKRAKEN_GIT` (the Electron Git service), verifies the selected path/version, and runs the full native/unit suite with Git LFS plus targeted desktop acceptance. The desktop selection covers repository opening, Canvas/search/paging/navigation, reference operations and the large sidebar, merge/rebase operations, worktrees, submodules, renderer security and serialized IPC. Test logs and desktop evidence are retained; Bash pipefail keeps logging from masking failed tests. The existing system-Git job remains in place.

The reference-reader suite adds a test that forwards every command to native Git. It compares all records across two reads and checks that unsupported pagination is probed once, uses complete enumerations and never launches pages. On current Git the same test requires successful probing and native pages. Separate simulated-error tests remain useful for deterministic failure coverage.

## Limits

Native Linux x64 results do not establish Windows, macOS or Linux ARM64 acceptance. Modern-only paging cases are intentionally skipped on Git 2.38; the current-Git suite covers them. The selected desktop tests are not the full desktop suite, live-provider acceptance, packaging or the large-repository performance gate. Remote CI configuration is not evidence of an executed remote run. Verification results belong in the M8 progress record.
