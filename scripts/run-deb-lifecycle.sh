#!/bin/bash
set -euo pipefail

# Run each distribution in a fresh container using the three built DEB artifacts.
# The graphical test runs as a regular user inside rootless Podman.
case "${1:-}" in
  debian) image=docker.io/library/debian@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 ;;
  ubuntu) image=docker.io/library/ubuntu@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289 ;;
  *) echo 'Usage: bash scripts/run-deb-lifecycle.sh debian|ubuntu' >&2; exit 1 ;;
esac

engine=${OPENKRAKEN_PODMAN:-podman}
mounts=(--volume "$(command -v node):/usr/local/bin/node:ro")
for path in scripts tests/e2e packages/test-fixtures node_modules package.json; do
  mounts+=(--volume "$PWD/$path:/source/$path:ro")
done

root=${INSTALLER_ROOT:-release/installers/linux-$(node -p 'process.arch')/test}
manifest_path() { node -p 'require("./release/installer-upgrade-" + process.argv[1] + ".json").manifestPath' "$1"; }
artifact_name() { node -p 'require(process.argv[1]).artifact.file' "$1"; }
current=$(realpath "$root/deb/manifest.json")
stable=$(manifest_path deb)
beta=$(manifest_path deb-beta)
"$engine" run --rm --cgroups=disabled --network=slirp4netns "${mounts[@]}" \
  --env OPENKRAKEN_DISPOSABLE_INSTALL_TEST=1 --env OPENKRAKEN_DEB_DESKTOP_SMOKE=1 \
  --volume "$(dirname "$current"):/artifacts:ro" \
  --volume "$(dirname "$beta"):/beta:ro" \
  --volume "$(dirname "$stable"):/upgrade:ro" \
  --volume "$PWD/scripts/check-deb-lifecycle.sh:/check.sh:ro" \
  "$image" timeout 12m bash /check.sh "/artifacts/$(artifact_name "$current")" \
  "/upgrade/$(artifact_name "$stable")" "/beta/$(artifact_name "$beta")"
