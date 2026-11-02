# GitLab merge-request discussions

Date: 2026-11-02

## Decision

The GitLab discussion reader uses the project-scoped Discussions API with explicit offset pages of 100 discussions. Each user-requested call revalidates the protected account and resolves the exact project and selected merge request. The native global merge-request ID is retained in the typed detail model, separately from its project-local number. Every note must identify that global merge request, its target project and the `MergeRequest` noteable type. A non-null noteable IID must also match the selected local number.

Discussion IDs and note IDs remain distinct. The typed model preserves individual comments, threaded replies, system notes, author deletion, timestamps, resolvability, resolution state and resolver metadata. Missing resolution fields remain unknown rather than becoming false. Duplicate discussion/note IDs within a page and contradictory individual-thread metadata fail validation.

Inline positions retain their three native diff SHAs, old/new paths and text, image or file kind. Text positions preserve old/new lines and multiline range endpoints; incomplete or reversed same-side ranges fail validation. Image dimensions and coordinates are retained as data. File comments do not invent a line number. The reader does not translate old locations onto a new diff. The UI compares all three stored SHAs with the currently displayed diff and labels a match, a different revision or an unavailable displayed revision.

## Bounds and transport

A page contains at most 100 discussions and 1,000 nested notes; a thread contains at most 1,000 notes. Note bodies are capped at 262,144 characters and the existing 4 MiB response cap applies before JSON decoding. Oversized or malformed content fails the page; notes are not silently cut off. Ten manual pages permit at most 1,000 loaded discussions, with an explicit limit indicator. A full final server page can require an extra empty request. Appending deduplicates discussions by stable ID and replaces their complete note arrays.

Gitbeaker's Discussions resource uses a resource URL prefix. The transport validates the complete prefix-plus-endpoint string against the exact expected HTTPS endpoint before sending a request. This supports the SDK's prefix without widening host or path access. One SDK dispatch per read, cookie omission, redirect refusal, cancellation, conditional caching and main-enforced cooldowns remain in force. Provider pagination URLs are ignored.

## Desktop lifecycle

Both the discussion selector and nested notes are virtualized. Loaded-note search covers note numbers, authors, bodies and paths. Arrow keys, Home, End and Enter select discussions; the note viewport supports arrow keys, Home and End. Descriptions render as literal text. Inline context is expandable, with open context IDs retained while scrolling and through refresh.

Scheduled refresh reads every loaded discussion page as a complete batch. It retains the selected discussion, search, active selector identity and expanded inline contexts while updating note arrays and resolution metadata. A changed displayed diff updates context labels without discarding historical discussions. Manual refresh starts at page one. Leaving the section or closing the panel cancels obsolete reads; failures keep bounded errors and expose retry without provider bodies or credentials.

## Evidence and remaining scope

ProviderService/MSW fixtures cover manual pages, canonical prefixed endpoints, native thread and note identity, foreign-target refusal, deleted authors, resolution metadata, multiline/image/file positions, malformed ranges, duplicates, nested bounds and cancellation. IPC tests reject malformed selectors and keep provider discussion reads outside the Git utility service. Electron acceptance covers thread and nested-note virtualization, search, keyboard navigation, literal text, resolution display, context retention, scheduled update across a changed diff, retry and cancellation.

This reader does not write discussions or resolutions, apply suggestions or render attachments. GitLab comment/reply creation, inline posting, resolution actions, approval workflows, merge-request creation/merging, pipelines and issues remain further work. Live-provider and actual OS keychain acceptance remain unverified.

## Public reference

- [GitLab Discussions API](https://docs.gitlab.com/api/discussions/)
