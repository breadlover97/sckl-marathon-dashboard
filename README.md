# SCKL 2026 Sub-2:50 Build

A lightweight static dashboard for the Standard Chartered Kuala Lumpur Marathon 2026 build.

The site is intentionally simple: Google Sheets is the editable plan, Strava is the running log, GitHub Actions syncs private data into safe JSON, and GitHub Pages serves the dashboard.

## What The Dashboard Shows

- This week’s planned sessions, actual Strava mileage, supplement input under the weekly progress bar, and read-only supplement status inside each day card.
- Week-by-week marathon plan from Google Sheets.
- Planned vs actual weekly mileage and long-run trends.
- Recent Strava activity feed with pace, time, elevation, heart rate, cadence, links, and optional run notes.
- Race execution draft page with pace calculator and split table.

## Local Preview

```bash
python3 -m http.server 8010
```

Open `http://localhost:8010`.

The dashboard loads `data/training-plan.json` and `data/strava-activities.json` when available. If live files are missing, it falls back to the mock JSON files in `data/`.

## Repository Map

```text
index.html                         Main dashboard
race.html                          Race execution page
backend.html                       How-it-works page
styles.css                         Shared visual system and themes
app.js                             Dashboard rendering, charts, notes, and local checks
race.js                            Pace calculator and race page interactions
theme.js                           Theme persistence
config.js                          Public frontend config
data/mock-*.json                   Local fallback data
scripts/fetch_google_sheet.py      Google Sheets -> dashboard JSON
scripts/fetch_strava.py            Strava API -> dashboard JSON
scripts/exchange_strava_code.py    One-time Strava OAuth helper
cloudflare-worker/                 Optional run-note writeback API
.github/workflows/deploy-pages.yml Scheduled/manual sync and GitHub Pages deploy
```

## Google Sheets API Setup

The Google Sheet is the editable source of truth for planned training. The browser never reads Google credentials directly; the server-side sync script reads the Sheet and writes safe dashboard JSON.

Expected columns:

```text
Week Number
Week Start Date
Phase
Target Weekly Mileage KM
Monday Date
Monday Plan
Monday Estimated KM
Tuesday Date
Tuesday Plan
Tuesday Estimated KM
Wednesday Date
Wednesday Plan
Wednesday Estimated KM
Thursday Date
Thursday Plan
Thursday Estimated KM
Friday Date
Friday Plan
Friday Estimated KM
Saturday Date
Saturday Plan
Saturday Estimated KM
Sunday Date
Sunday Plan
Sunday Estimated KM
Key Workout
Long Run Distance KM
Long Run Notes
Strength Training
Fuel Practice
Sleep / Recovery Focus
Notes
Week Summary
```

1. In Google Cloud, enable the Google Sheets API.
2. Create a service account and download its JSON key.
3. Share the training Google Sheet with the service account email using Viewer access.
4. Install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

5. Export credentials and sync:

```bash
export GOOGLE_SHEET_ID=1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo
export GOOGLE_SHEET_RANGE=A:AG
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/google-service-account.json
python scripts/fetch_google_sheet.py
```

The script writes `data/training-plan.json`.

Recommended sheet formatting:

- Keep `Week Start Date` in `YYYY-MM-DD` format.
- Keep daily estimated mileage columns numeric where possible.
- Leave the column headers exactly as listed above; order can change, but names should not.

## Strava Actuals Sync

The dashboard reads actual training from `data/strava-activities.json` when available. Without that file, it falls back to `data/mock-strava-activities.json`.

If your refresh token does not have activity permission, re-authorize the Strava app with:

```text
https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&response_type=code&approval_prompt=force&scope=read,activity:read_all
```

After approving, copy the `code=...` value from the redirected URL and exchange it:

```bash
export STRAVA_CLIENT_ID=your_client_id
export STRAVA_CLIENT_SECRET=your_client_secret
python scripts/exchange_strava_code.py --code THE_CODE_FROM_THE_URL
```

Then use the generated `refresh_token`:

```bash
export STRAVA_CLIENT_ID=your_client_id
export STRAVA_CLIENT_SECRET=your_client_secret
export STRAVA_REFRESH_TOKEN=your_refresh_token
python scripts/fetch_strava.py
```

The browser only reads sanitized run data. Strava secrets stay in your shell, local environment, or deployment secrets.

Published Strava JSON intentionally includes only the public training metrics used by the dashboard: activity ID, name, date, distance, time, elevation, heart rate, cadence, Strava link, and basic athlete profile image/name if Strava returns them. Do not publish fields you would not want visible on the public GitHub Pages site.

## GitHub Pages Deployment

GitHub Pages is deployed by `.github/workflows/deploy-pages.yml`.

The workflow:

1. Installs the Python dependencies.
2. Fetches the latest planned training from Google Sheets.
3. Fetches Strava run activities from 1 May 2026 onward.
4. Publishes the static site files and generated dashboard JSON files to GitHub Pages.

Required repository secrets:

```text
GOOGLE_SERVICE_ACCOUNT_JSON
STRAVA_CLIENT_ID
STRAVA_CLIENT_SECRET
STRAVA_REFRESH_TOKEN
```

Optional repository variables:

```text
GOOGLE_SHEET_ID
GOOGLE_SHEET_RANGE
```

If the optional variables are not set, the workflow uses:

```text
GOOGLE_SHEET_ID=1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo
GOOGLE_SHEET_RANGE=A:AG
```

To enable Pages:

1. Open the GitHub repository.
2. Go to **Settings**.
3. Go to **Pages**.
4. Under **Build and deployment**, set **Source** to **GitHub Actions**.
5. Go to **Actions**.
6. Run **Sync data and deploy Pages** manually once.

The workflow also runs daily at 12:15am Singapore time and whenever `main` is pushed.

Important Strava note: if a workflow run says Strava returned a rotated refresh token, generate or copy the new refresh token and update the `STRAVA_REFRESH_TOKEN` repository secret before the next sync.

## Run Notes And Supplements Writeback

Run notes and supplement checks are written through a Cloudflare Worker so Google credentials are not exposed on GitHub Pages.

Flow:

```text
Website note form -> Cloudflare Worker /notes -> Google Sheets API -> Run Notes tab
Supplement checkbox -> Cloudflare Worker /supplements -> Google Sheets API -> Supplements tab
```

The `Run Notes` tab is created automatically by the Worker the first time notes are loaded or saved. It may not exist yet if no note has been saved.

Setup:

1. Copy `cloudflare-worker/wrangler.toml.example` to `cloudflare-worker/wrangler.toml`.
2. In `cloudflare-worker`, run:

```bash
wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
wrangler secret put RUN_NOTES_TOKEN
wrangler deploy
```

3. Copy the deployed Worker URL into `config.js`:

```js
window.SCKL_CONFIG = {
  runNotesApiUrl: "https://sckl-run-notes.<your-subdomain>.workers.dev"
};
```

4. Commit and push `config.js`.

The first time you save a note from the website, it asks for `RUN_NOTES_TOKEN` and stores it in browser localStorage. Reading existing notes also requires that stored passcode, so notes are not exposed as a public unauthenticated API.

## Supplement Checks

Supplement checks are saved to the `Supplements` tab through the Cloudflare Worker when `runNotesApiUrl` is configured. The browser also keeps a local cache under the `sckl-wellness-checks` localStorage key so the dashboard still displays recent checks if the Worker is unavailable.

The local cache structure is keyed by date:

```json
{
  "2026-05-12": {
    "protein": true,
    "omega3": true,
    "vitaminD": false
  }
}
```

Google Sheets is the cross-device source of truth once the Worker is deployed. Clearing browser site data removes only the local cache and passcode, not rows already written to the `Supplements` tab.

## Security Notes

- Never commit `.env`, Google service account JSON, generated Strava token JSON, or local credential files.
- GitHub Actions secrets should hold `GOOGLE_SERVICE_ACCOUNT_JSON`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, and `STRAVA_REFRESH_TOKEN`.
- The frontend must not contain Strava client secrets, Google credentials, or Worker secrets.
- `config.js` is public. Only put public settings there, such as the Worker URL.
- The Cloudflare Worker is scoped to the `Run Notes` and `Supplements` tabs and requires a bearer passcode for reading or writing notes and supplement checks.
- Set the Worker `ALLOWED_ORIGIN` variable to the GitHub Pages URL in production so browser calls are limited to the dashboard origin. This is a CORS guard, not a replacement for the passcode.
- Rotate `RUN_NOTES_TOKEN`, Strava tokens, and Google service account keys if they are ever pasted into chat, committed, or shared.
- The site is public on GitHub Pages, so generated JSON should be treated as public data.

## Checks

```bash
python3 scripts/fetch_google_sheet.py --input-json data/training-plan.json --dry-run
python3 -m py_compile scripts/fetch_google_sheet.py
python3 -m py_compile scripts/fetch_strava.py
python3 -m py_compile scripts/exchange_strava_code.py
node --check app.js
node --check race.js
node --check theme.js
node --check cloudflare-worker/src/index.js
```

For a visual QC pass, run the local preview server and check:

- Dashboard nav links: This Week, Weekly Plan, Trends, Pace, Activities.
- Footer link to the backend page.
- Race button and race page calculator.
- Theme switching across Light, Dark, IDE editor, and Cyberpunk.
- Chart hover popups on desktop and resized charts on mobile.
- Activity links open Strava in a new tab.
