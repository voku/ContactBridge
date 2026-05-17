# ContactBridge

ContactBridge is a privacy-first social contact hub. It imports profiles from supported sources, groups them into reviewable candidates, and exports approved contacts as CSV, JSON, or vCard files.

## Features

- Import contacts from Bluesky, GitHub, Google Contacts, LinkedIn, Mastodon, and X
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

The Chrome extension lives in `extension/`.

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
npm run lint
npm run build
```
