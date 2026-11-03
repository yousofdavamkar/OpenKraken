#!/usr/bin/env bash
# Isolated compatibility-test toolchain; never replaces the system Git.
set -euo pipefail

prefix=${1:?Usage: build-minimum-git.sh ABSOLUTE_EMPTY_INSTALL_DIRECTORY}
case "$prefix" in
  /*) ;;
  *) echo 'The install directory must be absolute' >&2; exit 1 ;;
esac
if [[ -e "$prefix" ]]; then
  echo 'The install directory must not already exist' >&2
  exit 1
fi
for tool in curl sha256sum tar xz make cc perl; do
  command -v "$tool" >/dev/null || { echo "Missing build prerequisite: $tool" >&2; exit 1; }
done

source_dir=$(mktemp -d)
trap 'rm -rf "$source_dir"' EXIT
archive="$source_dir/git-2.38.0.tar.xz"
curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --max-time 120 \
  https://www.kernel.org/pub/software/scm/git/git-2.38.0.tar.xz -o "$archive"
# https://www.kernel.org/pub/software/scm/git/sha256sums.asc
printf '%s  %s\n' \
  923eade26b1814de78d06bda8e0a9f5da8b7c4b304b3f9050ffb464f0310320a \
  "$archive" | sha256sum --check --status
tar -xJf "$archive" -C "$source_dir"
make -C "$source_dir/git-2.38.0" -j2 \
  prefix="$prefix" NO_GETTEXT=YesPlease NO_TCLTK=YesPlease all
make -C "$source_dir/git-2.38.0" \
  prefix="$prefix" NO_GETTEXT=YesPlease NO_TCLTK=YesPlease install
test "$("$prefix/bin/git" --version)" = 'git version 2.38.0'
"$prefix/bin/git" --version
