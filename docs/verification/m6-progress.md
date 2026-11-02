# M6 progress — provider integrations

M6 is in progress as of 2026-11-01, at implementation checkpoint `21eb87e`. M0–M5 retain their documented Linux acceptance scope; M6–M8 remain open. React 19.3.1 and TypeScript 7.0.2 remain pinned.

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
- Provider/vault queues retain only completion, avoiding retention of the last decrypted credential value.
- Shutdown cancels provider validation and waits for pending profile work alongside the Git service, retaining the existing deadline and editor Quit-cancellation behavior.

## Verification

| Check                                                                | Result                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Full Vitest suite                                                    | 249 tests passed across 41 files                            |
| Combined Electron suite with Gitea enabled                           | 60 passed; one dedicated large-repository benchmark skipped |
| TypeScript build, ESLint and Prettier                                | Passed                                                      |
| Linux package, fuse verification and packaged isolation/helper smoke | Passed                                                      |
| 2,000-commit graph first paint                                       | 225.9 ms                                                    |
| Next 5,000 graph commits including worker/layout/UI                  | 166.1 ms                                                    |
| 12,000-row graph scroll frame p95                                    | 16.8 ms                                                     |
| 50,000-line comparison open                                          | 326.6 ms                                                    |
| 10,000-line blame first screen                                       | 95.0 ms                                                     |

The full desktop run passed the new repository picker/clone and account-switch cancellation tests, graph goldens, native HTTPS/SSH transport, rejected pushes, staging, watcher, integration and editor lifecycle checks. Device-flow fixtures cover initial polling, slow-down, expiry, denial, redirect refusal, overlapping polls/cancellation, refresh exchange and identity mismatch refusal. Desktop coverage shows the public user code, verifies the exact browser destination, saves the validated account and exercises cancel/close/restart without polling obsolete codes. Timings are local Linux observations, not cross-platform claims. The Undo/Redo desktop fixture now waits for UI completion before inspecting the index; HEAD can move before the private index is published. It passed three isolated repeats and the full rerun.

Provider tests use MSW API fixtures, authenticated encryption at the OS boundary and real temporary profile files. Electron acceptance replaces only OS encryption and provider responses, keeping the actual main/preload/UI routing, profile persistence and restart. Repository fixtures additionally cover malformed pages, canonical clone URLs, bounds and protected refresh during browsing. The manual-helper picker test invokes native clone with a test-only URL rewrite to a local source. A separate saved-account test uses a locally trusted authenticated HTTPS server and the actual native helper. It verifies token-free renderer events/config/profile metadata and cancellation during account validation before native transport starts. Native fixtures also verify exact prompt scope, rewrite/redirect refusal and absence of plaintext credential-store or curl-trace files. The saved-fetch desktop fixture verifies imported refs, refusal when settings change during validation, early refusal of stale dialog state and cancellation before native network use. Actual desktop keychain availability and live GitHub/GHES authentication have not been verified. The artifact remains an unsigned Linux platform bundle.

## Remaining

Saved-provider credentials for pull/push and GitHub PR flows come next, followed by GitLab and the other planned providers. Checks/issues, repository fork/create, SSH key upload, PR templates/review/merge and saved-account integration for the remaining Git transports remain open. GitLab PKCE and provider fixture coverage are still required; optional Jira is lower priority. No server component is planned. A device flow requires a configured OAuth application client ID, not an invented or borrowed registration.

Account sign-in, repository picking and saved-account HTTPS clone/foreground fetch are implemented slices, not completion of M6. A user-supplied OAuth application client ID is required for live device authorization; no registration was invented or borrowed. Refreshing uses the stored client ID and protected refresh token. A server-side rotation followed by a failed local write can require signing in again. Existing Git credential helpers and SSH agents continue to handle manual clone/fetch/push; provider-selected HTTPS clones and foreground fetches can use their protected account credential. Automatic fetch retains its existing noninteractive helper flow. Cross-file credential/metadata crash recovery, real-keychain and cross-platform runtime acceptance remain further work.

Decisions: [provider credentials](../decisions/0026-provider-credentials.md), [GitHub device authorization](../decisions/0027-github-device-authorization.md), [provider repository picker](../decisions/0028-provider-repository-picker.md), [provider Git authentication](../decisions/0029-provider-git-authentication.md), [provider remote authentication](../decisions/0030-provider-remote-authentication.md).
