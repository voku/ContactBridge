# ContactBridge Demo Walkthrough

This walkthrough exercises the local-first beta without real provider tokens.

## 1. Clone and install

```bash
git clone https://github.com/voku/ContactBridge.git
cd ContactBridge
npm ci
```

## 2. Copy the local environment file

```bash
cp .env.example .env.local
```

Recommended local beta values:

```dotenv
APP_MODE="local"
APP_URL="http://localhost:3000"
CONTACTBRIDGE_DEMO_DATA_DIR="./test/demo-data"
```

## 3. Start demo mode

```bash
npm run demo
```

Leave that terminal running.

## 4. Open the dashboard

Open:

```text
http://localhost:3000
```

Confirm the dashboard shows:

- backend reachable
- database reachable
- export endpoints available
- extension health available
- local or test `APP_MODE`

## 5. Import demo data

Open **Sources** and connect one demo-backed source.

Use any of these demo-safe inputs:

- Bluesky: identifier `demo.bsky.social`, password `demo-app-password`
- Mastodon: instance `mastodon.social`, token `demo-token`
- X: access token `demo-token`
- LinkedIn: handle `demo-linkedin`, token `demo-token`
- GitHub: token `demo-token`
- Google Contacts: token `demo-token`

Then run sync for that source. When demo fixtures are enabled, ContactBridge loads local fixture data instead of real provider data.

## 6. Capture one manual profile with the extension

Load the extension unpacked:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the repository `extension/` directory
5. Open the side panel and set the hub URL to `http://localhost:3000`

Then visit one supported profile page and capture it manually:

- LinkedIn
- X
- Bluesky
- XING

## 7. Approve one candidate

Open **Review Queue** and approve at least one candidate.

## 8. Export CSV, JSON, and VCF

Open **Export Data** and download:

- CSV
- JSON
- VCF

Only approved candidates are exported.

## 9. Run the smoke checks

In a second terminal:

```bash
npm run smoke
```

## 10. Back up local data

```bash
export CONTACTBRIDGE_BASE_URL="http://127.0.0.1:3000"
curl -fsS "$CONTACTBRIDGE_BASE_URL/api/database/backup" -o /tmp/contactbridge-backup.json
```

## 11. Restore local data

```bash
curl -fsS -X POST "$CONTACTBRIDGE_BASE_URL/api/database/restore" \
  -H 'Content-Type: application/json' \
  -H 'X-ContactBridge-Confirm-Restore: restore-local-data' \
  --data-binary @/tmp/contactbridge-backup.json
```

## 12. Reset local data

```bash
curl -fsS -X DELETE "$CONTACTBRIDGE_BASE_URL/api/database" \
  -H 'X-ContactBridge-Confirm-Reset: erase-local-data'
```

## 13. Optional final verification

```bash
npm run test:integration
npm run lint
npm run build
```
