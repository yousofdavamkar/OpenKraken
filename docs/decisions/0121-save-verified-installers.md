# 0121. Save verified installers through a native dialog

A verified DEB, RPM, DMG, ZIP or MSI previously stayed in the private update cache until the next check or startup. The desktop app now lets the user choose a destination and complete the installation with the operating system. This also applies to AppImage downloads outside the in-place restart flow.

Main issues a fresh ID for the selected verified package. The renderer supplies that ID to open a native picker. Main proposes the signed filename, checks the selection again when the picker returns, and requires the matching extension. Cancelling the picker retains the verified download. A second check or download invalidates the earlier ID.

Main streams the cached bytes to a private staging directory on the selected filesystem, checks the signed size and SHA-256 digest, and syncs the file. Before rename it rechecks the trusted release record, expiry, staging file identity, destination identity and cancellation. A destination error or cancelled copy keeps the download available for retry. A completed export resumes the normal opt-in update check schedule. The user opens the resulting package manually. Desktop installation and restart for a running AppImage still use the recovery transaction. [AppImage handoff](0084-appimage-desktop-update-handoff.md)
