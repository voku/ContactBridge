# ContactBridge

ContactBridge is a privacy-first social contact hub. It imports profiles from supported sources, groups them into reviewable candidates, supports manual profile capture from XING, and exports approved contacts as CSV, JSON, or vCard files.

## Features

- Import contacts from Bluesky, GitHub, Google Contacts, LinkedIn, Mastodon, and X
- Capture public profiles manually from XING with the browser extension
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

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file:

   ```bash
   cp .env.example .env.local
   ```

3. Set the values you need:

   - `APP_URL`: public backend URL used for OAuth callbacks
   - `VITE_API_BASE_URL`: optional frontend API origin when the UI is hosted separately

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

## Scripts

- `npm run dev`: start the local Express + Vite app
- `npm run test:integration`: run backend integration tests with bundled demo fixtures
- `npm run lint`: run TypeScript checks
- `npm run build:client`: build the static frontend only
- `npm run build`: build the frontend and bundle the Node server
- `npm run start`: run the production server bundle

## Production deployment

### Full application deployment

Use `npm run build` when you want the Express API and frontend deployed together on a Node-compatible host.

Required environment variables:

- `APP_URL`: absolute backend origin, for example `https://api.example.com`
- `VITE_API_BASE_URL`: optional absolute API origin for separately hosted frontends

### Step-by-step live switch guide

Use this checklist when you are ready to move ContactBridge from local or staging usage to the live environment.

1. Pick your production shape:
   - **Single host:** deploy the Express API and frontend together with `npm run build`
   - **Split host:** deploy the backend separately and publish the frontend with `npm run build:client` or GitHub Pages
2. Provision a public backend URL and set `APP_URL` to that exact origin.
3. Choose a persistent SQLite file location and set `CONTACTBRIDGE_DB_PATH` if you do not want to use the default `sqlite.db` in the app directory.
4. If the frontend will live on a different origin, set `VITE_API_BASE_URL` to the public backend URL before building the frontend.
5. Install dependencies and verify the release locally:

   ```bash
   npm install
   npm run test:integration
   npm run lint
   npm run build
   ```

6. If you already have production data, copy the current SQLite database to the new `CONTACTBRIDGE_DB_PATH` location before starting the new server.
7. Deploy the backend, start it with `npm run start`, and confirm `GET /api/health` returns `{"status":"ok"}`.
8. Update OAuth callback settings so every provider points to the live backend:
   - `https://YOUR_APP_URL/auth/google/callback`
   - `https://YOUR_APP_URL/auth/x/callback`
9. If you are using a separately hosted frontend, build and publish that frontend only after `VITE_API_BASE_URL` is set for the live backend.
10. Switch traffic to the live deployment by updating DNS, your reverse proxy, or your public frontend URL.
11. Run a smoke test in production:
    - open the dashboard
    - add or reconnect a source
    - run a sync
    - review candidates
    - export contacts
12. Keep the previous deployment and database backup until the live instance has been stable long enough for you to roll back safely if needed.

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

The Chrome extension lives in `extension/` and supports manual capture from LinkedIn, X, Bluesky, and XING.

To load it locally:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select `extension/`

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
```
