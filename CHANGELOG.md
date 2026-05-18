# Changelog

## 0.1.0-beta.1

- Ships ContactBridge as a local-first beta for single-operator installs, demo walkthroughs, and feedback collection.
- Supports source imports from Bluesky, GitHub, Google Contacts, Mastodon, and X.
- Supports manual browser-extension capture for LinkedIn, X, Bluesky, and XING, with LinkedIn API sync limited to approved partner access only.
- Exports approved contacts from the backend as CSV, JSON, and VCF.
- Includes local backup, restore, and reset flows for local/test mode.
- Includes `npm run smoke` checks for health, status, extension health, exports, and non-destructive local backup verification.
- Includes `beta-release-check.yml` to verify install, integration tests, lint, build, built-server startup, and smoke checks before release.
- Keeps hosted limitations explicit: no hosted accounts, no multi-user isolation, no SaaS deployment support, and no unrestricted LinkedIn scraping claims.
