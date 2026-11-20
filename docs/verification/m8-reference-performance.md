# M8 reference performance checkpoint

The sidebar now mounts a bounded set of reference controls on large repositories. **The 50,000-reference first-paint gate remains failing.** No budget was changed. Raw measurements, including the initial full-Linux outlier and all five later samples, are retained in [m8-reference-performance.json](m8-reference-performance.json).

## Large commit messages in the saved history window

Two Linux x64 bare histories contained the same 80 consecutive commits with 256 KiB message bodies. On the 4,800-commit tip the large messages appeared within the first 2,000 rows. On the 9,600-commit tip they appeared in the next 5,000 rows. Fresh and restarted service runs matched every displayed commit ID and ordered parent with native Git, including all 80 messages. Four Electron launches opened the first page, appended through the root and selected the root with End. The first repository saved no cache pages. The second retained its 2,000-commit opening page.

A separate cache-writer experiment used fresh Node processes, a warm-up pair and five measured pairs with alternating build order. With 100 records sharing a 600 KiB body, the previous writer encoded the full batch before discovering that it exceeded 8 MiB. Stopping at the first record that exceeded the remaining budget reduced median flush time from 212.0 to 21.5 ms and peak resident memory growth from 118.6 to 8.5 MiB. An ordinary 2,000-commit prefix took 13.2 and 14.4 ms respectively and produced identical file bytes.

In three fresh Node processes per build, four successive pages supplied 17,000 distinct 4.5 KiB bodies. Each process flushed after every page and forced GC before sampling retained JS heap. After the final page, median heap growth fell from 82.28 MiB to 0.10 MiB when the writer released the unreachable records. On ordinary 17,000-commit windows with Unicode and escaped characters, all four file digests matched across all six runs. [Cache behavior](../decisions/0008-bounded-history-cache.md#oversized-commit-messages)

## Ref fields and concurrent Git probes

A baseline opening of the 50,000-distinct-target Linux fixture painted in 855.7 ms. Two experiments used five alternating pairs after warm-up with fresh Electron profiles and populated OS caches. Each run displayed 2,000 commits and 50,000 refs, checked the same first ten mounted IDs and badge labels, and appended 5,000 commits.

| Experiment                                                 | Median first paint, before → after | Median native snapshot, before → after |
| ---------------------------------------------------------- | ---------------------------------: | -------------------------------------: |
| Omit two empty fields when Git confirms no tracking config |                   721.7 → 746.9 ms |                       410.1 → 424.9 ms |
| Read tracking config while resolving sampled tag objects   |                   741.8 → 814.5 ms |                       435.7 → 425.4 ms |

The shipping reader retains the six-field direct format and resolves sampled objects before checking tracking configuration. The independent final gate painted in 762.6, 869.4 and 740.4 ms against the 500 ms budget. All nine 5,000-commit appends met 300 ms, taking 199.4–257.9 ms. [Paired measurements](m8-opening-experiments.csv)

## Hashing ordered history roots

The Git service hashes roots in batches of 1,024 and shares the ordered root array with the history cursor. Six pairs of fresh Node processes followed a warm-up pair on Linux x64. Each process loaded the roots, ran GC, and measured elapsed time and memory growth through producing the cache key and cursor inputs. The 50,000-root input came from the full Linux fixture. The 250,000-root input added synthetic IDs. All paired digests matched.

|   Roots | Median time, before → after | Median resident memory growth | Median JS heap growth |
| ------: | --------------------------: | ----------------------------: | --------------------: |
|  50,000 |               13.8 → 8.9 ms |               4.81 → 0.75 MiB |       2.94 → 3.15 MiB |
| 250,000 |             115.9 → 93.9 ms |             30.18 → 12.44 MiB |     24.87 → 25.80 MiB |

On each 50,000-ref fixture, Electron at `fb13733` saved four contiguous pages containing 17,000 commits. The new service reopened that profile, navigated into the live page and back across the cache boundary, and matched the selected commit IDs with Git. After quitting, the cache files retained their content digests, inode numbers and modification times. An independent restarted traversal compared all 50,000 refs and all 302 pages with native Git on both fixtures.

In five alternating fresh-profile pairs after warm-up, median first paint on distinct targets changed from 743.5 to 735.9 ms, with median native snapshot time changing from 418.6 to 413.0 ms. The nested-tag fixture changed from 525.6 to 501.0 ms, with native snapshot time changing from 186.7 to 186.5 ms. [Individual desktop measurements](m8-opening-experiments.csv) · [Cache key format](../decisions/0117-history-cache-inputs.md#hashing-large-ordered-root-lists)

The independent Linux x64 gates used Git 2.53.0 with the OS cache retained. Each series used three profiles. The nested fixture also verified the first-row dialog for 49,999 aliases. All 78 measured page appends across the full Linux and synthetic fixtures, including the six live pages immediately after the restarted cache windows, took 109.9–287.3 ms.

| Fixture                                    | Fresh first paint, series one | Fresh first paint, final series | First paint after restart |
| ------------------------------------------ | ----------------------------: | ------------------------------: | ------------------------: |
| Full Linux, one ref                        |                             — |                  335.9–369.3 ms |                         — |
| Full Linux, nested tag aliases             |                497.3–540.8 ms |                  470.7–504.1 ms |            442.4–476.6 ms |
| Full Linux, distinct targets               |                749.3–897.9 ms |                  726.7–865.7 ms |            648.2–690.9 ms |
| Two million commits, 100,000 tracked files |                             — |        1,117.7, 302.0, 339.6 ms |                         — |

The slow first opening on the synthetic checkout spent 950.8 ms in the native snapshot. The later three-profile diagnostic run with Git tracing painted in 312.4–333.1 ms, with native snapshots of 139.5–167.1 ms. It did not reproduce the slow opening. The watcher-warm status benchmark on that checkout passed all 30 clean and dirty requests in 185.5–245.3 ms and reported all three external edits within 861.2 ms.

## Checking object existence on the first page

On the 50,000-distinct-target fixture with one annotated tag, a prototype combined a revision walk for commit IDs with the existing sparse tag lookup and native ref enumeration. Across five alternating fresh desktop pairs the median first paint changed from 752.2 to 715.3 ms. A separate fixture revealed that the prototype accepted a ref to a missing loose commit that was still present in the commit-graph. Native Git’s typed ref query rejected the missing object. The regression failed with the prototype and passed with the shipping reader.

In six isolated native trials after warm-up, the revision walk took 122.1 ms at the median. Running it with `core.commitGraph=false` rejected the missing object and took 799.0 ms in the separate verification series. Checking captured IDs with `cat-file --batch-check=%(objectname)` took 125.3 ms by itself and reported the absent ID as missing. The shipped reader continues to ask Git for object types. [Individual desktop measurements](m8-opening-experiments.csv) · [Missing-object regression](../decisions/0098-direct-first-reference-enumeration.md#missing-objects-in-a-commit-graph)

## Reusing validated object IDs

On Linux x64, five paired parser runs compared `4e20003` and `c6b8c9a` on native output from 50,000 refs. Each run started a new Node process, streamed the same bytes in 64 KiB chunks, and measured retained heap after GC. All four streams produced identical digests for every record across builds. The full format includes peeled fields. The direct format omits them.

| Native stream            | Median parse time, before → after | Median retained heap, before → after |
| ------------------------ | --------------------------------: | -----------------------------------: |
| Full, nested aliases     |                    73.6 → 58.8 ms |        21,491,416 → 18,264,968 bytes |
| Direct, nested aliases   |                    47.9 → 32.9 ms |        12,922,640 → 11,340,488 bytes |
| Full, distinct targets   |                    62.3 → 56.0 ms |        14,686,008 → 14,687,392 bytes |
| Direct, distinct targets |                    60.1 → 58.5 ms |        14,584,008 → 14,585,024 bytes |

Five fresh-profile Electron pairs after warm-up used the same renderer and alternated Git-service build order. With nested tags, median first paint changed from 531.2 to 525.2 ms and native snapshot time from 214.8 to 196.5 ms. With distinct targets, median first paint changed from 749.1 to 735.4 ms and native snapshot time from 429.5 to 427.0 ms.

The independent acceptance runs used Git 2.53.0, retained OS caches and three profiles per condition. The restart cases reopened a profile after persisting 17,000 commits. Every nested-tag run exercised the first-row overflow dialog.

| Complete Linux history                         | First paint, fresh profile | First paint, restarted profile |
| ---------------------------------------------- | -------------------------: | -----------------------------: |
| One ref                                        |             332.2–340.0 ms |                              — |
| 49,999 aliases of a three-level annotated tag  |             493.8–495.0 ms |                 437.6–487.9 ms |
| 50,000 distinct targets with one annotated tag |             738.2–823.0 ms |                 688.6–705.1 ms |

All 45 appends through 17,000 commits met 300 ms. After restart, keyboard navigation triggered six more appends past the persisted window, taking 200.3–244.9 ms. The distinct-target first paint exceeded 500 ms on every run. [Individual desktop measurements](m8-opening-experiments.csv) · [Parser decision](../decisions/0002-git-protocol.md#repeated-object-ids-in-reference-streams)

## Commit badge lookups by object ID prefix

On Linux x64, five pairs of fresh Electron profiles compared eager indexing with resolving groups of target IDs as their commit rows mounted. Each pair alternated renderer build order after a warm-up pair. Both builds used the same Git utility and fixture, displayed 2,000 commits and 50,000 matching refs, and matched on the first ten mounted rows’ commit IDs, badge labels and tooltips. A renderer GC after the paint measurement preceded the heap sample and the first 5,000-commit append.

| Median across five pairs         | 50,000 distinct targets, eager → deferred | Nested tag aliases, eager → deferred |
| -------------------------------- | ----------------------------------------: | -----------------------------------: |
| Renderer heap after GC           |             28,894,072 → 26,227,452 bytes |        21,331,576 → 21,440,712 bytes |
| Store publication to first paint |                          117.5 → 102.7 ms |                       88.4 → 89.3 ms |
| Full first paint                 |                          781.4 → 740.7 ms |                     802.2 → 784.0 ms |
| First page append                |                          252.9 → 250.2 ms |                     255.7 → 246.7 ms |

The distinct-target fixture retained 2.54 MiB less renderer heap at the median. Both fixtures still exceeded the 500 ms first-paint budget in every measured pair. [All samples including warm-up](m8-commit-badge-index-samples.csv) · [Lookup and ordering rules](../decisions/0113-visible-commit-badges-and-reference-row-heights.md#looking-up-badges-on-large-sets-of-distinct-commits)

The separate three-profile acceptance run painted the one-ref Linux fixture in 337.2–359.3 ms. Distinct targets took 750.0–811.9 ms and nested tag aliases took 716.8–770.9 ms. All 27 appends took 169.4–279.4 ms.

### First-row annotated tag aliases in the packaged app

The nested-tag repository used for the paired badge-index measurements places the independent tagged commit below the first page. Regenerating the fixture from full Linux history with the current CI generator places that commit first. In the Linux x64 package, its badge opened a dialog reporting 49,999 refs. Filtering found the first, middle and last names from native Git. On the freshly generated distinct-target fixture, the package matched Git on all 207 mounted-row badge checks across seven scroll positions after loading 17,000 commits.

The acceptance benchmark on the regenerated nested-tag fixture exercised the first-row alias dialog in all three fresh profiles. First paints were 560.3, 503.5 and 511.3 ms. The regenerated distinct-target fixture took 838.2, 745.1 and 734.4 ms. All 18 appends met 300 ms, ranging from 175.2 to 263.5 ms. Both fixtures exceeded 500 ms in each run.

A separate CSS experiment isolated layout in the reference list and history scroll containers. Across five paired openings of each regenerated fixture, Canvas pixel hashes and sampled row and viewport bounds matched. Median first paint changed from 502.6 to 491.6 ms with first-row aliases and from 739.0 to 730.6 ms with distinct targets. In the independent acceptance runs all three alias openings still exceeded 500 ms, and one third-page append took 848.9 ms. That append spent 503.3 ms waiting for the service, 249.3 ms in the worker phase and 96.3 ms in publication. The release retains the existing scroll CSS.

## Memory used to locate sparse annotated tags

On the Linux history fixture with 50,000 distinct ref targets and one annotation, the packed-ref file occupied 3,410,078 bytes. Reading it to locate sparse annotated tags previously grew Node's array-buffer usage by 3,672,382 bytes. Reusing the 256 KiB prefix buffer reduced growth to 262,304 bytes. On a separate 7,800,100-byte packed-ref input with a Unicode tag near the end, growth fell from 7,996,724–8,062,404 bytes to 262,304 bytes. Each measurement used a fresh Node process, forced GC before the read and compared buffer usage immediately afterward. All three runs per build and input recovered the same tag.

To repeat the buffer measurement, set `REPO` to the bare repository produced by the `one-annotation` fixture. Run this from each checkout with its dependencies installed. The baseline is `8b47f33`. Commit `932ec89` introduces the bounded scan and `5cb1751` adds the 8 KiB initial allocation for repeated targets.

```sh
node --expose-gc --import tsx --input-type=module - "$REPO" <<'JS'
import { samplePackedRefs } from './packages/git-core/src/reference-reader.ts';
global.gc();
const before = process.memoryUsage().arrayBuffers;
const sample = await samplePackedRefs(process.argv[2]);
console.log(process.memoryUsage().arrayBuffers - before, sample.annotationNames);
JS
```

Three fresh Electron profiles opened the 50,000-ref Linux fixture in 738.4, 706.5 and 738.1 ms against the 500 ms budget. The nine 5,000-commit appends took 189.2–250.2 ms, and both scroll views measured at most 16.8 ms p95. An earlier batch overlapped the native reference tests in its first run. That opening took 996 ms and one append took 312.9 ms. The other two openings in that batch took 790.1 and 738.1 ms. These runs establish the buffer reduction and the outstanding opening gate. [Reader and boundary checks](../decisions/0098-direct-first-reference-enumeration.md#bounded-annotation-sampling)

On the fixture with 49,999 aliases of a nested annotated tag, the reader can stop after its first 8 KiB read. Allocating only that preview reduced measured array-buffer growth from 262,304 to 160 bytes in three fresh processes per build. Node's buffer pool supplied the small allocation in these runs. The native tests check individual allocation limits directly for both this case and the larger scan.

The final build exercised three more fresh profiles per distribution. The distinct-target fixture painted in 699.2, 794.4 and 923.0 ms. The nested-tag fixture painted in 1,282.2, 741.6 and 768.1 ms. All six openings exceeded the 500 ms budget. All 18 appends took 180.1–245.1 ms and both scroll views stayed within 16.8 ms p95. Independent 302-page traversals matched native Git through all 1,505,199 and 1,505,200 commits respectively, including every parent in order.

## Git object cache and snapshot transfer on November 20

A Git trace of a fresh Electron profile on Linux x64 measured 889.1 ms from opening the repository to painting 2,000 commits. The native snapshot took 470.4 ms. Within that interval Git spent 287.7 ms enumerating the 50,000 refs and their types. The three subsequent 5,000-commit pages took 299.2, 256.6 and 228.6 ms. Scrolling measured 16.8 ms p95 for history and 16.7 ms for references. The fixture contains 1,505,199 Linux commits, distinct ref targets and one annotated tag.

Two separate experiments alternated build order and used fresh Electron profiles with populated OS caches. The control and candidate each had one warm-up opening before the measured pairs. All measured openings exceeded 500 ms. [Individual measurements](m8-opening-experiments.csv)

| Experiment                                                                   | Measured pairs | Median first paint, control → candidate | Other measurement, control → candidate   |
| ---------------------------------------------------------------------------- | -------------: | --------------------------------------: | ---------------------------------------- |
| Give Git a 256 MiB delta base cache during ref enumeration                   |              5 |                        807.8 → 815.5 ms | Native snapshot 436.8 → 436.6 ms         |
| Send compact ref strings in one NUL-delimited field beside the snapshot JSON |              6 |                        729.8 → 748.1 ms | Renderer snapshot decoding 16.5 → 7.1 ms |

In six isolated native trials per condition after warm-up, median ref enumeration with Git 2.53.0 took 182.6 ms with its default settings, 176.7 ms with the larger delta base cache, 191.4 ms with a 4 GiB packed window and 190.0 ms with a 16 MiB window. All outputs were byte-identical. The desktop keeps Git’s configured cache settings and the existing snapshot transfer format.

## Retained memory in a 50,000-ref sidebar

The sidebar now indexes runs of adjacent references of the same kind. Five measured pairs compared the range index with the four-row arrays on Linux x64, using Git 2.53.0 and the 1,505,199-commit Linux fixture with 50,000 distinct ref targets and one annotation. Each experiment used a warm-up pair (pair zero), alternated build order and retained OS caches.

| Median across five pairs                          |  Four-row arrays |   Section ranges |
| ------------------------------------------------- | ---------------: | ---------------: |
| Renderer heap after first paint and forced GC     | 29,435,408 bytes | 27,860,012 bytes |
| Isolated grouping heap increase after forced GC   |  1,808,296 bytes |     87,632 bytes |
| Isolated grouping time                            |          4.54 ms |          1.59 ms |
| First paint after replaying the snapshot response |         838.0 ms |         776.0 ms |
| First paint including repository opening          |         873.8 ms |         934.7 ms |

The post-GC renderer heap fell in each pair. The isolated Node test built the grouping index on frozen records from native Git and verified the displayed order of all 50,000 names by SHA-256. The replay timed the app with a fresh profile after the test main process captured a real opening response, then checked the renderer asset and the visible commit and ref counts. Replay improved in four pairs. Full opening improved in two pairs and exceeded 500 ms in all five. The change is retained for the memory reduction. All 15 measured appends of 5,000 commits on the range build met 300 ms. [Heap, isolated grouping and replay samples](m8-reference-range-samples.csv)

Two preliminary builds used offsets into copied per-kind arrays. That alone moved median full paint from 787.7 to 784.7 ms. Preparing commit badge data during worker layout on top of that build moved median paint from 840.2 to 848.0 ms. Each comparison used five pairs after a warm-up. The release uses the range index and initializes badge data on demand. [Full opening, paging and scrolling measurements](m8-opening-experiments.csv)

On the subsequent Linux acceptance run at `116fc5b`, the 50,000-ref fixture took 1,210.6 ms to paint, including 817.2 ms in the native snapshot. Its three appends took 268.0, 255.6 and 248.3 ms. The graph scrolled at 16.8 ms p95 and the sidebar at 16.7 ms p95. The separate standard fixture painted in 355.9 ms and appended in 214.1 ms. The packaged app also compared the mounted names and their accessible positions against native Git at five offsets throughout the 50,000-ref list. It painted in 1,184.4 ms, filtered to the last tag, selected HEAD by keyboard and appended to 7,000 commits.

## Switching back to a cached repository with 50,000 refs

A Linux x64 Electron profile first saved 17,000 commits from the 50,000-distinct-target fixture and restarted. It opened single-ref Linux history, loaded 17,000 commits there, then switched back to the saved fixture. Four measured pairs alternated build order after a warm-up pair. Both builds waited for the outgoing cache write and checked the destination’s current graph fingerprint. The prototype also read the destination’s first cache page during the outgoing write and rechecked the file stamp afterward.

Median first paint was 845 ms for the control and 850 ms for the prototype. The prototype was faster in two pairs and slower in two. All 24 measured appends of 5,000 commits met 300 ms. Every measured opening exceeded 500 ms. The shipping implementation keeps the early read on initial process startup. [Individual timings](m8-opening-experiments.csv)

## Reading the cached first page during ref enumeration

Each Linux x64 run opened the full Linux fixture with 50,000 distinct ref targets, persisted 17,000 commits, then restarted Electron. The timed launch displayed 2,000 commits and all 50,000 refs. Both builds used Git 2.53.0, the same renderer and retained OS caches. Five measured pairs alternated build order after a warm-up pair. The control read the first cache page after computing the graph fingerprint. The candidate read and validated that page during Git’s ref enumeration and checked the final fingerprint and file stamp before using it.

| Median across five restarts |  Control | Early cache read |
| --------------------------- | -------: | ---------------: |
| Native snapshot             | 461.9 ms |         368.2 ms |
| First Canvas paint          | 870.4 ms |         733.8 ms |

First paint improved in all five measured pairs. Every opening exceeded 500 ms. Fourteen of the 15 measured candidate appends met 300 ms, with one taking 305.3 ms. All five candidate appends beyond the restored window took 202.6–258.6 ms. A 321.0 ms candidate append occurred in the warm-up pair. [Individual measurements, including warm-up](m8-opening-experiments.csv)

## Testing three ways to open 50,000 distinct refs

The first fresh-profile control painted in 992.7 ms, with 681.5 ms in the native snapshot. Subsequent paired runs used the same 1,505,199-commit Linux fixture, 50,000 refs, Git 2.53.0 and populated OS caches on Linux x64. Each pair included a fresh profile for each build, and the order alternated. The measurements below preceded the cache cancellation fix. [Per-run timings](m8-opening-experiments.csv)

| Experiment                                                                            | Pairs | Median first paint, control → prototype | Median snapshot, control → prototype |
| ------------------------------------------------------------------------------------- | ----: | --------------------------------------: | -----------------------------------: |
| Resolve direct commit types separately while reading ref names and tracking fields    |     4 |                        711.7 → 749.6 ms |                     397.7 → 431.5 ms |
| Compare equally sized root lists by position after peeling annotations                |     5 |                        704.9 → 749.2 ms |                     401.2 → 410.0 ms |
| Send the compact ref list to main as one JSON string and validate its decoded records |     4 |                        713.5 → 721.4 ms |                     404.9 → 395.4 ms |

In a separate native probe, omitting object types reduced the Git ref query from 139–143 ms to 36–40 ms in three of four trials. In the desktop experiment, a second Git process had to recover those types and the utility had to associate them with the authoritative records. All four resulting openings took longer. The equal-length comparison also took longer end to end in each pair. The JSON transfer improved first paint in one of four pairs. The shipping app retains the original reader, root comparison and transfer. All 78 paired page appends took at most 235.2 ms.

## Resolving annotated objects before enumerating refs

On the 50,000-ref nested-tag fixture, the first 128 native rows contain both direct targets. Git resolves their object types and peeled commits before enumerating every name and its current tracking fields. The full enumeration checks coverage by object ID. A second change lets history start from the commits in the same sample. For a repository with distinct targets and just one annotation, a bounded packed-ref scan identifies candidate names. Git resolves the names before its authoritative direct read. [Reader behavior and fallbacks](../decisions/0098-direct-first-reference-enumeration.md#sampling-annotated-objects-before-reading-all-ref-names)

Five measured pairs per comparison alternated builds on Linux x64 with Git 2.53.0. Each fresh profile opened the full Linux fixture, verified the 50,000-ref heading and appended from 2,000 to 17,000 commits. OS caches were populated. Pair zero was a warm-up. The table reports medians.

| Change                                        | Fixture                          | First paint before | First paint after | Snapshot before | Snapshot after |
| --------------------------------------------- | -------------------------------- | -----------------: | ----------------: | --------------: | -------------: |
| Resolve the repeated objects first            | Nested tag aliases               |           576.3 ms |          504.8 ms |        270.4 ms |       199.7 ms |
| Share the object sample with the opening walk | Nested tag aliases               |           501.7 ms |          493.8 ms |        197.9 ms |       188.2 ms |
| Resolve sparse annotated names first          | Distinct targets, one annotation |           841.0 ms |          697.5 ms |        459.5 ms |       387.9 ms |
| Same builds, ordinary refs only               | Distinct targets                 |           691.0 ms |          679.6 ms |        370.9 ms |       376.3 ms |

Four of five candidate openings in the shared-sample comparison met 500 ms. The fifth took 511.9 ms. Two appends in the earlier comparison took 903.4 and 823.4 ms in one profile. All 15 appends in the subsequent shared-sample comparison took at most 230.3 ms. The cause of the two earlier delays is unconfirmed. All measured distinct-target openings exceeded 500 ms. [Per-run timings, including warm-ups](m8-opening-experiments.csv)

## Opening 50,000 distinct refs with one annotated tag

The mixed fixture replaces the lightweight tag `benchmark-10000` with an annotation of the same commit in a shared-object mirror. It retains 50,000 refs and 1,505,199 reachable commits. Git 2.38.0 and 2.53.0 matched all application ref records and the first 17,000 ordered commit IDs and parent lists. SHA-256 for the displayed history prefix was `539be6736e0fe82c65494612f950a6f55601967a237c6c4875777895a1f50965`. Both versions also matched the prefix on the nested-annotation fixture. On a separate 950-commit DAG, substituting peeled commit IDs for tag object IDs preserved the native date-order and parent stream for 120 root lists on each Git version.

Recreate this distribution from a full Linux repository with `node scripts/create-reference-performance-fixture.mjs SOURCE NEW_DIRECTORY one-annotation`. It writes the annotation in the new bare repository and records its full name and peeled commit in `fixture.json`. The source supplies the existing Git objects.

Each row shows the median of five alternating fresh-profile pairs after a warm-up pair on Linux x64, Git 2.53.0, with populated OS caches. Each run opened 2,000 commits and appended three pages to reach 17,000.

| Change                                             | Fixture          | First paint before | First paint after | Snapshot before | Snapshot after |
| -------------------------------------------------- | ---------------- | -----------------: | ----------------: | --------------: | -------------: |
| Verify tracking fields after peeling               | Nested aliases   |           604.1 ms |          570.0 ms |        297.4 ms |       271.4 ms |
| Verify tracking fields after peeling               | One annotation   |         1,089.3 ms |        1,045.3 ms |        766.3 ms |       733.1 ms |
| Same builds, ordinary refs only                    | Distinct targets |           707.7 ms |          754.6 ms |        382.0 ms |       403.2 ms |
| Reuse the walk after checking ordered peeled roots | One annotation   |         1,032.5 ms |          877.9 ms |        716.4 ms |       538.1 ms |

The ordinary-refs run used one direct enumeration in both builds. A prototype that reread object types to hash both complete streams raised median first paint from 1,102.8 to 1,247.2 ms on the mixed fixture. Comparing text fields on the grouped alias path raised the median from 569.7 to 598.3 ms. The shipped reader hashes grouped streams and compares direct fields for distinct targets. All 60 measured candidate appends in the table took less than 269 ms. Every candidate first paint exceeded 500 ms. [Individual runs, including warm-ups and discarded variants](m8-opening-experiments.csv) · [Reference recheck](../decisions/0098-direct-first-reference-enumeration.md#rechecking-tracking-counts-after-tag-reads) · [Ordered history roots](../decisions/0122-overlap-reference-and-history-reads.md#validating-walks-started-from-tag-objects)

## Nested annotated tags on full Linux history

A shared-object bare clone of the one-ref Linux fixture retained its original branch at `46fec1c3029b552ec63b2d01af9d43a386f043ea`. The fixture added a parentless commit and a three-level annotated tag chain pointing to it. After the intermediate tag names were removed, 49,999 packed tag names pointed to the outer annotation. Native Git counted 50,000 refs and 1,505,200 reachable commits. The earlier 50,000-distinct-target fixture has a different distribution and remains a separate gate.

Git 2.38.0 originally omitted the parentless commit from the application graph. With recursive peeling, both Git 2.38.0 and 2.53.0 returned all 50,000 ref records with every field matching Git 2.53.0's full ref enumeration. On both versions, the first 17,000 displayed IDs and parent lists matched native traversal byte for byte (SHA-256 `06f2b482653f92d39961da5c7a2853af13de640ec0fc4885ee08825a6d22d110`). A solo view of the last tag found the parentless commit by its message. An unfiltered message search during concurrent verification reached the 30-second native deadline. A subsequent search found that commit in 24.5 seconds.

The table gives medians from alternating fresh-profile Electron runs on Linux x64 with populated OS caches. The first two comparisons include the compatibility fix in both builds. The third comparison includes native batch peeling in both builds and changes the utility-to-main transfer. Each run opened 2,000 commits, appended three 5,000-commit pages, and scrolled the 12,000-row graph.

| Change                       | Git    | Pairs | First paint before | First paint after | Native snapshot before | Native snapshot after |
| ---------------------------- | ------ | ----: | -----------------: | ----------------: | ---------------------: | --------------------: |
| Peel each shared object once | 2.53.0 |     3 |         1,560.2 ms |          978.9 ms |               965.4 ms |              394.0 ms |
| Peel each shared object once | 2.38.0 |     3 |         2,408.4 ms |        1,031.3 ms |             1,750.1 ms |              438.3 ms |
| Stage repeated tag names     | 2.53.0 |     5 |         1,018.1 ms |          894.9 ms |               403.6 ms |              412.2 ms |

Staging the aliases reduced median time from the open request to receipt in the renderer from 806.5 to 658.8 ms. All 15 appends with the staged transfer took 182.0–226.8 ms. Graph frame intervals were at most 16.8 ms p95. Every first paint in the table exceeded 500 ms. [Per-run timings](m8-opening-experiments.csv)

### Keeping validated tag aliases compact through the renderer bridge

Five alternating pairs followed one warm-up pair (pair 0) on the same 50,000-ref annotated fixture. Each Linux x64 Electron run used a fresh profile, Git 2.53.0 and populated OS caches. Each opened 2,000 commits, checked the displayed ref count and appended to 17,000 commits. Median first paint fell from 893.0 to 709.5 ms. Median time to receive the opening response fell from 656.3 to 525.8 ms. Parsing the renderer metadata took 10.6 ms at the median, down from 47.5 ms. Reconstructing the tag aliases in the renderer took 6.5 ms at the median.

All five candidate openings exceeded 500 ms (688.0–817.1 ms). All 15 candidate page appends took less than 300 ms (186.0–272.2 ms). This comparison measured opening and paging only. The existing distinct-target fixture uses a different ref format. [Per-run measurements](m8-opening-experiments.csv) · [Transfer format](../decisions/0116-validated-snapshot-references.md#consecutive-names-for-annotated-tags)

### Starting the history walk from annotated refs

The earlier speculative walk received the direct tag object ID. The complete enumeration returned the peeled commit, so opening this repository started a second walk. Git now peels a bounded sample before the first walk starts. A native regression follows nested annotations through the first page, an append and exact-ID search. A second case puts an independent commit outside the sample and verifies that the service discards the tentative walk and returns all of Git's ordered commits and parents.

Five alternating fresh-profile pairs followed one warm-up pair on the same annotated fixture. Both builds used compact renderer aliases. Median first paint fell from 708.0 to 582.1 ms and native snapshot time fell from 408.2 to 288.9 ms. All five candidate first paints exceeded 500 ms (576.9–644.5 ms), and all 15 appends took less than 239 ms. [Individual measurements](m8-opening-experiments.csv) · [Cursor adoption checks](../decisions/0122-overlap-reference-and-history-reads.md#packed-annotated-tags)

## Raw Git dates in the history stream

On full Linux history, Git returned 21,207,090 bytes for 17,000 commits using the original author and committer dates. With raw dates it returned 20,527,090 bytes. All parsed fields matched on Git 2.53.0 and 2.38.0. The raw format also reads an epoch-zero commit whose negative timezone caused the original Git command to abort. [Format and compatibility](../decisions/0002-git-protocol.md#raw-author-and-committer-dates)

A second comparison traversed all 1,505,199 commits from the 50,000 refs on Git 2.53.0. Each parser streamed complete ordered commit objects into SHA-256, including parent lists, author and committer records, summaries and bodies. Both digests were `a8d8aa93f10d02879da75d613294f7c6fb12db04dd35c2ba46655efd861762fa`. Native output fell from 1,319,948,216 to 1,259,740,256 bytes. On a separate set of 42 timestamp and timezone combinations, both Git versions returned all raw dates and refused six calendar dates near the epoch.

Three pairs per fixture alternated Git utility bundles on Linux x64 under X11. Each opening used a fresh profile, loaded the first 2,000 commits and appended three 5,000-commit pages. The Linux checkout contained 1,505,199 commits. OS caches stayed populated.

| Fixture                 | Median first paint, original | Median first paint, raw dates | Median append, original | Median append, raw dates |
| ----------------------- | ---------------------------: | ----------------------------: | ----------------------: | -----------------------: |
| One ref                 |                     328.2 ms |                      318.7 ms |                200.3 ms |                 203.9 ms |
| 50,000 distinct targets |                     688.8 ms |                      697.9 ms |                212.5 ms |                 209.4 ms |

With raw dates, the three distinct-target openings took 731.8, 665.7 and 697.9 ms. All 18 candidate appends met 300 ms and graph frame intervals were 16.7–16.8 ms p95. The reduced stream size and the epoch fix held independently of the timing variation. First paint on distinct targets still exceeds 500 ms. [Individual measurements](m8-opening-experiments.csv)

A separate prototype piped the starting IDs into the history walk while Git enumerated refs. Across nine alternating native pairs after warm-up, median time to read the first 2,001 commits fell from 166.6 to 155.8 ms with identical output. In six alternating fresh-profile Electron pairs after warm-up, median native snapshot time fell from 368.0 to 352.8 ms while first paint rose from 682.4 to 689.9 ms. The shipping utility keeps the existing root enumeration.

## Commit type and renderer scheduling experiments

On full Linux history with 50,000 distinct targets, a diagnostic utility ran a name and tracking read alongside `git --no-replace-objects rev-list --no-walk=unsorted --all`. It accepted commit types only for targets that appeared in the latter output and used the full native query if any target was unresolved or the repository used replacement refs. In a separate mixed-object repository, Git's no-walk command returned the commit ID and omitted the direct IDs of the annotated tag, tree and blob. Across six alternating fresh-profile pairs after warm-up on the large fixture, median native snapshot time rose from 374.9 to 399.7 ms and first paint rose from 713.5 to 737.5 ms.

A second diagnostic build dispatched graph layout before expanding compact reference records. Across six more alternating pairs on the same fixture, median time from receiving the snapshot to first paint rose from 184.4 to 199.0 ms. Median end-to-end first paint was 723.8 ms with the original renderer and 747.1 ms with early dispatch. Both comparisons opened all 2,000 commits and showed all 50,000 references. The shipping implementation retains its existing read and layout order. [Individual measurements](m8-opening-experiments.csv)

## Streaming object-type lookup

On the pinned full Linux fixture with 50,000 distinct targets, a native probe piped the ref name, target and tracking fields from `for-each-ref` into `cat-file --batch-check`. The second command looked up the type of each object and returned the other fields using `%(rest)`. Across eight alternating pairs after warm-up, the median command time with empty upstream fields fell from 163.9 to 140.4 ms. With both upstream fields requested, it fell from 216.3 to 169.8 ms. The direct and piped commands returned byte-identical output in all runs on this fixture.

A separate diagnostic Git utility passed the identity stream between two supervised Git processes and parsed the returned records. Both builds opened the same fixture, displayed 2,000 commits and reported all 50,000 matching refs. After one warm-up pair, six alternating fresh-profile pairs measured median snapshot time of 383.2 ms with the existing reader and 404.0 ms with the pipeline. Median first paint was 724.1 and 730.9 ms, respectively. The shipping reader retains the single direct enumeration for this case.

## Wide graph drawing and append-only passage indexing

A Linux x64 Electron Canvas probe drew a 400 × 560 CSS-pixel viewport straddling rows 499 and 500 at device pixel ratio 1. It alternated between the first lane and the middle of the graph. Each case included a diagonal crossing the viewport, dashed passages and two warm-up draws. Both builds produced identical RGBA hashes at both horizontal positions for each case.

| Concurrent vertical passages | Previous median draw | Median with viewport clipping |
| ---------------------------: | -------------------: | ----------------------------: |
|                            1 |               0.1 ms |                        0.1 ms |
|                          100 |               0.5 ms |                        0.5 ms |
|                        5,000 |               6.5 ms |                        0.4 ms |
|                       50,000 |              51.2 ms |                        1.6 ms |

Each median covers ten calls to the painter. A separate compact allocator comparison with 100, 5,000 and 50,000 parents returned identical serialized rows, lane checkpoints and passages before and after the full-frontier change. A native Git fixture in Electron verifies both lane pixels across graph rows 2,000 and 2,001, where an uncommitted working-tree row shifts the page boundary, and follows the surviving lane below the merge's ancestor. [Graph layout decision](../decisions/0006-compact-graph-passages.md#drawing-and-appending-wide-histories)

At `8022374`, five fresh-profile desktop runs opened 2,000 commits and appended three pages of 5,000 commits from full Linux history. Git was 2.53.0 and OS caches stayed populated. First paint took 324.3 ms with one ref and 487.4 ms with 50,000 refs sharing HEAD. With 50,000 distinct targets it took 666.6, 724.1 and 752.9 ms, exceeding the 500 ms budget in every run. All fifteen appends took 179.6–238.3 ms. Graph scrolling measured 16.7–16.8 ms p95. [Individual runs and phase timings](m8-opening-experiments.csv)

## Reading tentative history roots from packed refs

On the pinned full Linux fixture with 50,000 distinct targets, a scratch service read the 3.4 MB packed-refs file directly to start a speculative history walk. The complete native enumeration still decided whether the ordered roots matched before the walk could be used. After one warm-up pair, five alternating fresh-profile pairs measured median first paint of 699.4 ms with the existing Git query and 722.0 ms with the file read. The corresponding native snapshot medians were 381.3 and 387.5 ms. The shipped service retains the Git query.

Three subsequent full benchmarks of the shipped code at `2c44546` painted in 699.2, 686.8 and 696.5 ms. All exceeded 500 ms. All nine 5,000-commit appends took 152.4–259.7 ms. Graph scroll p95 was 16.7–16.8 ms. These Linux x64 runs used Git 2.53.0, fresh application profiles and retained OS caches. [Individual runs](m8-opening-experiments.csv)

## Preparing the snapshot during graph layout

At `d1e8346`, the renderer freezes the validated repository snapshot and display rows while the graph worker lays out the first page. Both revisions used the same native Git service and Electron build. Each opening used a fresh profile on Linux x64 with Git 2.53.0 and retained OS caches. Build order alternated in each series.

| Fixture and measurement                                              | Baseline | With preparation during layout |
| -------------------------------------------------------------------- | -------: | -----------------------------: |
| Shared target, median first paint across five full benchmarks        | 495.2 ms |                       493.6 ms |
| Shared target, first paints below 500 ms                             |      3/5 |                            5/5 |
| Shared target, median time from layout reply to store publication    |  29.7 ms |                         7.0 ms |
| Distinct targets, median first paint across three full benchmarks    | 727.8 ms |                       705.5 ms |
| Distinct targets, median time from layout reply to store publication |  21.1 ms |                         8.3 ms |
| Single ref, first paint in one full benchmark                        | 343.6 ms |                       335.5 ms |

All 27 candidate appends met 300 ms. The distinct-target candidate painted in 705.5, 894.6 and 700.6 ms. In a separate series of six opening-only pairs on the shared-target fixture, the median interval from receiving the snapshot to publication fell from 99.0 to 82.4 ms. Five of the six candidate first paints met 500 ms. The worker round-trip includes any overlapping renderer preparation. [Individual full-benchmark runs](m8-opening-experiments.csv)

Two further experiments used the distinct-target fixture. Looking up object types in three parallel Git processes reduced the median time for an isolated enumeration and record comparison from 159.4 to 139.7 ms. Every field matched a direct enumeration in each run. In seven fresh-profile desktop pairs, that approach increased median native snapshot time from 375.1 to 445.9 ms and median first paint from 706.5 to 752.2 ms. In a second experiment, sending the staged refs to main as one JSON string took 502.3 ms to deliver the opening response, compared with 497.2 ms using the existing transfer, across six pairs. The shipped build uses the direct native enumeration and staged ref array.

A separate instrumented development build recorded four openings with 50,000 distinct targets. The median interval from starting the reference read to having the refs, worktrees and cache inputs ready was 268.4 ms. Sending the staged ref array took a further 24.8 ms in the utility. From sending the completed snapshot to the renderer receiving its response took 84.7 ms. That final interval included main-process validation (14.1 ms median), response encoding (17.8 ms) and delivery after encoding (26.1 ms). These are wall-clock measurements from a diagnostic build.

## Starting history from a shared HEAD

With Git 2.53.0, a traced Linux x64 opening of full Linux history painted in 342.5 ms with one ref and 672.3 ms with 50,000 distinct refs. On the distinct fixture, five native runs took a median 133.4 ms to enumerate ref names, IDs, object types and HEAD markers. Asking Git to omit object types took 35.0 ms. Looking up the missing types in a separate batch took another 99.1 ms. These native timings exclude parsing and IPC. The app continues to resolve every ref's type.

On the 50,000-ref fixture where every ref pointed to HEAD, the old opening path also asked Git to print all 50,000 tentative roots. The new path starts its optional walk from the opened HEAD when the sampled packed refs agree. It still checks every root before accepting that walk. The native regressions compare every displayed ID and parent on both initial and appended pages when an independent tip exists outside the sample. [Cursor adoption rules](../decisions/0122-overlap-reference-and-history-reads.md#packed-refs-sharing-the-opened-head)

Both builds used the same renderer and Git 2.53.0 on Linux x64, with fresh application profiles and retained OS caches. Six opening-only pairs followed one warm-up pair. Five more pairs used the full paging benchmark. Build order alternated within each series.

| Shared-target fixture                     | Baseline | With sampled HEAD |
| ----------------------------------------- | -------: | ----------------: |
| Median native snapshot, opening-only      | 211.7 ms |          184.9 ms |
| Median first paint, opening-only          | 522.5 ms |          496.8 ms |
| First paints below 500 ms, opening-only   |      0/6 |               5/6 |
| Median first paint, full benchmark        | 536.0 ms |          489.7 ms |
| First paints below 500 ms, full benchmark |      0/5 |               3/5 |
| 5,000-commit appends below 300 ms         |    15/15 |             14/15 |

The third candidate run recorded a 713.4 ms append and 33.3 ms p95 graph frame interval. That append spent 419.8 ms in the service phase, 192.3 ms in the worker phase and 101.3 ms in publication. The next two candidate runs met both paging and scroll budgets. The cause of the outlier is undetermined. A final one-ref opening painted in 336.7 ms, and the distinct-target fixture took 734.4 ms. All six of their appends met 300 ms. [Individual runs](m8-opening-experiments.csv)

## Upstream fields on 50,000 local branches

On Linux x64 with Git 2.53.0, a traced opening of the full-history fixture took 842 ms. The initial reference enumeration occupied 318 ms, and 135 ms elapsed between publication and paint. In six native comparisons on the fixture without configured upstreams, the median enumeration took 207 ms with both upstream fields, 177 ms with the upstream name alone and 147 ms with both fields empty. The product checks Git configuration before and after using the shorter format. [Query selection and compatibility](../decisions/0098-direct-first-reference-enumeration.md#packed-local-branches-without-tracking-configuration)

Opening-only desktop runs compared the same builds in six alternating pairs after a warm-up pair. Each opening used a fresh profile, retained OS caches and displayed 2,000 commits and all 50,000 matching refs. The tracking control was a separate copy of the distinct-target fixture with a local upstream 11 commits behind its branch.

| Fixture                                  | Median first paint before / after | Median native snapshot before / after |
| ---------------------------------------- | --------------------------------: | ------------------------------------: |
| Distinct targets                         |                  851.1 / 823.6 ms |                      441.8 / 451.3 ms |
| Shared target                            |                  555.2 / 545.0 ms |                      212.4 / 211.7 ms |
| Distinct targets with one tracked branch |                  791.8 / 790.2 ms |                      435.2 / 448.0 ms |

A separate full benchmark ran three alternating pairs per untracked fixture and measured three appends of 5,000 commits per run. All 12 first paints exceeded 500 ms. With the change, first paint ranged from 786.6 to 2,750.9 ms on distinct targets and 593.0 to 723.1 ms on the shared target. Thirteen of 18 appends met the 300 ms budget, compared with 14 of 18 on the baseline. Two candidate runs measured graph frame intervals of about 50 ms p95. The native command improvement has yet to translate into reliable desktop acceptance. [Individual opening and paging samples](m8-opening-experiments.csv)

## Working-state fingerprint on 100,000 files

Three alternating pairs of fresh Linux x64 Electron profiles measured the same two-million-commit checkout. Each run waited for the native watcher, warmed one status request, measured five clean requests, edited the fixture's tracked probe and measured five dirty requests. The harness restored the probe. Git was 2.53.0 and the OS caches stayed populated. A preceding baseline run exceeded 300 ms on one clean read at 316.8 ms.

| Status reads                            | Buffered index | Streamed index |
| --------------------------------------- | -------------: | -------------: |
| Median clean, 15 reads                  |       249.3 ms |       228.8 ms |
| Median dirty, 15 reads                  |       260.7 ms |       214.6 ms |
| Maximum across clean and dirty reads    |       410.3 ms |       314.1 ms |
| Reads below 300 ms                      |          28/30 |          29/30 |
| Edit visible in UI, range across 3 runs | 859.9–877.0 ms | 855.9–880.6 ms |

Each of the three paired runs had a lower median for both clean and dirty reads after streaming. The first streamed run missed the status budget on one dirty read. The other two passed every status check. All six external edits became visible within 1,500 ms. [Fingerprint compatibility](../decisions/0101-one-fingerprint-per-working-state.md#streaming-the-index-listing)

## Keyboard navigation with 32,000 loaded commits

On full Linux history, three alternating pairs compared `6933166` with `c8a5ec9` using fresh profiles. Each run loaded 32,000 commits. The first End/Home cycle warmed the handler, followed by ten measured cycles. Holding the scroll position fixed avoided prefetch during timing. The driver checked that End moved the selection offscreen and Home returned it to the first visible row.

| Key  | Baseline medians by pair | New medians by pair |
| ---- | -----------------------: | ------------------: |
| End  |      2.70, 2.60, 2.65 ms | 0.10, 0.10, 0.10 ms |
| Home |      1.40, 1.40, 1.45 ms | 0.10, 0.10, 0.10 ms |

These timings cover synchronous key dispatch. The separate 12,000-row Electron regression checked the visible selection and scroll behavior. The row-access regression at position 32,000 checks that Home and PageUp read no row objects and that Shift+Up inspects only the parent and its immediately preceding child in that fixture.

## Opening a bare repository with 50,000 distinct refs

On the 1,505,199-commit Linux fixture, a Git process trace captured a 517 ms cached diff against the entire HEAD tree despite the absence of an index. A separate trace showed two full watcher ref scans during startup. The updated app skips the diff when the bare index is absent, coalesces the initial ref checks when subscription completes promptly, and resolves HEAD while reading repository metadata. A trace of the resulting opening recorded one watcher scan and zero cached diffs.

| Isolated comparison                                | Measured pairs | Median before | Median after |
| -------------------------------------------------- | -------------: | ------------: | -----------: |
| Working state in the bare repository               |              7 |      324.4 ms |      12.6 ms |
| Repository metadata in the bare repository         |             12 |       61.8 ms |      43.6 ms |
| Repository metadata in a working checkout          |             12 |       87.1 ms |      55.5 ms |
| Desktop first paint with the watcher change alone  |              6 |      869.8 ms |     809.0 ms |
| Desktop first paint with the metadata change alone |              6 |      911.6 ms |     895.2 ms |

The opening-only desktop runs alternated build order after one warm-up pair, used a fresh profile each time and checked the first 2,000 commits and the sidebar count. The watcher change improved four of six pairs and the metadata change improved five of six. In the separate paging benchmark, the bare-index change alone improved the first append in all three pairs. All nine appends on that build met 300 ms.

The full benchmark compared all three changes at `d88934f` with `39a186d`. First paints increased in every pair, from 1,600.9, 850.1 and 869.5 ms to 2,212.7, 1,017.5 and 1,035.5 ms. The first 5,000-commit append improved in every pair, from 584.2, 357.0 and 323.9 ms to 471.0, 250.4 and 262.9 ms. Six of nine appends met 300 ms. The single-ref control painted in 857.2 ms and all three appends met budget. These runs shared the host with other development processes and retained the OS cache. Every first paint exceeded the 500 ms gate. [Individual opening and paging samples](m8-opening-experiments.csv)

After the suites finished, three further fresh-profile runs on each fixture measured the final app. The two-million-commit, 100,000-file checkout painted in 1,146.5, 470.9 and 383.6 ms. All nine appends met 300 ms. The 50,000-distinct-ref fixture painted in 805.1, 900.2 and 805.4 ms. Eight of its nine appends met budget, with one at 356.2 ms. Both fixtures scrolled at 16.7–16.8 ms p95. All 17,000 persisted commit IDs and parent lists also matched native Git in a separate packaged run on the distinct-ref fixture. [Final control samples](m8-opening-experiments.csv)

## Extending a persisted window from 12,000 to 17,000 commits

A Linux x64 replay used the first 17,000 commits of the full Linux fixture. Their order and parents matched native Git. Each run flushed the first 12,000 records, appended the final 5,000 and timed that second flush. The reopen variant created a new cache instance and accepted the persisted pages before the timed append. Each variant ran six measured pairs in alternating build order after one warm-up pair. Every final cache file matched the previous writer byte for byte. [Individual timings and bytes replaced](m8-history-cache-append-samples.csv)

| Starting state             | Previous median | New median | Files replaced |         Bytes replaced |
| -------------------------- | --------------: | ---------: | -------------: | ---------------------: |
| Same cache instance        |        198.3 ms |    54.0 ms |          4 → 1 | 24,501,310 → 6,492,122 |
| Reopened persisted history |        192.5 ms |    52.7 ms |          4 → 1 | 24,501,310 → 6,492,122 |

In a separate packaged Linux x64 run, the app opened 12,000 commits, switched repositories and restarted. Paging the source to 17,000 commits and switching again preserved the inode and modification time of its three filled files. The fourth file grew to contain the last 5,000 commits. Both repositories’ stored histories matched Git, and another restart replayed all 17,000 source records.

On fresh Electron opens at `30851f3`, the single-ref fixture painted in 348.4 ms and the 50,000-distinct-target fixture in 728.9 ms. The six 5,000-commit appends took 180.6–271.7 ms. The large-ref opening still exceeds the 500 ms target. The cached-append replay above measures storage work separately from these desktop timings.

## Switching with 17,000 commits loaded

Each paired Linux x64 run opened the single-ref Linux fixture in a fresh profile, loaded 17,000 commits and switched to the same 1,505,199-commit history with 50,000 refs. Before switching, the final source cache page had yet to reach disk. After switching, every one of the 17,000 saved IDs and parent lists matched Git, and the destination appended 5,000 commits. Three pairs per fixture alternated build order. The host used Git 2.53.0, a prepared commit-graph and uncleared OS caches. [Individual switch samples](m8-opening-experiments.csv)

| Change                                                                   | Distinct ref targets, median switch paint | 500 interleaved targets, median switch paint |
| ------------------------------------------------------------------------ | ----------------------------------------: | -------------------------------------------: |
| Start the previous cache flush during destination reads                  |                        1,109.1 → 950.6 ms |                           1,047.5 → 931.0 ms |
| Encode each cache batch once, with the overlapping flush already enabled |                      2,504.1 → 2,197.6 ms |                           1,045.3 → 983.8 ms |

Both changes reduced switch time in each of their six pairs. Absolute timings differed substantially between cohorts. Several destination appends in the second cohort also exceeded 300 ms, on both builds. The cause of the variation was not isolated. In a separate eight-pair replay of the same 17,000 commits, median time to write all four cache files fell from 292.6 to 198.6 ms. Every byte, including all four stored digests, matched the original format. [Cache write samples](m8-history-cache-write-samples.csv)

The repository benchmark at `a0fd141` measured one run per condition. Switching from 17,000 commits to distinct and interleaved targets took 805.8 and 768.6 ms respectively. Switching back to a previously cached single-ref repository took 482.3 ms. Fresh opens took 716.6 ms with 50,000 distinct refs and 346.5 ms with one ref. All 15 appends met 300 ms (134.5–282.3 ms), and graph frame intervals were at most 16.8 ms p95. Use `OPENKRAKEN_BENCH_FROM_REPO` for the source and `OPENKRAKEN_BENCH_REPO` for the destination. Setting `OPENKRAKEN_BENCH_WARM=1` also primes the destination and restarts the app before loading the source. [Final benchmark samples](m8-opening-experiments.csv)

### Capturing the initial watcher baseline

A separate prototype replaced the watcher's captured reference lines with a flat array of immutable fields. Across 12 alternating replay pairs per fixture, median capture time fell from 4.9 to 0.9 ms on distinct targets and from 4.6 to 0.9 ms on interleaved targets. The captured baseline occupied approximately 1.2 MB of V8 heap after GC, down from 6.9 MB. Hashing it at the first check took approximately 23 ms, up from 20 ms. Every watcher domain hash matched. On the desktop, first paint took longer in five of six pairs. Its medians rose from 683.8 to 710.7 ms on distinct targets and from 616.6 to 630.2 ms on interleaved targets. The application retains its existing watcher capture. [Opening samples](m8-opening-experiments.csv)

## Filtered history and graph worker input

Three alternating pairs per view compared `54a10fe` with a prototype that started a filtered history walk while the sidebar read authoritative refs. Each run opened a fresh profile on the same 1,505,199-commit Linux history with a prepared commit-graph, Git 2.53.0 and uncleared OS caches.

| Fixture and saved view                             | Median first paint, baseline → prototype | Median native snapshot, baseline → prototype |
| -------------------------------------------------- | ---------------------------------------: | -------------------------------------------: |
| 50,000 distinct targets, 10,000 hidden tags        |                         819.0 → 749.4 ms |                             444.4 → 395.2 ms |
| 50,000 refs across 500 targets, 10,000 hidden tags |                         667.4 → 672.8 ms |                             308.0 → 313.1 ms |
| 50,000 distinct targets, solo current branch       |                         645.4 → 632.7 ms |                             347.2 → 297.8 ms |

All three distinct-target hidden-view pairs improved first paint. Two of three hidden-view pairs with repeated targets took longer. The shipped code keeps the ordinary hidden-view walk on a repeated-target sample. The solo prototype queried Git for the ref name and ID. The shipped current-branch shortcut starts with the already opened HEAD. All 18 experimental opens exceeded 500 ms. All 54 appends met 300 ms. [Individual timings](m8-opening-experiments.csv)

The worker input experiment compared builds based on `683a37a` in three alternating pairs per fixture. Sending only topology and search fields reduced the median 5,000-commit worker phase from 54.3 to 48.0 ms on distinct targets and from 70.1 to 65.7 ms on a single ref. Median end-to-end append fell from 199.9 to 187.8 ms on distinct targets and rose from 193.6 to 207.4 ms on the single ref. Median first paints were 695.5 → 698.7 ms and 336.6 → 326.8 ms respectively. The JSON representation of the fixed replay input shrank from 3,891,476 to 3,577,342 bytes on open and from 7,506,072 to 6,719,951 bytes on append. These byte counts describe the records used in the replay. Chromium uses structured cloning for the actual transfer. [Individual timings](m8-opening-experiments.csv)

The final app at `25dd0cb` ran the repository benchmark without concurrent suites. On 50,000 distinct targets, the ordinary view took 686.1 ms to paint, hiding 10,000 tags took 781.5 ms and soloing the current branch took 673.9 ms. Hiding 10,000 tags on interleaved targets took 694.5 ms. The single-ref control took 852.4, 341.6 and 338.8 ms across three fresh profiles. Its slow first run spent 619.9 ms in the native snapshot. All 21 appends met 300 ms (166.9–264.2 ms), and graph frame intervals reached at most 16.8 ms p95. Set `OPENKRAKEN_BENCH_SOLO_REF=refs/heads/master` to reproduce the solo view on this fixture. [Final run samples](m8-opening-experiments.csv)

## Transferring the opening snapshot’s commit bodies

The renderer now receives the first 2,000 commit messages as an ordered array alongside JSON metadata. A captured first page from full Linux history contained 2,945,781 bytes of unescaped UTF-8 message text. The complete snapshot JSON was 3,860,347 bytes with one ref and 7,370,328 bytes with 50,000 distinct refs. [Snapshot format](../decisions/0115-history-page-response.md#opening-snapshots)

Three pairs per fixture alternated the existing and new formats in fresh Electron profiles on Linux x64 with Git 2.53.0, a prepared commit-graph and populated OS caches. Both variants used the same Git utility and the same 1,505,199-commit history. The first-paint measurement includes repository open, native enumeration, transfer, layout and display. The separate IPC replay used the same validated snapshot in memory for both formats, a sandboxed renderer and the production encoding and decoding functions. Ten alternating pairs per fixture followed a warm-up pair. Each replay checked a digest over every decoded field outside the timed interval.

| Reference targets                  | Median first paint, JSON → split bodies | Median IPC replay through ref expansion, JSON → split bodies |
| ---------------------------------- | --------------------------------------: | -----------------------------------------------------------: |
| 50,000 distinct                    |                        734.8 → 735.5 ms |                                               68.7 → 53.1 ms |
| 500 interleaved across 50,000 refs |                        671.3 → 639.6 ms |                                               66.8 → 51.1 ms |
| One ref                            |                        410.4 → 339.3 ms |                                               34.1 → 12.2 ms |

The split format completed the IPC replay faster in all 30 pairs. All 12 large-ref openings exceeded 500 ms. The three single-ref openings with the split format took 336.1–350.9 ms. The slowest single-ref baseline spent 587.5 ms in its native snapshot alone. Of 27 measured page appends per build, all 27 baseline appends and 25 with the new opening format met 300 ms. The two misses, 396 and 414 ms, occurred in the same single-ref run, which also recorded a 33.4 ms graph frame interval p95. [Opening and paging samples](m8-opening-experiments.csv) · [IPC replay samples](m8-snapshot-body-replay.csv)

The final application at `e0e8be1` ran the unchanged graph benchmark three times per fixture with fresh profiles. The distinct-target first paints took 750.5, 703.4 and 728.2 ms. Interleaved targets took 637.4, 626.3 and 611.6 ms. The single-ref fixture took 896.8, 340.3 and 372.3 ms. All 27 appends met 300 ms and graph frame intervals stayed at or below 16.8 ms p95. [Final runs](m8-opening-experiments.csv)

A separate renderer experiment froze the decoded snapshot and display rows while the worker computed the initial layout. Median state-publication time dropped from 20.3 to 7.9 ms on distinct targets and from 23.6 to 10.3 ms on interleaved targets. Median first paint increased from 709.0 to 755.4 ms and from 652.3 to 676.2 ms respectively. Production retains its existing freeze scheduling. [Timing samples](m8-opening-experiments.csv)

## Cache-key timing on the opening path

A trace of a fresh open on the distinct-target fixture put about 330 ms between starting reference enumeration and receiving the full records. Preparing and dispatching the compact ref message took another 31 ms. After that, about 48 ms elapsed before the service adopted the early cursor and its ready first page. The following experiments used a separate uninstrumented app for each variant, the same renderer, fresh profiles and uncleared OS caches. The baseline was `b674110` on Linux x64 with an Intel Core i7-9750H and Git 2.53.0. Each fixture had 1,505,199 commits, 50,000 refs and a prepared Git commit-graph. [Individual measurements](m8-opening-experiments.csv)

| Experiment                                                 | Reference targets | Median first paint, baseline → candidate | Median native snapshot, baseline → candidate |
| ---------------------------------------------------------- | ----------------- | ---------------------------------------: | -------------------------------------------: |
| Reuse verified early roots and their precomputed cache key | 50,000 distinct   |                         706.2 → 765.1 ms |                             356.8 → 357.4 ms |
| Reuse verified early roots and their precomputed cache key | 500 interleaved   |                         648.9 → 645.9 ms |                             240.4 → 234.3 ms |
| Compute the key at first cache access                      | 50,000 distinct   |                         735.5 → 733.9 ms |                             366.4 → 352.0 ms |
| Compute the key at first cache access                      | 500 interleaved   |                         623.5 → 652.2 ms |                             242.7 → 237.3 ms |

Each row summarizes three alternating pairs. Every opening missed 500 ms. All 72 measured appends of 5,000 commits met 300 ms and graph and sidebar frame intervals reached at most 16.8 ms p95. The early-root approach slowed first paint on the distinct-target fixture in all three pairs. Deferring the key shortened the native snapshot in all three distinct-target pairs, but it slowed first paint in all three interleaved pairs. The production cache retains its existing fingerprint computation.

## Parallel object-type lookup

On the 50,000-distinct-target fixture, a prototype read names and upstream metadata with `for-each-ref` and resolved object types in two parallel `cat-file --batch-check` processes. Five native-only pairs produced identical ordered ref records and reduced median lookup from 214.5 to 172.8 ms. With the same prototype on the Electron opening path, median native snapshot time increased from 336.0 to 411.0 ms and median first paint increased from 694.0 to 774.1 ms. The prototype was slower in all three desktop pairs. All 18 appends met 300 ms. Production continues to use the existing ref reader. [Individual desktop runs](m8-opening-experiments.csv)

## Transferring Canvas rows from the graph worker

The baseline at `18f0ef4` cloned the row and edge objects. The worker in `63a7e8e` transfers two typed buffers and the renderer reconstructs those objects. The benchmark used fresh Electron profiles, a Git commit-graph, uncleared OS caches and the same Linux x64 host. Each fixture had 1,505,199 reachable commits and 50,000 refs. Three pairs alternated build order. Each opening painted 2,000 commits and appended three pages of 5,000. The harness checked the active renderer path and bundle name before opening the repository.

| Reference targets       | Median worker phase, before → after | Median full page, before → after | Full page range after | Median first paint, before → after |
| ----------------------- | ----------------------------------: | -------------------------------: | --------------------: | ---------------------------------: |
| 50,000 distinct commits |                      74.6 → 59.2 ms |                 228.2 → 208.7 ms |        167.0–259.6 ms |                   729.6 → 733.2 ms |
| 500 interleaved commits |                      81.7 → 70.6 ms |                 209.6 → 211.8 ms |        189.3–235.0 ms |                   620.6 → 632.2 ms |

The worker phase includes projection, dispatch, layout and receipt in the renderer. All 18 appends in each build passed the 300 ms budget. Every opening missed the 500 ms budget. Graph and sidebar p95 frame intervals were at most 16.8 ms in both builds. The full-page median on the interleaved fixture increased by 2.2 ms despite the lower worker time. [All paired runs](m8-layout-transfer-samples.csv)

The final Linux x64 build with timeout recovery also ran against two smaller ref sets. Each opening used a fresh app profile. The synthetic checkout has 100,000 tracked files and 2,000,000 commits reachable across both branches, of which 1,999,999 are reachable from HEAD. Each fixture missed first paint on its first run and passed on its next two. Every append passed. Graph p95 frame intervals were 16.7–16.8 ms, and the renderer mounted at most 32 rows.

| Fixture                     | Run | First paint (ms) | Three successive 5,000-commit appends (ms) |
| --------------------------- | --: | ---------------: | ------------------------------------------ |
| Full Linux, one ref         |   1 |            900.0 | 196.2 / 183.3 / 173.9                      |
| Two-million-commit checkout |   1 |          1,148.5 | 145.0 / 134.9 / 114.1                      |
| Full Linux, one ref         |   2 |            350.3 | 263.1 / 190.2 / 198.2                      |
| Two-million-commit checkout |   2 |            291.1 | 158.3 / 149.6 / 113.4                      |
| Full Linux, one ref         |   3 |            354.3 | 268.5 / 189.5 / 174.8                      |
| Two-million-commit checkout |   3 |            315.3 | 185.8 / 142.7 / 114.7                      |

## Renderer heap for commits with one reference

The graph used to allocate a badge list for every target when opening a repository. It now holds a single ref directly until a row needs its list. Additional refs at the same target still form an ordered list. Four alternating pairs of fresh Electron profiles opened 2,000 commits from full Linux history with 50,000 distinct targets. After first paint, Chromium collected garbage and reported live renderer JavaScript heap through CDP.

| Pair | Previous renderer heap (bytes) | New renderer heap (bytes) |
| ---: | -----------------------------: | ------------------------: |
|    1 |                     31,063,484 |                29,398,944 |
|    2 |                     30,838,556 |                29,444,584 |
|    3 |                     31,067,172 |                29,399,104 |
|    4 |                     31,065,096 |                29,386,836 |

In a separate Node probe, five fresh-process pairs built the index from the same native refs and accessed the first 50 targets. Median added heap for 50,000 distinct targets fell from 4,328,216 to 1,533,216 bytes. For 500 interleaved targets it rose from 315,720 to 330,064 bytes. For a single shared target it rose from 113,608 to 124,192 bytes. Traversing every group after the measurement produced identical ordered ref-name and target digests.

The desktop timing comparison used the same Git utility for both renderers. Distinct-target median first paint changed from 822.5 to 783.2 ms in three pairs. The interleaved median rose from 624.0 to 662.5 ms in three pairs. One shared-target pair measured 603.8 and 582.7 ms. All 14 openings missed 500 ms and two of 21 candidate page appends missed 300 ms. The change reduced heap on the distinct fixture. The timing samples do not establish a general opening speedup. [Individual timings](m8-badge-index-pairs.csv)

## Interleaved reference targets

The Linux x64 fixture cycled 50,000 packed refs through 500 commits in name order, keeping master at the original Linux HEAD. The previous 8 KiB scheduling sample saw distinct targets and requested the type of each ref from Git. A second read can now extend the sample to 256 KiB. On this fixture, the resulting reader resolved each of the 500 types once and matched full Git enumeration for every ordered record. Git 2.38.0 and 2.53.0 also matched on 50,000 distinct targets, 500 targets grouped contiguously and one shared target.

Fresh Electron profiles opened 2,000 commits from 1,505,199 reachable commits with warm OS caches. The benchmark alternated the previous and new Git utilities. Each run appended three pages of 5,000 commits.

| 50,000 references       | Pairs | Median first paint before | Median first paint after | Median native snapshot before | Median native snapshot after |
| ----------------------- | ----: | ------------------------: | -----------------------: | ----------------------------: | ---------------------------: |
| 500 interleaved targets |     3 |                  846.6 ms |                 647.7 ms |                      442.8 ms |                     229.8 ms |
| Distinct targets        |     3 |                  779.7 ms |                 735.2 ms |                      391.0 ms |                     360.1 ms |
| One shared target       |     1 |                  585.1 ms |                 540.3 ms |                      222.9 ms |                     207.7 ms |

All three interleaved openings improved. All 14 openings exceeded 500 ms. Three of 21 candidate appends exceeded 300 ms. Graph and sidebar scrolling were 16.7–16.8 ms p95 throughout. The distinct and shared fixtures retained their previous Git query strategy. [Individual measurements](m8-interleaved-ref-samples.csv)

A separate disposable experiment ran a Git revision walk without traversal in parallel with reading ref names and upstreams. It verified that every one of the 50,000 distinct targets occurred in Git’s commit output. Over four alternating fresh-profile pairs, median first paint changed from 757.9 ms to 778.8 ms. The application keeps its original distinct-target reader.

## Memory retained during native ref enumeration

Three paired native reads of the 50,000-distinct-target fixture each received 4,009,992 bytes from Git. A probe kept a weak reference to each stdout buffer, yielded to the event loop and forced GC after the native process finished but before the reader continued. At that point all 4,009,992 bytes were still reachable in each baseline run (`65d63dd`), and zero stdout bytes were reachable in each candidate run (`0714557`). The probe used fresh Node 24.22.2 processes in alternating order. This measures reachable input buffers at one point in the Git utility. Parsed refs still occupy memory.

Fresh Linux x64 Electron profiles then opened full Linux history with Git 2.53.0 and warm OS caches. Each fixture has 1,505,199 reachable commits. Each row is a single opening.

| Fixture                      | First paint | Three 5,000-commit appends | Graph scroll p95 |
| ---------------------------- | ----------: | -------------------------- | ---------------: |
| One ref                      |    365.9 ms | 253.9 / 208.6 / 177.9 ms   |          16.7 ms |
| 50,000 distinct targets      |    705.2 ms | 250.6 / 199.7 / 189.2 ms   |          16.8 ms |
| 50,000 refs sharing a target |    494.8 ms | 207.0 / 194.5 / 168.8 ms   |          16.7 ms |

The distinct-target opening missed the 500 ms gate. The shared-target run met it once. The earlier three-run shared-target median was 564.7 ms. All nine appends met 300 ms. [Streaming validation decision](../decisions/0098-direct-first-reference-enumeration.md#streaming-utf-8-validation)

## Repeated targets and the first watcher check

Three alternating pairs per fixture compared `42b4423` with `a8e90ba` on Linux x64, Git 2.53.0 and an Intel Core i7-9750H. Each fresh Electron profile opened the same 2,000 commits from full Linux history and appended three 5,000-commit pages. OS caches were retained. The two apps used the same renderer asset and physically separate main and Git utility bundles. Each opening checked the renderer URL and asset.

| 50,000 refs      | Native snapshot before | Native snapshot after | First paint before | First paint after |
| ---------------- | ---------------------: | --------------------: | -----------------: | ----------------: |
| Distinct targets |               360.7 ms |              365.3 ms |           737.2 ms |          712.8 ms |
| 500 targets      |               289.8 ms |              204.3 ms |           662.0 ms |          528.2 ms |
| One target       |               253.5 ms |              203.0 ms |           627.0 ms |          564.7 ms |

All values in the table are medians. All eighteen openings exceeded 500 ms. The combined build had 26 of 27 appends under 300 ms. The first append on the third distinct-target run took 301.6 ms. All 27 baseline appends passed. Graph and sidebar scrolling measured 16.7–16.8 ms p95. [Individual openings and appends](m8-repeated-target-samples.csv)

Two additional comparisons isolated the changes. With the new Git reader alone, median first paint changed from 671.2 to 591.6 ms for 500 targets, from 597.3 to 558.8 ms for one target and from 726.8 to 746.8 ms for distinct targets. A disposable utility then compared eager watcher hashing with capturing the opening values and hashing them on the first active check. This shortened first paint in all twelve pairs across the three fixtures. The native regression changes a tag between capture and comparison while also mutating the returned snapshot, and verifies that the watcher reports the tag change. [Native reader](../decisions/0098-direct-first-reference-enumeration.md#repositories-with-many-refs-pointing-to-the-same-objects) · [Watcher capture](../decisions/0104-snapshot-reference-watcher-baseline.md#hashing-a-large-opening-snapshot-at-the-first-check)

Git 2.38.0 and 2.53.0 each produced the same 50,000 complete ordered records as full native enumeration on all three fixtures. When the distinct fixture was deliberately given the repeated-target hint, the reader fell back to direct enumeration and matched every record. The SHA-256 native fixture also covered per-worktree HEAD, upstream tracking, annotated and Unicode tags, tree and blob targets, replacements, output limits, cancellation, incomplete or failed batch reads and a tag moving during lookup.

A separate disposable build serialized the staged reference array to JSON in the utility and parsed it before the existing main-process validation. Across four alternating pairs per fixture, median first paint changed from 740.6 to 733.9 ms for distinct targets, from 554.4 to 563.5 ms for 500 targets and from 584.2 to 562.5 ms for the shared target. The production transfer still uses the validated array.

Separate openings of the full Linux history with one ref took 424.6, 362.1 and 345.4 ms. The two-million-commit, 100,000-file checkout took 287.2, 326.1 and 316.8 ms. All eighteen appends on those six openings passed. On an earlier opening with the grouped reader alone, the same synthetic checkout took 1,123.2 ms, including 916.6 ms in the native snapshot. Three fresh profiles on the final build completed all 30 watcher-warm clean and dirty status reads in 198.6–248.2 ms.

The shared-target repository with 17,000 cached commits took 543.2 ms to reopen. On the distinct-target repository with 10,000 saved hidden refs, first paint took 879.4 ms and the first append took 308.9 ms. The other five appends across those two openings passed.

## Reference sidebar measurements and commit badge grouping

Three alternating pairs per fixture compared `93d1b05` with `d648174` on Linux x64 using Git 2.53.0 and an Intel Core i7-9750H. Both builds used the same main process and Git utility. Each fresh profile opened 2,000 commits from full Linux history and appended three 5,000-commit pages. The harness checked the renderer file URL and the loaded JavaScript asset for each build. The OS caches remained populated.

| 50,000 refs      | Median first paint before | Median first paint after | Store publication to paint before | Store publication to paint after |
| ---------------- | ------------------------: | -----------------------: | --------------------------------: | -------------------------------: |
| Distinct targets |                  734.5 ms |                 733.6 ms |                          114.7 ms |                          97.7 ms |
| 500 targets      |                  689.1 ms |                 678.4 ms |                          125.5 ms |                         103.5 ms |
| One target       |                  674.9 ms |                 634.5 ms |                          146.2 ms |                         101.3 ms |

The time from store publication to first paint fell in all nine comparisons. Five of nine full openings improved, and all eighteen exceeded 500 ms. All 54 page appends met 300 ms. The candidate's appends took 179.1–278.9 ms and graph and sidebar scrolling measured 16.7–16.8 ms p95. Eight reference controls were mounted in the candidate's resting viewport and six in the baseline. [Raw samples](m8-sidebar-block-samples.csv) · [Sidebar measurement](../decisions/0094-bounded-reference-sidebar.md#measuring-several-refs-together)

A separate renderer comparison retained the first real, validated snapshot response in the test main process and delivered it on the next open in the same fresh profile. Each timed open still parsed the response, computed the worker layout, published the store and rendered the graph and sidebar. Every run verified the 2,000-commit count, 50,000-ref count and renderer bundle. Across five alternating pairs per fixture, median replay time fell from 284.2 to 256.2 ms for distinct targets and from 262.6 to 228.6 ms for a shared target. All ten pairs improved. These replay times exclude native repository opening.

An eight-row prototype shortened the publication-to-paint phase in nine of nine native pairs and mounted fifteen refs. Four refs per section block shortened that phase in eight of nine pairs and mounted eight. Deferring the first measurement of individual rows to ResizeObserver shortened the paint phase in five of ten replay pairs. The shipped sidebar groups four refs together. Badge grouping also avoids constructing a map key for every undisplayed label. An isolated Node comparison checked the full and capped badge records across the first 32 visible commits. With 50,000 refs on one commit, the median three-badge preview took 7.57 ms before and 1.23 ms after. [Badge behavior](../decisions/0113-visible-commit-badges-and-reference-row-heights.md)

Separate fresh-profile openings painted single-ref Linux history in 370.9 ms and the two-million-commit, 100,000-file checkout in 307.2 ms. The shared-target Linux repository reopened with 17,000 cached commits in 666.8 ms. Opening the distinct fixture with 10,000 saved hidden refs took 887.4 ms. All twelve appends met 300 ms.

## Reading object types for unique reference targets

A diagnostic compared three native reads of the same 50,000 refs on full Linux history. The direct read used the six-field production format. The other reads enumerated the identities and upstream fields, then used one buffered Git batch request for the type of each unique object. The serial reader waited for all identities. The pipelined reader wrote new IDs to the batch as they arrived. Six trials per reader and fixture rotated execution order with populated OS caches. Every reconstruction matched the SHA-256 digest of the complete ordered direct records.

A separate Electron experiment used fresh profiles and the production renderer. A disposable Git utility used the pipelined reader only for the three known fixtures. It checked all 50,000 results for commit type and the expected unique-target count. Each run verified the app path, renderer asset, 2,000 loaded commits and 50,000 displayed refs. Four pairs per fixture alternated the order of the two utilities.

| Fixture          | Native direct | Native serial | Native pipelined | Desktop direct paint | Desktop pipelined paint |
| ---------------- | ------------: | ------------: | ---------------: | -------------------: | ----------------------: |
| Distinct targets |      190.0 ms |      221.9 ms |         156.1 ms |             771.0 ms |                787.8 ms |
| 500 targets      |      195.5 ms |       98.5 ms |          95.5 ms |             675.2 ms |                589.9 ms |
| One target       |      155.5 ms |       95.5 ms |          87.9 ms |             637.5 ms |                583.8 ms |

Values are medians. All eight repeated-target pairs painted sooner, and all 24 openings exceeded the 500 ms budget. On the distinct fixture the native read improved while median end-to-end time increased. The shipping reader still uses the direct Git format. The next candidate is a read of unique object types for repositories with many repeated targets. [Individual trials](m8-ref-type-probe.csv)

A separate direct-metadata comparison used Git 2.38.0 and 2.53.0 on SHA-1 and SHA-256 repositories. It reproduced the six native fields byte for byte for loose refs, packed refs and a cross-type replacement, including a tracked branch, symbolic remote HEAD, Unicode name and annotated tags pointing to commits, a tree, a blob and another tag. These static comparisons cover direct metadata. A production implementation still needs to preserve peeled tag details and handle concurrent changes, cancellation, missing objects and output limits.

## Validating refs before the first page is ready

Three alternating pairs per fixture compared the previous one-message Git utility (`d00f8a7`) with the staged transfer in `38213be`. Each opened 2,000 commits from the same full Linux history in a fresh Electron profile and appended three pages of 5,000. The benchmark used Linux x64, Git 2.53.0 and an Intel Core i7-9750H, with populated OS caches and no concurrent build or test suite. Both used the same renderer. The benchmark's app directory pointed to the main and utility bundles under test.

| 50,000 refs      | Median response before | Median response after | Median first paint before | Median first paint after |
| ---------------- | ---------------------: | --------------------: | ------------------------: | -----------------------: |
| Distinct targets |               572.7 ms |              523.4 ms |                  789.7 ms |                 751.1 ms |
| 500 targets      |               514.2 ms |              466.8 ms |                  721.9 ms |                 686.7 ms |
| One target       |               449.8 ms |              429.7 ms |                  682.3 ms |                 667.4 ms |

Eight of nine comparisons improved first paint. The third shared-target pair measured 682.3 ms before and 686.5 ms after. Every opening exceeded the 500 ms target. All 54 appends met 300 ms, and both graph and sidebar scrolling stayed at 16.7–16.8 ms p95. [All eighteen openings](m8-staged-snapshot-samples.csv) · [Transfer and cancellation semantics](../decisions/0116-validated-snapshot-references.md#validate-references-while-opening-a-repository)

Before the change, six instrumented openings isolated these median intervals on the distinct/shared fixtures, respectively. Reading the refs took 272.5/224.9 ms. Once refs were ready, finishing the native graph took 36.2/17.1 ms. Computing the watcher baseline took 31.2/44.1 ms. Posting the utility reply through its receipt in main took 49.2/36.6 ms, followed by 68.2/51.9 ms to validate it. Instrumentation ran in a temporary copy of the app. The paired measurements above used the normal bundles.

In separate fresh profiles, single-ref Linux history painted in 344.8 ms and the two-million-commit, 100,000-file checkout in 352.6 ms. Reopening full Linux history with 17,000 cached commits and 50,000 refs sharing one target took 720.8 ms. Opening it with 50,000 distinct targets and 10,000 hidden refs took 876.7 ms. All twelve appends met 300 ms.

Six additional Electron openings sampled the renderer at 200 µs using CDP and hidden source maps. The mapped main JavaScript bundle matched the production bundle byte for byte. Between store publication and first paint, the sampled interval averaged 132 ms for distinct targets and 153 ms for the shared target. Self time in TanStack Virtual Core averaged 52.9 and 54.6 ms respectively. The history model accounted for 19.6 and 26.4 ms, and React DOM for 18.1 and 17.2 ms. Source-mapped stacks included sidebar measurement and per-commit ref grouping. These instrumented runs identify work remaining in the renderer. The timing table above uses separate uninstrumented runs.

## Transferring consecutive references

Three alternating pairs per fixture opened 2,000 commits of full Linux history in fresh Electron profiles on Linux x64. The OS caches stayed populated. Baseline used `31d5960`. The new build omitted repeated object IDs on the Git utility and renderer boundaries. Each opening appended three 5,000-commit pages. The grouped fixture borrowed the same Linux object store and distributed 50,000 refs across the first 500 commits from HEAD, with 100 refs per target. Git verified the target and ref counts before testing.

| 50,000 refs      | Baseline ref JSON |    New ref JSON | Median baseline first paint | Median new first paint |
| ---------------- | ----------------: | --------------: | --------------------------: | ---------------------: |
| Distinct targets |   3,510,101 bytes | 3,510,101 bytes |                    811.1 ms |               807.8 ms |
| 500 targets      |   3,310,100 bytes | 1,280,641 bytes |                    759.0 ms |               720.6 ms |
| One target       |   3,360,104 bytes | 1,310,186 bytes |                    741.3 ms |               698.6 ms |

All six comparisons with repeated targets improved first paint. All eighteen openings exceeded 500 ms. One new distinct-target append took 305.6 ms. The other 53 appends met 300 ms, and both scroll measurements stayed at 16.7–16.8 ms p95. The byte counts cover UTF-8 JSON for the reference array alone. A separate replay expanded both forms and compared every ordered ref against Git service output on all three fixtures.

Two earlier experiments each used three pairs on the shared and distinct fixtures. Sending a single shared target to main and reconstructing every object ID there moved shared-target median first paint from 708.0 to 735.6 ms. Keeping that single target through the renderer moved it from 720.9 to 702.6 ms. The shipped consecutive encoding also handles multiple targets in one snapshot. [All 42 paired openings](m8-ref-run-samples.csv) · [Wire format and compatibility](../decisions/0116-validated-snapshot-references.md#consecutive-refs-with-the-same-target)

## Reading tentative roots with rev-parse

Three paired fresh-profile openings per fixture compared the optional `git rev-parse --all` read with `git for-each-ref --format=%(objectname)`. Only the Git utility bundle changed. Each opening used the full Linux history on Linux x64 with populated OS caches and appended three pages of 5,000 commits.

| 50,000 refs      | Median snapshot before | Median snapshot after | Median first paint before | Median first paint after |
| ---------------- | ---------------------: | --------------------: | ------------------------: | -----------------------: |
| Distinct targets |               319.4 ms |              311.3 ms |                  802.5 ms |                 796.6 ms |
| Shared target    |               250.7 ms |              239.2 ms |                  759.0 ms |                 737.2 ms |

All twelve first paints exceeded 500 ms. Distinct-target snapshot time improved in all three pairs and first paint improved in one. Shared-target first paint improved in all three pairs. All 36 appends met 300 ms, with graph and reference scrolling at 16.7–16.8 ms p95. Git 2.38.0 and 2.53.0 passed the eleven native prefetch cases, including a loose branch and a detached HEAD reachable only through its direct object ID. [All paired measurements](m8-native-root-samples.csv) · [Root reconciliation](../decisions/0122-overlap-reference-and-history-reads.md)

## Preparing the display snapshot during worker layout

A renderer experiment sent the projected commits to the graph worker before expanding the compact refs and freezing the initial snapshot. It published the refs, graph and selection together. Three pairs of fresh Electron profiles per fixture alternated the baseline and experimental renderer with the same Git utility. The OS caches stayed populated.

| Linux history with 50,000 refs | Median first paint, baseline | Median first paint, experiment | Median state publication, baseline | Median state publication, experiment |
| ------------------------------ | ---------------------------: | -----------------------------: | ---------------------------------: | -----------------------------------: |
| Distinct targets               |                     817.3 ms |                       867.7 ms |                            34.5 ms |                              18.4 ms |
| One shared target              |                     749.6 ms |                       739.2 ms |                            32.6 ms |                              19.3 ms |

Moving the freeze earlier shortened the measured publication step in every pair. Distinct-target first paint regressed in two of three pairs. All twelve openings exceeded 500 ms. One baseline page took 305.1 ms and the other 35 appends met 300 ms. The production renderer retains its previous scheduling. [All opening, paging and scroll measurements](m8-renderer-preparation-samples.csv)

## Overlapping reference enumeration and history

Three paired Linux x64 openings per fixture switched only the Git utility bundle between baseline `8d2c620` and the overlapping walk. Each opening used a fresh app profile and populated OS caches, with a single Electron worker. The order was baseline first in pairs one and three and candidate first in pair two. Both fixtures borrow the same full Linux history. Each has 50,000 refs. [All twelve openings and 36 page appends](m8-history-prefetch-samples.csv)

| Ref targets     | Median snapshot before | Median snapshot after | Median first paint before | Median first paint after |
| --------------- | ---------------------: | --------------------: | ------------------------: | -----------------------: |
| 50,000 distinct |               414.6 ms |              319.5 ms |                  893.8 ms |                 793.5 ms |
| One shared      |               262.2 ms |              244.0 ms |                  783.5 ms |                 739.5 ms |

All six paired comparisons improved first paint. Every large-ref opening still exceeded 500 ms. The first append on distinct targets took 265.5–281.6 ms with the new walk and 190.5–298.6 ms on baseline. One of the eighteen new appends exceeded 300 ms, at 327.5 ms on shared targets. Graph and sidebar scrolling measured 16.7–16.8 ms p95 throughout.

One separate opening of full Linux history with a single ref painted in 330.4 ms and appended pages in 261.3, 206.6 and 196.1 ms. After priming the history cache and reopening the distinct-target fixture, first paint took 809.9 ms and appends took 259.0, 269.8 and 217.2 ms. These runs exercise paths that skip the optional walk. [Scheduling and cursor adoption](../decisions/0122-overlap-reference-and-history-reads.md)

## Graph selection and reference sidebar measurements

Three alternating pairs opened full Linux history in fresh Electron profiles on Linux x64. Each loaded 32,000 commits and dispatched End and Home eleven times each to the focused grid. The viewport was held still to prevent automatic paging. The following medians cover the ten cycles after the first. They measure synchronous dispatch through the renderer's keyboard handler. A separate 12,000-row desktop regression uses the real scroll behavior and checks the visible selection after End.

| Key  | Previous handler, medians by pair | Current handler, medians by pair |
| ---- | --------------------------------: | -------------------------------: |
| End  |             20.2 / 20.6 / 22.6 ms |               3.0 / 3.0 / 2.9 ms |
| Home |                2.9 / 3.1 / 3.0 ms |               1.7 / 1.7 / 1.6 ms |

Selecting a commit now reads the loaded rows from the current store snapshot and writes the resulting selection in an Immer update. The previous implementation created draft proxies as it searched the rows. Range selection across an appended page and cancellation of superseded keyboard jumps have store-level coverage.

A separate startup experiment removed per-reference row wrappers from the virtual sidebar. Three paired openings per fixture used the same Git utility, fresh profiles and populated OS caches. With 50,000 distinct targets, median first paint went from 904.0 to 915.6 ms. With 50,000 refs at one target it went from 763.6 to 802.7 ms. The production sidebar retains the existing row model. All twelve openings missed 500 ms. Two of the 36 appends missed 300 ms, at 306.6 and 364.3 ms. Each opening mounted six sidebar rows and both lists scrolled at 16.7–16.8 ms p95. [Paired startup measurements](m8-sidebar-row-samples.csv)

A diagnostic build timed the native and IPC work separately on the same fixtures. In three distinct-target openings, reference enumeration and its concurrent prerequisites took 200–249 ms. Preparing and reading the first native history page then took another 193–231 ms. Main took 56–85 ms to validate the utility reply. On the shared target those three intervals were 170–190, 92–97 and 46–53 ms. The diagnostic marks were confined to a temporary copy of the app. The production measurements above used the normal build.

## Compact reference validation experiment

A validator that checked the object ID and namespace directly in the wire string took 13.2 ms median to check 50,000 refs in a Node replay, compared with 18.9 ms for the existing validator. The replay used fresh JSON-decoded strings and collected garbage before each timed pass. Two initial rounds were discarded.

Three paired Electron openings per fixture switched only the main bundle. Median first paint went from 785.9 to 750.4 ms on shared targets and from 871.1 to 891.7 ms on distinct targets. All twelve first paints exceeded 500 ms. One of the 36 page appends took 314.1 ms. In a separate instrumented set of three pairs per fixture, median main-process validation went from 58.5 to 57.6 ms on distinct targets and from 53.3 to 54.0 ms on the shared target. The original validator remains in production. Contract tests cover malformed SHA-1 and SHA-256 lengths, invalid hexadecimal characters and namespace prefix lookalikes. [Production and diagnostic samples](m8-compact-validation-samples.csv)

## Reading six fields for unpeeled references

The initial ref query omits two empty peeling fields. The parser also uses the known namespace length to extract each short name. On the full Linux history fixture with 50,000 distinct targets, native output shrank from 4,109,992 to 4,009,992 bytes. Replay in 64 KiB chunks returned the same 50,000 records in order. Across 32 alternating pairs with garbage collection before each run, median parsing took 38.5 ms before and 34.2 ms after. [Git format and coverage](../decisions/0119-reference-parser-and-scale-gates.md)

Three paired Electron openings per fixture switched only the Git utility. Each used a fresh profile, loaded 2,000 commits and appended three 5,000-commit pages. The OS caches stayed populated. Both fixtures used the same full Linux history at `46fec1c3029b552ec63b2d01af9d43a386f043ea` with Git 2.53.0 on Linux x64. [All samples](m8-direct-ref-samples.csv)

| 50,000 references | Previous median first paint | Six-field median first paint | Previous median Git snapshot | Six-field median Git snapshot |
| ----------------- | --------------------------: | ---------------------------: | ---------------------------: | ----------------------------: |
| Distinct targets  |                    925.0 ms |                     867.7 ms |                     400.9 ms |                      388.1 ms |
| Shared target     |                    781.9 ms |                     753.2 ms |                     293.8 ms |                      269.9 ms |

All twelve openings missed the 500 ms first-paint budget. The first shared-target baseline took 1,313.8 ms and the change was slower in one shared-target pair. All 36 page appends met 300 ms. The slowest took 289.9 ms.

A separate experiment sent up to 512 compact ref strings per block between the utility and main, then validated each row in main. On the distinct-target fixture, median first paint across four pairs rose from 872.7 to 903.3 ms. The time from opening to receipt, after subtracting Git snapshot preparation, increased in all four pairs. The app retains the existing IPC format.

## Time to receive and decode the snapshot

The Electron benchmark now times receipt of the snapshot string, JSON parsing and expansion of compact references separately. Six fresh-profile openings used the same 1,505,199-commit Linux history on Linux x64, Git 2.53.0 and Xvfb. The operating system caches were left populated. Each opening appended three 5,000-commit pages.

|   Refs | First paint (ms) | Snapshot ready in Git utility (duration, ms) | Response received since open (ms) | JSON parse (ms) | Ref expansion (ms) |
| -----: | ---------------: | -------------------------------------------: | --------------------------------: | --------------: | -----------------: |
|      1 |            320.4 |                                         89.3 |                             211.2 |            12.8 |                0.1 |
|      1 |            375.5 |                                         85.9 |                             247.7 |            17.3 |                0.2 |
|      1 |            340.0 |                                         92.0 |                             226.2 |            12.3 |                0.0 |
| 50,000 |            868.0 |                                        400.1 |                             651.3 |            16.6 |               14.0 |
| 50,000 |            896.6 |                                        429.3 |                             680.9 |            16.9 |               14.7 |
| 50,000 |            907.4 |                                        414.0 |                             663.5 |            19.1 |               16.7 |

With 50,000 distinct ref targets, the renderer received the serialized response 151.3–180.9 ms beyond the 500 ms first-paint deadline. Parsing and expanding it took a further 30.6–35.8 ms. The interval before receipt includes repository opening, Git snapshot preparation, watcher setup, validation and transfer. These measurements do not isolate those costs. All 18 appends passed 300 ms (178.8–276.4 ms) and graph scrolling p95 was 16.7–16.8 ms. The one-ref fixture passed all three first paints, and the large-ref fixture missed all three.

## Reading ancestry from Git's traversal header

The Git utility reads full object and parent IDs from the header emitted by the existing date-ordered `rev-list --parents` traversal. Search and stash queries use the same twelve-field parser with explicit IDs. Linux-history replay compared all fields of 17,000 ordered commits, including every body and parent, against the previous production parser. The streams occupied 22,615,101 and 21,207,090 bytes. Native octopus, shallow and replacement fixtures also compared every returned commit against the earlier Git format. [Protocol decision](../decisions/0002-git-protocol.md#decoding-the-graph-traversal-header)

In an isolated Node replay, 20 pairs alternated the old stream/parser and the new stream/parser, with garbage collection before each timing and 64 KiB input chunks. For the first 2,000 commits, median parsing took 18.3 ms before and 12.7 ms after. For the next 5,000 commits, it took 38.3 ms before and 26.7 ms after.

Three paired fresh-profile Electron openings per fixture switched only the Git utility bundle. Each opening loaded 2,000 commits, appended three pages of 5,000 and measured scrolling at 12,000 rows. The fixtures contained the same 1,505,199-commit Linux history. Pair order alternated on Linux x64 with Git 2.53.0 and Xvfb. OS caches were left populated. [All twelve openings](m8-history-stream-samples.csv)

| Fixture and measurement         | Previous utility | Traversal header |
| ------------------------------- | ---------------: | ---------------: |
| One ref, median first paint     |         374.0 ms |         376.8 ms |
| One ref, median page append     |         241.4 ms |         228.2 ms |
| 50,000 refs, median first paint |         968.7 ms |         973.7 ms |
| 50,000 refs, median page append |         213.1 ms |         212.1 ms |

The new utility passed all 18 paging checks at 185.4–298.9 ms. The previous utility missed once at 305.1 ms. Scroll p95 was 16.7–16.8 ms throughout. Both builds met 500 ms on each one-ref opening and missed on every 50,000-ref opening. In the three large-ref runs with the new utility, Git snapshot preparation took 451.9–469.9 ms. By the time the renderer received and decoded the snapshot, 751.4–777.8 ms had elapsed. The 500 ms budget was already exceeded before layout and painting.

## Publishing compact references to the repository store

Three paired Electron openings loaded 2,000 commits from full Linux history with 50,000 distinct reference targets. Each opening used a fresh profile on Linux x64 with Git 2.53.0 and Xvfb. Only the renderer bundle switched between runs. Pair order alternated, and the OS caches were left populated. [All twelve measurements, including the initial ordinary and large-ref cohorts](m8-compact-ref-publication.csv)

| Median in milliseconds           | Previous renderer | Freeze compact refs at decode |
| -------------------------------- | ----------------: | ----------------------------: |
| Renderer state publication       |              66.6 |                          30.9 |
| First paint, including Git reads |           1,037.2 |                         932.3 |

Publication was faster in every pair. End-to-end first paint improved in two pairs and rose from 1,037.2 to 1,141.9 ms in the third. All six missed the 500 ms target. All 18 page appends met 300 ms and all six scroll p95 measurements were 16.7–16.8 ms. An isolated Node replay constructed and published 50,000 flat refs through Immer in both orders across 18 pairs. Median combined construction and publication took 23.9 ms with recursive freezing and 10.9 ms with freezing at decode.

Before the paired test, three fresh-profile openings of the one-ref Linux repository painted in 1,105.2, 385.1 and 351.3 ms. Git service snapshot time accounted for 806.7 ms on the first opening. The three initial large-ref openings painted in 1,509.2, 912.6 and 1,035.6 ms. All 18 appends in those two cohorts met 300 ms. [Renderer decoding decision](../decisions/0116-validated-snapshot-references.md#publishing-compact-records-in-the-repository-store)

## Reading fixed-width ref records in batches

On the 1,505,199-commit Linux-history fixture with 50,000 distinct targets, direct native ref enumeration took 182–189 ms over four runs. Omitting object types in a diagnostic command reduced this to 78–89 ms. Walking 2,000 commits from all 50,000 pinned OIDs took 148–172 ms, compared with 64–89 ms from HEAD alone. These diagnostic commands used populated OS caches and a reduced history output format. The app still reads object types and walks the full set of visible roots.

Replaying the native ref stream in 64 KiB chunks took a median 59.1 ms with the original parser and 44.3 ms with batched decoding across 60 runs per parser. Three paired fresh-profile Electron openings with only the Git utility bundle switched gave the following results. Pair order alternated. Each opening loaded 2,000 commits and appended three 5,000-commit pages.

| Median in milliseconds | Original | Batched |
| ---------------------- | -------: | ------: |
| Utility snapshot       |    427.4 |   413.8 |
| First paint            |    915.9 |   904.7 |

The initial unpaired opening took 1,697.9 ms. One paired opening with the batched parser took 1,010.3 ms, slower than its control. All six paired openings missed 500 ms. All 18 pages passed 300 ms, and scroll p95 was 16.8 ms throughout. [Per-opening measurements](m8-ref-parser-samples.csv)

CI now also constructs two bare reference repositories from the synthetic scale checkout. Each borrows its source's objects and has 50,000 packed refs. One uses the same commit for every ref, the other uses 50,000 distinct commits reachable from HEAD. The generator verifies both counts with Git. On Linux x64, three fresh-profile first paints on the synthetic fixtures had medians of **636.5 ms shared** and **777.0 ms distinct**. All six missed 500 ms. All 18 page appends passed. Each fixture had 1,999,999 commits reachable from HEAD. The source checkout also contains a separate topic tip. [Generator and reproduction](../decisions/0119-reference-parser-and-scale-gates.md) · [Per-opening measurements](m8-ref-parser-samples.csv)

## Starting the layout worker during repository opening

Three paired fresh-profile Electron runs used 50,000 distinct reference targets and 1,505,199 reachable commits on Linux x64, Git 2.53.0 and X11 under Xvfb. Only the renderer bundle changed. The order was baseline/change, change/baseline and baseline/change. OS caches were left populated between runs.

| Measurement                     | Start after snapshot | Start during opening |
| ------------------------------- | -------------------: | -------------------: |
| Worker layout phase, median     |              44.7 ms |              33.5 ms |
| First paint, median             |             934.8 ms |             950.4 ms |
| First paints below 500 ms       |                  0/3 |                  0/3 |
| 5,000-commit pages below 300 ms |                  9/9 |                  9/9 |
| Graph scroll p95                |              16.8 ms |         16.7–16.8 ms |

The worker phase includes commit projection, messaging and layout. The first baseline utility snapshot took 1,299.3 ms, compared with 407.6–453.1 ms for the other five openings. The shorter median worker phase did not produce a shorter median first paint. [Per-run measurements](m8-graph-worker-samples.csv)

## Reading history cache inputs alongside references

Four paired fresh-profile openings on Linux x64 used the same 1,505,199-commit, 50,000-distinct-target fixture with Git 2.53.0, X11 under Xvfb and populated OS caches. The only bundle switched between runs was the Git utility. The order alternated between pairs. Each run drew 2,000 commits, appended three 5,000-commit pages and scrolled with 12,000 loaded rows.

| Measurement               | Sequential cache reads | Concurrent cache reads |
| ------------------------- | ---------------------: | ---------------------: |
| Median first paint        |             1,114.7 ms |             1,135.3 ms |
| Median utility snapshot   |               518.2 ms |               532.7 ms |
| First paints below 500 ms |                    0/4 |                    0/4 |
| Pages below 300 ms        |                  12/12 |                   7/12 |
| Scroll p95 below 18.7 ms  |                    4/4 |                    2/4 |

The last concurrent run took 2,125.1 ms to paint, including 968.2 ms in the utility snapshot. These measurements show no repeatable end-to-end speedup. A gated native test verifies that a cache config error interrupts a pending ref scan and preserves the displayed cursor. [All eight openings](m8-history-cache-read-samples.csv) · [Scheduling decision](../decisions/0117-history-cache-inputs.md)

Five separate native probes on the distinct-target fixture measured 241.7–285.9 ms for the complete direct ref records and 178.5–258.9 ms for a date-ordered 2,000-commit walk from all distinct tips. A second probe compared direct enumeration with reading identities, deduplicating object IDs, resolving their types with buffered Git processes, and reconstructing the records in Python. Six alternating runs per fixture produced identical bytes. Median times for direct enumeration, one type reader and up to three type readers were 204.5 / 260.9 / 191.9 ms for distinct targets and 171.3 / 129.7 / 132.8 ms for the shared target. The production reference reader still uses direct enumeration.

## Passing validated references to the renderer

The repository store now requests compact JSON for snapshots. Main checks each reference from the utility, expands ordinary branch, remote and tag records for callers using the object or ordinary JSON API, and passes their compact strings to callers using the new format. Main validates and strips unknown fields from rich reference records in every format. [ADR 0116](../decisions/0116-validated-snapshot-references.md)

The original 50,000-distinct-target build took 1,701.2–2,122.2 ms to paint in three fresh profiles. The following diagnostic cohorts used the same fixture and interleaved one-run variants. Combining up to 1,024 compact rows per string on the utility boundary alone yielded a median first paint of 1,420.1 ms across three runs. Carrying those combined strings on both boundaries yielded 1,091.0 ms. Reusing individual compact strings on the renderer boundary produced a median of 1,056.1 ms in three runs, compared with 1,116.1 ms in the three interleaved ordinary-format controls. Repacking already-expanded records in main took 1,080.7 ms median across three runs. The final implementation validates the wire strings in main and expands them once at the receiving boundary.

An isolated Node replay used all 50,000 ordered Git refs from the distinct-target fixture in a snapshot with an empty commit list. Both paths used the production response schema and main/renderer conversion functions. Each of eight pairs alternated execution order after warming both paths and ran GC before each timed sample. Exact deep equality with the original snapshot was checked after each timing. Validation, JSON serialization, parsing and expansion together took **172.4 ms median** with ordinary JSON and **66.9 ms median** with compact JSON. The encoded snapshots occupied **9,375,499 and 3,510,622 bytes** respectively. This measures the reference transfer code in one Node process and excludes Git, Electron IPC and drawing.

A separate six-opening Electron comparison switched only the renderer call between the two supported APIs in the same production build. With ordinary JSON the first paints were 1,738.6 / 1,591.3 / 1,333.2 ms. With compact JSON they were 2,481.8 / 2,406.5 / 1,280.5 ms. In the two slowest compact runs, the Git utility's snapshot read alone took 1,047.9 and 1,184.1 ms, before main serialized the response. That phase took 570.6–628.2 ms in the three controls. These runs did not demonstrate a repeatable end-to-end startup improvement. All six missed the 500 ms target.

The four fixture runs below used the production build with new renderer requests, fresh Electron profiles, uncleared OS caches, native Git 2.53.0 and X11 under Xvfb. Each opened 2,000 commits and appended three pages of 5,000. During these runs the shared 12-CPU host reported one-minute load averages above 19. Every large-ref opening exceeded 500 ms.

| Fixture, three openings each          | First paints (ms)           | 5,000-commit pages (ms) | Pages below 300 ms |
| ------------------------------------- | --------------------------- | ----------------------- | -----------------: |
| 50,000 distinct targets               | 2,943.7 / 2,974.1 / 2,934.7 | 500.9–728.0             |                0/9 |
| 50,000 refs at one target             | 3,051.5 / 2,528.4 / 2,415.4 | 450.7–637.3             |                0/9 |
| Full Linux, one ref                   | 1,829.7 / 1,204.3 / 1,203.8 | 448.7–754.5             |                0/9 |
| Two million commits and 100,000 files | 1,922.7 / 457.1 / 501.9     | 167.5–652.8             |                7/9 |

The [per-opening CSV](m8-snapshot-bridge-samples.csv) records every opening phase, page and scroll measurement from the initial baseline, interleaved experiments, four fixture runs and same-build comparison. Service time includes the utility snapshot read. The difference between service and snapshot time also includes dispatch, repository opening, watcher work and renderer decoding.

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
