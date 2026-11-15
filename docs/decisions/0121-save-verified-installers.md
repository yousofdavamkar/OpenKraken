# 0121. Save verified installers through a native dialog

A verified DEB, RPM, DMG, ZIP or MSI previously stayed in the private update cache until the next check or startup. The desktop app now lets the user choose a destination and complete the installation with the operating system. This also applies to AppImage downloads outside the in-place restart flow.

Main issues a fresh ID for the selected verified package. The renderer supplies that ID to open a native picker. Main proposes the signed filename, checks the selection again when the picker returns, and requires the matching extension. Cancelling the picker retains the verified download. A second check or download invalidates the earlier ID.

Main streams the cached bytes to a private staging directory on the selected filesystem, checks the signed size and SHA-256 digest, and syncs the file. Before rename it rechecks the trusted release record, expiry, staging file identity, destination identity and cancellation. A destination error or cancelled copy keeps the download available for retry. A completed export resumes the normal opt-in update check schedule. The user opens the resulting package manually. Desktop installation and restart for a running AppImage still use the recovery transaction. [AppImage handoff](0084-appimage-desktop-update-handoff.md)

## Checking the native installer in CI

After building the test installers, each native CI job serves its package over loopback HTTPS and signs its release metadata with an ephemeral Ed25519 key. Linux exercises DEB and RPM, macOS exercises DMG, and Windows exercises MSI. The Electron test intercepts the destination picker, cancels once, saves the installer, then checks its size and SHA-256 against the packaging manifest. Successful saves write a receipt to the test output directory. The ordinary desktop test uses a seven-byte fixture on the same code path.

To exercise a built installer, set `OPENKRAKEN_UPDATE_TEST_MANIFEST` to its manifest and run `pnpm exec playwright test tests/e2e/updates.test.ts -g 'signed update UI' --reporter=list` on that platform. On headless Linux, prefix the command with `xvfb-run -a`. The Go toolchain already used by the desktop build creates the temporary loopback TLS certificate. The fixture passes that trust root to the launched test app.
