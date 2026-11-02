# ADR 0058: Bitbucket Cloud pull-request comment browsing

Read the native chronological PR comments endpoint, including general comments, inline comments and replies. Explicitly request created_on order, 100 records per page and at most 100 pages. Reconstruct page requests locally; reject foreign or repeated next links and duplicate IDs within a page. Append/deduplicate loaded pages by comment ID. Keep provider tokens in main with the existing bounded JSON transport, cancellation, authenticated conditional reads and polling cooldowns.

Bind each read to the selected repository UUID and PR number. Re-read repository-bound details before and after fetching. Validate comment PR identity and destination metadata when supplied. A changed source commit does not invalidate historical comments. Unlike file reads, comments remain available when the source repository or full commit identifiers are unavailable.

Preserve direct parent IDs without recursive payload parsing. Reject self/cyclic relationships visible within a page. Present a chronological virtualized list with search, keyboard navigation, full selected text and navigation to a loaded parent. An unloaded/deleted parent is explicitly identified; do not synthesize a complete thread from partial pages.

Render raw text only. Retain deleted comments as tombstones with no exposed body. Keep missing authors, dates and publication metadata unknown. Distinguish absent resolution metadata, explicit null, and a resolution record; do not infer thread-wide resolution from a reply. Preserve old/new line endpoints and starts, file-only anchors and optional outdated metadata. Validate same-side ranges. These comment anchors do not supply a pinned commit identity, so do not claim they match the displayed diff or permit a write from them without a separate reviewed native workflow.

The UI preserves comment search and selection across scheduled source changes and refreshes all loaded pages atomically. Closing/hiding the section cancels obsolete requests. A repository identity change resets the section.

References: public Bitbucket REST pull-request comments and comment-resolution documentation and its OpenAPI comment, pullrequest_comment and comment_resolution schemas:
https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/
https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json

This slice reads comments. Posting/replying/editing/deleting, resolution actions and live-provider acceptance remain separate work.
