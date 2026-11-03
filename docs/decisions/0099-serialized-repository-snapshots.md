# 0099 — Use the existing serialized bridge for repository snapshots

## Context

The repository store already uses the typed bridge's JSON response mode for append-only history pages. A startup trace with the reduced reference model measured about 223 ms between main's reply and renderer receipt with an object response, versus about 114 ms in a subsequent JSON-mode sample. These are separate instrumented runs, not proof of an isolated causal difference.

## Decision

Use the same JSON response mode for the repository store's main request path, including open, refresh and operation results. Decode the returned string in the renderer before the existing result handling. Keep the shared `Result` type, request validation, sender validation and main's validation of utility responses. The transport and accepted response formats are unchanged; this selects an existing supported mode.

Errors still use the existing result/error handling, and stale request identities still prevent publication. JSON preserves the contract's strings, arrays and plain objects; no binary or executable payload is introduced. Existing store tests exercise stale refreshes, paging and errors; the live serialized-IPC test checks Unicode, quotes, backslashes, multiline Git text, history pages, errors and invalid response formats.

The earlier JSON experiment in the performance report was reverted with the larger payload. This decision records a new evaluation after removing unused reference subjects. Final uninstrumented measurements include the direct-first reader from ADR 0098, so their improvement is attributed to the combined change, not entirely to serialization. The 500 ms first-paint gate remains unchanged and failing.
