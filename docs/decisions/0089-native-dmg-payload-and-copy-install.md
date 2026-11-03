# 0089 — Native DMG payload and copy-install verification

## Decision

The macOS installer target uses native `hdiutil` to create a compressed, read-only UDZO image from the existing hardened `OpenKraken.app`. It supports native x64 and arm64 builders and refuses cross-platform creation. The image contains the app and an `Applications` shortcut. It does not modify `/Applications`, invoke a privileged installer, publish an artifact or configure an update feed.

Packager sets the bundle identifier to `org.openkraken.desktop`. POSIX bundle permissions are normalized before the existing fuse operation resets the macOS ad-hoc signature. The producer requires the root release version, `openkraken` executable and repository URL scheme in `Info.plist`, hardened fuses, and successful `codesign --verify --deep --strict`. Copies and the final source must preserve every recorded file digest, mode and relative link. `ditto` copies the bundle into the image source and from its mounted volume.

The existing installer CLI retains its explicit test-only or supplied metadata choice and unsigned manifest. The `signed: false` field means no distribution identity: the local ad-hoc bundle signature is an integrity prerequisite, not Developer ID signing, notarization or a release signature. Metadata values are not invented. The default macOS target is `dmg`; Linux keeps `deb`.

The verifier first checks the artifact size and SHA-256. It mounts the image read-only without browsing or opening it, verifies the mounted payload, bundle metadata, signature, fuses and exact `/Applications` shortcut, then copies the app into a disposable installation directory. It checks that copy again, detaches the image and runs the existing packaged desktop smoke against the copied executable. Only locally built or independently authenticated images are eligible; an adjacent manifest is not authentication.

The verifier owns its temporary directory separately from the Linux extractor. Once attachment starts, recursive cleanup is prohibited until successful detachment. An uncertain attachment or failed detach retains the directory and reports its path. It does not force-unmount a volume or kill another application's processes for cleanup. Successful verification removes only its disposable copy and directory.

## Verification and limits

Public packaging tests cover native-host refusal, foreign manifest refusal, framework-style links and executable modes surviving a copy, external links being rejected inside an app, and writable helpers being rejected. macOS-only tests use native `plutil` to reject altered identity, executable, version and repository scheme. Native CI builds a real DMG, rejects artifact/helper digest and version mismatches, and verifies copy-install followed by desktop launch after detach.

The implementation was developed on Linux. Native DMG creation, mounting, signature validation and desktop execution remain unverified until the macOS runner completes. Linux tests do not establish these results. This gate also does not certify Finder drag-and-drop, Launch Services default-handler registration, quarantined downloads, Gatekeeper, Developer ID/notarization, upgrades over an existing installation or either Mac architecture's complete release acceptance. MSI and production release configuration remain separate work.

## Sources

- [Electron Packager options](https://electron.github.io/packager/main/interfaces/Options.html): bundle identity, version and protocol metadata.
- [Apple Command-Line Administration](https://www.apple.com/server/docs/Command_Line_v10.4_2nd_Ed.pdf), disk-image administration: native image creation, attachment and detachment. The native macOS CI command execution is the compatibility gate for the current OS tools.
