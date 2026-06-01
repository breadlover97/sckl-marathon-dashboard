# SCKL 2026 Sub-2:50 Build

A lightweight static dashboard for the Standard Chartered Kuala Lumpur Marathon 2026 build.

The site is intentionally simple: Google Sheets is the editable plan, Strava is the running log, GitHub Actions syncs private data into generated JSON, and Cloudflare Pages serves the dashboard.

## What The Dashboard Shows

- This week’s planned sessions and actual Strava mileage.
- Week-by-week marathon plan from Google Sheets.
- Planned vs actual weekly mileage and long-run trends.
- Recent Strava activity feed with pace, time, elevation, heart rate, cadence, and Strava links.
- Standalone nutrition tracker with calendar view, supplement checkboxes, targets, meal rows, confidence, and notes.
- Race execution draft page with pace calculator and split table.

## Local Preview

```bash
python3 -m http.server 8010
```

Open `http://localhost:8010`.

The dashboard loads `data/training-plan.json` and `data/strava-activities.json` when available. The standalone nutrition page loads `data/nutrition.json` and `data/supplements.json`. If live files are missing, the site falls back to the mock JSON files in `data/`.

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
scripts/sync_strava_actuals_to_sheet.py  Strava JSON -> Google Sheet actual columns
scripts/sync_training_calendar.py  Training Plan -> Google Calendar events
scripts/exchange_strava_code.py    One-time Strava OAuth helper
.github/workflows/deploy-pages.yml Scheduled/manual sync and Cloudflare Pages deploy
.github/workflows/sync-calendar.yml Manual Google Calendar training sync
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
Monday Actual
Monday Actual Distance Ran
Tuesday Date
Tuesday Plan
Tuesday Estimated KM
Tuesday Actual
Tuesday Actual Distance Ran
Wednesday Date
Wednesday Plan
Wednesday Estimated KM
Wednesday Actual
Wednesday Actual Distance Ran
Thursday Date
Thursday Plan
Thursday Estimated KM
Thursday Actual
Thursday Actual Distance Ran
Friday Date
Friday Plan
Friday Estimated KM
Friday Actual
Friday Actual Distance Ran
Saturday Date
Saturday Plan
Saturday Estimated KM
Saturday Actual
Saturday Actual Distance Ran
Sunday Date
Sunday Plan
Sunday Estimated KM
Sunday Actual
Sunday Actual Distance Ran
Key Workout
Long Run Distance KM
Notes
Week Summary
```

1. In Google Cloud, enable the Google Sheets API.
2. Create a service account and download its JSON key.
3. Share the training Google Sheet with the service account email using Editor access.
4. Install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

5. Export credentials and sync:

```bash
export GOOGLE_SHEET_ID=1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo
export GOOGLE_SHEET_RANGE=A:AQ
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/google-service-account.json
python scripts/fetch_google_sheet.py
```

The script writes `data/training-plan.json`, `data/supplements.json`, and `data/nutrition.json`.

Recommended sheet formatting:

- Keep `Week Start Date` in `YYYY-MM-DD` format.
- Keep daily estimated mileage columns numeric where possible.
- Leave daily actual columns alone unless you need to manually override Strava data.
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

Published Strava JSON intentionally includes only the public training metrics used by the dashboard: activity ID, name, date, distance, time, elevation, heart rate, cadence, Strava link, and basic athlete profile image/name if Strava returns them. Do not publish fields you would not want visible on the public Cloudflare Pages site.

To write synced Strava runs back into the training sheet:

```bash
export GOOGLE_SHEET_ID=1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/google-service-account.json
python scripts/fetch_strava.py
python scripts/sync_strava_actuals_to_sheet.py
python scripts/fetch_google_sheet.py
```

`sync_strava_actuals_to_sheet.py` only writes the `{Day} Actual` and `{Day} Actual Distance Ran` columns. It does not change planned workouts, notes, phases, or weekly summaries.

## Training Calendar Sync

The Google Sheet remains the source of truth for planned training, while Google Calendar holds the runnable schedule. `scripts/sync_training_calendar.py` compares the Sheet plan with calendar events and then creates, updates, adopts, or optionally deletes managed events.

The sync rules currently match your preferred calendar setup:

- Wednesday runs are skipped by default because the recurring RD Wed run already exists in Google Calendar.
- Monday interval workouts are scheduled 7:00pm-9:00pm.
- Easy, recovery, relaxed, rolling, and medium runs are scheduled 9:30pm-10:30pm unless another timed calendar event ends after 9:00pm, then the run moves to 7:30am-8:30am.
- Long runs are scheduled 6:30am-8:30am.
- Race day is scheduled as `KL Marathon` from 3:30am-8:00am.
- Event titles are plain, without an `SCKL` prefix.
- Events use Google Calendar color ID `11`, which is tomato/red, and have no reminders.

The script writes hidden private event metadata, not visible descriptions:

```text
scklCalendarSync=training-plan-v1
scklPlanId=sckl-YYYY-MM-DD-day
```

That metadata is the sync layer. After the first run, later Sheet changes can update the same calendar event instead of creating duplicates. On the first apply, the script also tries to adopt existing manually-created events when the title, date, start time, and end time match.

Google Calendar setup:

1. Enable the Google Calendar API in the same Google Cloud project.
2. Share the target Google Calendar with the service account email and give it permission to make changes to events.
3. Set `GOOGLE_CALENDAR_ID` to the target calendar ID or email. Do not rely on `primary` for a service account, because that points to the service account's own calendar.
4. Keep `GOOGLE_SERVICE_ACCOUNT_JSON` in GitHub Actions secrets or `GOOGLE_APPLICATION_CREDENTIALS` locally.

Local preview without touching Google Calendar:

```bash
python scripts/sync_training_calendar.py --input-json data/training-plan.json --no-calendar-awareness --preview-limit 20
```

Calendar-aware preview from the live Sheet:

```bash
export GOOGLE_CALENDAR_ID=your_calendar_id_or_email
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/google-service-account.json
python scripts/sync_training_calendar.py --preview-limit 120
```

Apply changes:

```bash
python scripts/sync_training_calendar.py --apply --preview-limit 120
```

Use `--delete-stale` only when you want the sync to delete previously managed training events that no longer exist in the Sheet. The manual GitHub Actions workflow is `.github/workflows/sync-calendar.yml`; start with `preview`, then run `apply` once the output looks right.

## Pages Deployment

The site is currently deployed to both GitHub Pages and Cloudflare Pages by `.github/workflows/deploy-pages.yml`. This keeps the existing GitHub Pages URL online while the project transitions to Cloudflare Pages.

The workflow:

1. Installs the Python dependencies.
2. Optionally estimates raw nutrition logs with OpenAI and writes the results back to Google Sheets.
3. Fetches Strava run activities from 1 May 2026 onward.
4. Writes Strava actuals into the daily actual columns in the `Training Plan` tab.
5. Fetches the latest planned training, supplement history, and nutrition history from Google Sheets.
6. Publishes the same static site files and generated dashboard JSON files to Cloudflare Pages and GitHub Pages.

Required repository secrets:

```text
GOOGLE_SERVICE_ACCOUNT_JSON
STRAVA_CLIENT_ID
STRAVA_CLIENT_SECRET
STRAVA_REFRESH_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

Optional repository secret for AI nutrition processing:

```text
OPENAI_API_KEY
```

Optional repository variables:

```text
CLOUDFLARE_PAGES_PROJECT_NAME
GOOGLE_SHEET_ID
GOOGLE_SHEET_RANGE
GOOGLE_SUPPLEMENTS_RANGE
GOOGLE_CALENDAR_ID
TRAINING_CALENDAR_TIMEZONE
TRAINING_CALENDAR_COLOR_ID
OPENAI_NUTRITION_MODEL
```

If `CLOUDFLARE_PAGES_PROJECT_NAME` is not set, the workflow deploys to `sckl-marathon-dashboard`.

If the optional variables are not set, the workflow uses:

```text
GOOGLE_SHEET_ID=1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo
GOOGLE_SHEET_RANGE=A:AQ
GOOGLE_SUPPLEMENTS_RANGE=Supplements!A:F
TRAINING_CALENDAR_TIMEZONE=Asia/Singapore
TRAINING_CALENDAR_COLOR_ID=11
```

To enable Cloudflare Pages deployment alongside GitHub Pages:

1. Create a Cloudflare Pages project named `sckl-marathon-dashboard`, or set `CLOUDFLARE_PAGES_PROJECT_NAME` to the project name you choose.
2. Create a Cloudflare API token with `Account > Cloudflare Pages > Edit` permission.
3. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets.
4. Go to **Actions** in GitHub.
5. Run **Sync data and deploy Pages** manually once.

The workflow also runs daily at 12:15am Singapore time and whenever `main` is pushed.

Important Strava note: if a workflow run says Strava returned a rotated refresh token, generate or copy the new refresh token and update the `STRAVA_REFRESH_TOKEN` repository secret before the next sync.

## Supplement History

Supplement rows live in the `Supplements` tab. The first three columns are `Date`, `Week`, and `Training Phase`; every column after that is treated as a supplement checkbox and synced to `data/supplements.json`.

The standalone nutrition page shows this supplement history alongside daily nutrition totals in its calendar view. The main dashboard does not display supplement or nutrition detail.

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

The main dashboard stays focused on training and Strava. `nutrition.html` shows supplement completion, daily nutrition totals, and meal-level history.

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

Google Sheets is the cross-device source of truth. The website displays supplement and nutrition history only after the scheduled or manual GitHub Actions sync regenerates `data/supplements.json` and `data/nutrition.json`.

## Security Notes

- Never commit `.env`, Google service account JSON, generated Strava token JSON, or local credential files.
- GitHub Actions secrets should hold `GOOGLE_SERVICE_ACCOUNT_JSON`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`. Add `OPENAI_API_KEY` to enable AI nutrition processing.
- The frontend must not contain Strava client secrets or Google credentials.
- The frontend must not call OpenAI directly. AI nutrition processing runs only from GitHub Actions or a local private script, then syncs static JSON.
- The Google service account needs Editor access to the sheet for Strava actual writeback and AI nutrition processing. Viewer access is only enough for read-only JSON sync.
- Rotate Strava tokens and Google service account keys if they are ever pasted into chat, committed, or shared.
- The site is public on Cloudflare Pages unless protected separately with Cloudflare Access, so generated JSON should be treated as public data.

## Checks

```bash
python3 scripts/fetch_google_sheet.py --input-json data/training-plan.json --dry-run
python3 -m py_compile scripts/fetch_google_sheet.py
python3 -m py_compile scripts/process_nutrition_ai.py
python3 -m py_compile scripts/fetch_strava.py
python3 -m py_compile scripts/sync_strava_actuals_to_sheet.py
python3 -m py_compile scripts/sync_training_calendar.py
python3 -m py_compile scripts/exchange_strava_code.py
python3 scripts/sync_training_calendar.py --input-json data/training-plan.json --no-calendar-awareness --preview-limit 5
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
