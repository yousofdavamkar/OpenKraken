# 0117. Read history cache inputs while Git enumerates references

The Git version, effective config, shallow boundary, grafts, alternates and commit-graph metadata can be read as soon as a repository snapshot starts. Queue these reads alongside references, linked worktrees and status. Build the cache key after resolving visible history roots and stash bases. Use the existing key format so reopening a checkout can reuse its stored history.

On failure, cancel the candidate snapshot and wait for every started read before releasing its repository queue. The displayed history remains available for paging. The regression test holds reference enumeration open, fails the config read and verifies both cleanup and the next page from the displayed history.

## Reading graph metadata within a fixed memory budget

Fingerprint the shallow boundary, grafts and object alternates in chunks of at most 64 KiB. Keep the existing base64 key for files up to that size. For a larger file, include its SHA-256 digest in the generation key. The first open after this change rebuilds a cache that used the old representation of a large metadata file.

A missing file contributes the existing empty key. If a file is unreadable, has an unexpected type, changes size or is replaced during the read, bypass cache adoption and writes for that opening. A failed commit-graph metadata lookup also bypasses the cache. Native Git then determines the displayed history. After the metadata becomes readable, the next open can validate and update the saved cache again.

On Linux x64, a 32,800,000-byte synthetic shallow-boundary file was fingerprinted in six fresh Node processes. Across three runs per implementation, the increase in peak resident memory above the pre-read high-water mark was 160,620–161,796 KiB with whole-file base64 encoding and 124–256 KiB with the bounded reader. This measures cache-key construction in isolation. The native integration tests also open a repository with unreadable metadata, compare every displayed commit ID with Git and confirm the prior cache file survives until a later valid open.
