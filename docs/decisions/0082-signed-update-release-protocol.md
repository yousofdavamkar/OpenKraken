# 0082 — Signed update release metadata

The roadmap requires signature-verified updates for Linux, macOS and Windows. The existing installer inventory is unsigned and cannot authorize installation. We use an independent, versioned signed release envelope, verified in the main process, to authenticate installer bytes. Platform installation and restart remain separate work; this protocol alone does not constitute automatic update support.

The build owns one HTTPS feed and one Ed25519 public key in canonical base64 SPKI DER form. Missing configuration disables update networking. The feed cannot contain credentials, parameters or a fragment. Metadata cannot supply a new key, algorithm or artifact URL. Artifacts are safe basenames relative to the feed directory. Key rotation requires a trusted new app build; there is no remotely supplied trust-root rotation.

An envelope contains only `payload` and `signature`, both canonical base64. Ed25519 signs `OPENKRAKEN-UPDATE-V1\n` followed by the exact UTF-8 JSON payload bytes. Verification uses Node's crypto implementation before interpreting the payload. The envelope is limited to 48 KiB, payload to 32 KiB, and signature to 64 bytes. Its payload binds schema version 1, product `org.openkraken.desktop`, stable channel, positive monotonic release sequence, canonical stable SemVer, issue/expiration timestamps and up to 16 artifacts. Stable versions currently exclude prerelease and build suffixes. Metadata lasts at most 30 days with five minutes of future clock skew. A device with an incorrect clock may be unable to update.

Each artifact binds platform, architecture, package format, safe basename, positive size (at most 2 GiB) and SHA-256. Platform/architecture/format tuples and case-insensitive filenames must be unique. Linux permits AppImage/DEB/RPM, macOS DMG/ZIP, and Windows MSI. Downloaders must verify both signed length and digest before handing a file to an installer. Platform code signing and package-manager verification are additional protections, not substitutes for this metadata signature.

`node scripts/sign-update.mjs descriptor.json private-key.pem release.json` is an offline producer. The descriptor has the release fields above and artifact entries `{platform, arch, format, path}`. Paths resolve relative to the descriptor. It streams regular files to calculate sizes and hashes, rejects changing or invalid files, validates the release and signs with an Ed25519 PEM private key. It writes and syncs the envelope in a private staging directory alongside the destination. A hard link publishes the complete envelope at an unused filename. Concurrent publishers cannot overwrite each other. A process exit during writing can leave a staging directory, and the final name remains available for retry. The output directory must support hard links. The publisher prints the public key, channel, sequence, version and artifact inventory. It never uploads or installs anything. Keep private keys outside the repository and never put them in build configuration. Publishing the corresponding immutable artifacts and metadata is a separate release action.

The updater retains the highest authenticated sequence and payload digest, rejecting older sequences and same-sequence changes across restarts. Such state cannot protect a fresh installation or an attacker-controlled local profile from rollback to an otherwise still-valid signed release; comparing against the installed version and the bounded validity window also remain necessary. Private `trusted-release.json` is synced and atomically replaced before offering a release, with a directory sync on POSIX. Corrupt, redirected, non-private or externally changed storage fails closed. An unrecognized configuration change leaves the stored release history intact and prevents checks. A trusted build can explicitly name its preceding configuration as described below.

Checks were initially user initiated; [ADR 0085](0085-opt-in-automatic-update-checks.md) adds separately consented automatic checking through the same verifier. Main accepts read/check/cancel and an allowlisted format for downloading a previously authenticated release. The later installation and automatic-preference routes carry identities and settings only. No URL, path, key or command crosses renderer IPC. Default builds embed null configuration and create neither update files nor requests. `OPENKRAKEN_UPDATE_CONFIG` is validated by the build script; it is not read by the running app. Network operations use normal HTTPS certificate validation, omit credentials/referrers, reject redirects and non-identity encoding, and have 30-second metadata/10-minute artifact deadlines. Only one operation runs at a time. Cancellation and app shutdown abort the active transport; the existing app shutdown deadline is unchanged. Responses expose fixed failure categories, never remote bodies or exception text.

Metadata is streamed with a 48 KiB cap. Artifacts stream to an exclusive private scratch file with exact signed length and SHA-256 checks, then sync and rename to `artifact.ready`. An existing cache is removed before a new download, failed/incomplete owned scratch files are removed, and expiration/storage ownership are checked again before promotion. Startup discards incomplete scratch files. A complete private file can be reused after a fresh signed check confirms the same accepted release under the same feed and verification key. Selecting a format rehashes the file against its signed size and digest. Missing or mismatched bytes trigger a new transfer. Advancing the watermark retires the previous file first. Each verified selection issues fresh save or install approval IDs. Exporting checks the bytes again. A saved Linux AppImage gets owner read, write and execute permissions after that check. The cached copy stays private with its execute bits cleared. These checks do not defend against an attacker who controls the user's account or races arbitrary changes inside its private profile.

The original Updates dialog offered check, download, progress and cancellation without installation. [ADR 0084](0084-appimage-desktop-update-handoff.md) adds supported AppImage installation/restart, ADR 0085 adds opt-in automatic checks, and [ADR 0086](0086-appimage-startup-exit-recovery.md) adds startup-exit restoration. Closing the dialog does not cancel a transfer; quitting does. Further recovery of hung or interrupted installations, other native installation formats, production release configuration, signed installers and native platform acceptance remain open. No release has been published by this implementation.

## Rechecking a downloaded installer

The running desktop retains a verified download across manual and scheduled checks, including an unsuccessful metadata request. A successful check of the same signed release makes its formats selectable again. Selecting a format reads the cached bytes, verifies their signed size and SHA-256 and issues a fresh approval ID. A different digest or size requires another download. A newer release sequence retires the old file before recording the new release.

On POSIX the desktop syncs the update directory after renaming the scratch file to `artifact.ready`. It checks the release validity, local trust record and cancellation again before offering Save or Install. If the sync fails, the next selection revalidates the file and retries the sync. A file surviving a process exit follows the same verification on restart.

## Configuring a release feed

For a beta feed, configure the channel and prerelease versions described in [ADR 0118](0118-beta-update-channel.md). The following example configures a stable build.

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

## Serving and checking a release

For a self-hosted feed, point a hostname you control at the HTTPS server and allow inbound traffic on ports 80 and 443. This example Caddyfile selects Let's Encrypt for TLS certificates and serves versioned installers beside the manifest. Replace the example hostname with the one in the build configuration. Give Caddy persistent storage for its certificate state. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) · [TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls)

```caddyfile
updates.example.org {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
        }
    }
    root * /srv/openkraken-updates
    @manifest path /stable/release.json /beta/release.json
    header @manifest Cache-Control "no-cache"
    file_server
}
```

Put only the public distribution files in the web root. For a feed ending in `/beta/release.json`, place the signed installer filenames under `/srv/openkraken-updates/beta/`. After all those files are in place, publish the signed envelope at `beta/release.json` with a same-filesystem rename so a concurrent reader receives a complete manifest. Keep earlier versioned URLs available for downloads already in progress. The release signing key stays on the signing machine.

From the checkout with dependencies installed, run this check with the public configuration embedded in the build and a copy of the signed envelope from the release owner.

```sh
node scripts/verify-update-feed.mjs build-config.json signed-release.json
```

The check authenticates the approved candidate, fetches the configured HTTPS manifest and requires the same authenticated payload. It streams every listed platform and architecture through the desktop's size and digest checks, then verifies the manifest again. Exit code zero and the JSON receipt identify the feed, release sequence, version and artifact inventory checked during that run. A feed change during the check requires verification against the newly approved candidate.

## Moving a feed or rotating a release key

A publisher can include `migrateFrom: { feed, publicKey }` in the new build's `OPENKRAKEN_UPDATE_CONFIG`. The top-level feed and public key are the new values. Both pairs use the same HTTPS and Ed25519 validation. The build's stable or beta channel applies to both. A release served over the network has no authority to name a predecessor.

For a planned rotation, the old feed can continue serving a release signed with the old key that installs the migration-capable build. The new build checks its configured destination with its new public key. Its first accepted release must advance the previous sequence or carry the identical payload at that sequence. The app then saves the sequence and payload digest against the new configuration. Operators can keep the predecessor declaration in later builds to support profiles that have yet to check the new feed. Once a profile has migrated, subsequent builds can omit the declaration for that profile.

Migration clears the preceding automatic-check consent, including its revision and deadline. The user can check manually or enable automatic checks for the new configuration. A rejected signature, lower sequence or conflicting reuse of a sequence leaves the stored watermark intact. After migration, an older build that lacks a matching declaration refuses to update that profile.

## Signing from installer build receipts

A publisher can put `{"manifest":"path/to/manifest.json"}` in a release descriptor’s artifact list. Each receipt path resolves relative to the descriptor. The installer resolves relative to its receipt. The signer reads the platform, architecture, format, full application version, filename, size and SHA-256 from the build receipt. The release version must match exactly, including the beta suffix. The shared update schema validates the artifact identity before the signer opens its file. The signer reads the file and compares its size and digest with the receipt before publishing the envelope.

This allows a single signing machine to assemble artifacts from multiple native builds. The publisher obtains the receipts from its trusted build process. Native code signing and installer smoke tests still run on their respective platforms. Existing explicit entries with `platform`, `arch`, `format` and `path` can appear alongside receipt entries.

The hosted-feed verification receipt includes `publicKeySha256` over the configured Ed25519 public key’s DER SubjectPublicKeyInfo bytes, `payloadSha256` over the authenticated payload bytes, and the signed `issuedAt` and `expiresAt` timestamps in Unix milliseconds. These fields let the release owner identify which key and candidate the verifier checked.
