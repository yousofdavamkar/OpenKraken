# 0092 — Disposable MSI lifecycle acceptance

## Decision

Add `scripts/check-msi-lifecycle.mjs` as a native Windows x64 acceptance gate for locally built test-only MSIs. Require explicit `OPENKRAKEN_DISPOSABLE_INSTALL_TEST=1` together with GitHub Actions' Windows and hosted-runner markers before reading artifacts or starting installer operations. Refuse self-hosted runners. These environment checks prevent accidental workstation use; they do not provide isolation against deliberately forged environment variables.

Read current-user/machine related products through Windows Installer's read-only COM API, native known folders, shortcut ownership and protocol state before installing. Refuse existing or uncertain product registration, default install directories, user data, shortcuts, protocol registration and OS URL-association preferences. Do not delete state to pass this guard. The inventory does not enumerate installations belonging only to other user accounts.

Require an ordered list of at least two native unsigned test manifests, valid artifact hashes/sizes and compiled MSI metadata. Each replacement must have a newer release version, a distinct ProductCode and changed ASAR bytes. Generalize the existing real-version fixture builder to Windows, including a native dependency junction. The fixture changes its own package version and rebuilds the actual bundle and MSI without editing the workspace version.

## Acceptance sequence

1. Create a uniquely marked profile at the native default user-data location, refusing a directory that appeared after the initial inventory. Install the current MSI quietly without overriding its install directory or allowing a reboot.
2. Require exactly one installed product, the expected version/executable component path, current-user Start menu shortcut bound to that product/component, and the four exact quoted protocol values. Compare every installed payload entry with the manifest, validate native ownership/DACLs and fuses, and read the installed ASAR's actual version.
3. Run installed desktop smoke with the fixture's persistent default profile. Cancel the cold-start link, require its proposal to disappear, then dispatch a repository URI through Windows `Start-Process`. The resident application must show a fresh review proposal and open the repository only after acceptance. Never rewrite the registered command to supply a temporary profile or debug arguments.
4. After rechecking the installed payload and ownership, remove the bundled askpass helper and advertised Start menu shortcut. Repair with `/faums`, then require the full payload, shortcut, product and registry assertions again.
5. Upgrade through the next two betas and their stable release. After each upgrade, verify the installed product, beta registry revision, ASAR, full payload and profile. Try reinstalling the previous beta after the second beta and again after stable promotion. Require Windows Installer to return 1603 with the beta launch-condition message and verify the newer installation again. Repeat desktop and OS URI acceptance on the final release using the original profile.
6. Uninstall the replacement. Require related-product registration, the application directory, shortcut and MSI-owned protocol subtree to disappear while retaining the profile's sentinel. Machine installation/shortcut/protocol state must remain absent throughout.

The Start menu check reads the advertised shortcut's product, feature and component binding; it does not simulate clicking the Start menu. The URI test exercises delivery to an already running default-profile application. It does not establish cold OS launch, browser chooser behavior, other user profiles or arbitrary custom installation paths.

## Failure handling and evidence

Keep verbose installer logs, stage inventories and smoke logs under `test-results/msi-lifecycle-*`, including on failure. Each installer invocation has a five-minute deadline. Successful operations require exit zero. The two deliberate downgrades require the expected installer rejection. A timeout does not authorize deleting a potentially active installation or killing unrelated processes. Leave the fixture profile and its sentinel on the disposable VM even after a passing uninstall. Never recursively remove registry keys or user data to manufacture a passing result.

Windows can create an OS-managed URL-association `UserChoice` while dispatching a URI. The preflight refuses a pre-existing association, but post-uninstall acceptance does not erase or claim removal of OS-owned preference state. Inventory records it separately from the MSI-owned `HKCU\Software\Classes\openkraken` subtree.

The Windows CI matrix builds the three future-version fixtures and invokes this gate with step-scoped opt-in. Local policy tests cover guard rejection, unrelated/advertised/stale products, changed paths, detached shortcuts, registry differences, removal and profile retention. A native read-only inventory test runs only on Windows. Development on Linux, PowerShell syntax parsing and configured CI are not evidence that Windows COM, installation, repair, upgrade, URI dispatch or removal has passed. Native execution, signing and distribution remain open.

## Sources

- [Microsoft RelatedProducts](https://learn.microsoft.com/en-us/windows/win32/msi/installer-relatedproducts): read-only current-user/machine product enumeration.
- [Microsoft ComponentPath](https://learn.microsoft.com/en-us/windows/win32/msi/installer-componentpath) and [ShortcutTarget](https://learn.microsoft.com/en-us/windows/win32/msi/installer-shortcuttarget): installed component location and advertised shortcut ownership.
- [Microsoft msiexec](https://learn.microsoft.com/windows-server/administration/windows-commands/msiexec): install, repair, removal, quiet, reboot and logging options.
