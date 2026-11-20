# Running an OpenKraken beta

## Prepare a candidate

Use a checkout whose package version is the candidate version, for example `0.2.0-beta.2`. Configure the build with the beta feed and the publisher's public Ed25519 verification key. A configuration has this shape.

```json
{
  "channel": "beta",
  "feed": "https://updates.example.org/beta/release.json",
  "publicKey": "<base64 DER public key>"
}
```

Replace the example values with the release infrastructure the publisher controls. Save the JSON in `beta-config.json` on the build machine. For a Linux installer, run the following commands from the candidate checkout with the paths to your configuration and installer metadata.

```sh
OPENKRAKEN_UPDATE_CONFIG="$(cat /path/to/beta-config.json)" pnpm package
format=AppImage  # AppImage, deb or rpm
pnpm installer --target "$format" --metadata /path/to/installer-metadata.json
```

For a macOS DMG, set `OPENKRAKEN_UPDATE_CONFIG` to the same JSON when running `pnpm package`. For a Windows MSI, set `$env:OPENKRAKEN_UPDATE_CONFIG = Get-Content -LiteralPath .\beta-config.json -Raw` in the PowerShell session used for packaging. Then follow the native signing and verification steps for your installer. [Native installer builds](../README.md)

Collect the native installer build receipts and their named installer files on the signing machine. Keep each pair together. For example, a release descriptor can list `{"manifest":"linux-x64/AppImage/manifest.json"}` and `{"manifest":"win32-x64/msi/manifest.json"}` as entries in its `artifacts` array. The paths are relative to the descriptor. The signer checks the descriptor version against each receipt and rechecks the size and digest of its installer. [Descriptor format](decisions/0082-signed-update-release-protocol.md#signing-from-installer-build-receipts)

Sign a descriptor for **each** candidate, including the first. Set its channel to `beta`, use the exact package version and increase the sequence for each release. From a POSIX signing machine with Node and jq, run the following commands in a fresh output directory. Set `platform`, `arch` and `format` for the participant. The platform values are `linux`, `darwin` and `win32`. Include each published artifact in the descriptor.

```sh
platform=linux
arch=x64
format=AppImage
node /path/to/openkraken/scripts/sign-update.mjs descriptor.json private-key.pem release.json > receipt.json &&
  jq -er --arg platform "$platform" --arg arch "$arch" --arg format "$format" '
    .artifacts[] | select(.platform == $platform and .arch == $arch and .format == $format)
    | "\(.sha256)  \(.name)"
  ' receipt.json > SHA256SUMS
```

Publish the immutable, versioned installers before the signed manifest. Before sending invitations, run `node scripts/verify-update-feed.mjs beta-config.json release.json` with the configuration used to build the candidate and the signed envelope from the signing machine. Retain the successful JSON receipt with the beta record. It identifies the checked feed, signing key fingerprint, signed payload digest, validity period and installer hashes. In the invitation, give participants the candidate version, architecture, HTTPS artifact URL, feedback contact and the **one-line SHA256SUMS from the signing machine**. Deliver that line through an independently authenticated release-owner channel the participant already trusts. [Installer instructions](../README.md) · [Feed and signing procedure](decisions/0082-signed-update-release-protocol.md)

## Validate a Windows beta installer

On Windows x64, set the checkout version to the candidate, then run `pnpm package`, `pnpm installer --test-metadata --target msi` and `pnpm smoke:installer release/installers/win32-x64/test/msi/manifest.json`. The receipt and installed application carry the full beta version, such as `0.2.0-beta.10`. Windows Installer displays the numeric core and the package tracks the beta revision in the current user’s registry. The Windows CI workflow also exercises promotion to stable, attempted downgrades and profile retention on a disposable runner. Public Windows distribution still requires native acceptance and release signing. [MSI lifecycle acceptance](decisions/0092-disposable-msi-lifecycle-acceptance.md)

## Verify the first download

Save the checksum line from the invitation as `SHA256SUMS` in an empty directory. Download the selected installer into the same directory with the exact filename from that line. On Linux, run this command there before opening or installing it.

```sh
sha256sum --check --strict SHA256SUMS
```

On macOS, run the following command in the download directory.

```sh
shasum -a 256 --check SHA256SUMS
```

On Windows, run the following in PowerShell in the download directory. It reads the expected MSI filename and digest from the invitation’s checksum line.

```powershell
$line = @(Get-Content -LiteralPath .\SHA256SUMS -ErrorAction Stop)
if ($line.Count -ne 1 -or $line[0] -cnotmatch '^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*\.msi)$') {
    throw 'Expected a single MSI checksum line'
}
$expected = $Matches[1]
$file = $Matches[2]
if ((Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash -ne $expected) {
    throw "Checksum differs for $file"
}
"$file OK"
```

Continue when the command exits successfully and prints the expected installer filename followed by `OK`. If the file is missing or the checksum differs, discard the download and contact the release owner. For a DMG or MSI, open the verified installer and follow the platform installation steps. For an AppImage, grant execute permission to the verified file and launch it. For a DEB or RPM, open the verified file with the system package installer. These formats use the same `openkraken` package name for beta and stable. Installing a newer candidate replaces the installed application. Subsequent checks in **Updates** verify the manifest using the key embedded in that build.

## Exercise a candidate

1. Launch the beta in its default profile. In **Updates**, confirm that the dialog shows **Beta channel**. Crash reporting and automatic checks start disabled.
2. Open a disposable checkout representative of your usual work. Record the candidate version, operating system, CPU architecture, Git version, repo size and the operation you exercised.
3. Open **Updates**, check for the next candidate, download it and save your work. For an AppImage, choose **Install and restart**. For a DEB, RPM, DMG or MSI, choose **Save installer…**, quit OpenKraken, and use the native installer. Confirm that the new version starts with your beta preferences. If you kept the stable AppImage, launch it separately to check its preferences.
4. To check download recovery, close the app after **Updates** reports a verified download. Reopen **Updates**, check for updates and select the same format. If the same release is still available, the app verifies the saved bytes and offers the install or save action again. If the app closed during the transfer, selecting the format downloads it from the beginning.
5. Send the release owner the observed result, expected result and reproducible steps through the feedback route supplied with the invitation. Include repository contents, paths, account details or diagnostics only if you choose to share them.

For each candidate the release owner records the artifact digest, verification key identity, expiry, tested platforms, participant feedback and dispositions of release-blocking defects. The Linux fixture tests the updater using disposable keys and local HTTPS. Recruiting participants, supplying a real feedback route and approving public distribution are release-owner actions.
