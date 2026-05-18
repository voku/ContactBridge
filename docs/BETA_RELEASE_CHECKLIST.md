# ContactBridge Beta Release Checklist

## Required env vars

- `APP_MODE=local` for the normal local-first beta flow
- `APP_URL=http://localhost:3000` for local OAuth callback testing
- `CONTACTBRIDGE_DEMO_DATA_DIR=./test/demo-data` for safe demo walkthroughs without real provider tokens
- `CONTACTBRIDGE_CORS_ORIGINS` only when you intentionally run hosted or split-origin setups
- `CONTACTBRIDGE_SECRET_KEY` only when `APP_MODE=hosted`
- `VITE_API_BASE_URL` only when the frontend does not share the backend origin

## Local smoke test steps

1. `npm install`
2. `cp .env.example .env.local`
3. Confirm `.env.local` keeps `APP_MODE=local`
4. Start the app with `npm run dev` or `npm run demo`
5. Open `http://localhost:3000`
6. Confirm the dashboard shows:
   - backend reachable
   - database reachable
   - export endpoints available
   - extension health available
7. Run `npm run smoke`

## Extension smoke test steps

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select the repository `extension/` directory
5. Open the extension side panel
6. Set the hub URL to `http://localhost:3000`
7. Capture one supported public profile
8. Confirm the captured profile appears in the review queue

## Export smoke test steps

1. Import demo data or connect one source
2. Approve at least one candidate from **Review Queue**
3. Open **Exports**
4. Download CSV, JSON, and VCF
5. Confirm only approved candidates are exported
6. Confirm `npm run smoke` passes against the running app

## Known limitations

- Local-first single-operator beta only
- Hosted mode exists for productization work, not for real multi-user deployments
- No user accounts, per-user ownership, or hosted authorization boundaries yet
- Production extension origins must be explicitly packaged before distribution
- Demo mode depends on local fixture files matching supported integrations

## Not hosted multi-user ready

ContactBridge is **not hosted multi-user ready**. Do not expose hosted mode to real users until authentication, authorization, tenancy, and hosted browser security hardening are implemented.
