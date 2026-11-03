#!/bin/bash
set -euo pipefail

# Run only inside a disposable Debian container, with the artifact mounted at
# /artifacts. This intentionally installs and removes packages inside that image.
if [[ ${OPENKRAKEN_DISPOSABLE_INSTALL_TEST:-} != 1 ]]; then
  echo 'Run this only in a disposable container with OPENKRAKEN_DISPOSABLE_INSTALL_TEST=1' >&2
  exit 1
fi
artifact=$1
export DEBIAN_FRONTEND=noninteractive
apt_options=(-o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
apt-get "${apt_options[@]}" update
apt-get "${apt_options[@]}" install -y --no-install-recommends "$artifact" desktop-file-utils

check_installed() {
  test "$(dpkg-query -W -f='${Status}' openkraken)" = 'install ok installed'
  test "$(readlink -f /usr/bin/openkraken)" = /opt/OpenKraken/openkraken
  test -x /opt/OpenKraken/resources/app.asar.unpacked/dist/helpers/openkraken-askpass
  test -f /usr/share/icons/hicolor/512x512/apps/openkraken.png
  desktop-file-validate /usr/share/applications/openkraken.desktop
  test -s /etc/ssl/certs/ca-certificates.crt
  # A developer desktop can hide missing package dependencies. Check Electron
  # and the native PTY/watcher modules against this minimal installation.
  while IFS= read -r -d '' binary; do
    # node-pty also ships unused Windows/macOS prebuilds. Only ELF files can
    # contribute shared-library requirements to this native Linux installation.
    if [[ $(od -An -tx1 -N4 "$binary" | tr -d ' \n') != 7f454c46 ]]; then
      continue
    fi
    libraries=$(ldd "$binary")
    if [[ $libraries == *'not found'* ]]; then
      printf 'Unresolved libraries in %s:\n%s\n' "$binary" "$libraries" >&2
      return 1
    fi
  done < <(find /opt/OpenKraken -type f \( -name openkraken -o -name '*.node' \) -print0)
  git --version
}
check_installed

# Exercise the shipped replacement guards while a real installation is present.
mkdir /tmp/control
dpkg-deb --control "$artifact" /tmp/control
bash /tmp/control/postrm upgrade
check_installed
bash /tmp/control/postrm 1
check_installed
apt-get "${apt_options[@]}" install -y --no-install-recommends --reinstall "$artifact"
check_installed

# Uninstall must remove system integration and leave user data alone.
mkdir -p /home/fixture/.config/OpenKraken
echo keep-this-draft > /home/fixture/.config/OpenKraken/draft.txt
apt-get remove -y openkraken
test ! -e /usr/bin/openkraken
test ! -L /usr/bin/openkraken
test ! -e /opt/OpenKraken
test ! -e /usr/share/applications/openkraken.desktop
test ! -e /usr/share/icons/hicolor/512x512/apps/openkraken.png
test ! -e /etc/apparmor.d/openkraken
test "$(cat /home/fixture/.config/OpenKraken/draft.txt)" = keep-this-draft
apt-get purge -y openkraken
test "$(cat /home/fixture/.config/OpenKraken/draft.txt)" = keep-this-draft
echo 'Debian install, replacement guards, reinstall, removal and user-data retention passed'
