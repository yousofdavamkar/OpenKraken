# ADR 0055: Bitbucket Cloud accounts and workspace browsing

Use scoped Bitbucket Cloud API tokens with Bearer authentication against the fixed `https://api.bitbucket.org/2.0` API. The account origin and canonical Git URLs remain `https://bitbucket.org`. Current Atlassian documentation supports Bearer API tokens without collecting an Atlassian email address. The roadmap's app-password reference is superseded by this API-token flow. Data Center and OAuth are separate future adapters.

Bind accounts and vault entries to native brace-wrapped UUIDs, with display names used only as labels. Git authentication uses the documented static username `x-bitbucket-api-token-auth` through the existing private native helper. Tokens never enter clone URLs or renderer results. Existing GitHub/GitLab account identities remain numeric and existing OAuth restrictions remain enforced.

Browse `GET /user/workspaces` first, then `GET /repositories/{workspace}`. Workspace selectors carry both UUID and slug; repository results must match both and the full repository path. Do not use the removed global repository listing or deprecated workspace listing. Each page contains at most 100 entries; each list is capped at 100 pages. Validate next-page metadata but reconstruct requests locally, never follow server URLs. Reject duplicate entries within a page; the desktop deduplicates overlapping pages by UUID. Sorting and mutable provider data cannot guarantee an atomic snapshot across pages; refresh restarts the list.

Derive clone URLs from validated path components, ignoring returned links. Bitbucket does not provide the shared archive field in this endpoint's documented schema, so its adapter leaves the shared archive marker false; this is not a write-permission claim. Only API-visible Git repositories are accepted. Issue and pull-request actions remain unavailable for Bitbucket until their native adapters exist.

Use the shared protected vault, conditional in-memory cache and cooldown policy with a bounded direct-fetch transport: no redirects, cookies or implicit retries; 20-second timeout; 32 KiB identity and 4 MiB page limits; sanitized errors; cancellation; cache clearing on authentication/permission failures. Cached data requires an authenticated 304 before reuse. Separate strict main-process IPC reads expose only normalized workspace/repository metadata.

References:

- https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/
- https://developer.atlassian.com/cloud/bitbucket/rest/api-group-users/
- https://developer.atlassian.com/cloud/bitbucket/rest/api-group-workspaces/
- https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/
