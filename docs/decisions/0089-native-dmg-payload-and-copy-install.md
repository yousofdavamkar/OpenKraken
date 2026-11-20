# 0089 — Native DMG payload and copy-install verification

## Decision

The macOS installer target uses native `hdiutil` to create a compressed, read-only UDZO image from the existing hardened `OpenKraken.app`. It supports native x64 and arm64 builders and refuses cross-platform creation. The image contains the app and an `Applications` shortcut. It does not modify `/Applications`, invoke a privileged installer, publish an artifact or configure an update feed.

Packager sets the bundle identifier to `org.openkraken.desktop`. POSIX bundle permissions are normalized before the existing fuse operation resets the macOS ad-hoc signature. The producer requires the root release version, `openkraken` executable and repository URL scheme in `Info.plist`, hardened fuses, and successful `codesign --verify --deep --strict`. Copies and the final source must preserve every recorded file digest, mode and relative link. `ditto` copies the bundle into the image source and from its mounted volume.

The default installer records an unsigned manifest with either test-only or supplied metadata. The `signed: false` field means no distribution identity: the local ad-hoc bundle signature is an integrity prerequisite, not Developer ID signing, notarization or a release signature. Metadata values are not invented. The default macOS target is `dmg`; Linux keeps `deb`.

The verifier first checks the artifact size and SHA-256. It mounts the image read-only without browsing or opening it, verifies the mounted payload, bundle metadata, signature, fuses and exact `/Applications` shortcut, then copies the app into a disposable installation directory. It checks that copy again, detaches the image and runs the existing packaged desktop smoke against the copied executable. Only locally built or independently authenticated images are eligible; an adjacent manifest is not authentication.

The verifier owns its temporary directory separately from the Linux extractor. Once attachment starts, recursive cleanup is prohibited until successful detachment. An uncertain attachment or failed detach retains the directory and reports its path. It does not force-unmount a volume or kill another application's processes for cleanup. Successful verification removes only its disposable copy and directory.

## Verification and limits

Public packaging tests cover native-host refusal, foreign manifest refusal, framework-style links and executable modes surviving a copy, external links being rejected inside an app, and writable helpers being rejected. macOS-only tests use native `plutil` to reject altered identity, executable, version and repository scheme. Native CI builds a real DMG, rejects artifact/helper digest and version mismatches, and verifies copy-install followed by desktop launch after detach.

The implementation was developed on Linux. Native DMG creation, mounting, signature validation and desktop execution remain unverified until the macOS runner completes. Linux tests do not establish these results. This gate also does not certify Finder drag-and-drop, Launch Services default-handler registration, quarantined downloads, Gatekeeper, Developer ID/notarization, upgrades over an existing installation or either Mac architecture's complete release acceptance. MSI and production release configuration remain separate work.

## Developer ID signing

The optional `--mac-identity` argument selects the exact Developer ID Application certificate by its SHA-1 keychain fingerprint. The builder signs nested Mach-O code and bundles in a disposable copy, enables the hardened runtime and requests secure timestamps. The main app and its generic and renderer helpers receive the JIT entitlement for V8. The original app and the embedded ASAR are checked for changes. The final image has a separate signature using the same identity. The receipt hashes the final bytes. Each signed image has a digest in its filename. The builder moves the complete image into place before atomically replacing the receipt, so a concurrent build or failed retry preserves readable earlier images. [Electron signing tool](https://github.com/electron/osx-sign)

The smoke verifier copies the candidate image into its private directory before hashing and authenticating it. A signed receipt requires an independently supplied fingerprint. The native requirement checks the Apple anchor, Developer ID intermediate and application leaf extensions, certificate fingerprint and expected identifier. The signed app is verified on the mounted volume and again after copying. An unsigned image is suitable for local testing. [Apple code signing requirement language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html) · [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/)

Supplying a keychain profile with `--notary-profile` explicitly requests upload of the signed image to Apple. The builder waits for an accepted submission, staples the ticket, verifies the signed image again, validates its ticket and runs the native disk image policy assessment. Only then does it hash the artifact and write the submission ID to its receipt. The verifier repeats the ticket and policy checks on its private copy before mounting. Release consumers can require this check with `--require-notarization` even if a receipt omits the ID. Release acceptance still requires a real Apple account and testing a quarantined download on macOS. [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) · [Apple disk image assessment](https://developer.apple.com/library/archive/technotes/tn2206/)

## Sources

- [Electron Packager options](https://electron.github.io/packager/main/interfaces/Options.html): bundle identity, version and protocol metadata.
- [Apple Command-Line Administration](https://www.apple.com/server/docs/Command_Line_v10.4_2nd_Ed.pdf), disk-image administration: native image creation, attachment and detachment. The native macOS CI command execution is the compatibility gate for the current OS tools.
