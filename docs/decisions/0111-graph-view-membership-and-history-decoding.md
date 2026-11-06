# 0111 — Index graph visibility and stream history text

A graph view can hide up to 10,000 canonical ref names. With 50,000 distinct refs, scanning the saved list for every ref made opening a filtered repository take 13.9 seconds on the Linux benchmark host. The utility process spent about 10.1 seconds preparing the snapshot. The renderer spent another 3.3 seconds between publishing state and painting.

Compile the graph view into a name predicate once per snapshot or badge calculation. A solo ref matches by exact name, even if the saved hidden list also contains it. Otherwise, use a set for hidden names and a constant predicate for an empty list. The Git service visits refs in their existing order to collect traversal starts, the visible pinned target and stash presence. The renderer applies the same predicate while grouping badges. The sidebar still receives all refs so users can reveal hidden ones.

Commit history consists of UTF-8 text fields separated by NUL bytes. Use the existing byte-limited streaming text decoder for those fields, as for reference records. Both consumers split only on NUL and preserve UTF-8 sequences across chunk boundaries. Status records still carry original filename bytes through the binary decoder. The history cursor retains its existing callback and page-boundary backpressure.

The opt-in filtered benchmark seeds 10,000 tag names into the disposable profile before launch and verifies a hidden tag through the sidebar after timing. The same 500 ms first-paint, 300 ms paging and 18.7 ms scrolling limits apply. The fixture and results are described in [the reference performance record](../verification/m8-reference-performance.md).
