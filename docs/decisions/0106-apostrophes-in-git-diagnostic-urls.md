# 0106 — Apostrophes in Git diagnostic URLs

The M8 boundary review reproduced credential disclosure when the shared URL redactor treated an apostrophe as the end of a URL. For example, `https://user:pa'ss@example.test/repo` retained its entire password, while `https://example.test/repo?token='secret'` retained the quoted query value after a redaction marker. A failing native pre-commit hook reproduced both cases in the Electron error alert.

URL scanning now includes apostrophes before applying the existing authority and parameter masks. This preserves whole-authority password masking, including literal `@`, and removes query/fragment tails containing apostrophes. Ordinary apostrophes in paths remain visible. Single-quoted native diagnostics still mask the complete credential; a closing quote in a parameter tail may also be removed conservatively.

The streaming regression feeds UTF-8 bytes individually through the public progress API and checks HTTP userinfo, SSH passwords, query values, fragments, quoted native diagnostics and unchanged paths. The desktop regression uses a real failing hook and requires masked values in the alert, no fixture secrets in the document, and retention of the rejected commit draft.

This extends [ADR 0079](0079-security-boundaries-and-git-diagnostics.md). It remains structural URL redaction, not arbitrary secret detection or support for every malformed diagnostic representation. Persistent diagnostics continue to exclude message content entirely, as described in [ADR 0081](0081-local-rotating-diagnostics.md). This scoped Linux check does not complete the broader security review or native Windows/macOS acceptance.
