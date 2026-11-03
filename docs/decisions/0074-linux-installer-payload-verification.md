# 0074 — Linux installer payload verification

M8 requires installable packages without weakening the hardened Electron bundle.

## Decision

Build DEB and RPM on native Linux x64/arm64 with pinned electron-builder 26.18.0, using its public `prepackaged` API. Copy the bundle before wrapping it: FPM adds an AppArmor profile, and packaging must not mutate the original bundle. Recheck every original file's SHA-256, size and mode, directory modes, symlink destinations and the five hardened Electron fuses. Unexpected additions or changes fail the build. Relative links must remain inside the bundle.

Normalize Linux bundle directories/executables to 0755 and other files to 0644. Electron's ZIP preserved writable modes in the first bundle; RPM extraction exposed them during comparison. Refuse payloads with group/other write or special permission bits, generate installer metadata under umask 022, and preserve archived modes during extraction so verification cannot hide unsafe permissions. The root-installed Chromium SUID helper is configured separately by the post-install hook when required.

Require explicit maintainer name/email, HTTPS homepage and license through a JSON file, or an explicit `--test-metadata` flag. Test artifacts carry `TEST-ONLY` filenames, reserved `example.invalid` metadata and `UNLICENSED`; these are validation fixtures, not project ownership or license decisions. No repository remote or project license has been supplied. All artifacts are unsigned, publication is disabled, and manifests label metadata mode and source commit/dirty state. Adjacent SHA-256 manifests detect corruption; they are not authenticity proofs or update signatures.

Keep the existing Git 2.38 minimum and add Electron's audio, GBM, CUPS and C++ runtime dependencies to builder's defaults. RPM also requires the Secret Service library. Use RPM v4 payloads and SHA-256 file digests explicitly: the locally available RPM 6 otherwise emitted a payload the extraction tool could not read. RPM dependency declarations use shared-library capabilities for these additions.

The desktop entry launches the executable directly without disabling the Chromium sandbox. The existing bundle embeds `openkraken.desktop` for desktop association. Installer icons are independently authored diamonds matching OpenKraken's own UI mark. The builder's post-install hook registers the launcher, selects the SUID sandbox only when user namespaces are unavailable, and conditionally installs its Ubuntu user-namespace AppArmor profile. A custom removal hook distinguishes final removal from Debian/RPM replacement phases, preserving a replacement installation's launcher/profile. No hook touches user configuration or repositories.

## Verification boundary

`smoke:installer` accepts a locally built or independently authenticated artifact and its manifest. It checks the archive hash before extracting without root, compares the complete payload and fuses, checks the desktop launch entry and Git dependency, then exercises the existing packaged Electron UI smoke boundary: renderer isolation, native askpass/editor helpers, and optional native picker/Bash/PTY checks. It does not authenticate an untrusted downloaded artifact.

The disposable Debian lifecycle check installs dependencies through APT, checks shared-library resolution and desktop integration, exercises the shipped replacement guards, reinstalls, removes and purges the package, and checks that fixture user data survives. It runs only inside an explicitly opted-in disposable container. It does not establish an RPM distribution's install lifecycle, a graphical login session in the container, actual version-to-version migration, or all distribution/architecture combinations.

Linux CI builds both test artifacts and runs extraction/UI checks plus the Debian lifecycle fixture. Existing unsigned platform-bundle CI remains on macOS/Windows. AppImage, DMG/MSI, signing/notarization, authenticated updates, real release metadata and distribution acceptance remain separate work. In particular, the inspected builder AppImage launcher can add `--no-sandbox`; do not adopt that fallback. This pipeline exposes no AppImage target yet.

Public implementation references: [electron-builder v26 CLI/prepackaged](https://www.electron.build/v26/docs/cli/), [Linux options](https://www.electron.build/v26/docs/linux/) and [RPM format documentation](https://rpm.org/docs/6.0.x/manual/format_v6.html). No proprietary artifacts were consulted.
