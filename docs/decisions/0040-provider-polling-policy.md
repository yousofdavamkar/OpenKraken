# Provider polling policy and cooldowns

Status: accepted for GitHub/GHES transport. Automatic polling controls and state-preserving UI refresh remain unfinished.

## Context

Conditional reads reduce primary quota use but do not prevent secondary limits. GitHub's [REST guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) calls for observing `Retry-After`, exhausted-quota reset timestamps, endpoint polling intervals and increasing delays after repeated secondary limits. Our account queue already serializes provider operations; this decision adds shared timing policy for manual reads, future polling and writes.

## Decision

Keep timing policy in main-process memory, keyed by a digest of the configured host and credential. Observe response headers as soon as they arrive, including on 304 and on responses whose bodies later fail size or parsing checks. Use the later applicable `Retry-After` (seconds or HTTP date) and `x-ratelimit-reset` when remaining quota is zero. Treat 429, exhausted quota without a usable future reset, and recognized secondary-limit 403 messages as rate limits. An ordinary permission-denied 403 does not block unrelated reads.

Without a usable server deadline, start at one minute and double consecutive rate-limit delays to a one-hour ceiling. Successful reads of the failing endpoint reset that fallback; successful identity reads must not reset a repository endpoint's failures. Explicit server deadlines are never shortened to the fallback ceiling. Numeric overflow saturates at the maximum representable JavaScript date. No HTTP operation is retried automatically.

Refuse further HTTP requests for that credential/host until the deadline, including identity checks and manual retry attempts. Check both before each provider operation and before each individual HTTP dispatch. A preflight read that exhausts quota can therefore stop the following write. A known local refusal before any write dispatch remains a rate-limit error even if an SDK or write helper wraps it. Once a write was dispatched, uncertain-outcome handling still takes precedence.

Retain the largest observed `x-poll-interval` as a conservative minimum for future scheduled reads using that credential and host. This interval does not itself block a manual read. Timing metadata is bounded to 256 credential/host records; under exceptional credential churn, evicted timing constraints become conservative session-wide minimums so eviction cannot shorten a provider-requested delay. Normal account/host policies remain isolated. Reconnecting the same credential does not clear its active cooldown.

The read-only `providerPollingPolicy` IPC returns only `{minimumIntervalMs, blockedUntil}` for a saved account. It reads protected credentials locally to select the policy and makes no HTTP request or OAuth refresh, so it works while the account is throttled. Provider errors may include a validated `retryAt` timestamp. Neither interface exposes raw headers, provider error payloads, credentials or arbitrary HTTP destinations. The native Git service rejects the policy request.

## Verification and limits

ProviderService/MSW tests cover header forms, fallback delays and recovery, host/credential isolation, reconnect refusal, preflight exhaustion, uncertain writes, response limits, long delays and bounded policy retention. Contract tests constrain selectors and timestamps. Electron acceptance exercises real main/preload/UI routing, conditional issue-list refresh, sanitized errors, blocked requests and recovery after the deadline, replacing only OS encryption, HTTP and time boundaries.

Policy is session-local, not persisted across application restart. It is scheduling guidance and client behavior, not a server-side quota authority. Future UI timers must respect both user intervals and provider minimums, recheck absolute deadlines, pause on hidden/inactive views or action dialogs, cancel obsolete work, and preserve loaded pages, selection and drafts. Use bounded timer segments for distant deadlines; never pass an arbitrarily large delay directly to `setTimeout`. Live-provider acceptance remains outstanding.
