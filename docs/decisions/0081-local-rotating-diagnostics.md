# 0081 — Local rotating diagnostics without request content

The specification requires rotating log files with token and credential-URL redaction. Persistent diagnostics use fixed structured fields instead of arbitrary messages. This excludes credentials and URLs at the input boundary rather than trying to recognize every secret in native stderr. The separate user-visible Git diagnostic redactor remains described in ADR 0079.

## Contents and ownership

Main owns the logger and its read/clear IPC routes. Records contain a random per-record identity and timestamp, plus one of:

- App start/normal shutdown: version, operating system and architecture.
- Request completion: an allowlisted operation name, duration, outcome and an optional fixed error code. Unknown codes become `OTHER`; unlisted failed operations use `other`.
- Process failures: a fixed component and failure category. Unknown reasons become `unknown`; normal process exits are omitted.
- Queue overflow: the number of omitted records.

Successful activity operations and history refresh/page/search requests are recorded. Successful low-level/read-only UI chatter is omitted. There are no request payloads, repository/account identifiers, paths, URLs, commit messages, source content, exception values/stacks, native output, environment variables, credentials or machine identifiers. No arbitrary-message write route exists. Renderer failure reports retain their strict fixed-category contract; the Git utility cannot create main-owned log records directly.

These logs are local and independent of opt-in crash reports. They are never attached to crash-report envelopes or sent to a provider. Users can inspect/select the JSON records in **Diagnostics**, refresh the view, and explicitly clear supported files. Clearing does not disable future logging: shutdown and subsequent startup create new records.

## Retention and storage

Files live in `diagnostics/` beneath Electron's user-data directory (including a custom `--user-data-dir`). The current segment is `diagnostics-0.json`; segments 1 and 2 are older. Each strict version-1 JSON segment contains at most 256 records and is bounded to 256 KiB. Rotation removes the oldest whole segment, so retention varies below the maximum 768 records. No repository-local file is created.

Writes are serialized in main. Each segment replacement uses a private, exclusively created `diagnostics-next.tmp`, file sync and atomic rename. Rotation moves existing segments before creating the next current segment. A crash can leave fewer retained older segments, but does not require accepting a partially appended JSON record. A single bounded regular temporary file is discarded on next startup after validating the committed segments. The fixed scratch filename prevents repeated interruptions from accumulating random temporary files. Directory metadata is not explicitly synced; power-loss durability and complete fatal-process coverage are not guaranteed.

New directories/files use modes 0700/0600. POSIX storage with group/other permissions is refused. Symlinks, hard-linked files, non-files, oversized/invalid segments and redirected directories stop logging without overwriting their targets. Loaded content is checked against the strict record schema. Source comparisons detect external changes before replacement/rotation; this is not a guarantee against a hostile process running under the same account. The single-instance main process owns the directory. Unsupported files are preserved for manual repair; the session does not automatically resume after a storage failure. Clearing unsupported storage is rejected, and a failure during a supported multi-file clear may leave some files uncleared.

At most 128 event jobs wait in memory; excess records are counted and a fixed drop notice is written when capacity permits. Read/clear controls share the serialized queue and are additionally bounded by main's existing IPC admission limit. Filesystem failure never rejects the underlying Git/provider operation. Normal app shutdown flushes queued diagnostics under the existing overall 1.5-second shutdown deadline. Forced termination or immediate fatal exit may lose pending records; diagnostics are not a replacement for the activity history or interrupted-session crash marker.

## Evidence

Native tests exercise production rotation limits, retention across restart, clearing, queue overflow, malformed/external storage, private permissions, symlink/hard-link refusal including scratch files, interrupted scratch cleanup, and exclusion of malicious codes/reasons/messages. Contract tests reject arbitrary payloads and utility-side access.

Electron acceptance runs a real failing native hook containing credentials, URL parameters and arbitrary private output. The UI and disk logs retain only the operation outcome. It also verifies selection/copy preparation, clearing/restart behavior, a real renderer crash and JavaScript failure without exception content, and repository opening while log storage is corrupt. Native Windows/macOS filesystem/ACL behavior and forced power-loss durability remain unverified.
