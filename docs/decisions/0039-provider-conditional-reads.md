# Provider conditional reads

Status: accepted for the GitHub/GHES driver; scheduled polling remains separate work.

## Context

The integration-service specification includes polling and caching, and the roadmap names ETags as a rate-limit mitigation. There is no server component to receive provider webhooks. GitHub's [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) describe authenticated conditional GETs as a way to avoid consuming primary quota when a response is unchanged. They also require respecting provider polling intervals and rate-limit delays; the cache alone does not implement those scheduling requirements.

## Decision

Cache bounded GET representations in main-process memory. Each read still reaches the configured provider with its credential. Send `If-None-Match` only for the same origin, credential, full URL (including paging/filter parameters) and request headers. The cache key is a SHA-256 digest; it does not retain the token or plaintext request headers. A matching cached request can reuse its body only after HTTP 304. HTTP 200 replaces the representation, and errors never serve stale data. An unsolicited 304 fails. Redirect refusal and the existing per-response four-MiB limit remain in force.

The cache holds at most 64 representations and 16 MiB of body bytes, evicting the oldest inserted entries first. Bodies expire five minutes after receipt; a 304 does not extend this lifetime. Unreferenced expiry timers release idle entries, and reads also check expiry. Retained metadata is limited to the ETag and content type, each at most 1,024 characters. ETags must use quoted strong or weak syntax. Other response headers, including cookies, are not retained. `Cache-Control: no-store` and `Vary: *` forbid storage, including when supplied on a revalidation response.

Any mutative HTTP attempt clears the cache before dispatch, including attempts that later have uncertain outcomes. The fixed read-only GraphQL check-rollup query explicitly opts out of invalidation; its POST responses are never cached. Other POSTs default to invalidation. Authentication/access failures (401, 403 and 404), credential connection/replacement/refresh and account disconnection also clear cached reads. Clearing all entries is deliberately conservative across connected accounts.

## Verification and limits

ProviderService tests use real temporary profiles, protected vault storage and MSW at the HTTP boundary. They cover revalidation and replacement, account/host/page/filter isolation, storage prohibitions, access failures, uncertain writes without retry, GraphQL reads, credential replacement, expiry and both capacity limits. No test calls cache internals.

This is a transport optimization, not an offline store or a transactional write guard. Existing preview and server-side write conditions still apply. Server-directed cooldowns are implemented in [the polling-policy decision](0040-provider-polling-policy.md). Scheduled polling and preserving loaded UI state during automatic refresh remain unfinished. Live-provider and real-keychain acceptance remain separate from fixtures.
