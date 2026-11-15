#!/bin/bash
set -euo pipefail
trap 'printf "RPM lifecycle failed at line %s\n" "$LINENO" >&2' ERR

# Native package-manager acceptance only in an explicitly disposable container.
# Never run this against the developer's or user's host package database.
if [[ ${OPENKRAKEN_DISPOSABLE_INSTALL_TEST:-} != 1 ]] ||
   [[ ! -e /run/.containerenv && ! -e /.dockerenv ]]; then
  echo 'Run only inside a disposable container with OPENKRAKEN_DISPOSABLE_INSTALL_TEST=1' >&2
  exit 1
fi
source /etc/os-release
[[ $ID == fedora && $VERSION_ID == 43 ]]
[[ $(id -u) == 0 ]]
artifact=$(realpath "$1")
[[ $artifact == /artifacts/*.rpm && -f $artifact ]]
[[ $# -le 3 ]] || { echo 'Provide current RPM, optional stable upgrade and intermediate beta' >&2; exit 1; }
upgrades=()
if [[ $# == 3 ]]; then
  beta=$(realpath "$3")
  [[ $beta == /beta/*.rpm && -f $beta ]]
  upgrades+=("$beta")
fi
if [[ $# -ge 2 ]]; then
  upgrade=$(realpath "$2")
  [[ $upgrade == /upgrade/*.rpm && -f $upgrade ]]
  upgrades+=("$upgrade")
fi
expected_artifact=$artifact
# The application artifact is an unsigned local test build. Repository package
# signatures and TLS stay enabled; only this explicitly supplied local RPM is unsigned.
dnf_options=(-y --setopt=install_weak_deps=False --setopt=timeout=30 --setopt=minrate=50000 --setopt=retries=1 --setopt=keepcache=True)
dnf "${dnf_options[@]}" install "$artifact" desktop-file-utils

check_installed() {
  [[ $(rpm -q --qf '%{VERSION}-%{RELEASE}' openkraken) == "$(rpm -qp --qf '%{VERSION}-%{RELEASE}' "$expected_artifact")" ]]
  [[ $(readlink -f /usr/bin/openkraken) == /opt/OpenKraken/openkraken ]]
  test -x /opt/OpenKraken/resources/app.asar.unpacked/dist/helpers/openkraken-askpass
  test -f /usr/share/icons/hicolor/512x512/apps/openkraken.png
  desktop-file-validate /usr/share/applications/openkraken.desktop
  test -s /etc/pki/tls/certs/ca-bundle.crt
  while IFS= read -r -d '' binary; do
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

mkdir -p /home/fixture/.config/OpenKraken
printf '%s\n' keep-this-draft > /home/fixture/.config/OpenKraken/draft.txt
dnf "${dnf_options[@]}" reinstall "$artifact"
check_installed
[[ $(cat /home/fixture/.config/OpenKraken/draft.txt) == keep-this-draft ]]

for upgrade in "${upgrades[@]}"; do
  old_version=$(rpm -q --qf '%{VERSION}-%{RELEASE}' openkraken)
  old_asar=$(sha256sum /opt/OpenKraken/resources/app.asar)
  dnf "${dnf_options[@]}" upgrade "$upgrade"
  expected_artifact=$upgrade
  check_installed
  [[ $(rpm -q --qf '%{VERSION}-%{RELEASE}' openkraken) != "$old_version" ]]
  [[ $(sha256sum /opt/OpenKraken/resources/app.asar) != "$old_asar" ]]
  [[ $(cat /home/fixture/.config/OpenKraken/draft.txt) == keep-this-draft ]]
  echo "RPM upgrade to $(rpm -q --qf '%{VERSION}-%{RELEASE}' openkraken) preserved launcher and user data"
done

dnf "${dnf_options[@]}" remove openkraken
! rpm -q openkraken
for path in /usr/bin/openkraken /opt/OpenKraken /usr/share/applications/openkraken.desktop /usr/share/icons/hicolor/512x512/apps/openkraken.png /etc/apparmor.d/openkraken; do
  if [[ -e $path || -L $path ]]; then
    printf 'Installation path survived removal: %s\n' "$path" >&2
    ls -la "$path" >&2
    exit 1
  fi
done
[[ $(cat /home/fixture/.config/OpenKraken/draft.txt) == keep-this-draft ]]
echo 'Fedora RPM installation, dependencies, reinstall, removal and user-data retention passed'
