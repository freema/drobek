# Security policy

Report a vulnerability privately through GitHub's private vulnerability
reporting: <https://github.com/freema/drobek/security/advisories/new>
(Security tab → "Report a vulnerability"). Please do not open a public issue.

Include the affected version (`GET /api/version`) and the steps to
reproduce. Test against your own instance only.

Supported versions: the latest release. Fixes ship as a new release with a
`CHANGELOG.md` entry.

Abuse of an app hosted on a drobek instance (phishing, malware) is not a
vulnerability: use that instance's report form at `/.well-known/drobek-report`
on the app's host.

The threat model and the full policy: [`docs/SECURITY.md`](./docs/SECURITY.md).
