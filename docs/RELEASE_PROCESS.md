# ContactBridge v0.1.0-beta.1 Release Process

Use this checklist for the manual `v0.1.0-beta.1` beta cut.

## Release steps

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Run integration tests:

   ```bash
   npm run test:integration
   ```

3. Run TypeScript linting:

   ```bash
   npm run lint
   ```

4. Build the frontend and bundled server:

   ```bash
   npm run build
   ```

5. Start the built app in test/demo mode and wait for `/api/health`:

   ```bash
   APP_MODE=test \
   NODE_ENV=test \
   CONTACTBRIDGE_DEMO_DATA_DIR=./test/demo-data \
   CONTACTBRIDGE_DB_PATH=/tmp/contactbridge-release.sqlite \
   CONTACTBRIDGE_BASE_URL=http://127.0.0.1:3000 \
   PORT=3000 \
   node dist/server.cjs
   ```

   In a second terminal, wait until the server responds:

   ```bash
   until curl -fsS http://127.0.0.1:3000/api/health > /dev/null; do sleep 1; done
   ```

6. Run smoke verification against the built app:

   ```bash
   npm run smoke
   ```

7. Manually run the demo flow:

   ```bash
   npm run demo
   ```

8. Manually load the unpacked extension from `extension/`.
9. Capture one supported profile with the extension.
10. Approve one candidate in the review queue.
11. Export approved contacts as CSV, JSON, and VCF.
12. Create the release tag:

   ```bash
   git tag v0.1.0-beta.1
   git push origin v0.1.0-beta.1
   ```

13. Create a GitHub Release from `docs/RELEASE_NOTES_BETA.md`:
    - Title: `ContactBridge v0.1.0-beta.1`
    - Label: `Local-first beta`

## Rollback

If a critical issue is found before announcement, delete the GitHub Release and remove the tag before retrying:

```bash
git push --delete origin v0.1.0-beta.1
git tag -d v0.1.0-beta.1
```
