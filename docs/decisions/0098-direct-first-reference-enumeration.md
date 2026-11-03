# 0098 — Begin reference enumeration with complete direct metadata

## Context

Profiling the selective reader from ADR 0097 on the 50,000-ref fixture showed two identity reads around three direct-metadata pages. Those identity reads took about 67 and 73 ms in one instrumented sample. The fixture has no annotated tags, so all product-used fields are available from the direct format alone.

## Decision

Start with one complete native direct-format enumeration. If it contains no annotated tags, return those complete records immediately. This preserves names, targets, direct types, upstream counts/state and HEAD markers with the same single-command consistency semantics as ordinary `for-each-ref`.

For annotated tags, retain the bounded detail queries and exact-name/target checks from ADR 0097. Use the initial complete records as the expected identities and compare them with a final native identity enumeration. Additions, deletions, target moves and HEAD/upstream changes observed between those reads cause one full-enumeration fallback. Check both returned coverage and identities. This detects observed changes; it does not provide an atomic snapshot against external writers.

Only large annotation-heavy repositories probe native pagination and use three complete pages. Smaller annotation-heavy repositories and unsupported Git use the full compatibility read. Cache the capability result without disabling the direct/selective path on Git 2.38. Non-UTF-8 initial output requiring tag-name arguments, oversized names or oversized page markers also use the full compatibility read. Build page markers only when pagination is needed, including correct behavior for a repository with one annotated ref.

Direct, detail and page output share the existing 32 MiB budget; native identity/probe/fallback commands each retain their own bounded output. The whole operation retains its 30-second deadline, and a page failure cancels and drains every page. No graph root or product-used reference field is omitted. This supersedes ADR 0097's initial identity/three-direct-page sequence and its small-repository/old-Git selection rules.

Native tests compare all fields with full enumeration, cover sparse and dense concurrent changes, exact annotation metadata including non-commit tags, single-ref repositories, mixed loose/packed coverage, output limits, cancellation and compatibility. Application performance remains governed by the unchanged first-paint gate.
