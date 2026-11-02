# Saved accounts for existing Git remotes

The existing-remote flow starts with foreground fetch. The public `providerGit` request carries a saved account ID and a strict operation descriptor: repository ID, remote name and the revision shown in Manage remotes. It cannot carry a URL, credential or background flag. Existing helper/agent-based requests remain available.

Main asks the Git utility to resolve the configured target without network access. Saved-account mode requires one canonical HTTPS owner/repository URL; URL rewrites and credential-bearing/non-HTTPS URLs are refused. Main compares the resolved remote/configuration revision with the reviewed revision before loading a token, validates the account identity and configured origin, and passes the credential plus resolved revision to the utility over its private contract.

The Git service rechecks the remote URL and configuration/tracking-ref revision under the repository queue immediately before fetch. Changed settings or refs require reloading/reviewing the remote. Native askpass remains bound to the exact URL/account; redirects, credential helper storage, HTTP credential headers/cookies and tracing are restricted by the same per-operation safeguards used for saved-account clone. Only HTTPS is permitted. The existing atomic fetch, refspec, pruning and tag behavior is retained.

The main-to-utility target lookup uses its own request ID but is attached to the foreground cancellation signal. Cancellation propagates through lookup, account validation and native execution. Saved-account failures and progress use fixed diagnostic fields so remote output cannot expose authentication material. Automatic fetch continues to use the existing noninteractive helper flow; this request does not silently opt users into background use of saved accounts.

Native tests exercise real verified HTTPS fetch and validate imported tracking refs, scope matching and refusal before network use when a remote changes. The shared contract rejects renderer-supplied credentials and caller-supplied URLs, and keeps target resolution private. Push, pull and remote-deletion support need their corresponding direction, upstream and reviewed-plan checks before using this boundary.

References: [Git fetch](https://git-scm.com/docs/git-fetch), [Git remote](https://git-scm.com/docs/git-remote), [saved-account transport safeguards](0029-provider-git-authentication.md).
