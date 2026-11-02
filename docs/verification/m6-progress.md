# M6 progress — provider integrations

M6 is in progress as of 2026-11-01, at implementation checkpoint `a32b6dc`. M0–M5 retain their documented Linux acceptance scope; M6–M8 remain open. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Implemented

- A main-process provider boundary and Octokit GitHub/GHES account validation using HTTPS-only configured origins, cookie-free requests, redirect refusal, cancellation, timeouts and bounded response bodies.
- OS-protected credential storage through asynchronous Electron safeStorage, refusal of Linux plaintext/unknown backends, encrypted account-bound envelopes, serialized atomic writes and key rotation.
- A desktop account dialog with token validation, metadata-only responses, offline account listing, reconnection after login changes, local forgetting and cancellation when setup closes.
- Strict IPC schemas keep saved provider credentials out of renderer requests and responses and reject malformed origins without leaking raw URL exceptions. Tokens are cleared from the password field before requests; provider error bodies and request diagnostics are not shown.
- GitHub device authorization with a configured client ID, explicit private-repository scope, fixed browser destination, main-enforced polling/slow-down/expiry and cancellation. Private device codes remain in main.
- Protected access/refresh-token storage, identity validation after sign-in, and a Verify action that refreshes expiring device credentials while checking the original account identity.
- GitHub/GHES repository pages with identity validation and protected refresh, canonical HTTPS clone URLs, bounded metadata and explicit paging limits.
- A provider repository picker in Clone with virtualized rows, loaded-result search, append/deduplication, keyboard selection, account switching, cancellation and retry. Selection feeds the existing native clone flow.
- Saved-account HTTPS cloning through a URL-bound native askpass scope, with no renderer prompts, plaintext helper store, token environment variables or token command arguments. Per-operation safeguards refuse rewrites and redirects, retain TLS verification and disable trace output.
- Foreground HTTPS fetch with a saved account selected in Manage remotes. Main checks the displayed remote revision before credential access; the Git service rechecks URL/configuration under its repository queue. Stale, changed and cancelled attempts do not contact the Git server.
- Saved-account HTTPS push review and execution using the configured push URL. Account selection locks after review; local-source/configuration guards, non-fast-forward rejection and exact force-with-lease remain enforced. Review again reloads remote metadata.
- Saved-account HTTPS pull with local-only upstream/URL/policy review, separate working-state and remote revision checks, refusal after configuration changes during account validation, and retained integration/Undo behavior.
- Saved-account remote branch/tag deletion with push-direction resolution, a locked account/ref review, separate confirmation and exact server-tip leases. Closing a review preserves server refs; rejected leases require re-review. Local branches and tags remain intact.
- Repository-scoped GitHub/GHES PR lists and details with protected account validation, strict selectors, bounded paging/metadata, canonical display URLs and sanitized failures.
- A desktop PR panel with repository selection, virtualized append/deduplication, state filters, loaded-result search, keyboard navigation, detail retry/refresh and cancellation on repository changes or close. Descriptions render as text.
- Revision-checked GitHub/GHES changed-file pages with rename metadata, bounded/missing provider patches, virtualized keyboard selection and read-only CodeMirror display.
- Paged review records and an explicit preview/submit composer for comments, approvals and requests for changes. Main checks displayed head/base and PR state, binds the reviewed head, and never retries an uncertain write automatically. Draft text survives errors and review inspection is available after uncertainty.
- Provider/vault queues retain only completion, avoiding retention of the last decrypted credential value.
- Shutdown cancels provider validation and waits for pending profile work alongside the Git service, retaining the existing deadline and editor Quit-cancellation behavior.

## Verification

| Check                                                                | Result                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Full Vitest suite                                                    | 268 tests passed across 42 files                            |
| Combined Electron suite with Gitea enabled                           | 65 passed; one dedicated large-repository benchmark skipped |
| TypeScript build, ESLint and Prettier                                | Passed                                                      |
| Linux package, fuse verification and packaged isolation/helper smoke | Passed                                                      |
| 2,000-commit graph first paint                                       | 252.5 ms                                                    |
| Next 5,000 graph commits including worker/layout/UI                  | 177.2 ms                                                    |
| 12,000-row graph scroll frame p95                                    | 16.8 ms                                                     |
| 50,000-line comparison open                                          | 495.4 ms                                                    |
| 10,000-line blame first screen                                       | 174.6 ms                                                    |

The full desktop run passed PR files/reviews/submission as well as PR paging/details/retry/cancellation, saved-account remote deletion review/confirmation/leases, pull review/Undo, push review/lease handling, repository picker/clone and account-switch cancellation tests, graph goldens, native HTTPS/SSH transport, rejected pushes, staging, watcher, integration and editor lifecycle checks. Device-flow fixtures cover initial polling, slow-down, expiry, denial, redirect refusal, overlapping polls/cancellation, refresh exchange and identity mismatch refusal. Desktop coverage shows the public user code, verifies the exact browser destination, saves the validated account and exercises cancel/close/restart without polling obsolete codes. Timings are local Linux observations, not cross-platform claims. The Undo/Redo desktop fixture waits for UI completion before inspecting the index; HEAD can move before the private index is published.

Provider tests use MSW API fixtures, authenticated encryption at the OS boundary and real temporary profile files. Electron acceptance replaces only OS encryption and provider responses, keeping the actual main/preload/UI routing, profile persistence and restart. Repository fixtures additionally cover malformed pages, canonical clone URLs, bounds and protected refresh during browsing. The manual-helper picker test invokes native clone with a test-only URL rewrite to a local source. A separate saved-account test uses a locally trusted authenticated HTTPS server and the actual native helper. It verifies token-free renderer events/config/profile metadata and cancellation during account validation before native transport starts. Native fixtures also verify exact prompt scope, rewrite/redirect refusal and absence of plaintext credential-store or curl-trace files.

The saved-fetch desktop fixture verifies imported refs, refusal when settings change during validation, early refusal of stale dialog state and cancellation before native network use. The Gitea saved-account push fixture verifies upstream tracking, divergent-push rejection, refusal after the remote tip changes and success after re-review, with no credential leakage into renderer events or Git configuration. Native coverage checks direction-specific push URLs and changed-target refusal.

Saved-pull acceptance verifies a local-only review, refusal when upstream configuration changes during validation, successful HTTPS integration and Undo. Native checks distinguish fetch/push URLs and prevent a changed local upstream from bypassing provider validation.

Saved-deletion Gitea acceptance covers both branch and annotated-tag refs: closing review preserves the server ref, competing updates reject the lease, and confirmation after a fresh review deletes only the server ref. Native tests additionally refuse changed deletion targets before writes.

PR review fixtures verify file/review page limits, malformed metadata, omitted/truncated patches, stale head and base refusal, closed/draft restrictions, all review actions, cancellation before dispatch and uncertain acknowledgments with exactly one POST. Electron coverage verifies file paging/keyboard navigation, literal read-only patches, draft discard, preview-before-send, stale rejection, commit-bound approval, review refresh and uncertain-outcome inspection without duplicate submission.

PR fixture acceptance verifies GitHub list/details and Enterprise paging, malformed metadata, pagination limits, canonical URLs, deleted authors, cancellation and sanitized failures. Desktop coverage verifies append/deduplication, bounded list DOM rows, search/keyboard selection, detail retry, literal markup, state changes and cancellation on repository changes or close.

Actual desktop keychain availability and live GitHub/GHES authentication have not been verified. The artifact remains an unsigned Linux platform bundle.

## Remaining

Inline GitHub review comments/threads, PR creation/templates and merge come next, followed by GitLab and the other planned providers. Polling, checks/issues, repository fork/create and SSH key upload remain open. Provider patches and whole-PR submitted reviews are implemented; durable review drafts and recovery of external writes across app quit/reload/crash remain hardening work. GitLab PKCE and provider fixture coverage are still required; optional Jira is lower priority. No server component is planned. A device flow requires a configured OAuth application client ID, not an invented or borrowed registration.

Account sign-in, repository picking and saved-account HTTPS clone, foreground fetch, reviewed push/pull, remote deletion, PR browsing/files and submitted reviews are implemented slices, not completion of M6. A user-supplied OAuth application client ID is required for live device authorization; no registration was invented or borrowed. Refreshing uses the stored client ID and protected refresh token. A server-side rotation followed by a failed local write can require signing in again. Existing Git credential helpers and SSH agents continue to handle manual clone/fetch/push; provider-selected HTTPS clones, foreground fetches, reviewed pushes/pulls and remote deletions can use their protected account credential. Automatic fetch retains its existing noninteractive helper flow. Authenticated lazy fetching during partial-clone working-tree operations needs acceptance coverage. Cross-file credential/metadata crash recovery, real-keychain and cross-platform runtime acceptance remain further work.

Decisions: [provider credentials](../decisions/0026-provider-credentials.md), [GitHub device authorization](../decisions/0027-github-device-authorization.md), [provider repository picker](../decisions/0028-provider-repository-picker.md), [provider Git authentication](../decisions/0029-provider-git-authentication.md), [provider remote authentication](../decisions/0030-provider-remote-authentication.md), [provider PR browsing](../decisions/0031-provider-pull-requests.md), [PR files and reviews](../decisions/0032-provider-pull-reviews.md).
