# Scheduled provider refresh

Status: implemented for issue and PR browsers, selected details, loaded comments, files, reviews and check contexts.

## Decision

Automatic refresh is opt-in, with off, one-, five- and fifteen-minute choices saved per account, repository and browser type. It runs only while the browser is open and its window is active. Action dialogs pause it. User interaction invalidates a pending snapshot, and disabling refresh, changing context or closing the browser cancels outstanding reads.

The scheduler uses the main-process [polling policy](0040-provider-polling-policy.md) before each batch. The later of the user interval, provider minimum and active cooldown controls dispatch. Failures increase the user interval exponentially up to one hour; provider deadlines are never shortened. Timer segments are bounded to one day, with absolute deadlines checked again after waking. Only one batch runs at a time. Provider writes are excluded from the scheduler's request type.

Each mounted view registers a read loader and a deferred update. List loaders revalidate every loaded page serially, deduplicate records and retain pagination limits. All updates are applied together only after the batch succeeds and its view is still eligible. A failed or cancelled batch leaves existing results visible with status text. Polling preserves query text, selected details, keyboard item identity and the list's visible row where that row still exists. It does not simulate the existing destructive manual-refresh buttons.

Selected-detail loaders run after list loaders and before child sections. When PR commit IDs change, their update may end the batch before old-commit file or check views are queried; applying the new detail then replaces those commit-bound views. Reviews and inline comments are queried by PR number, so their loaded pages refresh in the same batch, including newly outdated comment locations, without losing expanded discussions. Action-dialog pause and cancellation protect unsent drafts. This does not implement durable draft recovery across application restart.

## Verification

Tests run through the real Electron renderer, preload and main service, with HTTP, OS encryption and time fixtures. They cover loaded-page reconciliation, keyboard selection, detail/comment updates, draft pause, provider timing, complete-batch failure, cancellation, disabling refresh and remembered preferences. PR coverage includes every loaded tab, changed check cursors, commit-bound invalidation, preserved file selection, expanded discussions and paused inline drafts. Lifecycle tests exercise real window hide/show, search-input cancellation and repository-switch cancellation. The eligibility guard combines document visibility with focus because a hidden Electron window can retain a visible document visibility flag.
