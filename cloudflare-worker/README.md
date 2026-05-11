# SCKL Run Notes Worker

This Worker lets the static GitHub Pages dashboard write simple notes for Strava runs into the Google Sheet without exposing Google credentials in the browser.

## Data Flow

```text
Dashboard note form
-> Cloudflare Worker /notes with bearer passcode
-> Google Sheets API
-> Run Notes tab
```

The Worker stores notes in a separate `Run Notes` tab using this schema:

```text
Activity ID | Date | Activity | Note | Strava URL | Updated At
```

## Setup

1. Install Wrangler locally if needed.

```bash
npm install -g wrangler
wrangler login
```

2. Copy the example config.

```bash
cp cloudflare-worker/wrangler.toml.example cloudflare-worker/wrangler.toml
```

3. Add Worker secrets.

```bash
cd cloudflare-worker
wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
wrangler secret put RUN_NOTES_TOKEN
```

Use the same Google service account JSON used by GitHub Actions. `RUN_NOTES_TOKEN` is the passcode the website will ask for before saving or loading notes.

4. Deploy the Worker.

```bash
wrangler deploy
```

5. Copy the deployed Worker URL into the public site config.

```js
// config.js
window.SCKL_CONFIG = {
  runNotesApiUrl: "https://sckl-run-notes.<your-subdomain>.workers.dev"
};
```

6. Commit and push the config change so GitHub Pages redeploys.

## Security Notes

- Google credentials stay only in Cloudflare Worker secrets.
- Reading and writing notes both require the run-note passcode.
- Notes are capped at 500 characters per activity.
- Keep `ALLOWED_ORIGIN` set to the GitHub Pages origin unless you are testing locally.
- The browser stores only your run-note passcode in localStorage after the first save.
- Anyone with both the public site and the passcode can edit run notes, so keep the passcode private.
- The Worker is intentionally scoped to run notes only, not arbitrary sheet editing.
