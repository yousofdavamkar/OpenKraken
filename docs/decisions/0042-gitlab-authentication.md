# GitLab authentication and provider routing

Date: 2026-11-02

## Decision

GitLab.com and self-managed GitLab accounts use their configured HTTPS origin, the Gitbeaker `Users.showCurrentUser` endpoint at `/api/v4/user`, and the existing account-bound protected credential vault. Provider type participates in account IDs and vault scopes, so a GitHub account with the same host and numeric user ID cannot overwrite a GitLab credential. Login changes preserve the account ID; every authorized operation checks the saved numeric identity.

The account dialog supports PATs and public-client OAuth authorization code with S256 PKCE. Users supply their own registered application ID; OpenKraken does not invent or borrow a registration. The application must have Confidential disabled, permit the `api` scope, and register the exact callback URL displayed by the dialog. The default port is 47653 and can be changed to another unprivileged port. A fixed user-selected port makes the registered redirect URI repeatable; there is no silent fallback to an unregistered port.

The HTTP listener binds only `127.0.0.1`, with `/callback` as its sole accepted path. Only a GET with the exact Host header, one matching unpredictable state, and one code or error can complete the callback. The verifier, state, authorization code and tokens stay in main; IPC returns only a session ID, origin, callback URI and expiry. Browser opening takes an existing session ID, never a renderer-supplied URL. The code is single-use. The listener closes after accepting a callback; code exchange and identity validation run on the next local status poll. Callback responses contain no authorization material and use no-store and no-referrer headers.

Sessions expire after ten minutes and are cancelled when replaced, explicitly cancelled, the account dialog closes, the renderer navigates/reloads or crashes, the window closes, or the app quits. Aborting an exchange prevents late account creation. Invalid callback attempts do not consume the session. Occupied ports produce a bounded error and do not contact or replace the existing listener.

GitLab rotates refresh tokens. When a token is within one minute of expiry, main refreshes it and saves the replacement in the protected vault before the next identity request. This lets a later verification recover after a transient identity-read failure. Identity mismatch still blocks credential use. A failed local write after server rotation, or an interrupted token response, can require sign-in again. OAuth Git transport uses username `oauth2`; PAT transport uses the validated login. Existing URL-bound native transport safeguards still apply.

Gitbeaker runs through a custom requester using the isolated provider network partition. Identity and OAuth responses are capped at 32 KiB, time out after twenty seconds, omit cookies and reject redirects. Raw provider errors, request diagnostics and tokens never become public errors. Gitbeaker's default retry loop is not used. Identity rate-limit responses feed the existing bounded cooldown policy, including GitLab's `RateLimit-Remaining` and `RateLimit-Reset` headers.

## Scope and validation

This is an authentication foundation. GitLab repository discovery, nested namespace selectors, merge requests, issues and pipelines remain subsequent M6 work. Unsupported collaboration requests explicitly fail instead of routing a GitLab token to a GitHub endpoint. The current saved-account clone URL contract still supports only one namespace component.

Service/MSW tests exercise protected account separation and restart, malformed responses, cooldowns, a real loopback listener, S256 verification, forged/duplicate callbacks, denial, expiry, occupied ports, cancelled exchange, single-use codes and refresh recovery. Typed IPC tests reject arbitrary callback/browser URLs and private PKCE fields. Real Electron tests exercise PAT and PKCE account setup, browser dispatch, profile persistence, cancellation, reload and unavailable OS protection with only OS encryption and provider HTTP replaced by fixtures.

Live GitLab authorization, real OS keychain behavior and macOS/Windows acceptance remain unverified. Loopback binding is the spec's native-client choice; installations that disallow the registered HTTP loopback URI can use a PAT. There are no live-provider writes in these tests.

## Public references

- [GitLab OAuth API and PKCE](https://docs.gitlab.com/api/oauth2/)
- [GitLab CLI public application configuration](https://docs.gitlab.com/cli/authentication/)
- [GitLab REST authentication](https://docs.gitlab.com/api/rest/authentication/)
- [Gitbeaker](https://github.com/jdalrymple/gitbeaker)
