# ContactBridge

ContactBridge is a privacy-first social contact hub for local-first beta use. It imports profiles from supported sources, groups them into reviewable candidates, supports manual profile capture from LinkedIn, X, Bluesky, and XING, and exports approved contacts as CSV, JSON, or vCard files.

## Features

- Import contacts from Bluesky, GitHub, Google Contacts, Mastodon, and X
- Capture public profiles manually from LinkedIn, X, Bluesky, and XING with the browser extension
- Optional LinkedIn API sync only for approved partner-access deployments
- Review and merge candidate identities before approving them
- Export approved contacts in CSV, JSON, and VCF formats
- Optional browser extension for manual profile capture
- Separate frontend and backend deployment support

## Architecture

- `src/`: React + Vite frontend
- `server.ts`: Express API, OAuth callbacks, and SQLite-backed sync logic
- `src/lib/db/schema.ts`: Drizzle schema for persisted data
- `extension/`: Chrome extension for manual profile capture

The local development server runs the Express backend and serves the Vite frontend from the same origin.

## Requirements

- Node.js 22+
- npm

## Local-first beta quickstart

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file:

   ```bash
   cp .env.example .env.local
   ```

3. Edit `.env.local` for local-first beta use:

   - `APP_MODE`: `local`, `test`, or `hosted`; defaults to `test` when `NODE_ENV=test`, `local` when `NODE_ENV=development`, and `hosted` otherwise
   - `APP_URL`: use `http://localhost:3000` for local OAuth callback testing
   - `CONTACTBRIDGE_CORS_ORIGINS`: only needed for hosted or split-origin setups
   - `CONTACTBRIDGE_SECRET_KEY`: only required in hosted mode
   - `VITE_API_BASE_URL`: leave unset for same-origin local use
   - `CONTACTBRIDGE_DEMO_DATA_DIR`: keep `./test/demo-data` to enable safe demo fixture imports

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

6. Open the dashboard and confirm:
   - backend reachable
   - database reachable
   - export endpoints available
   - extension health available
   - current `APP_MODE`

7. Run a demo walkthrough without real provider tokens:

   ```bash
   npm run demo
   ```

   Then connect one demo source from **Sources** and run a sync, or point `CONTACTBRIDGE_DEMO_DATA_DIR` at your own fixture directory before starting the app.

8. Load the extension from `extension/`:
   - open `chrome://extensions`
   - enable **Developer mode**
   - choose **Load unpacked**
   - select `/home/runner/work/ContactBridge/ContactBridge/extension`
   - set the hub URL to `http://localhost:3000`

9. Capture one profile with the extension or import one profile from a configured source.

10. Open **Review Queue** and approve at least one candidate.

11. Open **Exports** and download CSV, JSON, or VCF. Only approved candidates are exported.

12. Run the local smoke check while the app is running:

   ```bash
   npm run smoke
   ```

## Local development

The quickstart above is the recommended local-first beta workflow. Use the sections below when you need deployment, extension, export, or verification details.

## Scripts

- `npm run dev`: start the local Express + Vite app
- `npm run demo`: start the app with bundled demo fixtures enabled
- `npm run test:integration`: run backend integration tests with bundled demo fixtures
- `npm run lint`: run TypeScript checks
- `npm run build:client`: build the static frontend only
- `npm run build`: build the frontend and bundle the Node server
- `npm run start`: run the production server bundle
- `npm run smoke`: verify `/api/health`, `/api/extension/health`, and export endpoints against `http://127.0.0.1:3000` (or `CONTACTBRIDGE_BASE_URL`)

## Production deployment

### Full application deployment

Use `npm run build` when you want the Express API and frontend deployed together on a Node-compatible host. ContactBridge is still single-user/local-first software: do not expose hosted mode to real users until authentication, authorization, CSRF protection, and per-user data ownership are implemented.

Required environment variables:

- `APP_MODE=hosted`: disables local-only destructive routes
- `APP_URL`: absolute backend origin, for example `https://api.example.com`
- `CONTACTBRIDGE_CORS_ORIGINS`: comma-separated list of trusted frontend origins
- `CONTACTBRIDGE_SECRET_KEY`: high-entropy secret used to encrypt stored provider tokens
- `VITE_API_BASE_URL`: optional absolute API origin for separately hosted frontends

### Step-by-step live switch guide

Use this checklist when you are ready to move ContactBridge from local or staging usage to the live environment.

1. Pick your production shape:
   - **Single host:** deploy the Express API and frontend together with `npm run build`
   - **Split host:** deploy the backend separately and publish the frontend with `npm run build:client` or GitHub Pages
2. Provision a public backend URL, set `APP_MODE=hosted`, and set `APP_URL` to that exact origin.
3. Choose a persistent SQLite file location and set `CONTACTBRIDGE_DB_PATH` if you do not want to use the default `sqlite.db` in the app directory.
4. Set `CONTACTBRIDGE_SECRET_KEY` and configure `CONTACTBRIDGE_CORS_ORIGINS` for the trusted frontend origin.
5. If the frontend will live on a different origin, set `VITE_API_BASE_URL` to the public backend URL before building the frontend.
6. Install dependencies and verify the release locally:

   ```bash
   npm install
   npm run test:integration
   npm run lint
   npm run build
   ```

7. If you already have production data, copy the current SQLite database to the new `CONTACTBRIDGE_DB_PATH` location before starting the new server.
8. Deploy the backend, start it with `npm run start`, and confirm `GET /api/health` returns `{"status":"ok","appMode":"hosted"}`.
9. Update OAuth callback settings so every provider points to the live backend:
   - `https://YOUR_APP_URL/auth/google/callback`
   - `https://YOUR_APP_URL/auth/x/callback`
10. If you are using a separately hosted frontend, build and publish that frontend only after `VITE_API_BASE_URL` is set for the live backend.
11. Switch traffic to the live deployment by updating DNS, your reverse proxy, or your public frontend URL.
12. Run a smoke test in production:
    - open the dashboard
    - add or reconnect a source
    - run a sync
    - review candidates
    - export contacts
13. Keep the previous deployment and database backup until the live instance has been stable long enough for you to roll back safely if needed.

Hosted mode fails closed at startup:

- Invalid `APP_MODE` values stop startup
- `CONTACTBRIDGE_SECRET_KEY` is required before startup completes
- CORS requires an explicit origin allowlist and rejects no-origin requests

### GitHub Pages frontend deployment

This repository includes a GitHub Actions workflow that deploys the Vite frontend to GitHub Pages on pushes to `main`.

Important:

- GitHub Pages hosts the frontend only
- The API, OAuth callbacks, and SQLite database still require a separate backend deployment
- Set `VITE_API_BASE_URL` in your frontend environment if the backend lives on another origin

The workflow uses:

- `VITE_BASE_PATH=/ContactBridge/`

If you fork this repository, update `.github/workflows/deploy-pages.yml` and the canonical social URLs in `index.html`.

## Browser extension

The Chrome extension lives in `extension/` and supports manual capture from LinkedIn, X, Bluesky, and XING. By default it only sends captured profile data to local hubs such as `http://localhost:3000`; production hub origins must be explicitly packaged into the extension before distribution. Before saving a hub URL, the extension validates `${hub}/api/extension/health` to confirm the target is a compatible ContactBridge hub.

## Export API endpoints

Frontend export buttons download server-generated files from:

- `GET /api/exports/contacts.csv`
- `GET /api/exports/contacts.json`
- `GET /api/exports/contacts.vcf`

Only approved candidates are exported.

To load it locally:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select `extension/`
5. Set the hub URL to `http://localhost:3000`
6. Production extension builds must explicitly package any non-local hub origins before distribution

## Demo mode

ContactBridge can run safely with local demo fixtures so you can test imports without real provider tokens.

1. Keep `CONTACTBRIDGE_DEMO_DATA_DIR="./test/demo-data"` in `.env.local`, or run:

   ```bash
   npm run demo
   ```

2. Start the app and connect a supported source from **Sources**.
3. Run the sync flow. ContactBridge will load local JSON fixtures instead of live provider data when a matching fixture file exists.
4. Review, approve, and export the demo contacts just like a real local session.

`CONTACTBRIDGE_DEMO_DATA_DIR` is exposed in runtime status only as an enabled/disabled flag; the app does not leak fixture filesystem paths.

## Local backup and restore

- `GET /api/database/backup`: download a local/test JSON backup of the SQLite-backed data
- `POST /api/database/restore`: restore a local/test backup with `x-contactbridge-confirm-restore: restore-local-data`
- Hosted mode blocks both restore and other local-only destructive flows

## Key Files Detector helper prompt

Use this prompt when you want an assistant to identify the most relevant files before making changes:

```text
You are reviewing the ContactBridge repository. Identify the key files for this task, grouped by frontend, backend, data model, deployment, and documentation. For each file, explain in one sentence why it matters and which change risks it affects.
```

## Verification

Before opening a pull request, run:

```bash
npm run test:integration
npm run lint
npm run build
npm run smoke
```

## Local-first beta boundaries

See `docs/LOCAL_FIRST_BETA.md` for what is currently safe in local usage, what is not yet safe for hosted multi-user usage, and what remains before public hosted rollout.
