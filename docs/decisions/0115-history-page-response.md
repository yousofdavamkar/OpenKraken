# 0115. Transfer commit bodies separately on history pages

The renderer already has a cursor and an offset when it requests the next 5,000 commits. On the full Linux fixture, the first such page contains about 7 MiB of JSON. Encoding and parsing the entire message text on each append contributes to the time the user waits for the next graph rows.

The renderer requests the `history-page` response format for a `page` request. Main validates the utility reply, removes each body from the commit metadata, then sends the metadata as one JSON string and the bodies as an ordered array of strings. The renderer checks the count and restores each body at the matching index. Lengths, delimiters and the contents of a message have no bearing on that correspondence. Any future commit fields remain in metadata by default.

Main and preload both restrict this format to the paging method. Errors and cancellations retain their ordinary result shape. The renderer still checks the cursor and offset before applying a page. Callers choosing object or JSON responses use the existing formats.

The [paired benchmark](../verification/m8-reference-performance.md#transferring-history-pages) compares both formats through the Electron sandbox with the same Git utility, main process and graph layout code.
