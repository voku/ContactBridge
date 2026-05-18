# Security Policy

## ContactBridge beta boundary

ContactBridge is a **local-first beta**. Treat it as single-operator local software, not as hosted SaaS.

## What not to expose yet

Do **not** expose hosted mode to real users yet.

Known beta non-goals:

- no hosted accounts
- no multi-user isolation
- no SaaS deployment support

## Handling local secrets and data

Do not commit any of the following:

- `.env.local`
- SQLite database files
- backup JSON files
- provider tokens or OAuth secrets
- extension builds that accidentally package production origins you did not intend to distribute

## Reporting a security issue

Please open a private security report through GitHub Security Advisories if available for this repository.

If private reporting is unavailable, open an issue only for non-sensitive reports. Do **not** post secrets, tokens, or private user data in a public issue.

Include:

- affected `APP_MODE`
- reproduction steps
- impact summary
- whether the issue affects local-only behavior, hosted mode boundaries, or extension packaging
