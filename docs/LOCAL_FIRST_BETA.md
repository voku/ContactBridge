# ContactBridge Local-First Beta Boundaries

## Safe today for local usage

- Single-user local and test usage (`APP_MODE=local` or `APP_MODE=test`)
- Encrypted storage of source account credentials via `source_account_secrets`
- Manual profile capture from LinkedIn, X, Bluesky, and XING through the extension
- Candidate review and approval before export
- Backend-generated approved-contact exports (CSV, JSON, VCF)

## Not yet safe for hosted multi-user usage

- No user authentication or authorization model
- No per-user data ownership isolation
- No full CSRF hardening model for browser-hosted multi-user operation
- SQLite data model is still optimized for local-first single-operator workflows

## Remaining work before public hosted rollout

- Add full authentication and user/account management
- Enforce per-user tenancy and row-level ownership boundaries
- Complete hosted security hardening (session protection, CSRF strategy, ownership checks)
- Add operational migration/versioning workflow for schema changes
- Add hosted operational controls (auditing, admin safety controls, incident-ready monitoring)
