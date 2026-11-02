# M6 progress — provider integrations

M6 is in progress. M0–M5 have documented Linux acceptance; M6–M8 remain open.

The initial credential-storage foundation uses asynchronous Electron safeStorage, rejects Linux plaintext/unknown backends, stores only encrypted account-bound envelopes, serializes atomic writes, and supports key rotation and forgetting credentials. It is not yet wired to the desktop account UI or a provider client.

Four focused vault tests pass, alongside TypeScript checking, ESLint and Prettier. Tests use authenticated encryption at the OS boundary and real temporary files; actual desktop keychain availability and live provider authentication have not been verified. The last complete application acceptance remains M5's 221 unit tests, 51 Electron tests with Gitea, and packaged Linux smoke checks.

Next work is the provider abstraction, GitHub account/device authentication and repository/PR flows, then GitLab and the other planned providers. Provider fixture suites, checks/issues, repository picker/fork/create, SSH key upload, PR templates/review/merge and credential integration remain open. Optional Jira is lower priority. No server component is planned.

Decision: [provider credentials](../decisions/0026-provider-credentials.md).
