# GitLab fixture connection reuse

The 2026-11-02 ordinary-LFS-pull full unit run passed 555 tests but failed one GitLab merge-file fixture with `PROVIDER_REQUEST`. Similar intermittent failures had been recorded in earlier milestones. This investigation establishes a fixture transport problem for the reproduced failure; it cannot retroactively prove that every earlier generic request failure had the same cause.

Thirty isolated runs of `apps/desktop/gitlab-merges.test.ts` passed. Eight temporary copies of that file, run together through Vitest, reproduced four failures among 72 tests in 2.17 seconds. The single failing test and a smaller file/cancellation subset did not reproduce it. Full concurrent copies reproduced it again in bounded loops.

Temporary diagnostics at the provider's existing error boundary found native `TypeError: fetch failed`, caused by an `AggregateError` containing `ETIMEDOUT`/`ENETUNREACH` connections to gitlab.com:443. No real connection should be needed by this MSW fixture. This was not a schema assertion, provider response, or application retry failure. Diagnostics logged only error names and redacted messages, not request headers or tokens, and were removed afterward.

Changing only fixture JSON responses to include `Connection: close` passed ten consecutive batches of eight copies: **720 checks**. Restoring the original responses reproduced four real-network escapes in the fourth control batch. The retained workaround closes each fixture response while preserving response bodies, status and other headers. Production transport, error handling and test expectations are unchanged. The precise defect within MSW 3.0.3 / interceptors 0.45.11 / native connection pooling remains unproven; this is a fixture mitigation, not an upstream fix or evidence that real GitLab networking is faulty.

Local evidence:

- `/tmp/openkraken-lfs-integration-final-unit.log`: original full-suite failure.
- `/tmp/openkraken-gitlab-repro-{1..30}.log`: isolated passes.
- `/tmp/openkraken-gitlab-parallel-repro.log`: concurrent reproduction.
- `/tmp/openkraken-gitlab-probe-3.log`, `/tmp/openkraken-gitlab-cause-2.log`, `/tmp/openkraken-gitlab-nested-1.log`: progressively narrowed diagnostics.
- `/tmp/openkraken-gitlab-close-{1..10}.log`: workaround passes.
- `/tmp/openkraken-gitlab-control-4.log`: restored-control failure.

To repeat the control experiment, create eight temporary test files alongside the original with the contents of `apps/desktop/gitlab-merges.test.ts` from commit `d2d35d0`. Run `pnpm exec vitest run apps/desktop/gitlab-repro-*.test.ts` in a bounded loop of ten attempts. For the workaround comparison, copy the current fixture instead. Remove all temporary copies afterward. Do not run packaging or Electron acceptance while changing test/build artifacts. The failure is intermittent: one passing control run is not sufficient evidence that it is absent.

## Provider cancellation and rejection fixtures

During AppImage verification the full suite failed six GitHub, GitLab and Bitbucket fixture tests. The six suites failed together on a second run. Some calls produced generic transport errors where a mocked authentication or rejection status was expected. Two cancellation tests timed out waiting for their pending request to reach the handler. One affected file passed in isolation.

The shared test fixture now sets `Connection: close` on requests before sending them through MSW. This also applies when a handler is waiting for cancellation and has not sent response headers yet. The original six suites passed five consecutive grouped runs (38 tests per run). A full rerun revealed the same class of failure in the GitLab merge-action fixture. Using the same fixture there passed all seven suites together (44 tests). Production transports keep their existing connection policy.
