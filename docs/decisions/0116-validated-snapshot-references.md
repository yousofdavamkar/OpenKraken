# 0116. Expand compact references at the receiving boundary

Large snapshots from the Git utility already contain strings for ordinary commit references and full records for the exceptions. Main used to expand all of them before serializing the snapshot again for the renderer. The repository store now requests `snapshot-json` when opening, cloning, initializing, switching checkouts or refreshing. Main sends the validated compact representation in this format. The renderer expands each string once when it receives the snapshot.

Main verifies the envelope, snapshot metadata and commit records. Each compact string must have a valid SHA-1 or SHA-256 object ID followed by the separator and a recognized branch, remote or tag prefix. For a full reference, main forwards the output of the reference schema, which drops unknown fields. An invalid row rejects the response. The object and ordinary JSON APIs still return expanded records. Small snapshots continue to use their ordinary representation in every format.

The large-fixture Electron test checks all three formats against the same repository. It compares the full ordered records and checks the native ref names, a Unicode branch and an annotated tag. The contract tests cover SHA-256, malformed compact strings and stripping unexpected fields on rich records. [Startup measurements](../verification/m8-reference-performance.md#passing-validated-references-to-the-renderer)

## Publishing compact records in the repository store

The renderer freezes each expanded compact record during decoding. Every field in that representation is a primitive, so Immer can skip traversing the record when publishing the snapshot. Rich records, including branches with nested upstream metadata, continue through Immer’s recursive freeze. Main uses the original expansion mode for object and JSON callers. The contract test exercises both modes on the same mixed snapshot and compares every reference in order. [Publication measurements](../verification/m8-reference-performance.md#publishing-compact-references-to-the-repository-store)
