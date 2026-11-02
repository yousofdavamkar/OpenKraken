# M6 progress — provider integrations

M6 is in progress as of 2026-11-01, at implementation checkpoint `ff0668c`. M0–M5 retain their documented Linux acceptance scope; M6–M8 remain open. React 19.3.1 and TypeScript 7.0.2 remain pinned.

## Implemented

- A main-process provider boundary and Octokit GitHub/GHES account validation using HTTPS-only configured origins, cookie-free requests, redirect refusal, cancellation, timeouts and bounded response bodies.
- OS-protected credential storage through asynchronous Electron safeStorage, refusal of Linux plaintext/unknown backends, encrypted account-bound envelopes, serialized atomic writes and key rotation.
- A desktop account dialog with token validation, metadata-only responses, offline account listing, reconnection after login changes, local forgetting and cancellation when setup closes.
- Strict IPC schemas keep provider credentials out of the Git service and reject malformed origins without leaking raw URL exceptions. Tokens are cleared from the password field before requests; provider error bodies and request diagnostics are not shown.
- Shutdown cancels provider validation and waits for pending profile work alongside the Git service, retaining the existing deadline and editor Quit-cancellation behavior.

## Verification

| Check                                                                | Result                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Full Vitest suite at the final checkpoint                            | 231 tests passed across 40 files                            |
| Combined Electron suite with Gitea at `c4a83ed`                      | 54 passed; one dedicated large-repository benchmark skipped |
| Provider desktop suite after the final malformed-origin guard        | 3 passed                                                    |
| TypeScript build, ESLint and Prettier                                | Passed                                                      |
| Linux package, fuse verification and packaged isolation/helper smoke | Passed                                                      |
| 2,000-commit graph first paint                                       | 233.8 ms                                                    |
| Next 5,000 graph commits including worker/layout/UI                  | 164.8 ms                                                    |
| 12,000-row graph scroll frame p95                                    | 16.7 ms                                                     |
| 50,000-line comparison open                                          | 385.1 ms                                                    |
| 10,000-line blame first screen                                       | 103.3 ms                                                    |

The full desktop run passed graph goldens, native HTTPS/SSH transport, rejected pushes, staging, watcher, integration and editor lifecycle checks. A subsequent IPC regression reproduced a malformed-URL exception; its fix passed the focused provider/security unit tests, a fresh complete unit suite and the three provider desktop tests. Timings are local Linux observations, not cross-platform claims.

Provider tests use MSW API fixtures, authenticated encryption at the OS boundary and real temporary profile files. Electron acceptance replaces only OS encryption and provider responses, keeping the actual main/preload/UI routing, profile persistence and restart. Actual desktop keychain availability and live GitHub/GHES authentication have not been verified. The artifact remains an unsigned Linux platform bundle.

## Remaining

GitHub device authorization and repository/PR flows come next, followed by GitLab and the other planned providers. Checks/issues, provider repository picker/fork/create, SSH key upload, PR templates/review/merge and native Git credential integration remain open. GitLab PKCE and provider fixture coverage are still required; optional Jira is lower priority. No server component is planned. A device flow requires a configured OAuth application client ID, not an invented or borrowed registration.

The current token form is an initial account-management slice, not completion of the required device flow or M6. Existing Git credential helpers and SSH agents continue to handle clone/fetch/push. Cross-file credential/metadata crash recovery, real-keychain and cross-platform runtime acceptance remain further work.

Decision: [provider credentials](../decisions/0026-provider-credentials.md).
