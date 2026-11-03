# 0063 — Serialized history page responses

## Decision

The typed desktop request API accepts an optional `json` response format. Main validates the sender, format and request before dispatch, then serializes the validated result before renderer IPC. Preload forwards the string across the isolated-world bridge. History paging parses that string in the renderer and retains the existing cursor, offset, cancellation, worker-layout and append-only state checks. Other callers keep the default object response.

This uses the existing request channel and grants no additional operations. Main validates utility-process responses before serialization; renderer-side parsing is decoding trusted application data, not a replacement for boundary validation. No code is evaluated. Requests remain objects validated in preload and main. Errors and cancellation use the same result union in both formats, and unknown response formats are rejected.

[Electron documents that contextBridge copies return values between contexts](https://www.electronjs.org/docs/latest/api/context-bridge#parameter--error--return-type-support). A page contains thousands of nested commit and signature objects. Serializing in main avoids copying that object graph through both renderer IPC and the isolated-world boundary. Serializing only in preload leaves the first object copy in place.

## Evidence and limits

The unchanged 5,000-commit paging test reproduced the failure with native menus, and the pre-menu baseline also failed once. Main-process profiling showed no meaningful menu-update work. A preload-only serialization experiment passed three initial runs but failed two later runs under contention; warmed same-app comparisons were mixed. Moving serialization to main produced three passing end-to-end runs at 208, 221 and 207 ms against the unchanged 300 ms budget. Same-app paired measurements of the object and JSON transports also favored main serialization overall, though individual samples varied.

The existing paging test remains the performance regression gate, including unchanged prior lanes, unloaded search and bounded scrolling. A real Electron IPC test checks Unicode, quotes, backslashes and multiline Git messages, remaining-page order, stale-offset errors, invalid requests/formats, and equivalence with the default object response. CPU contention remains an environmental limit; these measurements do not establish performance on real large repositories or every supported platform. Full-suite results are recorded separately in M7 progress.
