# ContactBridge v0.1.0-beta.1 Release Notes

> **Release label:** Local-first beta

## Release focus

ContactBridge is now available as a **local-first beta**. This release is intended for external users who want to install the app locally, run a safe demo, verify the current feature set, and report issues without relying on hosted SaaS behavior.

## Current feature set

- Local-first single-operator runtime with fail-closed `APP_MODE` handling
- Source imports for Bluesky, GitHub, Google Contacts, Mastodon, and X
- Restricted LinkedIn positioning: optional API sync only where approved partner access exists, plus manual extension capture
- Manual profile capture for LinkedIn, X, Bluesky, and XING via the optional extension
- Candidate review, approval, ignore, and merge flows before export
- Backend-generated CSV, JSON, and VCF exports
- Local backup, restore, and reset flows in local/test mode
- Demo mode with bundled fixtures via `npm run demo`
- Local smoke verification via `npm run smoke`

## Supported sources

- Bluesky
- GitHub
- Google Contacts
- Mastodon
- X
- LinkedIn (manual capture plus partner-access-only API sync; do not market as unrestricted full-network scraping)
- XING (manual capture via extension)

## Known limitations

- Local-first beta only
- No hosted accounts
- No multi-user isolation
- No SaaS deployment support
- Hosted mode is not ready for real users
- Demo mode depends on local fixture files for safe token-free imports
- Production extension hubs must be explicitly packaged into the extension build

## Security boundary

- Local and test modes expose backup, restore, and reset routes for single-operator workflows
- Hosted mode blocks those local-only destructive routes
- Hosted mode also requires explicit secret and CORS configuration before startup
- This beta is not a hosted trust boundary and must not be presented as one

## Restricted LinkedIn positioning

ContactBridge supports:

- manual LinkedIn profile capture with the extension
- limited LinkedIn API sync only where approved partner access already exists

ContactBridge does **not** support background scraping, broad crawling, or hidden collection of LinkedIn data.

## Extension behavior

- Optional side-panel extension only
- Manual user-triggered capture only
- Optional host permissions limit capture access to approved sites
- Hub validation checks `/api/extension/health` before saving the target hub
- Production hub origins must be explicitly packaged before distribution

## Backup and restore behavior

- `GET /api/database/backup` downloads a JSON backup in local/test mode
- `POST /api/database/restore` restores a prior backup with an explicit confirmation header
- `DELETE /api/database` resets local data with an explicit confirmation header
- Hosted mode blocks backup, restore, and reset

## How to report issues

Please include:

- `APP_MODE`
- Node version
- operating system
- source/provider involved
- extension version and whether it was manually loaded unpacked
- relevant `npm run smoke` output
- exact reproduction steps

Use the GitHub issue templates in this repository for bugs, provider issues, and extension capture issues.
