# 0080 — Local repository links with explicit review

The specification requires an independent URI scheme with an allowlist but leaves its syntax and consent behavior open. OpenKraken accepts one command: `openkraken://repo?path=<encoded absolute local path>`. Construct the value with `encodeURIComponent(path)`; form-style `+` spaces are also accepted. Commands for cloning, fetching, login, tokens, drafts or shell execution are not accepted.

## Parsing and ownership

Main parses the original string before URL normalization. Scheme/command spelling is exact, and userinfo, ports, command paths, fragments, duplicate/extra query fields and invalid percent encoding are rejected. Paths are decoded once. Relative paths, `.`/`..` components, repeated separators, backslashes on POSIX, control/bidirectional override characters and remaining percent-encoded octets are rejected. The latter intentionally excludes ambiguous filenames such as a literal `%20`. Raw URIs are bounded to 64 KiB and decoded paths to 16 KiB.

Windows accepts drive-qualified local paths and rejects UNC/device paths, alternate data streams, reserved device names and trailing spaces/dots. These rules are tested on Linux as parser behavior; Windows OS dispatch is not thereby verified. The handler does not concatenate a URI path with an application directory or access a privileged filesystem root. Filesystem symlinks and mounts retain the existing repository-opening semantics after approval; lexical validation is not a filesystem containment guarantee.

At most one pending proposal exists in main memory. A second link cannot replace a reviewed target or build up a queue. The renderer receives an opaque proposal identity and a display path. Acceptance and dismissal accept only that identity, never a renderer-provided path or URI. Main consumes the proposal before invoking the existing Git-service `open` operation. Stale identities fail, including after a failed open, and cancellation cannot dismiss a newer proposal. Proposals survive renderer reload but are not written to disk or restored after app restart. Main-owned link events are rejected if received from the Git utility.

## Consent and lifecycle

An incoming link focuses the app and reveals **Review repository link**. It does not switch repositories, open a native file picker, perform filesystem work or start Git by itself. Review shows the decoded path in a modal with Cancel focused by default. Existing dialogs remain in control; incoming links do not place another modal above them. Acceptance follows the ordinary snapshot/graph update path and records only the operation category/outcome in Activity.

Cold-start arguments and `second-instance` delivery handle Linux/Windows. The macOS `open-url` listener is registered synchronously before asynchronous startup. A pending proposal can therefore be read when the renderer mounts; a link delivered after the last macOS window closes can create a replacement window. Development runs do not register OS handlers. Packaged Windows launches request protocol registration, macOS bundles declare the scheme, and Linux DEB/RPM/AppImage desktop entries advertise `x-scheme-handler/openkraken` with `%U` argument forwarding. A portable AppImage still needs desktop integration before a browser can discover its handler.

## Verification scope

Tests cover parser rejection, one-use identities, stale dismissal, strict/main-only IPC and Windows lexical rules. Electron acceptance covers cold start, cancellation, delivery from a real second process, immutable review, successful opening, stale replay, invalid links, renderer reload and unavailable targets. An injected `open-url` event checks that route on Linux; it is not native macOS evidence. The packaged smoke exercises cold-start consent and Linux/Windows second-process delivery through the actual packaged executable, including AppImage when that target is selected. Installer verification requires the scheme MIME entry and a URI-forwarding launcher.

Native Windows/macOS execution, actual browser/desktop handler selection and broader distribution acceptance remain open. This does not complete all M8 release requirements.

The Linux x64 bundle and freshly generated DEB/RPM/AppImage test artifacts passed payload/fuse/launcher verification and packaged URI delivery. AppImage acceptance includes FUSE and extraction modes. A FUSE teardown race initially left a busy temporary mount after the executable exited; profile removal now retries filesystem teardown for at most 750 ms, independently of the unchanged two-second application shutdown deadline. A persistent failure still fails the smoke test.

References: [Electron deep links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app), [Electron app lifecycle and protocol registration](https://www.electronjs.org/docs/latest/api/app).
