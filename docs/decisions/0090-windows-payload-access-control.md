# 0090 — Windows payload ownership and access control

## Decision

Windows installer payload verification must use native ownership and discretionary access control lists (DACLs). Node's Windows mode bits are not POSIX account permissions. Applying the existing POSIX writable-bit rejection to Windows files would reject ordinary payloads without establishing who can modify them. Conversely, simply dropping the check would leave that security requirement unverified. See the [Node file mode documentation](https://nodejs.org/api/fs.html#file-modes).

On Windows, a bounded PowerShell reader inspects the actual payload root and every child with literal paths. It refuses reparse points before enumerating their children, including junctions and links. It reads owners and both explicit and inherited access rules by SID, avoiding localized account names. A missing/null DACL is unsafe: unlike an empty DACL, it permits unrestricted access. This distinction follows [Microsoft's DACL documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/null-dacls-and-empty-dacls).

The policy permits ownership by the current build/verification user, Local System or built-in Administrators. Effective allow rules granting mutation rights must name one of those principals, or OWNER RIGHTS when ownership has passed that check. Mutation includes file writes, append, attribute writes, deletion, child deletion, permission changes, ownership changes, generic write and generic all. Other principals may receive read/execute rights. The bit values follow [Microsoft's FileSystemRights definition](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemrights).

This is a conservative artifact policy, not a general Windows effective-access evaluator. It does not assume that deny entries cancel unsafe allow entries or expand arbitrary group memberships. Inherit-only entries do not apply to the current object; every existing descendant is checked separately for its inherited rights. Empty DACLs are not classified as public write access, but unreadable or unlaunchable artifacts still fail payload hashing or desktop smoke. The production checker does not rewrite ACLs. Shared build output writable by other accounts fails and must be built in a suitably restricted location.

The access report must have a unique directory root, complete parent paths, valid records and unambiguous case-insensitive paths. The subsequent Node walk must match its path/type inventory exactly. Additions, removals or type changes between the two walks fail verification. This does not claim an atomic filesystem snapshot or protection from the trusted owner/administrator modifying files during verification.

Windows payload manifests retain entry types, byte sizes and SHA-256 hashes, while omitting synthetic POSIX modes. A read-only file attribute, which the MSI builder may add, does not replace a DACL or change the payload byte identity. The verifier rechecks native access rather than comparing machine-specific owner SIDs in a portable manifest. Linux/macOS mode and link verification remains unchanged.

`pnpm package` checks Windows payload access after setting and verifying the hardened fuses, so the existing native Windows CI packaging step gates the actual bundle. This is a prerequisite for the MSI producer and lifecycle verifier, which remain unimplemented at this checkpoint.

## Verification and limits

Linux-runnable policy tests cover mutation masks, trusted and untrusted principals, missing/null DACLs, shared read access, inherited writes, conservative deny handling, malformed reports, redirected paths and case collisions. They validate policy against explicit records, not native Windows access behavior.

Three native Windows tests exercise the public payload verifier with test-owned directories: a restricted payload whose read-only attribute changes, inherited Everyone write access, and a directory junction. The existing CI matrix discovers these tests. Native execution is pending; Linux skips these cases. PowerShell 7.6.9 parsed the reader successfully on Linux, which is syntax evidence only, not Windows PowerShell 5.1 runtime evidence.

The existing Linux RPM artifact passed payload/fuse checks, packaged desktop smoke and corruption rejection using the changed shared verifier. This checkpoint does not establish MSI creation, installation, upgrade, removal, protocol registration cleanup, Windows signing or native release acceptance. Those remain required work.
