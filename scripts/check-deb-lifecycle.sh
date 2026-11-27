#!/bin/bash
set -Eeuo pipefail
trap 'printf "DEB lifecycle failed at line %s\n" "$LINENO" >&2' ERR

# Run only inside a disposable APT container, with the artifact mounted at
# /artifacts. This intentionally installs and removes packages inside that image.
if [[ ${OPENKRAKEN_DISPOSABLE_INSTALL_TEST:-} != 1 ]] ||
   [[ ! -e /run/.containerenv && ! -e /.dockerenv ]]; then
  echo 'Run this only in a disposable container with OPENKRAKEN_DISPOSABLE_INSTALL_TEST=1' >&2
  exit 1
fi
source /etc/os-release
[[ $(id -u) == 0 ]]
case "$ID:$VERSION_ID" in
  debian:13|ubuntu:24.04) ;;
  *) echo "Unsupported lifecycle fixture: $PRETTY_NAME" >&2; exit 1 ;;
esac
[[ $# == 2 || $# == 3 ]] || { echo 'Provide current DEB, stable upgrade and optional intermediate beta' >&2; exit 1; }
artifact=$(realpath "$1")
upgrade=$(realpath "$2")
[[ $artifact == /artifacts/*.deb && -f $artifact ]]
[[ $upgrade == /upgrade/*.deb && -f $upgrade ]]
upgrades=()
if [[ $# == 3 ]]; then
  beta=$(realpath "$3")
  [[ $beta == /beta/*.deb && -f $beta ]]
  upgrades+=("$beta")
fi
upgrades+=("$upgrade")
previous_version=''
for package in "$artifact" "${upgrades[@]}"; do
  [[ $(dpkg-deb --field "$package" Package) == openkraken ]]
  [[ $(dpkg-deb --field "$package" Architecture) == "$(dpkg --print-architecture)" ]]
  version=$(dpkg-deb --field "$package" Version)
  if [[ -n $previous_version ]]; then
    dpkg --compare-versions "$version" gt "$previous_version"
  fi
  previous_version=$version
done
if dpkg-query -W openkraken >/dev/null 2>&1; then
  echo 'Refusing existing OpenKraken package state' >&2
  exit 1
fi
integration_paths=(/usr/bin/openkraken /opt/OpenKraken /usr/share/applications/openkraken.desktop /usr/share/icons/hicolor/512x512/apps/openkraken.png /etc/apparmor.d/openkraken)
for path in "${integration_paths[@]}" /home/fixture/.config/OpenKraken; do
  [[ ! -e $path && ! -L $path ]]
done
asar_digest() {
  dpkg-deb --fsys-tarfile "$1" | tar -xOf - ./opt/OpenKraken/resources/app.asar | sha256sum | cut -d ' ' -f 1
}
expected_artifact=$artifact
expected_asar=$(asar_digest "$artifact")
mkdir -p /home/fixture/.config/OpenKraken
printf '%s\n' keep-this-draft > /home/fixture/.config/OpenKraken/draft.txt
export DEBIAN_FRONTEND=noninteractive
# The slim image excludes documentation. Install this package's documentation
# too, so dpkg verification covers all shipped files without exceptions.
apt_options=(-o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o 'Dpkg::Options::=--path-include=/usr/share/doc/openkraken/*')
apt-get "${apt_options[@]}" update
apt-get "${apt_options[@]}" install -y --no-install-recommends "$artifact" desktop-file-utils

check_installed() {
  test "$(dpkg-query -W -f='${Status}' openkraken)" = 'install ok installed'
  test "$(dpkg-query -W -f='${Version}' openkraken)" = "$(dpkg-deb --field "$expected_artifact" Version)"
  test "$(sha256sum /opt/OpenKraken/resources/app.asar | cut -d ' ' -f 1)" = "$expected_asar"
  verification=$(dpkg --verify openkraken)
  if [[ -n $verification ]]; then
    printf 'Installed package verification failed:\n%s\n' "$verification" >&2
    return 1
  fi
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
  test "$(cat /home/fixture/.config/OpenKraken/draft.txt)" = keep-this-draft
}
check_installed

desktop=${OPENKRAKEN_DEB_DESKTOP_SMOKE:-0}
config_home=/home/openkraken-smoke/.config
smoke_installed() {
  # Use the same XDG configuration across versions and fresh repositories per launch.
  runuser -u openkraken-smoke -- env OPENKRAKEN_PACKAGE_EXECUTABLE=/usr/bin/openkraken \
    OPENKRAKEN_PACKAGE_DIRECTORY=/opt/OpenKraken OPENKRAKEN_XDOTOOL=/usr/bin/xdotool \
    OPENKRAKEN_DEB_CONFIG_HOME="$config_home" \
    bash -c 'cd "$HOME" && exec dbus-run-session -- xvfb-run -a /usr/local/bin/node /source/scripts/smoke-package.mjs --history --installed-deb "$@"' bash "$@"
}
if [[ $desktop == 1 ]]; then
  # Add GUI automation tools only after checking the application dependencies.
  apt-get "${apt_options[@]}" install -y --no-install-recommends xvfb xauth xdotool dbus-x11 libglib2.0-bin
  if [[ $ID == ubuntu ]]; then
    apt-get "${apt_options[@]}" install -y --no-install-recommends apparmor
    apparmor_parser --skip-kernel-load --skip-read-cache /opt/OpenKraken/resources/apparmor-profile
  fi
  useradd --create-home --shell /bin/bash openkraken-smoke
  smoke_installed --save-upgrade-theme
fi

# Exercise the shipped replacement guards while a real installation is present.
mkdir /tmp/control
dpkg-deb --control "$artifact" /tmp/control
bash /tmp/control/postrm upgrade
check_installed
bash /tmp/control/postrm 1
check_installed
apt-get "${apt_options[@]}" install -y --no-install-recommends --reinstall "$artifact"
check_installed

for package in "${upgrades[@]}"; do
  next_asar=$(asar_digest "$package")
  [[ $next_asar != "$expected_asar" ]]
  apt-get "${apt_options[@]}" install -y --no-install-recommends "$package"
  expected_artifact=$package
  expected_asar=$next_asar
  check_installed
  if [[ $desktop == 1 ]]; then smoke_installed; fi
  echo "$PRETTY_NAME upgrade to $(dpkg-query -W -f='${Version}' openkraken) preserved launcher and user data"
done

# Both removal operations must preserve the app-written settings byte for byte.
if [[ $desktop == 1 ]]; then
  settings="$config_home/OpenKraken/settings.json"
  test -s "$settings"
  saved_settings=$(sha256sum "$settings")
fi
# Uninstall must remove system integration and leave user data alone.
apt-get remove -y openkraken
for path in "${integration_paths[@]}"; do
  [[ ! -e $path && ! -L $path ]]
done
test "$(cat /home/fixture/.config/OpenKraken/draft.txt)" = keep-this-draft
if [[ $desktop == 1 ]]; then [[ $(sha256sum "$settings") == "$saved_settings" ]]; fi
apt-get purge -y openkraken
registered_packages=$(dpkg-query -W -f='${Package}\n')
if grep -Fxq openkraken <<< "$registered_packages"; then
  echo 'OpenKraken remains in the package database after purge' >&2
  exit 1
fi
test "$(cat /home/fixture/.config/OpenKraken/draft.txt)" = keep-this-draft
if [[ $desktop == 1 ]]; then [[ $(sha256sum "$settings") == "$saved_settings" ]]; fi
echo "$PRETTY_NAME install, replacement guards, reinstall, version upgrade, removal, purge and user-data retention passed"
