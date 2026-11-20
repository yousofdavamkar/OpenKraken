# 0104 — Reuse snapshot refs for the initial watcher baseline

## Context

A startup trace on the 50,000-ref fixture measured 125 ms establishing the watcher baseline immediately before a 424 ms snapshot read. Both enumerated all refs. The initial watcher enumeration needs names, direct targets, upstreams and tracking counts already retained in the snapshot. Response transfer and validation remain separate startup costs.

## Decision

Let a fresh watcher prime its baseline around the initial snapshot read. Complete all other baseline reads first: status, HEAD, operation/config metadata, worktrees, shallow state and FETCH_HEAD. Then read the snapshot and reconstruct the watcher's reference identity bytes from its complete ordered ref list. Preserve direct annotated-tag targets and the exact native ahead/behind/gone tracking representation. Do not use the graph's filtered subset.

Finishing the other reads before the snapshot is deliberate. Running them alongside it could capture newer state than the displayed snapshot and hide an intervening external change. Ref identities come from the snapshot itself, so a later change remains detectable by the next native fingerprint. No filesystem or native Git validation is replaced with a timer assumption.

Keep the existing delayed subscription startup, pre/post-subscription checks, native self-test, polling fallback and normal native reference enumeration for every later check. Priming is permitted once on a fresh watcher. Checks wait for pending priming; closure drains it and suppresses notifications. If the initial snapshot fails, the utility drops and closes that watcher so retry creates a fresh baseline. Metadata-read failure retains the existing polling fallback behavior.

Reconstruction preserves valid UTF-8 ref names. If a native ref name contains invalid UTF-8 bytes, the existing snapshot decoding can change those bytes. The next raw native fingerprint then differs conservatively and can trigger one extra refresh; subsequent checks retain the raw native baseline. This change does not add support for operating on non-UTF-8 ref names.

## Verification and limits

The initial regression observes two native ref enumerations before this change and one afterward. Native tests compare the seeded baseline with a fresh fingerprint for checkout, bare and linked repositories, including ahead/behind/equal/gone upstreams, Unicode names, annotated/blob tags and stashes. Handoff tests change refs, HEAD, stash, config and working files after capture and require notifications when subscriptions start. Other cases cover failed/repeated priming and closure while a snapshot is pending. Desktop retry coverage opens a repository with a missing ref object, repairs it, reopens it and observes native ref/file changes.

All snapshot fields, graph roots, watcher domains, IPC validation and timing budgets remain unchanged. This removes one duplicate enumeration; it does not establish the 500 ms startup gate. Distinct-target and shared-target measurements, including variable and failing results, are retained in the [performance report](../verification/m8-reference-performance.md). A temporary V8 binary-transfer experiment did not improve transfer time and was removed.

## Hashing a large opening snapshot at the first check

At 10,000 or more refs the watcher copies the snapshot's ordered reference lines and worktree metadata before returning it. The first active check hashes those captured values before reading the current repository. A paused check keeps the opening values for resume, and closing the watcher releases them. Capturing the values at open lets the first check detect a native change even when a caller also mutates its copy of the snapshot. Small repositories still compute the initial hash during open.

## Delivering changes during initial layout

The renderer’s bridge listener is active before the graph mounts. It retains the latest watcher mode and merges changed domains for the utility’s single current repository. Subscribing the matching repository view consumes that pending notification once, then delivers live events normally. Changing the focus-refresh preference keeps the subscription and its scheduled refreshes active. Reopening the already watched repository preserves its mode. An Electron test waits for the native watcher, creates a real branch while the initial layout is held, then checks that the released view displays both the mode and the new branch.

## Comparing a primed snapshot during subscription startup

A primed watcher already has a comparison point. It begins subscribing immediately and schedules a check using the existing 120 ms debounce for repository metadata. If subscription and the native self-test complete first, the post-subscription check takes the place of that scheduled read. If startup stalls, the scheduled check can report intervening changes. A final check reconciles changes made during binding, including when the watcher falls back to polling. A watcher without a baseline still captures one before subscribing.

Native tests change a branch after the snapshot and delay or reject subscription. The slow case also adds a tag after the first notification. Both changes reach the observer. A Git trace from the 50,000-ref desktop fixture recorded one native watcher enumeration on ordinary startup, down from two.
