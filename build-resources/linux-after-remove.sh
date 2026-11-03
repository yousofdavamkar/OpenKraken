#!/bin/sh
set -eu

# Debian passes "upgrade" on replacement; RPM passes the remaining package
# count. Only a final removal may unregister the new version's launcher/profile.
case "${1:-}" in
  remove|purge|0) ;;
  *) exit 0 ;;
esac

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove openkraken /opt/OpenKraken/openkraken || true
elif [ "$(readlink /usr/bin/openkraken 2>/dev/null || true)" = /opt/OpenKraken/openkraken ]; then
  rm -f /usr/bin/openkraken
fi

profile=/etc/apparmor.d/openkraken
if [ -f "$profile" ]; then
  if command -v apparmor_parser >/dev/null 2>&1 &&
     command -v apparmor_status >/dev/null 2>&1 &&
     apparmor_status --enabled >/dev/null 2>&1; then
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser --remove "$profile" || true
    fi
  fi
  rm -f "$profile"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
