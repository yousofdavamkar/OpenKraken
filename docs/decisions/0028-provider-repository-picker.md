# Provider repository picker

GitHub and GHES repository browsing uses the connected account's protected credential in main. Each page first validates the account identity, refreshing an expiring device credential through the existing protected rotation path. Public results contain repository metadata only. The shared request wrapper retains HTTPS verification, cookie omission, redirect refusal, cancellation, timeouts, body bounds and fixed public errors.

The picker requests `GET /user/repos` ordered by full name, ascending, in pages of 100. It includes repositories accessible to the token under the endpoint's default affiliations. A full page permits the next numbered page; this can make one extra empty request when the total is a multiple of 100. It never follows server-supplied pagination URLs. Browsing stops at 100 pages (10,000 entries) with an explicit limit message. The provider can change between requests, so the desktop deduplicates IDs while appending pages; Refresh starts a new list. Search filters loaded metadata, rather than claiming to search all provider repositories.

Clone URLs are constructed from the configured HTTPS origin and validated literal owner/repository path segments. Provider-supplied clone URLs, pagination links and extra fields are not trusted or forwarded. Repository IDs must be positive safe integers before string conversion. Malformed pages fail with a fixed error. Selecting a repository fills the existing clone form; native Git uses its existing credential-helper/askpass flow. Automatic supply of saved provider credentials to Git remains a separate implementation step.

Reference: [GitHub repository REST API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user).
