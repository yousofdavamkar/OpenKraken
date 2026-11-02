# M6 progress — provider integrations

M6 is in progress as of 2026-11-01, at implementation checkpoint `355b98a`. M0–M5 retain their documented Linux acceptance scope; M6–M8 remain open. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Implemented

- A main-process provider boundary and Octokit GitHub/GHES account validation using HTTPS-only configured origins, cookie-free requests, redirect refusal, cancellation, timeouts and bounded response bodies.
- OS-protected credential storage through asynchronous Electron safeStorage, refusal of Linux plaintext/unknown backends, encrypted account-bound envelopes, serialized atomic writes and key rotation.
- A desktop account dialog with token validation, metadata-only responses, offline account listing, reconnection after login changes, local forgetting and cancellation when setup closes.
- Strict IPC schemas keep provider credentials out of the Git service and reject malformed origins without leaking raw URL exceptions. Tokens are cleared from the password field before requests; provider error bodies and request diagnostics are not shown.
- GitHub device authorization with a configured client ID, explicit private-repository scope, fixed browser destination, main-enforced polling/slow-down/expiry and cancellation. Private device codes remain in main.
- Protected access/refresh-token storage, identity validation after sign-in, and a Verify action that refreshes expiring device credentials while checking the original account identity.
- GitHub/GHES repository pages with identity validation and protected refresh, canonical HTTPS clone URLs, bounded metadata and explicit paging limits.
- A provider repository picker in Clone with virtualized rows, loaded-result search, append/deduplication, keyboard selection, account switching, cancellation and retry. Selection feeds the existing native clone flow.
- Shutdown cancels provider validation and waits for pending profile work alongside the Git service, retaining the existing deadline and editor Quit-cancellation behavior.

## Verification

| Check                                                                | Result                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Full Vitest suite                                                    | 242 tests passed across 41 files                            |
| Combined Electron suite with Gitea enabled                           | 58 passed; one dedicated large-repository benchmark skipped |
| TypeScript build, ESLint and Prettier                                | Passed                                                      |
| Linux package, fuse verification and packaged isolation/helper smoke | Passed                                                      |
| 2,000-commit graph first paint                                       | 241.2 ms                                                    |
| Next 5,000 graph commits including worker/layout/UI                  | 162.9 ms                                                    |
| 12,000-row graph scroll frame p95                                    | 16.7 ms                                                     |
| 50,000-line comparison open                                          | 328.3 ms                                                    |
| 10,000-line blame first screen                                       | 152.9 ms                                                    |

The full desktop run passed the new repository picker/clone and account-switch cancellation tests, graph goldens, native HTTPS/SSH transport, rejected pushes, staging, watcher, integration and editor lifecycle checks. Device-flow fixtures cover initial polling, slow-down, expiry, denial, redirect refusal, overlapping polls/cancellation, refresh exchange and identity mismatch refusal. Desktop coverage shows the public user code, verifies the exact browser destination, saves the validated account and exercises cancel/close/restart without polling obsolete codes. Timings are local Linux observations, not cross-platform claims.

Provider tests use MSW API fixtures, authenticated encryption at the OS boundary and real temporary profile files. Electron acceptance replaces only OS encryption and provider responses, keeping the actual main/preload/UI routing, profile persistence and restart. Repository fixtures additionally cover malformed pages, canonical clone URLs, bounds and protected refresh during browsing. The desktop picker test invokes real native clone with a test-only URL rewrite to a local source; it does not establish live provider clone or saved-token supply to Git. Actual desktop keychain availability and live GitHub/GHES authentication have not been verified. The artifact remains an unsigned Linux platform bundle.

## Remaining

Saved-provider credentials for native Git and GitHub PR flows come next, followed by GitLab and the other planned providers. Checks/issues, repository fork/create, SSH key upload, PR templates/review/merge and native Git credential integration remain open. GitLab PKCE and provider fixture coverage are still required; optional Jira is lower priority. No server component is planned. A device flow requires a configured OAuth application client ID, not an invented or borrowed registration.

Account sign-in and repository picking are implemented slices, not completion of M6. A user-supplied OAuth application client ID is required for live device authorization; no registration was invented or borrowed. Refreshing uses the stored client ID and protected refresh token. A server-side rotation followed by a failed local write can require signing in again. Existing Git credential helpers and SSH agents continue to handle clone/fetch/push. Cross-file credential/metadata crash recovery, real-keychain and cross-platform runtime acceptance remain further work.

Decisions: [provider credentials](../decisions/0026-provider-credentials.md), [GitHub device authorization](../decisions/0027-github-device-authorization.md), [provider repository picker](../decisions/0028-provider-repository-picker.md).
