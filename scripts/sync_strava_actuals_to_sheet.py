#!/usr/bin/env python3
"""Write synced Strava run actuals back to the training plan Google Sheet."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


DEFAULT_SHEET_ID = "1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo"
DEFAULT_SHEET_RANGE = "A:AQ"
DEFAULT_ACTIVITIES_JSON = "data/strava-activities.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
CHALLENGE_YEAR = 2026

DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


class SheetSyncError(Exception):
    pass


def normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def column_letter(index: int) -> str:
    """Return the A1 column letter for a zero-based column index."""
    result = ""
    number = index + 1
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def parse_sheet_date(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return date.fromisoformat(text).isoformat()
    for pattern in ("%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            pass
    compact_date = re.sub(r"\s*\([^)]*\)\s*$", "", text)
    for pattern in ("%d-%b", "%d-%B"):
        try:
            parsed = datetime.strptime(compact_date, pattern).date()
            return parsed.replace(year=CHALLENGE_YEAR).isoformat()
        except ValueError:
            pass
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        serial = int(float(text))
        return (date(1899, 12, 30) + timedelta(days=serial)).isoformat()
    return ""


def credentials_from_env(credentials_file: str | None, credentials_json: str | None):
    try:
        from google.oauth2 import service_account
    except ImportError as exc:
        raise SheetSyncError("Missing Google dependencies. Run: pip install -r requirements.txt") from exc

    json_value = credentials_json or os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if json_value:
        try:
            info = json.loads(json_value)
        except json.JSONDecodeError as exc:
            raise SheetSyncError("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON") from exc
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)

    file_value = credentials_file or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if file_value:
        return service_account.Credentials.from_service_account_file(file_value, scopes=SCOPES)

    raise SheetSyncError("Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON for Google Sheets access")


def build_service(credentials_file: str | None, credentials_json: str | None):
    try:
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise SheetSyncError("Missing Google dependencies. Run: pip install -r requirements.txt") from exc

    credentials = credentials_from_env(credentials_file, credentials_json)
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def fetch_values(service: Any, spreadsheet_id: str, range_name: str) -> list[list[Any]]:
    result = (
        service.spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=range_name,
            valueRenderOption="FORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    return result.get("values", [])


def load_activities(path: Path) -> dict[str, list[dict[str, Any]]]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    activities_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for activity in payload.get("activities", []):
        activity_date = str(activity.get("date") or "").strip()
        if not activity_date:
            continue
        try:
            date.fromisoformat(activity_date)
        except ValueError:
            continue
        activities_by_date[activity_date].append(activity)
    for activities in activities_by_date.values():
        activities.sort(key=lambda item: str(item.get("start_date_local") or item.get("date") or ""))
    return activities_by_date


def format_duration(seconds: Any) -> str:
    total = int(float(seconds or 0))
    if total <= 0:
        return ""
    hours, remainder = divmod(total, 3600)
    minutes = remainder // 60
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def format_pace(activity: dict[str, Any]) -> str:
    distance_km = float(activity.get("distance_km") or 0)
    moving_time = int(activity.get("moving_time_seconds") or 0)
    if distance_km <= 0 or moving_time <= 0:
        return ""
    pace_seconds = round(moving_time / distance_km)
    minutes, seconds = divmod(pace_seconds, 60)
    return f"{minutes}:{seconds:02d}/km"


def format_activity(activity: dict[str, Any]) -> str:
    name = str(activity.get("name") or "Run").strip()
    distance = round(float(activity.get("distance_km") or 0), 1)
    details = [f"{name} ({distance:g} km)"]
    duration = format_duration(activity.get("moving_time_seconds"))
    pace = format_pace(activity)
    if duration:
        details.append(duration)
    if pace:
        details.append(pace)
    return " · ".join(details)


def required_header(headers: list[str], label: str) -> int:
    key = normalize_header(label)
    if key not in headers:
        raise SheetSyncError(f"Training Plan sheet is missing required column: {label}")
    return headers.index(key)


def build_update_ranges(values: list[list[Any]], activities_by_date: dict[str, list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], int]:
    if not values:
        raise SheetSyncError("Training Plan range returned no rows")

    raw_headers = [str(value or "").strip() for value in values[0]]
    headers = [normalize_header(value) for value in raw_headers]
    date_columns = {day: required_header(headers, f"{day} Date") for day in DAY_LABELS}
    actual_columns = {day: required_header(headers, f"{day} Actual") for day in DAY_LABELS}
    distance_columns = {day: required_header(headers, f"{day} Actual Distance Ran") for day in DAY_LABELS}

    data = []
    touched_dates = set()
    row_count = max(len(values) - 1, 0)
    for day in DAY_LABELS:
        actual_values = []
        distance_values = []
        for row in values[1:]:
            padded = list(row) + [""] * max(len(raw_headers) - len(row), 0)
            session_date = parse_sheet_date(padded[date_columns[day]] if date_columns[day] < len(padded) else "")
            activities = activities_by_date.get(session_date, []) if session_date else []
            if activities:
                total_distance = round(sum(float(activity.get("distance_km") or 0) for activity in activities), 1)
                actual_values.append(["; ".join(format_activity(activity) for activity in activities)])
                distance_values.append([total_distance])
                touched_dates.add(session_date)
            else:
                actual_values.append([""])
                distance_values.append([""])

        if row_count:
            actual_letter = column_letter(actual_columns[day])
            distance_letter = column_letter(distance_columns[day])
            data.append({"range": f"'Training Plan'!{actual_letter}2:{actual_letter}{row_count + 1}", "values": actual_values})
            data.append({"range": f"'Training Plan'!{distance_letter}2:{distance_letter}{row_count + 1}", "values": distance_values})

    return data, len(touched_dates)


def write_updates(service: Any, spreadsheet_id: str, data: list[dict[str, Any]]) -> None:
    if not data:
        return
    (
        service.spreadsheets()
        .values()
        .batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "valueInputOption": "USER_ENTERED",
                "data": data,
            },
        )
        .execute()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Write Strava actual run details into the SCKL Google Sheet.")
    parser.add_argument("--spreadsheet-id", default=os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID))
    parser.add_argument("--range", default=os.environ.get("GOOGLE_SHEET_RANGE", DEFAULT_SHEET_RANGE))
    parser.add_argument("--activities-json", default=os.environ.get("STRAVA_ACTIVITIES_OUTPUT", DEFAULT_ACTIVITIES_JSON))
    parser.add_argument("--credentials-file", help="Path to a Google service account JSON key")
    parser.add_argument("--credentials-json", help="Raw Google service account JSON")
    parser.add_argument("--dry-run", action="store_true", help="Build the update payload without writing to Google Sheets")
    args = parser.parse_args()

    try:
        service = build_service(args.credentials_file, args.credentials_json)
        values = fetch_values(service, args.spreadsheet_id, args.range)
        activities_by_date = load_activities(Path(args.activities_json))
        updates, touched_date_count = build_update_ranges(values, activities_by_date)
        updated_cells = sum(len(item["values"]) for item in updates)
        if args.dry_run:
            print(f"Prepared {updated_cells} actual-field cell update(s) across {touched_date_count} Strava date(s).")
            return 0
        write_updates(service, args.spreadsheet_id, updates)
        print(f"Wrote {updated_cells} actual-field cell update(s) across {touched_date_count} Strava date(s).")
        return 0
    except (SheetSyncError, OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
