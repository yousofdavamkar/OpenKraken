# 0120. Finish an AppImage replacement during shutdown

A packaged update from 0.1.0 to 0.2.0 reopened 0.1.0 when its final rename took longer than the ordinary shutdown deadline. A separate test let the rename succeed and made the following directory sync fail. The retiring app reported an installation error, cancelled the armed helper and exited with the replacement installed and neither version running.

## Parent exit during an update

Main handles a quit request once. A repeated request while it is draining services waits for that shutdown. A Git service that remains alive after 1.5 seconds receives a forced termination on POSIX. The Electron regression stops the utility, requests quit twice, then checks that the app exited normally and the utility stopped. Electron's ordinary utility termination sends SIGTERM on POSIX. [Electron utility process API](https://www.electronjs.org/docs/latest/api/utility-process#childkill)

The update commit has the same ten-minute limit as preparation. The armed helper keeps reading its parent pipe until the commit finishes or the parent dies. It then verifies actual parent exit before examining the installed image. The existing 20-second parent-exit check starts at pipe closure. After launch the helper observes startup at 100 ms intervals for the first 60 seconds, then every two seconds while the same unconfirmed transaction remains active. An application that still has user work open cannot arm a restart until its normal quit confirmation succeeds. [Startup recovery](0086-appimage-startup-exit-recovery.md#slow-or-stalled-replacement-startup)

At the update deadline main can exit even if the rename has stalled. The helper checks which verified image occupies the target. An interruption before rename reopens the predecessor and cleans staging. An interruption after rename launches the verified replacement. The packaged slow-commit test delays the rename for 22 seconds and issues a second quit while waiting. The stalled-commit test leaves the rename pending and accelerates only the disposable app's ten-minute shutdown timer to four seconds.

## Directory sync after rename

The transaction records in memory when the replacement rename succeeds. If a later directory sync fails, the retiring app hands the installed image to the already-armed helper for independent digest verification. A failure before rename still cancels the install. At startup the app validates the installed image, retained predecessor and journal, then syncs the installation and transaction directories before removing recovery files. A failed sync retains the journal and predecessor for retry. The packaged test injects a sync error in the retiring app and checks the launched version, installed digest, release sequence and cleanup. Native tests fail each startup directory sync in turn and verify recovery on retry.

The tests cover process interruption and reported filesystem failures. Physical power loss and native installer handoff on macOS and Windows still need separate acceptance.

## Directory sync after restoring the predecessor

If the replacement exits before confirmation, the native helper can rename the verified predecessor back into place. A failed rename stops recovery. After a successful rename, the helper attempts both directory syncs. If either fails, it rechecks the installed predecessor’s size, SHA-256, inode and parent permissions before launching it. The restored app retries the syncs on startup and retains the journal if storage still fails.

The Linux regression gives the installation directory mode 0300, which permits renaming a file and prevents an unprivileged process from opening the directory for sync. The packaged replacement exits before confirmation. The restored app launches, reports an installation error and leaves its journal intact. After the test restores directory access, another launch clears the journal, preserves the signed release sequence and shows the restoration notice. Run `xvfb-run -a node scripts/verify-update-restart.mjs --rollback-sync-error` as an unprivileged Linux user after building.
