# 0098 — Begin reference enumeration with complete direct metadata

## Context

Profiling the selective reader from ADR 0097 on the 50,000-ref fixture showed two identity reads around three direct-metadata pages. Those identity reads took about 67 and 73 ms in one instrumented sample. The fixture has no annotated tags, so all product-used fields are available from the direct format alone.

## Decision

Start with one complete native direct-format enumeration. If it contains no annotated tags, return those complete records immediately. This preserves names, targets, direct types, upstream counts/state and HEAD markers with the same single-command consistency semantics as ordinary `for-each-ref`.

For annotated tags, retain the bounded detail queries and exact-name/target checks from ADR 0097. Use the initial complete records as the expected identities and compare them with a final native identity enumeration. Additions, deletions, target moves and HEAD/upstream changes observed between those reads cause one full-enumeration fallback. Check both returned coverage and identities. This detects observed changes; it does not provide an atomic snapshot against external writers.

Only large annotation-heavy repositories probe native pagination and use three complete pages. Smaller annotation-heavy repositories and unsupported Git use the full compatibility read. Cache the capability result without disabling the direct/selective path on Git 2.38. Non-UTF-8 initial output requiring tag-name arguments, oversized names or oversized page markers also use the full compatibility read. Build page markers only when pagination is needed, including correct behavior for a repository with one annotated ref.

Direct, detail and page output share the existing 32 MiB budget; native identity/probe/fallback commands each retain their own bounded output. The whole operation retains its 30-second deadline, and a page failure cancels and drains every page. No graph root or product-used reference field is omitted. This supersedes ADR 0097's initial identity/three-direct-page sequence and its small-repository/old-Git selection rules.

Native tests compare all fields with full enumeration, cover sparse and dense concurrent changes, exact annotation metadata including non-commit tags, single-ref repositories, mixed loose/packed coverage, output limits, cancellation and compatibility. Application performance remains governed by the unchanged first-paint gate.

## Repositories with many refs pointing to the same objects

While loading the saved graph view, the service checks the first 8 KiB of a regular packed-refs file of at least 512 KiB. When that first sample is inconclusive, it extends the same prefix to at most 256 KiB and counts again. This catches repeated targets separated by hundreds of names in Git order. If the sample has at least 32 ref rows and at most one distinct object per four rows, Git enumerates the ordered names, object IDs, upstreams, tracking counts and HEAD. The service requests the native type of each distinct ID in one subsequent batch. The file sample only chooses the query. Git supplies every identity, including loose refs and the current worktree's HEAD.

The reader checks each returned ID against its request and accepts Git's four object types. Unresolved objects, invalid replies, a failed batch command or more than 4,096 distinct targets select the original direct query. Repositories using replacement refs also use the direct query. Otherwise the type lookup disables replacements so a newly added replacement cannot change an already enumerated object's type. Annotated tags use the existing native peeling and identity checks. Reconstructed types count toward the same direct-record byte limit, and both Git commands share the read deadline and cancellation signal.

## Streaming UTF-8 validation

The direct reader checks each stdout chunk for valid UTF-8 as it arrives. A chunk that starts or ends inside a multibyte character can fail this check even when the stream is valid. From the first such chunk, a fatal streaming decoder checks across subsequent chunk boundaries and flushes at end of input. The reader keeps its existing full native fallback when annotated refs require a second lookup and decoding would lose information. A literal U+FFFD in a valid ref name remains addressable. Neither path retains the original stdout buffers for a later concatenation.

## Packed local branches without tracking configuration

When the existing packed-refs sample contains at least 32 local branches, ask Git whether any branch has a configured merge source. Run `git config --includes --name-only --get-regexp '^branch\..*\.merge$'` in the current worktree. Git uses this setting to determine a branch's upstream. The query includes conditional configuration and returns key names only. [Git branch configuration](https://git-scm.com/docs/git-config#Documentation/git-config.txt-branchltnamegtmerge)

Only an empty result with exit status 1 and empty stderr selects the shorter direct format. It retains the upstream and tracking field separators so the parser reads empty fields. After enumeration, repeat the configuration check. If a merge source appeared or Git cannot establish its absence, repeat the direct enumeration with the tracking fields enabled. Cancellation and the 30-second deadline cover the whole operation. As with the existing identity checks, an external Git writer can change the repository after the final observation.

### Repeated annotated tag objects

When the grouped read finds over 128 annotated refs and at most one distinct tag object per four annotations, peel their captured object IDs in one native batch. This avoids asking Git to resolve the same tag chain for every name. Check the returned ID, final type and object-ID width, charge the reconstructed fields against the existing byte limit and repeat the ref identity check before publication. A moved or deleted alias takes the full enumeration path. The distinct-target limit, deadline and cancellation signal still apply.

## Rechecking tracking counts after tag reads

A change to a shallow boundary can change ahead and behind counts while all ref names, object IDs, upstream names and HEAD markers stay the same. Before publishing a multi-command tag read, compare the original ordered direct fields with a final Git read, including tracking counts and the gone indicator. A mismatch selects a complete native enumeration. The recheck runs after Git has resolved any nested annotations.

For grouped targets, both enumerations use the same native format with an empty object-type field. Compare streaming SHA-256 digests of those bytes. For ungrouped targets, keep the first read's type metadata and ask Git to omit types from the verification command. Compare its UTF-8 records against the original refs in order. The existing configuration check still verifies that any omitted upstream fields were appropriate. Paged or selective tag details must also match the direct fields of their original rows.

## Sampling annotated objects before reading all ref names

When the packed-ref prefix contains peeled tags and repeated targets, Git reads the first 128 refs with object types and peeled targets. This query disables replacement objects and omits upstream tracking. Git 2.38 can return another tag after one level of peeling, so the reader resolves those remaining objects by ID with replacements disabled.

The next native enumeration supplies every current ref name, target ID, upstream, tracking count and HEAD marker. If each target is in the sample, the reader fills in its immutable object fields by ID. It charges those fields against the same output limit as the grouped reader. A target outside the sample, a replacement ref or an invalidly encoded stream selects the existing native resolution path. A custom replacement namespace disables the sample. A moved alias may use the sampled metadata of its new target, and a newly created alias is included in native order.

For distinct-target packs between 512 KiB and 8 MiB, the reader also looks for up to eight annotated names. Git's packed format places a peeled line directly after the corresponding ref. The reader uses just the preceding name to request a bounded native metadata sample. Git supplies the actual object ID, type and peeled target. The subsequent direct enumeration still reads every ref and object type. A missing annotation or a changed target outside the sample takes the usual post-enumeration peel and verification path. Larger packs, dense annotations, and unsuitable names use the existing reader. Only the repeated-target sample can seed a speculative history walk.

## Bounded annotation sampling

Start with an 8 KiB allocation. If this prefix already establishes repeated targets, return its result immediately. Otherwise copy the read bytes into a 256 KiB buffer. The sparse-annotation scan reuses this buffer across the eligible file. On refill it retains enough trailing bytes for a newline, a 64-byte hexadecimal object ID, a space, a 1,024-byte name and the newline preceding a peeled record. Only newly read carets are examined. Discovering a ninth annotation, an unusable name or premature EOF discards the candidate names. Git still resolves the sampled names and supplies the complete ref list.

Boundary tests split a SHA-256 ID, a UTF-8 character and the newline/caret pair. They verify the exact order of eight names and the ordinary fallback when the ninth occurs later in the file. The native fixture checks a late annotation and changes its target after sampling. [Linux memory and desktop measurements](../verification/m8-reference-performance.md#memory-used-to-locate-sparse-annotated-tags)

## Missing objects in a commit-graph

A revision walk with `--no-walk=unsorted --all` can return an ID after the underlying commit object disappears. Git 2.53.0 reproduced this with a two-commit repository, a prepared commit-graph and a missing loose tip. In that state `git for-each-ref` requesting `%(objecttype)` failed. The reference reader keeps Git’s object metadata checks when publishing a snapshot. A native regression now removes and restores a loose object in the distinct-target fixture and checks both failures and recovery. [Desktop and Git measurements](../verification/m8-reference-performance.md#checking-object-existence-on-the-first-page)
