# GitLab repositories and nested namespaces

Date: 2026-11-02

## Decision

The GitLab adapter now uses Gitbeaker's Projects API to list the connected account's member projects. Requests use `membership=true`, explicit offset pagination, `per_page=100`, `order_by=id`, and ascending order. This avoids treating the instance's entire public project catalog as the user's repository list. Manual clone URLs remain available for other repositories. Every page checks the protected account identity first, including the existing OAuth refresh path.

The desktop explicitly requests one page at a time. A full page permits the next numbered page; a short page ends the list. A full final page can therefore cause one extra empty request. The limit remains 100 pages/10,000 loaded rows, with an explicit limit indicator. The transport rejects additional SDK dispatches in one call and does not expose provider pagination headers to Gitbeaker's pager. Neither the adapter nor the UI follows a provider-supplied pagination URL. The existing list appends and deduplicates stable numeric IDs, searches loaded entries and keeps keyboard selection virtualized.

GitLab `path_with_namespace` supplies the full parent namespace; its final component must match `path`. The shared model represents nested parents in `owner`, rather than truncating the URL to the first two components. Namespace paths are bounded to 2,048 characters and consist of nonempty ASCII components, each at most 255 characters. Dot segments, encoded separators, backslashes, query strings and fragments are rejected. Project names are bounded to 255 characters and descriptions to 4,096. GitHub repository discovery retains its previous single-component, 100-character selector checks.

Clone URLs are constructed from the configured HTTPS account origin and validated path components. Provider-supplied `http_url_to_repo` is never used to redirect credentials. The full canonical URL passes through main, the typed private Git-service contract, native transport review and the existing askpass scope. Rewrites, redirects, protocol changes, sibling repositories and alternate usernames remain refused. GitHub saved credentials still require its owner/repository URL shape; GitLab can use nested namespaces. Selection passes typed repository metadata to the issue/PR panels instead of reparsing and truncating the URL.

GitLab visibility is retained as optional metadata on the shared repository model, including `internal`. The picker shows Internal explicitly. The existing `private` boolean treats internal projects as nonpublic for compatibility; when visibility is present the contract requires these fields to agree. Existing GitHub results remain compatible without that optional field.

## Network and cache behavior

GitLab identity responses remain capped at 32 KiB; repository pages have a 4 MiB response cap and at most 100 records. Identity and repository requests use the isolated provider partition, HTTPS verification, cookie omission, redirect refusal, cancellation and a twenty-second timeout. Malformed metadata and network failures produce bounded errors without provider bodies or tokens.

GitLab reads use a separate instance of the existing main-only conditional-read cache: at most 256 entries/16 MiB for five minutes. Keys bind origin, token, URL and representation headers. A cache entry only supplies a response body after an authenticated HTTP 304; errors never fall back to old data. No-store and wildcard Vary policies prevent storage. Credential replacement/refresh/disconnection and authentication/access failures clear the GitLab cache. ETags, bodies and credentials remain outside renderer results.

GitLab's quota headers and Retry-After feed the bounded timing policy. A server cooldown blocks subsequent account and repository requests before dispatch; there are no implicit SDK retries.

## Evidence and remaining work

Service/MSW tests cover nested and long namespaces, public/internal/private visibility, manual pages, caps, malformed metadata, hostile clone/pagination links, invalid paths, conditional reads, credential replacement, no-store, revoked access, quota headers, cancellation, redirects and oversized bodies. IPC checks reject noncanonical nested credential URLs. Native-helper tests verify exact subgroup path scopes and refusal of sibling/traversal targets.

Electron acceptance loads and deduplicates GitLab project pages, searches a deep namespace, selects with the keyboard, clones through the real native helper over locally trusted authenticated HTTPS, and fetches a new commit using the saved GitLab account. It checks the resulting refs/configuration and absence of token text. Existing GitHub picker, account and saved-Git flows continue to pass.

GitLab merge requests, issues and pipelines remain subsequent M6 work. Live GitLab repository access and actual OS keychain behavior remain unverified; API and keychain responses in acceptance tests are fixtures. The local HTTPS Git transport is real and retains TLS verification.

## Public references

- [GitLab Projects API](https://docs.gitlab.com/api/projects/)
- [GitLab namespaces](https://docs.gitlab.com/user/namespace/)
- [GitLab path/slugs](https://docs.gitlab.com/user/reserved_names/)
- [Conditional-read cache decision](0039-provider-conditional-reads.md)
- [GitLab authentication decision](0042-gitlab-authentication.md)
