# 0091 — Native MSI and installer-owned Windows protocol registration

## Decision

Add a native Windows x64 MSI producer using the pinned electron-builder 26.18.0 target and its supported `msiProjectCreated` hook. It wraps the existing hardened platform bundle, disables executable editing and all builder signing, and compares the original and copied payload before and after generation. The existing explicit test-only/provided metadata and unsigned manifest policy remains in force. Creation refuses other hosts/architectures rather than treating a cross-built artifact as native acceptance.

The MSI defaults to per-user installation, has no desktop shortcut or launch-after-finish action, and creates a Start menu entry. The project hook marks it as requiring no elevation and adds a launch condition refusing a machine-scope override. It preserves the builder's Windows Installer 5 per-user directory redirection. The hook parses XML with external resolution and DTDs disabled, checks the pinned schema and expected application/per-user structure, and refuses unexpected custom actions.

Freeze upgrade identity `8B1BEDFC-AAA5-5EFE-9437-351F2D7682D7`, the pinned builder's deterministic UUID for `org.openkraken.desktop`. Future releases must preserve it. Both stable releases and numbered betas use the numeric release core in ProductVersion with a fixed zero fourth field. The first two fields are limited to 255 and the third to 65535. The artifact, receipt and packaged application retain the full release version. [Microsoft ProductVersion](https://learn.microsoft.com/en-us/windows/win32/msi/productversion)

A beta owns a 64-bit HKCU string value named `Sequence` under `Software\OpenKraken\Installer\Beta\<major.minor.patch>`. Its launch condition uses a detect-only, inclusive exact-version Upgrade row and a registry search before evaluating the candidate revision. For a related installation with the same core, Windows may proceed if it finds a beta revision less than or equal to the candidate's. A stable install has no marker, including stable versions shipped before beta support. Repair and uninstall of the installed product remain available. The existing major-upgrade action promotes a beta to its matching stable version and removes the marker with the beta component. Canonical decimal beta revisions range from 0 to 2147483647 for MSI's signed integer comparison. [Windows Installer condition syntax](https://learn.microsoft.com/en-us/windows/win32/msi/conditional-statement-syntax)


## Protocol ownership

A single 64-bit, non-permanent Windows Installer component owns four values under `HKCU\Software\Classes\openkraken`: the protocol name, URL marker, icon and quoted executable/URL command. Its registry key path gives Windows Installer ownership for repair, upgrade and removal. No recursive registry deletion hook is added. The compiler's output must contain exactly these four protocol entries plus the release-specific beta marker when applicable, the expected component attributes and no explicit `RemoveRegistry` entries.

The desktop no longer calls `setAsDefaultProtocolClient` at Windows startup. Starting an unpacked or temporary bundle must not replace an installed handler with a path that will disappear. Packaged smoke snapshots the current user's complete OpenKraken protocol subtree before launch and compares it after shutdown. It does not restore or rewrite that subtree to hide a failure. Existing repository-link parsing and user review/consent are unchanged. A plain Windows bundle can still receive a repository URI as an argument but does not register itself with Windows.

## Verification

Before returning an artifact, the producer reads compiled MSI tables through Windows Installer's read-only database API. The verifier repeats those checks after the artifact size/SHA-256 check. Checks cover product/version/manufacturer/upgrade identity, x64 summary metadata, per-user defaults, the no-elevation bit, scope condition, executable/Start menu metadata, no custom actions, and the exact owned protocol component/values. This is a bounded policy check on our artifacts, not a general audit of arbitrary MSI files. Never inspect unauthenticated downloads merely because an adjacent manifest contains a hash.

The verifier uses `/a` with an explicit disposable `TARGETDIR` to extract an administrative image. This does not perform ordinary product installation or protocol registration. It checks native payload ownership/DACLs and refuses reparse points, locates the single application, compares every payload entry and digest, verifies fuses and launches it through packaged desktop smoke. Success removes the disposable extraction. Failure retains its files and log, including when a timed-out installer client leaves uncertain service activity; it does not recursively clean an uncertain active extraction.

Native Windows CI builds a test-only MSI, rejects checksum/helper/version corruption and runs the extraction/desktop gate. Lifecycle acceptance—ordinary installation, upgrade, repair, uninstall, retained user data and actual OS URI dispatch—is still a separate required gate and is not established by extraction. Signing, SmartScreen/download reputation and release distribution also remain open.

## Evidence limits

The implementation was developed on Linux. PowerShell 7.6.9 executes the XML hook tests and parses all three new PowerShell scripts. Metadata policy tests use explicit records; they do not prove that Windows COM, WiX compilation, per-user directory redirection, MSI extraction or registry operations work natively. Those await the Windows runner. A fresh Linux bundle and DEB plus targeted Electron repository-link/security tests check shared-path regressions without claiming Windows acceptance.

## Sources

- [electron-builder v26 hooks](https://www.electron.build/v26/docs/features/hooks/): the public MSI project hook; the installed pinned target/template are the source for its legacy WiX namespace.
- [Microsoft installation context](https://learn.microsoft.com/en-us/windows/win32/msi/installation-context): per-user properties and directory/registry context.
- [Microsoft Word Count Summary property](https://learn.microsoft.com/en-us/windows/win32/msi/word-count-summary): the no-elevation and compressed-source bits.
- [WiX registry entries](https://docs.firegiant.com/wix3/howtos/files_and_registry/write_a_registry_entry/): registry values owned by an installer component.
- [Microsoft administrative installation](https://learn.microsoft.com/en-us/windows/win32/msi/administrative-installation): extraction into an administrative source image, distinct from ordinary installation.
