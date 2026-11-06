# 0082 — Signed update release metadata

The roadmap requires signature-verified updates for Linux, macOS and Windows. The existing installer inventory is unsigned and cannot authorize installation. We use an independent, versioned signed release envelope, verified in the main process, to authenticate installer bytes. Platform installation and restart remain separate work; this protocol alone does not constitute automatic update support.

The build owns one HTTPS feed and one Ed25519 public key in canonical base64 SPKI DER form. Missing configuration disables update networking. The feed cannot contain credentials, parameters or a fragment. Metadata cannot supply a new key, algorithm or artifact URL. Artifacts are safe basenames relative to the feed directory. Key rotation requires a trusted new app build; there is no remotely supplied trust-root rotation.

An envelope contains only `payload` and `signature`, both canonical base64. Ed25519 signs `OPENKRAKEN-UPDATE-V1\n` followed by the exact UTF-8 JSON payload bytes. Verification uses Node's crypto implementation before interpreting the payload. The envelope is limited to 48 KiB, payload to 32 KiB, and signature to 64 bytes. Its payload binds schema version 1, product `org.openkraken.desktop`, stable channel, positive monotonic release sequence, canonical stable SemVer, issue/expiration timestamps and up to 16 artifacts. Stable versions currently exclude prerelease and build suffixes. Metadata lasts at most 30 days with five minutes of future clock skew. A device with an incorrect clock may be unable to update.

Each artifact binds platform, architecture, package format, safe basename, positive size (at most 2 GiB) and SHA-256. Platform/architecture/format tuples and case-insensitive filenames must be unique. Linux permits AppImage/DEB/RPM, macOS DMG/ZIP, and Windows MSI. Downloaders must verify both signed length and digest before handing a file to an installer. Platform code signing and package-manager verification are additional protections, not substitutes for this metadata signature.

`node scripts/sign-update.mjs descriptor.json private-key.pem release.json` is an offline producer. The descriptor has the release fields above and artifact entries `{platform, arch, format, path}`. Paths resolve relative to the descriptor. It streams regular files to calculate sizes and hashes, rejects changing or invalid files, validates the release and signs with an Ed25519 PEM private key. It creates output exclusively, refuses to overwrite a prior release, and prints only public key, sequence and version. It never uploads or installs anything. Keep private keys outside the repository and never put them in build configuration. Publishing the corresponding immutable artifacts and metadata is a separate release action.

The updater retains the highest authenticated sequence and payload digest, rejecting older sequences and same-sequence changes across restarts. Such state cannot protect a fresh installation or an attacker-controlled local profile from rollback to an otherwise still-valid signed release; comparing against the installed version and the bounded validity window also remain necessary. Private `trusted-release.json` is synced and atomically replaced before offering a release, with a directory sync on POSIX. Corrupt, redirected, non-private or externally changed storage fails closed. Configuration changes invalidate existing trust state; a future trusted-build key/feed migration must explicitly handle that state, rather than silently resetting rollback protection.

Checks were initially user initiated; [ADR 0085](0085-opt-in-automatic-update-checks.md) adds separately consented automatic checking through the same verifier. Main accepts read/check/cancel and an allowlisted format for downloading a previously authenticated release. The later installation and automatic-preference routes carry identities and settings only. No URL, path, key or command crosses renderer IPC. Default builds embed null configuration and create neither update files nor requests. `OPENKRAKEN_UPDATE_CONFIG` is validated by the build script; it is not read by the running app. Network operations use normal HTTPS certificate validation, omit credentials/referrers, reject redirects and non-identity encoding, and have 30-second metadata/10-minute artifact deadlines. Only one operation runs at a time. Cancellation and app shutdown abort the active transport; the existing app shutdown deadline is unchanged. Responses expose fixed failure categories, never remote bodies or exception text.

Metadata is streamed with a 48 KiB cap. Artifacts stream to an exclusive private scratch file with exact signed length and SHA-256 checks, then sync and rename to `artifact.ready`. An existing cache is removed before a new download, failed/incomplete owned scratch files are removed, and expiration/storage ownership are checked again before promotion. One download is retained; startup discards prior cache and scratch files and requires a fresh authenticated check/download. Cache contents must be reverified before any future installation handoff. These checks do not defend against an attacker who controls the user's account or races arbitrary changes inside its private profile.

The original Updates dialog offered check, download, progress and cancellation without installation. [ADR 0084](0084-appimage-desktop-update-handoff.md) adds supported AppImage installation/restart, ADR 0085 adds opt-in automatic checks, and [ADR 0086](0086-appimage-startup-exit-recovery.md) adds startup-exit restoration. Closing the dialog does not cancel a transfer; quitting does. Recovery of hung or interrupted updates, other native installation formats, production release configuration, signed installers and native platform acceptance remain open. No release has been published by this implementation.

## Configuring a release feed

Choose a stable manifest URL on a host the publisher controls. Enable managed HTTPS with automatic certificate renewal, or configure an ACME client on that host. A Let's Encrypt certificate authenticates the connection to the host. The app verifies each release manifest with an independent Ed25519 key, so routine TLS certificate renewal requires no app rebuild. [Let's Encrypt setup](https://letsencrypt.org/getting-started/)

On a POSIX signing machine, run these commands once from a private location outside the checkout. The fresh directory prevents a rerun from overwriting an existing key. Keep the private PEM and a protected backup under the publisher's control. Copy only the single-line public key to the build machine.

```sh
(
  set -eu
  umask 077
  mkdir openkraken-release-key
  cd openkraken-release-key
  openssl genpkey -algorithm ED25519 -out private-key.pem
  openssl pkey -in private-key.pem -pubout -outform DER -out public-key.der
  openssl base64 -A -in public-key.der
  printf '\n'
)
```

At package build time, set `OPENKRAKEN_UPDATE_CONFIG` to JSON with that public key and the actual HTTPS manifest URL. For example, replace both values in `{"feed":"https://updates.example.org/stable/release.json","publicKey":"<base64 public key>"}`. On the signing machine, use the offline publisher above with the same private PEM. Publish the immutable artifact files first, then the signed manifest, so every file it references is already available in the same directory. The host must serve the files directly without redirects.
