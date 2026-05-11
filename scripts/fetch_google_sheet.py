#!/usr/bin/env python3
"""Fetch planned marathon training data from Google Sheets."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


DEFAULT_SHEET_ID = "1sx46WZYNJNBBTtPoG2E3obdVrzUIhfa7-m84DWOvVDo"
DEFAULT_RANGE = "A:AF"
DEFAULT_OUTPUT = "data/training-plan.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

EXPECTED_COLUMNS = {
    "week_number": "Week Number",
    "week_start_date": "Week Start Date",
    "phase": "Phase",
    "target_weekly_mileage_km": "Target Weekly Mileage KM",
    "key_workout": "Key Workout",
    "long_run_distance_km": "Long Run Distance KM",
    "long_run_notes": "Long Run Notes",
    "strength_training": "Strength Training",
    "fuel_practice": "Fuel Practice",
    "sleep_recovery_focus": "Sleep / Recovery Focus",
    "notes": "Notes",
}

DAY_COLUMNS = [
    ("monday", "Monday"),
    ("tuesday", "Tuesday"),
    ("wednesday", "Wednesday"),
    ("thursday", "Thursday"),
    ("friday", "Friday"),
    ("saturday", "Saturday"),
    ("sunday", "Sunday"),
]


class SheetConfigError(Exception):
    pass


class SheetParseError(Exception):
    pass


def normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def row_value(row: dict[str, str], key: str) -> str:
    return row.get(normalize_header(EXPECTED_COLUMNS[key]), "").strip()


def row_header_value(row: dict[str, str], header: str) -> str:
    return row.get(normalize_header(header), "").strip()


def parse_number(value: str, field_name: str, row_number: int) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    if not match:
        raise SheetParseError(f"Row {row_number}: {field_name} must contain a number")
    return float(match.group(0))


def parse_int(value: str, field_name: str, row_number: int) -> int:
    number = parse_number(value, field_name, row_number)
    if number <= 0:
        raise SheetParseError(f"Row {row_number}: {field_name} must be greater than zero")
    return int(number)


def parse_date(value: str, field_name: str, row_number: int) -> str:
    text = str(value or "").strip()
    if not text:
        raise SheetParseError(f"Row {row_number}: {field_name} is required")

    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return date.fromisoformat(text).isoformat()

    for pattern in ("%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            pass

    # Google Sheets can return dates as serial numbers when formatting is changed.
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        serial = int(float(text))
        return (date(1899, 12, 30) + timedelta(days=serial)).isoformat()

    raise SheetParseError(f"Row {row_number}: {field_name} must be a recognizable date")


def rows_from_values(values: list[list[Any]]) -> list[dict[str, str]]:
    if not values:
        raise SheetParseError("Sheet range returned no rows")

    headers = [normalize_header(value) for value in values[0]]
    missing = [
        column
        for column in EXPECTED_COLUMNS.values()
        if normalize_header(column) not in headers
    ]
    if missing:
        raise SheetParseError(f"Missing required column(s): {', '.join(missing)}")

    rows = []
    for raw_row in values[1:]:
        padded = list(raw_row) + [""] * max(len(headers) - len(raw_row), 0)
        row = {
            header: str(value).strip()
            for header, value in zip(headers, padded)
            if header
        }
        if any(row.values()):
            rows.append(row)
    return rows


def normalize_training_week(row: dict[str, str], row_number: int) -> dict[str, Any]:
    week_start = parse_date(row_value(row, "week_start_date"), "Week Start Date", row_number)
    daily_sessions = []
    for offset, (day_key, day_label) in enumerate(DAY_COLUMNS):
        fallback_date = (date.fromisoformat(week_start) + timedelta(days=offset)).isoformat()
        session_date = row_header_value(row, f"{day_label} Date")
        session_plan = row_header_value(row, f"{day_label} Plan")
        session_km = row_header_value(row, f"{day_label} Estimated KM")
        if not session_plan:
            session_plan = row_header_value(row, f"{day_label} Plan")
        daily_sessions.append({
            "day": day_label,
            "date": parse_date(session_date, f"{day_label} Date", row_number) if session_date else fallback_date,
            "plan": session_plan,
            "planned_km": parse_number(session_km, f"{day_label} Estimated KM", row_number),
        })

    return {
        "week_number": parse_int(row_value(row, "week_number"), "Week Number", row_number),
        "week_start_date": week_start,
        "phase": row_value(row, "phase") or "Unassigned",
        "target_weekly_mileage_km": parse_number(
            row_value(row, "target_weekly_mileage_km"),
            "Target Weekly Mileage KM",
            row_number,
        ),
        "daily_sessions": daily_sessions,
        "daily_plan": {
            day_key: daily_sessions[index]["plan"]
            for index, (day_key, _day_label) in enumerate(DAY_COLUMNS)
        },
        "key_workout": row_value(row, "key_workout"),
        "long_run_distance_km": parse_number(
            row_value(row, "long_run_distance_km"),
            "Long Run Distance KM",
            row_number,
        ),
        "long_run_notes": row_value(row, "long_run_notes"),
        "strength_training": row_value(row, "strength_training"),
        "fuel_practice": row_value(row, "fuel_practice"),
        "sleep_recovery_focus": row_value(row, "sleep_recovery_focus"),
        "notes": row_value(row, "notes"),
    }


def build_plan(values: list[list[Any]], source: str) -> dict[str, Any]:
    rows = rows_from_values(values)
    weeks = [
        normalize_training_week(row, index + 2)
        for index, row in enumerate(rows)
    ]
    weeks.sort(key=lambda week: (week["week_number"], week["week_start_date"]))
    return {
        "metadata": {
            "race": "Standard Chartered Kuala Lumpur Marathon 2026",
            "race_date": "2026-10-04",
            "race_distance_km": 42.195,
            "flag_off": "03:30",
            "timezone": "Asia/Singapore",
            "goal_time": "2h 50m",
            "goal_pace": "4:02 /km",
            "tropical_marathon_pace_estimate": "4:15 /km",
            "source": source,
            "generated_at": datetime.now().astimezone().replace(microsecond=0).isoformat(),
        },
        "weeks": weeks,
    }


def credentials_from_env(credentials_file: str | None, credentials_json: str | None):
    try:
        from google.oauth2 import service_account
    except ImportError as exc:
        raise SheetConfigError("Missing Google dependencies. Run: pip install -r requirements.txt") from exc

    json_value = credentials_json or os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if json_value:
        try:
            info = json.loads(json_value)
        except json.JSONDecodeError as exc:
            raise SheetConfigError("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON") from exc
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)

    file_value = credentials_file or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if file_value:
        return service_account.Credentials.from_service_account_file(file_value, scopes=SCOPES)

    raise SheetConfigError(
        "Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON for Google Sheets access"
    )


def fetch_sheet_values(spreadsheet_id: str, range_name: str, credentials_file: str | None, credentials_json: str | None) -> list[list[Any]]:
    try:
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise SheetConfigError("Missing Google dependencies. Run: pip install -r requirements.txt") from exc

    credentials = credentials_from_env(credentials_file, credentials_json)
    service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
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


def values_from_plan_json(path: Path) -> list[list[Any]]:
    with open(path, "r", encoding="utf-8") as handle:
        plan = json.load(handle)

    header = [
        "Week Number",
        "Week Start Date",
        "Phase",
        "Target Weekly Mileage KM",
    ]
    for _day_key, day_label in DAY_COLUMNS:
        header.extend([f"{day_label} Date", f"{day_label} Plan", f"{day_label} Estimated KM"])
    header.extend([
        "Key Workout",
        "Long Run Distance KM",
        "Long Run Notes",
        "Strength Training",
        "Fuel Practice",
        "Sleep / Recovery Focus",
        "Notes",
    ])
    rows = [header]
    for week in plan.get("weeks", []):
        daily = week.get("daily_plan", {})
        sessions = week.get("daily_sessions") or []
        sessions_by_day = {
            str(session.get("day", "")).lower(): session
            for session in sessions
        }
        row = [
            week.get("week_number", ""),
            week.get("week_start_date", ""),
            week.get("phase", ""),
            week.get("target_weekly_mileage_km", ""),
        ]
        week_start = str(week.get("week_start_date", ""))
        for offset, (day_key, day_label) in enumerate(DAY_COLUMNS):
            session = sessions_by_day.get(day_label.lower(), {})
            fallback_date = ""
            if week_start:
                fallback_date = (date.fromisoformat(week_start) + timedelta(days=offset)).isoformat()
            row.extend([
                session.get("date", fallback_date),
                session.get("plan", daily.get(day_key, "")),
                session.get("planned_km", ""),
            ])
        rows.append([
            *row,
            week.get("key_workout", ""),
            week.get("long_run_distance_km", ""),
            week.get("long_run_notes", ""),
            week.get("strength_training", ""),
            week.get("fuel_practice", ""),
            week.get("sleep_recovery_focus", ""),
            week.get("notes", ""),
        ])
    return rows


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch and normalize SCKL training plan rows from Google Sheets.")
    parser.add_argument("--spreadsheet-id", default=os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID))
    parser.add_argument("--range", default=os.environ.get("GOOGLE_SHEET_RANGE", DEFAULT_RANGE))
    parser.add_argument("--output", default=os.environ.get("GOOGLE_SHEET_OUTPUT", DEFAULT_OUTPUT))
    parser.add_argument("--credentials-file", help="Path to a Google service account JSON key")
    parser.add_argument("--credentials-json", help="Raw Google service account JSON")
    parser.add_argument("--input-json", help="Developer helper: parse an existing plan JSON instead of calling Google")
    parser.add_argument("--dry-run", action="store_true", help="Validate parsing without writing output")
    args = parser.parse_args()

    try:
        if args.input_json:
            values = values_from_plan_json(Path(args.input_json))
            source = f"local test fixture: {args.input_json}"
        else:
            values = fetch_sheet_values(args.spreadsheet_id, args.range, args.credentials_file, args.credentials_json)
            source = f"google-sheet:{args.spreadsheet_id}:{args.range}"

        payload = build_plan(values, source)
        if args.dry_run:
            print(f"Parsed {len(payload['weeks'])} training week(s).")
            return 0

        write_json(Path(args.output), payload)
        print(f"Wrote {len(payload['weeks'])} training week(s) to {args.output}.")
        return 0
    except (SheetConfigError, SheetParseError, OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
