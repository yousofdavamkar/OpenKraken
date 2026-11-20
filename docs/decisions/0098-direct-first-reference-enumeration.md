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
