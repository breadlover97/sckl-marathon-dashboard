# SCKL Dashboard Worker

This Worker lets the static GitHub Pages dashboard write run notes and supplement checks into the Google Sheet without exposing Google credentials in the browser.

## Data Flow

```text
Dashboard note form or supplement checkbox
-> Cloudflare Worker /notes or /supplements with bearer passcode
-> Google Sheets API
-> Run Notes or Supplements tab
```

The Worker stores notes in a separate `Run Notes` tab using this schema. If the tab does not exist yet, the Worker creates it on the first successful notes request.

```text
Activity ID | Date | Activity | Note | Strava URL | Updated At
```

The Worker stores supplement checks in a separate `Supplements` tab using this schema:

```text
Date | Protein Shake | Omega 3 | Vitamin D | Updated At
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
base64 -i ../service-account.json | wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON_B64
wrangler secret put RUN_NOTES_TOKEN
```

Use the same Google service account JSON used by GitHub Actions. Base64 is preferred because it avoids broken multi-line private keys in terminal prompts. `RUN_NOTES_TOKEN` is the passcode the website will ask for before saving or loading notes.

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
- Reading and writing notes or supplement checks both require the passcode.
- Notes are capped at 500 characters per activity.
- Keep `ALLOWED_ORIGIN` set to the GitHub Pages origin unless you are testing locally.
- The browser stores only your dashboard passcode in localStorage after the first save.
- Anyone with both the public site and the passcode can edit run notes and supplement checks, so keep the passcode private.
- Rotate `RUN_NOTES_TOKEN` and the Google service account key if either one is pasted into chat, committed, or shared.
- The Worker is intentionally scoped to run notes and supplement checks only, not arbitrary sheet editing.
