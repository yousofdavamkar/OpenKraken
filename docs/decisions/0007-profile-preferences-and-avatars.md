# 0007 — Persisted graph views and opt-in author photos

Status: accepted.

## Profile-owned settings

Store each repository's hidden, solo and pinned refs in `repos/<sha256-canonical-path>.json` beneath Electron's user-data directory. Validate the GraphView schema on read and write, use private permissions and atomic rename, and recover from malformed JSON/schema with the default view. Preserve missing ref names so a deleted solo ref cannot silently reveal all history. Selection and search remain session state; Refresh still resets the loaded window to 2,000 commits.

## Author photos

Show generated initials by default. The Author photos checkbox explicitly opts into Gravatar; its tooltip explains that hashed author email addresses are sent to the provider. Persist the preference in the app profile. Only virtualized visible rows request photos, with duplicate addresses and concurrent requests coalesced.

The main process normalizes email addresses (trim/lowercase) and computes SHA-256, following [Gravatar's image API](https://docs.gravatar.com/sdk/images/). An isolated, nonpersistent Electron session fetches without credentials. Redirects must remain HTTPS on allowed Gravatar hosts and retain the requested hash path. Requests time out after eight seconds, accept only supported image media types, and cap downloads at 64 KiB. Electron decodes and normalizes successful images to 32-pixel PNGs; the renderer receives only validated PNG data URLs. Renderer network access remains disabled.

Memory and disk caches each hold at most 256 entries. Positive entries expire after seven days, missing-image results after one day. A stale cached photo remains available when the provider fails, with a one-minute retry delay. Disabling photos cancels active requests, clears memory and restores initials; disk entries remain available for a later opt-in. Failed or absent photos always fall back to initials. Atomic profile writes never touch repository configuration or files.

## Evidence

Unit tests cover malformed preferences, isolated repositories, opt-in, deduplication, expiration, offline fallback, eviction, cancellation, corrupt cache entries, redirects, decoding and response limits. Electron tests restart the entire app to verify persisted solo/pin state and offline photos. Photo tests use a local response stub; no author address is sent to Gravatar during tests.
