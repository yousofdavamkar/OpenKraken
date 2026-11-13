# 0117. Read history cache inputs while Git enumerates references

The Git version, effective config, shallow boundary, grafts, alternates and commit-graph metadata can be read as soon as a repository snapshot starts. Queue these reads alongside references, linked worktrees and status. Build the cache key after resolving visible history roots and stash bases. Use the existing key format so reopening a checkout can reuse its stored history.

On failure, cancel the candidate snapshot and wait for every started read before releasing its repository queue. The displayed history remains available for paging. The regression test holds reference enumeration open, fails the config read and verifies both cleanup and the next page from the displayed history.
