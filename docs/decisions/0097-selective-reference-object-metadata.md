# 0097 — Read peeled metadata only where the reference needs it

## Context

The 50,000-reference first-paint gate still fails after bounded native paging. Native format probes show that requesting dereferenced object fields forces expensive object reads even for ordinary commit refs. The implementation also collected `Ref.subject`, which is absent from the blueprint's reference model and has no product consumer. Commit summaries and stash messages use separate models.

## Decision

Remove the unused reference subject from the native format, parser and IPC model. Preserve every reference name, target, type, peeled target/type, upstream count/state and HEAD marker. This supersedes ADR 0095's decision to retain the unused ninth field; it does not remove any graph root, badge, reference control, commit summary or stash message.

For large repositories on Git with native pagination, read three pages containing direct object types and tracking metadata without requesting dereferenced fields. Then read complete records for refs whose direct type is `tag`, in batches of at most 128 names and 16 KiB of name arguments. Limit each individual name to 4,096 bytes; otherwise use the full compatibility read. Keep only exact requested names because Git's [pattern matching](https://git-scm.com/docs/git-for-each-ref) can also match slash descendants. Check that every requested tag is present with the same target before combining its complete record with the direct records.

When more than three detail batches would be needed, use three full native pages instead. This avoids hundreds of repeated pattern scans in repositories dominated by annotated tags. All direct, detail and full pages share the existing 32 MiB output budget and 30-second read deadline. Concurrent page failures abort and drain all jobs. Detail queries are sequential and cancellation/error cannot return partially populated records.

Retain the original pre/post identity checks and complete-enumeration fallback. Native Git 2.53.0 was observed returning a loose tag before a requested page boundary when loose and packed refs were mixed. The identity guard already detects this; a regression now compares native page coverage with the complete enumeration and requires fallback whenever coverage differs. These checks detect observed changes, not atomic snapshots or external-writer exclusion.

Small repositories, unsupported Git and non-UTF-8 reference identities retain the complete native read, using the eight-field model. Git 2.38 compatibility remains required. An annotation-heavy repository may do extra direct reads before choosing full pages, and the aggregate byte limit can reject a read earlier than a single enumeration. The 50,000-ref gate remains unchanged; app measurements, not isolated format timings, determine whether it passes.
