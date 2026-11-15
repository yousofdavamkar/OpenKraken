# Running an OpenKraken beta

## Prepare a candidate

Use a checkout whose package version is the candidate version, for example `0.2.0-beta.2`. For the Linux AppImage path, configure the build with the beta feed and the publisher's public Ed25519 verification key. A configuration has this shape.

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
pnpm installer --target AppImage --metadata /path/to/installer-metadata.json
```

For the next candidate, sign a descriptor with channel `beta`, the exact new package version, a higher sequence and the matching artifact. Use the offline signing command and publish the immutable artifact before its manifest. The first AppImage needs its own authenticated distribution and verification instructions for the intended audience. [Installer instructions](../README.md) · [Feed and signing procedure](decisions/0082-signed-update-release-protocol.md)

## Exercise a candidate

1. Launch the beta in its default profile. In **Updates**, confirm that the dialog shows **Beta channel**. Crash reporting and automatic checks start disabled.
2. Open a disposable checkout representative of your usual work. Record the candidate version, operating system, CPU architecture, Git version, repo size and the operation you exercised.
3. Open **Updates**, check for the next candidate, download it, save your work and choose **Install and restart**. Confirm that the new version starts with your beta preferences. Launch the stable build separately to check your stable preferences.
4. Send the release owner the observed result, expected result and reproducible steps through the feedback route supplied with the invitation. Include repository contents, paths, account details or diagnostics only if you choose to share them.

For each candidate the release owner records the artifact digest, verification key identity, expiry, tested platforms, participant feedback and dispositions of release-blocking defects. The Linux fixture tests the updater using disposable keys and local HTTPS. Recruiting participants, supplying a real feedback route and approving public distribution are release-owner actions.
