# 0079 — Security boundaries and Git diagnostic redaction

M8's security review found that transport progress masked URL credentials, but a failing local hook could return raw stderr through the Git service's general error reply. Error replies and SSH host-key problem events now use the same URL redactor before crossing the service boundary. Saved-provider operations retain their existing fixed error messages; this does not broaden their diagnostic disclosure.

HTTP(S) userinfo, URL passwords and query/fragment parameters are masked. Userinfo ends at the last `@` in the authority: a literal `@` within a password must not leave a password suffix visible. Authority matching stops at `/`, `?` or `#`; a path such as `path@revision` remains useful diagnostic context. SSH usernames without passwords remain visible. Streaming progress continues to buffer complete UTF-8 lines before redaction and omits oversized lines.

This is structural URL redaction, not detection of arbitrary secrets in hook output, paths, prose or source content. General Git diagnostics remain local user-visible text. The persistent activity log stores allowlisted operation categories, identities, timestamps and outcomes instead of diagnostic text. Opt-in reporting accepts only fixed failure categories, as described in ADRs 0077–0078.

## Executable boundary checks

- A real native pre-commit hook fails with a credential-bearing URL. The Electron UI receives a masked error and retains the rejected commit draft.
- A script loaded from the renderer's allowed asset directory attempts inline scripts, `eval`, `Function`, external scripts, direct fetch, an embedded app document and a data-URL worker. Chromium emits the expected CSP violations, executable probes do not run, and Node globals remain absent. Window opening is denied.
- A second sandboxed BrowserWindow loads the exact app document and production preload. Both request and cancellation IPC are rejected by main's sender check; the primary window remains usable. Unit tests separately cover wrong frame URLs, missing frames, parent frames and non-main-frame identities.
- The real authentication socket rejects invalid/expired capabilities, unknown fields, invalid JSON, multiple frames and oversized input without returning a saved password. A subsequent native helper request still succeeds. Existing tests cover operation ownership, explicit SSH confirmation, cancellation, exact saved-credential URL binding and POSIX socket/directory modes.

These checks run against OpenKraken's own source and output. No proprietary application artifacts are involved. Linux execution does not establish Windows named-pipe ACL behavior or macOS execution.

## Remaining review scope

The application has no custom URI dispatcher or OS protocol registration yet. URI traversal acceptance is therefore open, not passed by absence. Rotating diagnostic log files are also not implemented; adding them requires redaction before persistence and bounded retention. Signed updates, native platform installers and broader release security acceptance remain separate unfinished work. This checkpoint is not a complete security assessment or M8 completion.
