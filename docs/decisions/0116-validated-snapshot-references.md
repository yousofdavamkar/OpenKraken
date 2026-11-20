# 0116. Expand compact references at the receiving boundary

Large snapshots from the Git utility already contain strings for ordinary commit references and full records for the exceptions. Main used to expand all of them before serializing the snapshot again for the renderer. The original compact renderer API uses `snapshot-json`. Main sends self-contained object IDs and ref names in this format. The renderer expands each string once when it receives the snapshot.

Main verifies the envelope, snapshot metadata and commit records. Each self-contained compact row must have a valid SHA-1 or SHA-256 object ID followed by the separator and a recognized branch, remote or tag prefix. For a full reference, main forwards the output of the reference schema, which drops unknown fields. An invalid row rejects the response. The object and ordinary JSON APIs still return expanded records. Small snapshots continue to use their ordinary representation in every format.

The large-fixture Electron test checks all three formats against the same repository. It compares the full ordered records and checks the native ref names, a Unicode branch and an annotated tag. The contract tests cover SHA-256, malformed compact strings and stripping unexpected fields on rich records. [Startup measurements](../verification/m8-reference-performance.md#passing-validated-references-to-the-renderer)

## Publishing compact records in the repository store

The renderer freezes each expanded compact record during decoding. Every field in that representation is a primitive, so Immer can skip traversing the record when publishing the snapshot. Rich records, including branches with nested upstream metadata, continue through Immer’s recursive freeze. Main uses the original expansion mode for object and JSON callers. The contract test exercises both modes on the same mixed snapshot and compares every reference in order. [Publication measurements](../verification/m8-reference-performance.md#publishing-compact-references-to-the-repository-store)

## Consecutive refs with the same target

The utility keeps Git's original ref order. When successive compact refs point to the same commit, it writes the full object ID on the first row and only the canonical names on the following rows. A different compact target starts a new run. Rich records pass through at their original positions and leave the current compact target in effect. Each snapshot starts with no target.

Main verifies every explicit object ID, every name's namespace and every rich record. A name-only row before the first validated compact target rejects the whole reply. The `snapshot-transfer` format returns this validated form as JSON. The repository store receives the same compact refs in the opening snapshot metadata and restores each reference's target during expansion. Object and ordinary JSON callers still receive full records. The original `snapshot-json` caller receives a self-contained object ID on every compact row. All snapshot formats are restricted to the existing snapshot requests. [Linux measurements](../verification/m8-reference-performance.md#transferring-consecutive-references)

## Validate references while opening a repository

Main adds a fresh transfer ID to each internal `open` request. During a fresh watcher's initial snapshot, the Git utility can send the complete ordered ref array as soon as Git has enumerated it. This uses the same compact representation and eligibility threshold as a one-message snapshot. Main validates the refs and retains them on the pending request while the utility finishes the history page and watcher baseline.

The utility sends the rest of the snapshot only if it still owns the exact ref array it sent. Main checks the live utility, request ID, transfer ID, ref count and snapshot schema before resolving the renderer request. A duplicate or invalid ref part invalidates that transfer. A native error, cancellation, timeout or utility exit releases the pending state. Git decides whether cancellation arrived before the new cursor was committed. A cancellation received after that commit delivers the successful snapshot and its usable cursor. Existing response formats and one-message snapshots continue to use their public representations.

The native regression aborts a read after observing its refs and pages the previous cursor. Electron tests exercise cancellation during a held Git walk, cancellation after native completion, and utility exit with refs already received. Each retries with the same public request ID. A failed switch to a repository with 10,000 tags and a missing commit parent also leaves the previous history and watcher usable. [Desktop measurements](../verification/m8-reference-performance.md#validating-refs-before-the-first-page-is-ready)

## Consecutive names for annotated tags

On an initial open with at least 10,000 refs, the Git utility first tries the existing compact commit records. If those do not cover half the refs, it checks for consecutive names with identical annotated tag metadata. When at least half of the rows qualify, it sends the first tag as a full record and subsequent aliases as canonical tag names. A different target, peeled ID, final type or exceptional record starts a new run.

Main validates the full records and accepts alias names only after a canonical annotated tag with a final commit, tree or blob and no upstream or HEAD marker. For the split-body format used by the history view, main forwards the validated alias names alongside the full records. The renderer restores the original names, short names and metadata in order before publishing the snapshot. Ordinary object, JSON and earlier serialized snapshot callers receive full records for these tags. Both staged formats share the same request ID, transfer ID, ref count and duplicate-part checks.
