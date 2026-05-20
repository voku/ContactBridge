# ContactBridge Capture Privacy

ContactBridge Capture is an optional manual-capture helper for the local ContactBridge hub.

- The extension only runs profile extraction after the user grants optional host permission for a supported site.
- Captured data is limited to public profile fields shown on the active page, such as display name, handle, headline, and profile URL.
- Captures are sent only when the user clicks **Save this profile**.
- By default, the extension only accepts local ContactBridge hub URLs such as `http://localhost:3000`.
- The manifest includes loopback hub permissions for `localhost` and `127.0.0.1` so local validation and capture requests can succeed without broad remote access.
- Production hub origins must be explicitly packaged into the extension before distribution.
- The extension does not scrape background pages, does not collect browsing history, and does not use remotely hosted code.
