# M8 reference performance checkpoint

The sidebar now mounts a bounded set of reference controls on large repositories. **The 50,000-reference first-paint gate remains failing.** No budget was changed. Raw measurements, including the initial full-Linux outlier and all five later samples, are retained in [m8-reference-performance.json](m8-reference-performance.json).

## Transferring history pages

On the first 5,000-commit append after opening the full Linux history, the commit array occupied 7,426,072 bytes as JSON. The unescaped UTF-8 message bodies alone accounted for 5,235,164 bytes. Main now sends the bodies as strings alongside the remaining metadata. [ADR 0115](../decisions/0115-history-page-response.md)

Four paired runs used the same production bundles, changing only the renderer call between the ordinary JSON API and the new page format. Each benchmark opened a fresh Electron profile and appended three consecutive 5,000-commit pages. The order was JSON/split, split/JSON, JSON/split and split/JSON. The repository had 1,505,199 commits and one ref, using Git 2.53.0, Linux x64 and X11 under Xvfb. The OS cache stayed populated. An earlier diagnostic accessed the partial clone before the paired runs. Both paired conditions used that same clone with lazy fetching disabled.

| Measurement                                         |               Whole-page JSON |               Separate bodies |
| --------------------------------------------------- | ----------------------------: | ----------------------------: |
| First append, four runs (ms)                        | 289.6 / 298.7 / 338.1 / 366.4 | 291.2 / 248.1 / 284.4 / 241.7 |
| Median first append (ms)                            |                         318.4 |                         266.2 |
| Median first request through renderer decoding (ms) |                         208.6 |                         140.3 |
| Pages under 300 ms                                  |                      10 of 12 |                      12 of 12 |

Four earlier runs using just the new page format also passed all 12 page checks (184.1–285.2 ms). The real-repository test before the desktop restart recorded 283.1 / 269.2 / 214.9 ms, a 372.6 ms first paint and 16.8 ms graph scrolling p95. On the first full-suite run after the host app restarted, first paint took 1,216.3 ms, including 805.6 ms inside the snapshot read. Pages took 305.9 / 294.1 / 307.8 ms and scrolling reached 16.8 ms p95. Three later fresh-profile runs on the same shared host took 584.4–1,300.7 ms per page, 1,319.7–3,012.8 ms to paint and 33.4–83.3 ms p95 to scroll. The host had 12 logical CPUs and reported a one-minute load average of 42.38 near the end of these runs. All samples are retained. These results leave the full-Linux gates open.

On the two-million-commit checkout, all nine pages passed (144.7–211.8 ms). First paints were 1,172.0 / 316.3 / 299.9 ms. On Linux history with 50,000 distinct ref targets, all nine pages passed (186.4–273.3 ms), and all three first paints missed the 500 ms budget (1,754.6 / 1,003.8 / 1,042.2 ms). Graph and sidebar scrolling on that fixture measured 16.7–16.8 ms p95.

The [sample CSV](m8-page-transfer-samples.csv) includes every measured page and opening in this checkpoint. The initial baseline missed three of nine page checks. The diagnostic cohorts cover process-boundary timing (`trace`), utility JSON (`jsonprobe`), packed records (`packed`), worker layout transfer (`geometry`), commit freezing (`freeze`), and compacted fields (`columns`). The `bodies` experiment combined separate message text with experimental layout and freeze changes. The `body-only`, `split1`–`split4`, `distinct`, `synthetic`, `full-desktop`, `restarted-desktop` and `keyboard-final` cohorts used the shipped page implementation in isolation. Benchmark limits and graph layout stayed the same.

## Opening status and history

Fresh watchers now seed their status fingerprint from the porcelain bytes consumed by the opening snapshot and reuse its linked worktree list. Graph preparation can start when refs and worktree heads are available, while the current checkout's full status scan continues. A bare repository has no current-checkout scan to overlap. [ADR 0114](../decisions/0114-concurrent-snapshot-status-and-history.md)

| Repository, three openings each             | First paint (ms)            | 5,000-commit page range (ms) |
| ------------------------------------------- | --------------------------- | ---------------------------- |
| Two million commits, 100,000 files          | 297.9 / 321.4 / 299.7       | 123.0–206.9                  |
| Full Linux, one ref                         | 353.8 / 479.2 / 359.4       | 209.9–268.1                  |
| 50,000 distinct targets                     | 1,021.2 / 1,070.0 / 1,018.0 | 206.9–264.4                  |
| 50,000 refs at one target                   | 1,105.4 / 938.0 / 893.4     | 209.9–247.1                  |
| 50,000 distinct targets, 10,000 hidden tags | 1,161.8 / 1,174.6 / 1,049.0 | 220.4–287.4                  |

All 45 pages in the five-fixture run met the 300 ms budget. Graph and large-ref sidebar scrolling measured 16.7–16.8 ms p95. All nine large-ref openings exceeded the 500 ms target. In the default distinct-target view, waiting for the service alone took 791.1–835.1 ms. The synthetic checkout and the single-ref Linux history each met the opening budget in all three runs.

Three earlier alternating baseline/intermediate pairs per fixture isolate watcher reuse before concurrent history preparation. On the synthetic checkout, first paints were 1,329.4 / 414.0 / 469.1 ms at baseline and 655.2 / 403.4 / 332.4 ms with reuse. One intermediate synthetic page took 569.9 ms and its graph scroll p95 was 33.4 ms. The final cohorts ran separately. OS caches stayed populated between samples, so elapsed differences include run order and filesystem cache effects.

A diagnostic build timed the native ref read and parsing at 210.6–242.8 ms and the first history page at 161.6–178.0 ms in the three original distinct-target runs. Hashing the watcher's opening reference set took 37.1–39.2 ms in that build and 29.1–35.4 ms after batching. Production timings exclude the trace probes. The [43 sample records](m8-snapshot-observation-samples.csv) include the six instrumented openings, eighteen paired openings, fifteen five-fixture openings and four Linux follow-ups, including every budget miss. Each used a fresh Electron profile on Linux x64 with native Git 2.53.0. The benchmark retained its original first-paint, paging and scrolling assertions.

The later full desktop suite recorded a 312.3 ms first 5,000-commit page on Linux history. Three isolated X11 runs on the same repository recorded first pages of 303.4 / 260.6 / 349.0 ms. For the slowest page, waiting for the service took 209.6 ms, the worker phase took 116.0 ms and publishing took 23.4 ms. The six later pages passed at 238.2–257.0 ms. First paints passed at 349.7–445.0 ms and graph scrolling measured 16.8 ms p95 in all three runs.

## Visible commit badges and sidebar scrolling

In three fresh-profile runs on the 50,000-distinct-target fixture, jumping the reference list by 1,400 px per frame produced a 33.4 ms p95. A temporary key-lookup counter measured 36,919,053 lookups over the 120 jumps. Keeping the key callback stable reduced this to 33,827,435. Estimating unseen rows from measured rows of the same kind reduced it to 2,782. All three runs for each instrumented variant gave the same lookup counts. Each mounted row still receives individual resize measurements.

The final production build measured **16.7–16.8 ms p95** for sidebar scrolling in all nine large-ref runs. The existing graph scroll measurement ran before the sidebar measurement. The benchmark records both and restores the sidebar scroll position after sampling. Full Linux history with one ref uses the small sidebar.

The graph now groups badge labels only for mounted commits and builds the complete name list when the dialog opens. A Node probe compared the complete visible previews for the first 32 Linux commits using the same frozen ref records. Across eight alternating pairs with a warm-up and GC before each timed call, median preparation took 14.7 ms before and 11.9 ms after for distinct targets. For a shared target it took 27.8 ms before and 13.8 ms after. These measurements isolate badge preparation. [ADR 0113](../decisions/0113-visible-commit-badges-and-reference-row-heights.md)

| Final build, three runs each                | First paint median (ms) | First paint range (ms) | 5,000-commit page range (ms) |
| ------------------------------------------- | ----------------------: | ---------------------: | ---------------------------: |
| 50,000 distinct targets                     |                 1,074.7 |        1,040.7–1,076.2 |                  206.6–252.8 |
| 50,000 refs at one target                   |                   881.9 |            867.7–979.2 |                  222.2–320.1 |
| 50,000 distinct targets, 10,000 hidden tags |                 1,091.3 |        1,062.2–1,102.9 |                  203.5–246.6 |
| Full Linux, one ref                         |                   385.7 |            356.3–912.0 |                  217.7–270.7 |

Every large-ref first paint missed the 500 ms budget. One shared-target page missed the 300 ms budget. The first single-ref Linux run also missed first paint at 912.0 ms. Startup ranges overlap earlier cohorts. For the final distinct-target runs, the median wait for the snapshot response alone was 844.6 ms.

The [36 uninstrumented runs](m8-badge-sidebar-samples.csv) include the original build (`baseline`), on-demand badges (`lazy` and `list-before`), stable item keys (`final`) and measured row estimates (`measured`). Each Electron run used a fresh profile and uncleared OS caches. The first baseline openings took 2,023.5 and 1,522.9 ms for distinct and shared targets respectively. All samples are included.

A separate read-only native probe compared the current reference format with reading identities first and resolving types with one buffered `cat-file --batch-check` over unique object IDs. Both produced identical records on these fixtures. In three trials, the current command took 190–196 ms for distinct targets. The two-command probe including Python reconstruction took 233–257 ms. Shared targets took 152–168 ms and 125–144 ms respectively. The production path continues to use the existing native commands.

## Git utility snapshot transfer

Three alternating instrumented pairs on the 50,000-distinct-target repository measured 116–123 ms to copy the ordinary utility reply into main. Compact references took 47–50 ms to transfer and 9–12 ms to pack. An experiment using the compact form on the renderer boundary as well reduced its JSON reply from 13.24 MB to 7.37 MB. Main serialization rose from 43–47 ms to 67–74 ms. The shipped change confines the format to the Git utility boundary. See [ADR 0112](../decisions/0112-compact-git-snapshot-references.md).

| Final cohort (three runs each)              | First paint, median (ms) | First paint, range (ms) | 5,000-commit pages (ms) |
| ------------------------------------------- | -----------------------: | ----------------------: | ----------------------: |
| 50,000 distinct targets                     |                  1,039.7 |         1,025.4–1,276.2 |             211.4–309.9 |
| 50,000 distinct targets, 10,000 hidden tags |                  1,084.8 |         1,077.7–1,098.8 |             212.1–265.4 |
| 50,000 refs at one target                   |                    966.0 |           928.3–1,122.5 |             212.5–269.2 |
| Full Linux, one ref                         |                    359.6 |             354.5–362.6 |             211.2–280.4 |
| Synthetic two-million-commit repository     |                    469.4 |             460.5–474.7 |             126.0–181.0 |

The ordinary distinct-target baseline ranged from 1,108.5 to 1,542.0 ms (median 1,112.7 ms). Its range overlaps the final build. All nine large-ref openings exceeded 500 ms; 44 of 45 pages finished within 300 ms. All fifteen scroll measurements were 16.7–16.8 ms p95. Each run used a fresh profile with uncleared OS caches on the same Linux host, sequentially without competing suites or builds.

For the final distinct-target cohort, the median wait from open to response was 816.1 ms, including 445.0 ms preparing the snapshot inside the utility. The slow page spent 189.9 ms awaiting the service, 93.7 ms in worker layout and 26.3 ms publishing the result. These timings identify work on both sides of the utility boundary.

The [per-run measurements](m8-snapshot-transport-samples.csv) include the ordinary baseline (`base`), compact utility replies revalidated as normal objects (`compact`), compact replies on both boundaries (`both`), the alternating instrumented pairs (`trace`), per-row schema transforms (`direct`), batch validation before the density threshold (`batch`) and the final five cohorts (`final`). Probe columns appear only for instrumented runs. Snapshot time is included in service time. See the fixture and harness instructions below to reproduce the measurements.

## Saved views with 10,000 hidden tags

The maximum-size saved hidden list exposed repeated linear membership scans during both traversal and badge construction. With 10,000 tags hidden on the 50,000-distinct-ref fixture, the baseline took **13,908.2 ms** to paint. Of that, 10,116.8 ms was inside snapshot preparation and 3,267.4 ms was between renderer publication and paint. The unfiltered baseline in the same pair took 1,344.2 ms.

The service and renderer now index the saved names once per view (`a93dbc5`). Three filtered runs after that change alone took 1,136.3–1,376.9 ms. Three unfiltered controls took 1,129.0–1,273.7 ms, with one 300.7 ms page. The following history parser change (`506d7dd`) reuses the streaming UTF-8 decoder while retaining the byte limit and callback behavior. See [ADR 0111](../decisions/0111-graph-view-membership-and-history-decoding.md).

On 22,615,101 bytes of `rev-list` output from 17,000 Linux commits, six alternating-order parser samples took **193.9–234.7 ms** before and **113.9–129.1 ms** after the decoder change. Each received the same 64 KiB chunks after one warm-up per parser. All complete parsed arrays had SHA-256 `9a112556899ddfdf20d3f07fa4249a39bbfbdb37ec7f0f2c07af9185c7bc179d` over their JSON serialization. These numbers isolate parsing. End-to-end startup times overlap for the indexed implementations.

| Final cohort (three runs each)               | First paint (ms) | 5,000-commit pages (ms) | Scroll p95 (ms) |
| -------------------------------------------- | ---------------- | ----------------------- | --------------- |
| 50,000 distinct targets, 10,000 tags hidden  | 1,167.9–1,172.0  | 207.8–270.0             | 16.7–16.8       |
| 50,000 distinct targets, default view        | 1,098.5–1,162.8  | 216.0–274.6             | 16.8            |
| 50,000 refs at the same target, default view | 968.4–1,040.9    | 227.9–267.8             | 16.7–16.8       |
| Full Linux with one ref                      | 373.1–408.5      | 240.3–305.9             | 16.8            |
| Synthetic two-million-commit repository      | 482.1–583.5      | 120.1–195.2             | 16.7–16.8       |

Every large-ref first paint still exceeded 500 ms. All 27 pages on the three large-ref cohorts passed. The single-ref Linux cohort missed one page budget at 305.9 ms. Synthetic first paints were 583.5, 502.8 and 482.1 ms. All scroll samples passed. The earlier isolated outliers and these misses remain in the record.

[Per-run measurements](m8-graph-view-samples.csv) cover the original pair (`base`), the indexed-view intermediate runs (`final`) and the combined changes (`history`, `shared`, `linux`, `synthetic`). Each fresh-profile Electron run was sequential with uncleared OS caches and no simultaneous tests or builds. To reproduce the filtered cohort, add `OPENKRAKEN_BENCH_HIDDEN_TAGS=1` to the distinct-target benchmark command below. It seeds the first 10,000 tags into the disposable profile and checks the sidebar's hidden state after timing.

## Original baseline and bounded sidebar

Both fixtures contain the full Linux history at `46fec1c3029b552ec63b2d01af9d43a386f043ea`: 1,505,199 commits, not shallow, with a Git commit graph. The original bare repository has one branch. The second is an isolated shared-object bare clone with 50,000 refs targeting distinct recent commits: the original branch, 5,000 additional branches, 5,000 remote-tracking refs and 39,999 tags. The original repository's refs and objects were not changed. Objects are tree-filtered; this measures history/ref behavior, not checkout or blob-heavy operations.

Measurements used Linux x64, Git 2.53.0 and an Intel Core i7-9750H. Each app used a fresh profile; OS caches were **not cleared**. Main benchmark runs were sequential without concurrent builds or test suites. Memory is Electron's reported renderer working set, not a total-system measurement.

| Fixture/run                               |       First paint | 5,000-commit pages                    |        Scroll p95 | Mounted refs | Renderer working set |
| ----------------------------------------- | ----------------: | ------------------------------------- | ----------------: | -----------: | -------------------: |
| Full Linux, initial                       |   600.0 ms (fail) | 266.1 / 233.6 / 221.3 ms              |           16.8 ms | Not recorded |              486 MiB |
| Full Linux, repeat                        |          376.9 ms | 283.7 / 243.5 / 235.1 ms              |           16.8 ms | Not recorded |       See raw record |
| Full Linux, predetermined five-run sample |    343.3–371.8 ms | All below 300 ms                      | All below 18.7 ms | Not recorded |      See raw records |
| 50,000 refs, eager sidebar                | 8,728.6 ms (fail) | 1,099.1 / 1,694.9 / 1,130.5 ms (fail) |   166.7 ms (fail) |       50,000 |            2,690 MiB |
| 50,000 refs, bounded sidebar              | 1,929.2 ms (fail) | 247.2 / 198.2 / 202.9 ms              |           16.7 ms |            7 |              624 MiB |

The bounded-sidebar run spent 1,665.7 ms before the snapshot response, including 1,058.8 ms inside the snapshot operation, followed by 66.6 ms in worker layout, 45.5 ms publishing state and 151.4 ms before paint. Temporary service instrumentation measured `for-each-ref` at 852.9 ms. A separate native enumeration probe measured 847.1 ms for about 7 MB of output. These probes were removed after diagnosis. The initial 600 ms single-ref outlier is unexplained; subsequent successful samples do not prove it fixed.

An alternate JSON bridge response measured 1,884.6 ms first paint and did not resolve the startup gate. That experiment was reverted; it is not part of the implementation or the bounded-sidebar record above. The first large-ref harness attempt failed while collecting full reference names into Node's default output buffer; metadata collection now counts one dot per ref. That failed harness attempt is not a valid benchmark record.

## Text-decoder follow-up

Reference parsing (`3694895`) now decodes each UTF-8 read once and splits the resulting text into fields. It preserves streaming codepoints, byte-based field limits, empty fields, truncated-record errors and the optional final newline. The original binary decoder remains in use for paths and all other existing consumers. All nine reference fields, including subjects and peeled object metadata, remain present.

An alternating-order comparison against `029afa1` consumed the same 7,077,281 bytes in 64 KiB chunks and compared **every field of all 50,000 parsed records** for equality. Across six runs per implementation, baseline parsing took 182.1–228.7 ms and the text decoder took 61.5–97.5 ms. The [comparison record](m8-reference-decoder.json) retains all samples and the full-record digest. These are isolated parser measurements, not application startup measurements.

Three sequential app runs after the decoder change measured **2,022.5 / 1,972.0 / 1,953.1 ms** first paint. All failed the unchanged 500 ms budget; all paging, scroll and mounted-row bounds passed. Snapshot time remained 1,073–1,085 ms. The parser optimization therefore establishes lower parsing cost, **not an observed first-paint improvement**. These app records are retained under `m8-text-decoder` in the raw benchmark file.

Native format probes measured identity-only enumeration near 32 ms, object type near 134–141 ms, peeling near 679–702 ms and subjects near 721–775 ms. Full-format enumeration remained about 784–823 ms. A four-way partition of this specific fixture produced byte-identical full output in about 342–350 ms, but it is not a general implementation: portable partitioning, consistent coverage of arbitrary refs and bounded command inputs still need design and tests. At that checkpoint, no parallel enumeration or reduced metadata format was shipped.

A separate utility-to-main JSON transport experiment measured 2,050.4 ms first paint and a 313.5 ms page; it was reverted. The earlier renderer-bridge experiment and this utility transport experiment are distinct. Neither bypassed main-process result validation. Temporary probes are removed after recording their results.

## Bounded native pagination

The next increment (`c59d3e8`) retains complete reference records and uses three native pages for repositories with at least 10,000 refs when Git supports `--start-after`. Identity checks before and after the pages detect observed ref/HEAD/upstream changes and select a single complete read on mismatch. Old Git, non-UTF-8 names and overly long markers retain the single-read path. The full-record pages share a 32 MiB output limit; cancellation and failure drain all jobs before the reader returns. See [ADR 0095](../decisions/0095-parallel-native-reference-reads.md).

Three sequential real-app runs measured **1,688.9 / 1,698.5 / 1,710.9 ms** first paint, with snapshot time **815.9–821.3 ms**, compared with 1,953.1–2,022.5 ms and 1,073–1,085 ms in the preceding decoder sample. Every page remained below 300 ms, scroll p95 was 16.7–16.8 ms, and seven reference rows were mounted. The unchanged **500 ms first-paint gate still fails in all three runs**. Records are retained under `m8-native-ref-pages` in the raw benchmark file. Profiles were fresh, OS caches were not cleared, and benchmarks ran sequentially without concurrent builds or suites.

A temporary boundary probe on the preceding implementation measured 135 ms from utility send to main receipt, 67.6 ms in main validation, and 239 ms from main reply to renderer receipt. The full snapshot still crosses both process/isolated-world boundaries; validation was not removed. A native four-page feasibility probe returned byte-identical output in 278–296 ms, but production uses three jobs plus identity checks to respect the existing process pool. Those isolated timings are not substituted for the app's measured first paint. Instrumentation was removed before the final build and benchmark.

## Selective object metadata

The next reader removes the unused `Ref.subject` field and reads peeled metadata only for actual annotated tags. The reference model in the blueprint does not include subjects, and no product consumer read the removed field; commit summaries and stash messages remain separate and unchanged. All names, targets, types, peeled targets/types, tracking counts, HEAD markers and history roots remain present. This supersedes the earlier decision to retain all nine native fields. See [ADR 0097](../decisions/0097-selective-reference-object-metadata.md).

Native format probes measured approximately 188–194 ms for direct type/tracking metadata, 758–903 ms with peeling, and 817–836 ms with peeling plus subjects. These isolated probes motivated the change but are not app timing evidence. Detail queries are bounded by name count/bytes, and repositories needing more than three detail batches use full native pages. Identity checks still reject incomplete or shifted native page coverage, including an observed mixed loose/packed-ref case, and fall back to a complete enumeration.

A fresh baseline measured **1,724.8 ms** first paint and **833.5 ms** snapshot time. An initial implementation probe measured 1,344.3 ms first paint. Three sequential final-build runs measured **1,428.5 / 1,400.1 / 1,505.5 ms** first paint, with **548.6–641.9 ms** snapshots. All first-paint checks still fail the unchanged **500 ms** gate. Every page passed at **200.8–288.3 ms**, scrolling p95 was **16.7–16.8 ms**, and the reference sidebar remained bounded. The sample establishes an improvement over the same-turn baseline, not completion of the startup gate or an explanation for every timing variation.

All measurements used the unchanged 50,000-ref fixture, fresh app profiles and uncleared OS caches; no builds or test suites ran concurrently with the app benchmarks. The baseline, probe and final samples are retained under `m8-ref-startup-baseline`, `m8-ref-metadata-probe` and `m8-selective-ref-metadata` in the raw JSON. Process-boundary transport/validation and renderer work remain substantial; no validation or timing threshold was removed. Other large-history/status/platform gates were not rerun by this measurement.

## Direct-first enumeration and serialized snapshots

The next startup trace measured **1,404.1 ms** first paint, including two identity reads around three direct-metadata pages. In a subsequent instrumented JSON-response probe, first paint measured **1,295.7 ms**, and the main-reply-to-renderer-receipt interval fell from about **223 ms to 114 ms**. These separate samples identify useful boundaries but do not isolate serialization from run-to-run variation. Raw records are retained under `m8-startup-profile` and `m8-startup-json`.

The final reader starts with one complete direct-format enumeration. Ordinary refs need no additional identity or metadata reads; annotated refs retain bounded detail reads, consistency checks and native compatibility fallback. The repository store also selects the existing validated JSON bridge mode, already used for append-only pages. See [ADR 0098](../decisions/0098-direct-first-reference-enumeration.md) and [ADR 0099](../decisions/0099-serialized-repository-snapshots.md). No product-used fields, history roots or validation boundaries were removed.

With temporary instrumentation removed, three sequential fresh-profile runs measured **1,169.0 / 1,186.8 / 1,200.3 ms** first paint and **429.4–439.6 ms** snapshots. All nine 5,000-commit pages passed at **206.4–266.3 ms**; scroll p95 was **16.8 ms** in each run. Each mounted 32 history rows and seven reference controls. Renderer working set was about **558–562 MiB**. These combined changes improve the preceding 1,400.1–1,505.5 ms checkpoint, but **all three first-paint gates still fail the unchanged 500 ms budget**.

The fixture, native Git, host and cache conditions are unchanged. OS caches were not cleared. Benchmarks ran sequentially after the build and focused tests completed, with no concurrent builds or test suites. Raw records are retained under `m8-direct-first`; logs are `/tmp/openkraken-m8-direct-first-benchmark.log`, and artifacts are under `test-results/m8-direct-first/`. Each failed benchmark is retained rather than replaced with a passing threshold. This increment does not establish watcher-warm status, Chromium-sized or cross-platform performance, nor resolve the earlier full-Linux outlier.

## Utility transport follow-up

A subsequent probe serialized the snapshot between the Git utility and main while retaining main's response validation. It measured **1,250.4 ms** first paint, **441.6 ms** snapshot time and passing paging/scrolling. This single probe did not improve on the preceding 1,169.0–1,200.3 ms samples, so the transport experiment was reverted. It is retained as `m8-utility-json-probe`, with log `/tmp/openkraken-m8-utility-json-probe.log`; it is not part of the implementation and does not establish a general serialization regression. The renderer-side serialized response from ADR 0099 remains in use.

The additional two-million-commit/100,000-file synthetic graph and watcher-warm status gates are recorded separately in [m8-scale-performance.md](m8-scale-performance.md). They do not replace or relax this still-failing 50,000-ref first-paint gate.

## Renderer reference indexes

A 100 µs sampling profile around repository opening attributed about **56 ms** of renderer self time to sidebar construction/filtering and **26 ms** to badge grouping. The instrumented run measured **1,259.3 ms** first paint; it is diagnostic evidence, not an uninstrumented acceptance sample. The raw CPU profile is under `test-results/m8-renderer-profile/`, and its benchmark record is retained as `m8-renderer-profile`.

The sidebar now groups refs in one pass, skips case normalization for empty queries and locates the focused row only when focus exists. Badge grouping now uses target-local label/kind indexes while preserving ordered output and all ref names. A separate regression exposed **8,438.9 ms** grouping 50,000 distinct badges at one target. Five post-change isolated samples took **18.7–54.1 ms** for a shared target and **17.7–21.2 ms** for distinct targets, with every full ref name/order compared. Those timings measure the helper only, not DOM rendering of 50,000 badges. See [ADR 0102](../decisions/0102-linear-reference-presentation-indexes.md).

Three final uninstrumented runs on the unchanged distinct-target 50,000-ref fixture measured **1,235.3 / 1,133.4 / 1,180.5 ms** first paint. The post-publication paint interval was **132.9–144.1 ms**, compared with **159.5–169.7 ms** in the preceding direct-first samples. Service/snapshot variation left overall startup overlapping the previous range; these samples do not establish a clear total first-paint improvement. **All three still fail the unchanged 500 ms gate.** All nine pages passed at **183.5–262.1 ms**, scroll p95 was **16.7–16.8 ms**, and reference controls remained bounded.

Raw records are `m8-renderer-index` and `m8-badge-index-profile`. Logs: `/tmp/openkraken-m8-renderer-index-benchmark.log`, `/tmp/openkraken-m8-renderer-profile.log` and `/tmp/openkraken-m8-badge-index-profile.json`. Fresh profiles, uncleared OS caches and sequential runs without concurrent builds/tests were retained. The temporary profiler test and isolated probe script were removed. Verification passed 793 native/unit tests (14 platform/tool-dependent skips), 23 selected desktop tests with six unchanged graph goldens, typechecking/build and full lint. The desktop regression also covers Unicode/ASCII filtering, whitespace reset, accessible positions and a focused rename dialog surviving offscreen scrolling. Full native-platform/installer acceptance and other scale/status cohorts were not rerun.

## Bounded badges at a shared target

A second isolated bare fixture points all **50,000 refs at the same commit**, retaining the same complete Linux history and HEAD. It exposed a separate rendering problem: the visible commit row constructed every badge. The baseline measured **15,290.5 ms** first paint, including **14,420.5 ms** after state publication. Paging still passed at **233.9–249.1 ms**, and scroll p95 was **16.7 ms**.

Commit rows now show at most three badge previews and a total-ref button when overflow exists. Tooltips also contain at most three full names, including when thousands of remotes are grouped into one branch badge. The button opens a searchable, virtualized modal containing every full name in the current graph view. It preserves graph selection, updates on ref refresh, survives its originating row scrolling away, and restores focus on Close/Escape. See [ADR 0103](../decisions/0103-bounded-commit-reference-previews.md).

Three final runs on that shared-target fixture measured **1,004.5 / 1,019.2 / 1,063.7 ms** first paint, with **145.2–169.6 ms** after publication. All nine pages passed at **202.9–280.0 ms**, and scrolling passed at **16.7–16.8 ms p95**. This removes the large unbounded-rendering cost; **all three first-paint checks still fail the unchanged 500 ms gate**.

A separate three-run regression cohort on the original distinct-target fixture measured **1,142.1 / 1,208.3 / 1,170.6 ms** first paint, overlapping the previous **1,133.4–1,235.3 ms** range. Its nine pages passed at **208.1–268.9 ms**, and scroll p95 remained **16.7–16.8 ms**. All six final runs mounted 32 history rows and seven sidebar reference controls. No overall startup improvement is claimed for the distinct-target case.

Both cohorts used fresh profiles and uncleared OS caches; they ran sequentially with no concurrent builds or test suites. Raw records are `m8-shared-ref-baseline`, `m8-shared-ref-bounded` and `m8-commit-refs-distinct` in the JSON, with the new fixture manifest under `m8-shared-ref-fixture`. Logs are `/tmp/openkraken-m8-shared-ref-{baseline,bounded}.log` and `/tmp/openkraken-m8-commit-refs-distinct.log`; corresponding directories under `test-results/` retain measurements, screenshots and failure traces. All failed gates are retained. These runs do not establish cold-cache, packaged or cross-platform performance.

Verification passed **793 native/unit tests** (14 existing platform/tool-dependent skips), **24 selected desktop tests** with six unchanged graph goldens, typechecking/build and full ESLint/Prettier. The two new desktop cases cover canonical names, merged remotes, annotated tags, Unicode filtering, empty results, whitespace reset, native Home/End scrolling, external deletion and focus/lifecycle behavior. Their initial unbounded-rendering regression failed before the change. Logs are `/tmp/openkraken-m8-commit-refs-{red,green,keyboard,build,types,lint,unit,e2e}.log`. The dialog screenshot was visually inspected. Other platform, package, full-suite and synthetic/status acceptance was not rerun in this increment.

The shared-target repository is `.test-fixtures/refs-50000-shared-wt5fwj3d/repository.git`. To reproduce it, use the isolated-clone recipe below, replacing the `commits.slice(1).map(...)` update-ref input with:

```js
Array.from({ length: 49999 }, (_, index) => {
  const kind = index < 5000 ? 'heads' : index < 10000 ? 'remotes/fixture' : 'tags';
  return `create refs/${kind}/shared-${String(index).padStart(5, '0')} 46fec1c3029b552ec63b2d01af9d43a386f043ea`;
}).join('\n') + '\n';
```

Keep the original `master` ref, pack refs and write the fixture's own commit graph as before. It borrows source objects but makes no reference changes to the source. The fixture manifest verifies **1,505,199 commits**, **50,000 refs** and the expected HEAD. Use `--repeat-each=3` for each final benchmark cohort.

## Initial watcher reference baseline

A temporary boundary trace on the distinct-target fixture measured **1,209.5 ms** first paint. Its phases included **125 ms** establishing the watcher baseline, **424 ms** reading the snapshot, **153 ms** transferring the utility result to main, **62 ms** validating it, and **53 ms** decoding JSON in the renderer. These wall-clock boundary timings are diagnostic, instrumented samples rather than acceptance results. The complete trace and benchmark are retained as `m8-startup-phase-traces` and `m8-startup-phases`.

A [Node V8 serializer](https://nodejs.org/api/v8.html#serialization-api) probe preserved main's response validation but encoded the utility snapshot as bytes. It measured **1,201.3 ms** first paint; encoding/transfer took **75 ms** and main decoding **77 ms**, leaving essentially the same combined transfer cost. This did not establish an improvement. The probe was removed, and its record is retained as `m8-binary-probe`. Logs are `/tmp/openkraken-m8-{startup-phases,binary-probe}.log`. No binary transport or temporary timing instrumentation remains in the implementation.

The retained change reuses the initial snapshot's complete ordered refs for the watcher's first reference fingerprint. All other baseline reads finish before snapshot capture; later checks still enumerate native refs and close the subscription race. Failed initial snapshots discard their watcher before retry. The regression initially observed two native ref enumerations and now observes one. See [ADR 0104](../decisions/0104-snapshot-reference-watcher-baseline.md).

Three uninstrumented distinct-target runs measured **1,088.6 / 1,085.7 / 1,112.8 ms** first paint, compared with the preceding **1,142.1–1,208.3 ms** cohort. Service response time was **847.7–867.9 ms**, including **455.4–457.8 ms** snapshot reads. All nine pages passed at **191.6–258.6 ms**; scroll p95 was **16.7–16.8 ms**.

Three shared-target runs were more variable: **918.2 / 1,117.0 / 1,224.5 ms**, compared with the prior **1,004.5–1,063.7 ms** cohort. Their snapshot times varied from **283.2 to 436.2 ms**. These samples do **not** establish an overall startup improvement for the shared-target fixture or explain its variation. All nine pages passed at **203.6–284.9 ms**; scroll p95 was **16.7–16.8 ms**. **All six final first-paint checks still failed the unchanged 500 ms gate.**

Both cohorts used fresh profiles, uncleared OS caches and sequential runs without concurrent builds/tests. Raw records and artifacts are `m8-watcher-seed` and `m8-watcher-seed-shared`; logs are `/tmp/openkraken-m8-watcher-seed-{benchmark,shared}.log`. No failing or variable sample was discarded. These measurements do not establish cold-cache, packaged or cross-platform acceptance.

Verification passed **799 native/unit tests** (14 existing platform/tool-dependent skips), **13 watcher tests on native Git 2.38.0**, **41 selected Electron tests** with six unchanged graph goldens, typechecking/build and full ESLint/Prettier. Native tests compare complete seeded/fresh fingerprints, tracking states, tags/stashes, checkout/bare/linked repositories and handoff/closure cases. Desktop coverage includes repair/retry after an initial missing-object failure and subsequent native changes. Evidence is `/tmp/openkraken-m8-watcher-seed-{red-final,green,coverage,build,unit,git238,types-final,lint,e2e}.log`. The duplicate-read regression initially failed; test setup/type-target errors were corrected and retained in the earlier logs. Other native-platform/package and full-suite acceptance was not run.

## Reproduce the isolated fixture

Start with a local full-history bare Linux clone containing only `refs/heads/master` at the revision above. Run this from the repository root after setting `LINUX_SOURCE` to that clone's absolute path. The original must remain available because the fixture borrows its objects. All reference writes and commit-graph generation below target the new temporary clone.

```bash
LINUX_SOURCE=/absolute/path/to/linux.git node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
const source = process.env.LINUX_SOURCE;
const git = (cwd, args, input) => execFileSync('git', args, {
  cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
}).trim();
if (git(source, ['for-each-ref', '--format=%(refname)']) !== 'refs/heads/master')
  throw new Error('Expected a single master ref');
if (git(source, ['rev-parse', 'HEAD']) !== '46fec1c3029b552ec63b2d01af9d43a386f043ea')
  throw new Error('Unexpected source revision');
if (git(source, ['rev-parse', '--is-shallow-repository']) !== 'false')
  throw new Error('Expected full history');
mkdirSync('.test-fixtures', { recursive: true });
const repository = join(mkdtempSync(resolve('.test-fixtures/refs-50000-')), 'repository.git');
git(process.cwd(), ['clone', '--bare', '--shared', source, repository]);
const commits = git(repository, ['rev-list', '--max-count=50000', 'HEAD']).split('\n');
if (commits.length !== 50000) throw new Error('Insufficient history');
git(repository, ['update-ref', '--stdin'], commits.slice(1).map((oid, index) => {
  const kind = index < 5000 ? 'heads' : index < 10000 ? 'remotes/fixture' : 'tags';
  return `create refs/${kind}/benchmark-${String(index).padStart(5, '0')} ${oid}`;
}).join('\n') + '\n');
git(repository, ['pack-refs', '--all']);
git(repository, ['commit-graph', 'write', '--reachable']);
console.log(repository);
JS
```

Build once, then run the benchmark with the printed fixture path. On a headless Linux host:

```bash
pnpm build
OPENKRAKEN_BENCH_REPO=/absolute/path/to/new/repository.git GIT_NO_LAZY_FETCH=1 \
  xvfb-run -a pnpm exec playwright test tests/e2e/benchmark.test.ts \
  --reporter=list --output=test-results/reference-benchmark
```

The expected current result for this fixture is a first-paint failure with passing paging, scrolling and mounted-row bounds. Each run records phase timings, environment/cache metadata, a screenshot and raw JSON. The benchmark performs no Git writes; the observer briefly creates and removes its private self-test probe. Do not run performance samples alongside builds or other suites.

The desktop regression covers 1,000 added branches, filtering to a distant reference, keyboard activation, access to tags at the end of the list, and a focused rename dialog surviving offscreen scrolling and completing a real native branch rename. Small-repository graph visual goldens remain unchanged. This checkpoint does not establish Chromium-sized synthetic history, watcher-warm status budgets, cold OS cache behavior, cross-platform performance or M8 completion.
