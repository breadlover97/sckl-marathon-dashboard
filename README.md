# SCKL 2026 Sub-2:50 Build

A lightweight static dashboard for the Standard Chartered Kuala Lumpur Marathon 2026 build.

The site is intentionally simple: Google Sheets is the editable plan, Strava is the running log, GitHub Actions syncs private data into safe JSON, and GitHub Pages serves the dashboard.

## What The Dashboard Shows

- This week’s planned sessions, actual Strava mileage, and read-only nutrition status synced from Google Sheets.
- Week-by-week marathon plan from Google Sheets.
- Planned vs actual weekly mileage and long-run trends.
- Recent Strava activity feed with pace, time, elevation, heart rate, cadence, and Strava links.
- Standalone nutrition tracker with daily totals, targets, rolling averages, meal rows, confidence, and notes.
- Race execution draft page with pace calculator and split table.

## Local Preview

```bash
python3 -m http.server 8010
```

Open `http://localhost:8010`.

The dashboard loads `data/training-plan.json`, `data/strava-activities.json`, and `data/nutrition.json` when available. If live files are missing, it falls back to the mock JSON files in `data/`.

## Repository Map

```text
index.html                         Main dashboard
nutrition.html                     Standalone nutrition tracker
race.html                          Race execution page
backend.html                       How-it-works page
styles.css                         Shared visual system and themes
app.js                             Dashboard rendering, charts, and local checks
nutrition.js                       Nutrition rendering, daily totals, and meal groups
race.js                            Pace calculator and race page interactions
theme.js                           Theme persistence
data/mock-*.json                   Local fallback data
scripts/fetch_google_sheet.py      Google Sheets -> dashboard JSON
scripts/process_nutrition_ai.py    Private AI nutrition estimator -> Google Sheets
scripts/fetch_strava.py            Strava API -> dashboard JSON
scripts/exchange_strava_code.py    One-time Strava OAuth helper
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
export GOOGLE_SHEET_RANGE=A:AF
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/google-service-account.json
python scripts/fetch_google_sheet.py
```

The script writes `data/training-plan.json` and `data/nutrition.json`.

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
4. Optionally estimates raw nutrition logs with OpenAI and writes the results back to Google Sheets.
5. Publishes the static site files and generated dashboard JSON files to GitHub Pages.

Required repository secrets:

```text
GOOGLE_SERVICE_ACCOUNT_JSON
STRAVA_CLIENT_ID
STRAVA_CLIENT_SECRET
STRAVA_REFRESH_TOKEN
```

Optional repository secret for AI nutrition processing:

```text
OPENAI_API_KEY
```

Optional repository variables:

```text
GOOGLE_SHEET_ID
GOOGLE_SHEET_RANGE
OPENAI_NUTRITION_MODEL
```

If the optional variables are not set, the workflow uses:

```text
GOOGLE_SHEET_ID=1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo
GOOGLE_SHEET_RANGE=A:AF
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

## Nutrition History

Nutrition rows live in the Google Sheet, not on the website. The `Nutrition` tab is meal-level and uses these synced columns:

```text
Date
Meal
Raw Food Log
Estimation Guidelines
Calorie Target
Protein Target g
Food Item
Calories
Protein g
Carbs g
Fat g
Fibre g
Sodium mg
Confidence
Assumptions
Source
Notes
AI Status
AI Processed At
AI Error
```

Typical workflow:

1. Fill `Date`, choose a `Meal` from the dropdown, and add `Raw Food Log`.
2. Add optional `Estimation Guidelines`, for example "hawker portion, include soup sodium" or "higher confidence if packaged label is provided".
3. Leave the macro columns blank.
4. GitHub Actions runs `scripts/process_nutrition_ai.py`.
5. The script calls OpenAI from the private Actions runner, writes calories, macros, confidence, assumptions, source, notes, and AI status back to Google Sheets.
6. `scripts/fetch_google_sheet.py` then exports `Nutrition!A:T` to `data/nutrition.json`, but the generated JSON only includes the public nutrition fields used by the site.

If `OPENAI_API_KEY` is not set, the AI step safely skips and the normal dashboard sync still runs.

The main dashboard shows a compact daily nutrition status, while `nutrition.html` shows the full daily and meal-level history.

The generated JSON structure is:

```json
{
  "metadata": {
    "source": "google-sheet:...",
    "generated_at": "2026-05-12T14:16:59+08:00",
    "included_days": 1,
    "included_meals": 3
  },
  "days": [
    {
      "date": "2026-05-12",
      "calories": 2750,
      "protein_g": 158,
      "carbs_g": 330,
      "fat_g": 82,
      "fibre_g": 30,
      "sodium_mg": 2400,
      "calorie_target": 2800,
      "protein_target_g": 160,
      "seven_day_average_calories": 2680,
      "seven_day_average_protein_g": 151,
      "confidence": 82,
      "assumptions": "Portions estimated",
      "source": "manual",
      "notes": "",
      "meal_count": 3,
      "meals": []
    }
  ],
  "nutrition": [
    {
      "date": "2026-05-12",
      "meal": "Breakfast",
      "food_item": "Oats, banana, whey",
      "calories": 720,
      "protein_g": 42,
      "carbs_g": 104,
      "fat_g": 15,
      "fibre_g": 12,
      "sodium_mg": 430,
      "calorie_target": 2800,
      "protein_target_g": 160,
      "confidence": 85,
      "assumptions": "Standard scoop of whey",
      "source": "manual",
      "notes": ""
    }
  ]
}
```

Google Sheets is the cross-device source of truth. The website displays nutrition history only after the scheduled or manual GitHub Actions sync regenerates `data/nutrition.json`.

## Security Notes

- Never commit `.env`, Google service account JSON, generated Strava token JSON, or local credential files.
- GitHub Actions secrets should hold `GOOGLE_SERVICE_ACCOUNT_JSON`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, and `STRAVA_REFRESH_TOKEN`. Add `OPENAI_API_KEY` to enable AI nutrition processing.
- The frontend must not contain Strava client secrets or Google credentials.
- The frontend must not call OpenAI directly. AI nutrition processing runs only from GitHub Actions or a local private script, then syncs static JSON.
- The Google service account needs Editor access to the sheet if AI processing should write estimates back into the `Nutrition` tab. Viewer access is still enough for read-only plan/nutrition sync.
- Rotate Strava tokens and Google service account keys if they are ever pasted into chat, committed, or shared.
- The site is public on GitHub Pages, so generated JSON should be treated as public data.

## Checks

```bash
python3 scripts/fetch_google_sheet.py --input-json data/training-plan.json --dry-run
python3 -m py_compile scripts/fetch_google_sheet.py
python3 -m py_compile scripts/process_nutrition_ai.py
python3 -m py_compile scripts/fetch_strava.py
python3 -m py_compile scripts/exchange_strava_code.py
node --check app.js
node --check nutrition.js
node --check race.js
node --check theme.js
```

For a visual QC pass, run the local preview server and check:

- Dashboard nav links: This Week, Weekly Plan, Trends, Pace, Activities.
- Footer link to the backend page.
- Race button and race page calculator.
- Theme switching across Light, Dark, IDE editor, and Cyberpunk.
- Chart hover popups on desktop and resized charts on mobile.
- Activity links open Strava in a new tab.
