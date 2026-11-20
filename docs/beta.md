# Running an OpenKraken beta

## Prepare a candidate

Use a checkout whose package version is the candidate version, for example `0.2.0-beta.2`. For a Linux AppImage, DEB or RPM, configure the build with the beta feed and the publisher's public Ed25519 verification key. A configuration has this shape.

```json
{
  "channel": "beta",
  "feed": "https://updates.example.org/beta/release.json",
  "publicKey": "<base64 DER public key>"
}
```

Replace the example values with the release infrastructure the publisher controls. Save the JSON in `beta-config.json` on the build machine. From the candidate checkout, run the following commands with the paths to your configuration and installer metadata.

```sh
OPENKRAKEN_UPDATE_CONFIG="$(cat /path/to/beta-config.json)" pnpm package
format=AppImage  # AppImage, deb or rpm
pnpm installer --target "$format" --metadata /path/to/installer-metadata.json
```

Sign a descriptor for **each** candidate, including the first. Set its channel to `beta`, use the exact package version and increase the sequence for each release. From a POSIX signing machine with Node and jq, run the following commands in a fresh output directory. Set `arch` and `format` to the architecture and installer the participant will use. Include each published artifact in the descriptor.

```sh
arch=x64
format=AppImage
node /path/to/openkraken/scripts/sign-update.mjs descriptor.json private-key.pem release.json > receipt.json &&
  jq -er --arg arch "$arch" --arg format "$format" '
    .artifacts[] | select(.platform == "linux" and .arch == $arch and .format == $format)
    | "\(.sha256)  \(.name)"
  ' receipt.json > SHA256SUMS
```

Publish the immutable, versioned installers before the signed manifest. In the invitation, give participants the candidate version, architecture, HTTPS artifact URL, feedback contact and the **one-line SHA256SUMS from the signing machine**. Deliver that line through an independently authenticated release-owner channel the participant already trusts. [Installer instructions](../README.md) · [Feed and signing procedure](decisions/0082-signed-update-release-protocol.md)

## Validate a Windows beta installer

On Windows x64, set the checkout version to the candidate, then run `pnpm package`, `pnpm installer --test-metadata --target msi` and `pnpm smoke:installer release/installers/win32-x64/test/msi/manifest.json`. The receipt and installed application carry the full beta version, such as `0.2.0-beta.10`. Windows Installer displays the numeric core and the package tracks the beta revision in the current user’s registry. The Windows CI workflow also exercises promotion to stable, attempted downgrades and profile retention on a disposable runner. Public Windows distribution still requires native acceptance and release signing. [MSI lifecycle acceptance](decisions/0092-disposable-msi-lifecycle-acceptance.md)

## Verify the first Linux download

Save the checksum line from the invitation as `SHA256SUMS` in an empty directory. Download the selected installer into the same directory with the exact filename from that line. Run this command there before opening or installing it.

```sh
sha256sum --check --strict SHA256SUMS
```

Continue when the command exits successfully and prints the expected installer filename followed by `OK`. If the file is missing or the checksum differs, discard the download and contact the release owner. For an AppImage, grant execute permission to the verified file and launch it. For a DEB or RPM, open the verified file with the system package installer. These formats use the same `openkraken` package name for beta and stable. Installing a newer candidate replaces the installed application. Subsequent checks in **Updates** verify the manifest using the key embedded in that build.

## Exercise a candidate

1. Launch the beta in its default profile. In **Updates**, confirm that the dialog shows **Beta channel**. Crash reporting and automatic checks start disabled.
2. Open a disposable checkout representative of your usual work. Record the candidate version, operating system, CPU architecture, Git version, repo size and the operation you exercised.
3. Open **Updates**, check for the next candidate, download it and save your work. For an AppImage, choose **Install and restart**. For a DEB or RPM, choose **Save installer…**, quit OpenKraken, and install the saved file through the system package manager. Confirm that the new version starts with your beta preferences. If you kept the stable AppImage, launch it separately to check its preferences.
4. Send the release owner the observed result, expected result and reproducible steps through the feedback route supplied with the invitation. Include repository contents, paths, account details or diagnostics only if you choose to share them.

For each candidate the release owner records the artifact digest, verification key identity, expiry, tested platforms, participant feedback and dispositions of release-blocking defects. The Linux fixture tests the updater using disposable keys and local HTTPS. Recruiting participants, supplying a real feedback route and approving public distribution are release-owner actions.
