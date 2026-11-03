# M8 progress — hardening and release

M8 remains in progress. The current implementation checkpoint is `e874b32`, adding local commit drafts after native command supervision at `bba9063` and crash regression tests at `d68c18b`. It does not establish release completion or close the remaining [M6](m6-progress.md) and [M7](m7-progress.md) scope.

## Local commit drafts

Main-only draft persistence (`9ff7aa5`) and the commit-form integration (`e874b32`) save separate normal/amend text and signing choices for each checkout. Acknowledged text survives a forced renderer crash and app restart. Changed-HEAD amendment remains blocked until review; failed commits and edits made during a running commit retain text. Successful amendments keep the separate next-commit draft. Revision checks reject stale saves, and corrupt, externally changed or redirected storage is preserved with a warning. See [ADR 0072](../decisions/0072-local-commit-drafts.md).

The increment passed **592 native/unit tests in 77 files** with explicit `UNIT_EXIT=0`, typechecking/build, full ESLint/Prettier, and four focused Electron scenarios with explicit `E2E_EXIT=0`. The restored-draft screenshot was visually inspected. Native contract tests cover strict main-only routes and bounded payloads. Electron coverage includes renderer crash/restart, successful clearing, failed hooks, newer edits during a blocked commit, linked-worktree separation, amend toggle retention, changed-HEAD refusal, unknown identities, stale saves, private file permissions, external changes and corrupt/symlinked storage.

The subsequent **complete desktop suite passed 163 tests**, with one opt-in real-repository benchmark skipped and explicit `E2E_EXIT=0`. Native Git LFS 3.8.1 and the local Gitea HTTPS/SSH fixture were enabled. First paint for 2,000 commits measured **266.0 ms**, a 5,000-commit page **162.7 ms**, 12,000-row scrolling **16.7 ms p95**, the 50,000-line comparison **498.6 ms**, and 10,000-line blame first screen **257.1 ms**. Six graph visual goldens passed unchanged. These are Linux fixture measurements; the skipped real-repository benchmark and cross-platform runtime gates remain open. Full-suite evidence is `/tmp/openkraken-drafts-full-e2e.log`.

A fresh unsigned Linux x64 package passed fuse verification and packaged smoke checks with explicit `PACKAGE_EXIT=0` and `SMOKE_EXIT=0`: renderer isolation, native askpass/editor helpers, the native folder picker, repository opening, Bash integration, keyboard delivery and terminal exit. Evidence is `/tmp/openkraken-drafts-{package,smoke}.log`. This smoke checks packaged startup and existing native integrations; draft crash/restart scenarios were exercised in the Electron suite above, not against the packaged executable.

The first test reproduced missing persistence. A later test reproduced edited amend text being replaced on toggle; that behavior is corrected. A changed-HEAD fixture originally created an empty commit that native Git correctly refused to amend; it now creates a content change. Playwright retained a crashed page handle after native reload, so crash recovery is verified through app restart. No performance budget or timeout was relaxed. Evidence is `/tmp/openkraken-drafts-{red,green,amend-red,guards,amend-diagnostic,crash-green,recovery-green,unit,types,lint,recovery-build}.log`.

Draft files are local plaintext. The UI distinguishes pending, acknowledged and failed saves. Crashes before acknowledgment can lose the newest edits, and a crash after Git succeeds but before draft clearing can restore already-submitted text. This does not establish a transaction journal, native lock recovery or durability for other editors/composers.

## Native command supervision

The Git utility configures the bundled native helper before starting Git discovery or repository commands. Each command receives a supervisor that retains its process-group identity on POSIX or joins a private Windows Job Object. Parent death stops ordinary active descendants. Existing argument vectors, environment isolation, streamed output, cancellation and deadlines remain in place. See [ADR 0071](../decisions/0071-native-process-supervision.md) for platform behavior and limitations.

A native fetch to a stalled local HTTP endpoint reproduced the leak before the change: its connection remained open after the Git utility died. The same regression now observes closure before the server releases any connections and reopens the repository through a replacement service. A Linux commit-hook fixture kills the utility while a signal-ignoring hook and its child are active; both stop and HEAD, index entries and staged content remain intact. This particular fixture does not establish rollback or lock recovery for arbitrary interrupted writes.

## Verification

- **591 native/unit tests in 77 files**, explicit `UNIT_EXIT=0`, including four supervisor tests for binary input, streamed output, literal arguments, exit codes, output limits, deadlines, parser errors and cancellation after a direct child exits while its descendant retains streams.
- **51 targeted Electron tests**, explicit `E2E_EXIT=0`: service crashes, activity, authentication, graph, working tree, operations, submodules, LFS and terminal. Git LFS 3.8.1 was enabled. This was not the complete desktop suite or live-provider acceptance.
- A 5,000-commit page including worker layout/UI update measured **152.7 ms**; scrolling with 12,000 rows measured **16.8 ms p95**. Six graph visual goldens passed unchanged. No timing budget was relaxed.
- Typechecking, build, full ESLint/Prettier, Go vet and Go formatting passed. Windows amd64 and macOS arm64 helper cross-compilation passed; neither is runtime evidence.
- The unsigned Linux x64 package built and its fuse bytes passed verification, explicit `PACKAGE_EXIT=0`. Packaged renderer isolation, native askpass/editor helpers, native folder picker, repository opening, Bash integration, keyboard delivery and terminal exit passed, explicit `SMOKE_EXIT=0`. The terminal screenshot was visually inspected. The first smoke attempt failed because `xdotool` was absent from PATH; using the existing cached executable resolved that environment setup issue without product changes.

Evidence: `/tmp/openkraken-supervisor-{red,green,native,hook,unit,e2e,types,build,lint,package,smoke,smoke-recheck}.log`. Unit, lint, typecheck, desktop, package and smoke terminal exit codes were captured separately from redirected logs.

## Remaining work

- Native supervision runtime acceptance on Windows/macOS, broader prompt/editor and main-process crash scenarios, native lock handling and durable write recovery. POSIX processes that intentionally detach or daemonize beyond the active command's stream lifetime are not contained.
- Durable drafts for working-file, conflict/native editors and provider composers; commit-form drafts are implemented within the bounds above. Opt-in crash reporting, signature-verified updates, signed installers/distribution, security review and beta evidence remain open.
- Broader real-repository and cross-platform performance/regression gates, plus the unresolved intermittent command exit-143 investigation recorded in M7 progress.

Interrupted operations retain an unknown activity outcome. Process cleanup does not prove that a remote write failed, reverse completed changes or authorize an automatic retry. Linux fixtures and an unsigned local bundle do not establish production release readiness.
