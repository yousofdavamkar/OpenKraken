# Reviewed GitLab discussion actions

Date: 2026-11-02

## Decision

Overview comments create discussion threads. Replies target a native discussion ID, and resolve/reopen changes the whole thread. These actions use separate typed GitLab contracts; GitHub review semantics do not stand in for GitLab approval or discussion state.

A read-only preview loads the exact project and merge request and, for replies/resolution, the selected discussion. Its SHA-256 revision binds the canonical origin, complete action payload, merge-request metadata and normalized discussion including all notes and positions. Confirmation clears cached reads, repeats these reads, compares the revision, and sends at most one write. Changed text, target, notes, diff revision or resolution requires a fresh review. Locked merge requests and system-root discussions fail before dispatch. Resolution requires a nonindividual thread with known resolvable notes and a state change. Provider permissions remain authoritative.

This is a freshness guard, not a server transaction or authorization token. GitLab exposes no conditional discussion-write revision, so a change between the final read and write cannot be excluded. The UI must show the reviewed payload, freeze it until confirmation or editing, and retain drafts on failure.

## Transport and uncertain outcomes

The SDK transport validates the exact HTTPS target and HTTP method before dispatch. POST/PUT bypass and invalidate read caches. Cookies and redirects remain disabled, response size/time limits remain enforced, and SDK retries cannot dispatch a second request. Cancellation before dispatch sends no write. A lost connection, cancellation after dispatch, server error, malformed acknowledgment or unexpected response target becomes `PROVIDER_WRITE_UNCERTAIN`. Explicit client refusals are distinct from uncertain results. Neither class retries automatically.

Response notes must identify the expected project and global merge request. Replies must return a new note ID; resolution acknowledgments must identify the selected thread and requested state. Overview acknowledgments must be a new nonindividual thread with one nonsystem note and no inline position. Returned text is displayed as acknowledged: GitLab documents note-body normalization, so exact input/output text equality is not required.

Uncertain results require read-only inspection before another deliberate review. A missing item in a bounded page is not proof that a write failed. Durable recovery across application restarts belongs to M8.

## Verification and scope

ProviderService/MSW tests cover payload delivery, nested projects and self-managed origins, stale notes and altered drafts, resolve/reopen, invalid targets, unavailable resolution, system notes, explicit refusals, malformed acknowledgments and cancellation without retries. Strict public IPC excludes these operations from the Git utility service. The desktop composer freezes reviewed text, displays current thread notes with the existing virtualized viewer, preserves drafts on stale/error/cancelled outcomes, and refreshes discussion browsing after a completed or uncertain action. Uncertain-result inspection uses manual bounded discussion pages and never repeats the write. Modal actions pause scheduled refresh; Escape preserves the parent panel and offers keep/discard for unsent drafts. Live-provider writes are not exercised.

Inline posting, approval reviews, note edits/deletion, suggestions and attachments remain separate work.

## Public reference

- [GitLab Discussions API](https://docs.gitlab.com/api/discussions/)
