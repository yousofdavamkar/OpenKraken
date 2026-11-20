# 0101 — Reuse the index fingerprint within one working-state read

## Context

The new 100,000-file status benchmark measured 324–518 ms for watcher-warm working-state responses, failing the 300 ms M8 budget. A native supervised profile showed that each request enumerated and hashed the index twice, with each fingerprint taking roughly 74–96 ms: once for the working-state revision and again for its operation controls.

## Decision

Reuse the fingerprint already computed for the working-state revision when assembling that response's operation token. Retain fresh operation metadata, conflict counts and working-file image capture. Keep the fingerprint local to that single request; do not cache it across requests or mutations. Bare working-state reads retain their separate operation inspection because their working-state revision intentionally uses an empty index signature.

The public operation inspection and all mutation/review checks still obtain a fresh fingerprint. A later index, HEAD, operation or conflict-file change invalidates an older token through the existing native checks. Working-state revisions and their operation tokens now refer to the same sampled index/HEAD. The read remains optimistic with respect to external Git processes; this does not introduce an atomic repository snapshot.

The native rebase test now obtains unresolved/resolved operation controls through the working-state API used by the UI, compares them with independent operation inspection, rejects stale conflict-file reviews and continues through native Git. A bare-repository regression checks token equality; it caught inappropriate reuse of the bare revision's empty signature before the compatibility path was restored. The original performance benchmark determines whether the complete request meets its budget.

## Bare repositories without an index

Working-state and operation inspection now check for the bare repository's index. If it is absent, HEAD and the operation markers identify the operation state. Running a cached diff in that case would enumerate the entire HEAD tree as staged deletions. If the index is present, or a transaction supplies its own index, inspection still fingerprints its entries and staged diff. Only a missing index selects the shortcut. Other filesystem errors propagate. The working-state revision for a bare repository still depends on HEAD alone.

The native regression checks both public reads before an index exists, after loading HEAD into an index and after emptying it. Removing the index restores the original operation token, and moving HEAD changes it again.
