# ContactBridge Extension Packaging

## Local beta: load unpacked

For the local-first beta, load the extension unpacked from `extension/`:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select the repository `extension/` directory
5. Click the ContactBridge extension button (pin it first if it only appears in the browser extensions menu) to open the side panel, then set the local hub URL

## Optional host permissions

The extension uses `optional_host_permissions` so capture access is granted only for the sites you explicitly approve. This keeps the beta narrower than a broad always-on extension.

## Why production hub origins are packaged

Local hubs such as `http://localhost:3000` work by default.

Non-local production hub origins must be explicitly packaged because the extension should not send captured data to arbitrary remote origins by default.

## Manual beta ZIP packaging

A simple manual packaging flow:

1. Confirm the extension works locally in unpacked mode
2. Review the packaged production hub origins you intend to allow
3. Zip the contents of `extension/` for beta distribution
4. Document the exact extension version and allowed origins alongside the ZIP

## What not to do

- no broad host permissions by default
- no background scraping
- no browsing history collection
- no silent capture from tabs the user did not explicitly choose
