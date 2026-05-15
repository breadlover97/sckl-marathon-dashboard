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
DEFAULT_NUTRITION_RANGE = "Nutrition!A:O"
DEFAULT_NUTRITION_OUTPUT = "data/nutrition.json"
CHALLENGE_YEAR = 2026
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

EXPECTED_COLUMNS = {
    "week_number": "Week Number",
    "week_start_date": "Week Start Date",
    "phase": "Phase",
    "target_weekly_mileage_km": "Target Weekly Mileage KM",
    "key_workout": "Key Workout",
    "long_run_distance_km": "Long Run Distance KM",
    "long_run_notes": "Long Run Notes",
    "fuel_practice": "Fuel Practice",
    "sleep_recovery_focus": "Sleep / Recovery Focus",
    "notes": "Notes",
    "week_summary": "Week Summary",
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

NUTRITION_COLUMNS = {
    "date": "Date",
    "meal": "Meal",
    "food_item": "Food Item",
    "calories": "Calories",
    "protein_g": "Protein g",
    "carbs_g": "Carbs g",
    "fat_g": "Fat g",
    "fibre_g": "Fibre g",
    "sodium_mg": "Sodium mg",
    "calorie_target": "Calorie Target",
    "protein_target_g": "Protein Target g",
    "confidence": "Confidence",
    "assumptions": "Assumptions",
    "source": "Source",
    "notes": "Notes",
}


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


def truthy_sheet_value(value: Any) -> bool:
    if value is True:
        return True
    if value is False or value is None:
        return False
    return str(value).strip().lower() in {"true", "yes", "y", "1", "checked", "done"}


def parse_number(value: str, field_name: str, row_number: int) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    if not match:
        raise SheetParseError(f"Row {row_number}: {field_name} must contain a number")
    return float(match.group(0))


def parse_optional_number(value: Any) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    return float(match.group(0)) if match else None


def parse_confidence(value: Any) -> float | None:
    number = parse_optional_number(value)
    if number is None:
        return None
    return round(number * 100 if 0 <= number <= 1 else number, 1)


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

    compact_date = re.sub(r"\s*\([^)]*\)\s*$", "", text)
    for pattern in ("%d-%b", "%d-%B"):
        try:
            parsed = datetime.strptime(compact_date, pattern).date()
            return parsed.replace(year=CHALLENGE_YEAR).isoformat()
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

    target_mileage = parse_number(
        row_value(row, "target_weekly_mileage_km"),
        "Target Weekly Mileage KM",
        row_number,
    )
    long_run_distance = parse_number(
        row_value(row, "long_run_distance_km"),
        "Long Run Distance KM",
        row_number,
    )
    planned_runs = sum(1 for session in daily_sessions if number_like(session["planned_km"]) > 0)
    key_workout = row_value(row, "key_workout")
    phase = row_value(row, "phase") or "Unassigned"

    return {
        "week_number": parse_int(row_value(row, "week_number"), "Week Number", row_number),
        "week_start_date": week_start,
        "phase": phase,
        "target_weekly_mileage_km": target_mileage,
        "daily_sessions": daily_sessions,
        "daily_plan": {
            day_key: daily_sessions[index]["plan"]
            for index, (day_key, _day_label) in enumerate(DAY_COLUMNS)
        },
        "key_workout": key_workout,
        "long_run_distance_km": long_run_distance,
        "long_run_notes": row_value(row, "long_run_notes"),
        "fuel_practice": row_value(row, "fuel_practice"),
        "sleep_recovery_focus": row_value(row, "sleep_recovery_focus"),
        "notes": row_value(row, "notes"),
        "week_summary": row_value(row, "week_summary") or summarize_week(phase, target_mileage, planned_runs, key_workout, long_run_distance),
    }


def number_like(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def summarize_week(phase: str, target_mileage: float, planned_runs: int, key_workout: str, long_run_distance: float) -> str:
    if phase.lower() == "race week":
        return (
            f"Race week includes {target_mileage:g} km across {planned_runs} planned runs, "
            f"anchored by the SCKL Marathon and the {long_run_distance:g} km race."
        )
    key_text = key_workout or "the key workout"
    return (
        f"{phase} week with {target_mileage:g} km across {planned_runs} planned runs, "
        f"anchored by {key_text} and a {long_run_distance:g} km long run."
    )


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


def compact_unique(values: list[Any]) -> str:
    seen = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in seen:
            seen.append(text)
    return "; ".join(seen)


def nutrition_empty_payload(source: str, warnings: list[str] | None = None) -> dict[str, Any]:
    return {
        "metadata": {
            "source": source,
            "generated_at": datetime.now().astimezone().replace(microsecond=0).isoformat(),
            "included_days": 0,
            "included_meals": 0,
            "warnings": warnings or [],
        },
        "days": [],
        "nutrition": [],
    }


def row_lookup(row: dict[str, Any], column_key: str) -> Any:
    return row.get(normalize_header(NUTRITION_COLUMNS[column_key]), "")


def build_nutrition(values: list[list[Any]], source: str) -> dict[str, Any]:
    if not values:
        return nutrition_empty_payload(source)

    headers = [normalize_header(value) for value in values[0]]
    missing = [
        column
        for column in NUTRITION_COLUMNS.values()
        if normalize_header(column) not in headers
    ]
    if missing:
        return nutrition_empty_payload(
            source,
            [f"Nutrition tab missing column(s): {', '.join(missing)}"],
        )

    meals = []
    warnings = []
    for index, raw_row in enumerate(values[1:], start=2):
        padded = list(raw_row) + [""] * max(len(headers) - len(raw_row), 0)
        row = {
            header: value
            for header, value in zip(headers, padded)
            if header
        }
        if not any(str(value or "").strip() for value in row.values()):
            continue
        date_value = row_lookup(row, "date")
        if not str(date_value or "").strip():
            warnings.append(f"Row {index}: skipped nutrition row without a date")
            continue
        try:
            meal_date = parse_date(str(date_value), "Nutrition Date", index)
        except SheetParseError as exc:
            warnings.append(str(exc))
            continue
        meals.append({
            "date": meal_date,
            "meal": str(row_lookup(row, "meal") or "Unspecified").strip() or "Unspecified",
            "food_item": str(row_lookup(row, "food_item") or "").strip(),
            "calories": parse_optional_number(row_lookup(row, "calories")),
            "protein_g": parse_optional_number(row_lookup(row, "protein_g")),
            "carbs_g": parse_optional_number(row_lookup(row, "carbs_g")),
            "fat_g": parse_optional_number(row_lookup(row, "fat_g")),
            "fibre_g": parse_optional_number(row_lookup(row, "fibre_g")),
            "sodium_mg": parse_optional_number(row_lookup(row, "sodium_mg")),
            "calorie_target": parse_optional_number(row_lookup(row, "calorie_target")),
            "protein_target_g": parse_optional_number(row_lookup(row, "protein_target_g")),
            "confidence": parse_confidence(row_lookup(row, "confidence")),
            "assumptions": str(row_lookup(row, "assumptions") or "").strip(),
            "source": str(row_lookup(row, "source") or "").strip(),
            "notes": str(row_lookup(row, "notes") or "").strip(),
        })

    meals.sort(key=lambda item: (item["date"], item["meal"], item["food_item"]))
    days_by_date: dict[str, dict[str, Any]] = {}
    for meal in meals:
        day = days_by_date.setdefault(meal["date"], {
            "date": meal["date"],
            "calories": 0.0,
            "protein_g": 0.0,
            "carbs_g": 0.0,
            "fat_g": 0.0,
            "fibre_g": 0.0,
            "sodium_mg": 0.0,
            "calorie_target": None,
            "protein_target_g": None,
            "confidence_values": [],
            "assumptions_values": [],
            "source_values": [],
            "notes_values": [],
            "meals": [],
        })
        for key in ("calories", "protein_g", "carbs_g", "fat_g", "fibre_g", "sodium_mg"):
            day[key] += meal[key] or 0.0
        for key in ("calorie_target", "protein_target_g"):
            if day[key] is None and meal[key] is not None:
                day[key] = meal[key]
        if meal["confidence"] is not None:
            day["confidence_values"].append(meal["confidence"])
        day["assumptions_values"].append(meal["assumptions"])
        day["source_values"].append(meal["source"])
        day["notes_values"].append(meal["notes"])
        day["meals"].append(meal)

    days = []
    for day in sorted(days_by_date.values(), key=lambda item: item["date"]):
        confidence_values = day.pop("confidence_values")
        assumptions_values = day.pop("assumptions_values")
        source_values = day.pop("source_values")
        notes_values = day.pop("notes_values")
        day["confidence"] = round(sum(confidence_values) / len(confidence_values), 1) if confidence_values else None
        day["assumptions"] = compact_unique(assumptions_values)
        day["source"] = compact_unique(source_values)
        day["notes"] = compact_unique(notes_values)
        day["meal_count"] = len(day["meals"])
        days.append(day)

    for index, day in enumerate(days):
        window = days[max(0, index - 6):index + 1]
        day["seven_day_average_calories"] = round(sum(item["calories"] for item in window) / len(window), 1) if window else None
        day["seven_day_average_protein_g"] = round(sum(item["protein_g"] for item in window) / len(window), 1) if window else None

    return {
        "metadata": {
            "source": source,
            "generated_at": datetime.now().astimezone().replace(microsecond=0).isoformat(),
            "included_days": len(days),
            "included_meals": len(meals),
            "warnings": warnings,
        },
        "days": days,
        "nutrition": meals,
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


def fetch_sheet_values(
    spreadsheet_id: str,
    range_name: str,
    credentials_file: str | None,
    credentials_json: str | None,
    value_render_option: str = "FORMATTED_VALUE",
) -> list[list[Any]]:
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
            valueRenderOption=value_render_option,
            dateTimeRenderOption="SERIAL_NUMBER" if value_render_option == "UNFORMATTED_VALUE" else "FORMATTED_STRING",
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
        "Fuel Practice",
        "Sleep / Recovery Focus",
        "Notes",
        "Week Summary",
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
            week.get("fuel_practice", ""),
            week.get("sleep_recovery_focus", ""),
            week.get("notes", ""),
            week.get("week_summary", ""),
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
    nutrition_range_default = os.environ.get("GOOGLE_NUTRITION_RANGE", DEFAULT_NUTRITION_RANGE)
    nutrition_output_default = os.environ.get("GOOGLE_NUTRITION_OUTPUT", DEFAULT_NUTRITION_OUTPUT)
    parser.add_argument("--nutrition-range", dest="nutrition_range", default=nutrition_range_default)
    parser.add_argument("--nutrition-output", dest="nutrition_output", default=nutrition_output_default)
    parser.add_argument("--skip-nutrition", dest="skip_nutrition", action="store_true", help="Fetch only the training plan JSON")
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
            if not args.input_json and not args.skip_nutrition:
                nutrition_values = fetch_sheet_values(
                    args.spreadsheet_id,
                    args.nutrition_range,
                    args.credentials_file,
                    args.credentials_json,
                    value_render_option="UNFORMATTED_VALUE",
                )
                nutrition_payload = build_nutrition(nutrition_values, f"google-sheet:{args.spreadsheet_id}:{args.nutrition_range}")
                print(f"Parsed {len(nutrition_payload['nutrition'])} nutrition meal row(s) across {len(nutrition_payload['days'])} day(s).")
            return 0

        write_json(Path(args.output), payload)
        print(f"Wrote {len(payload['weeks'])} training week(s) to {args.output}.")
        if not args.input_json and not args.skip_nutrition:
            nutrition_values = fetch_sheet_values(
                args.spreadsheet_id,
                args.nutrition_range,
                args.credentials_file,
                args.credentials_json,
                value_render_option="UNFORMATTED_VALUE",
            )
            nutrition_payload = build_nutrition(nutrition_values, f"google-sheet:{args.spreadsheet_id}:{args.nutrition_range}")
            write_json(Path(args.nutrition_output), nutrition_payload)
            print(f"Wrote {len(nutrition_payload['nutrition'])} nutrition meal row(s) to {args.nutrition_output}.")
        return 0
    except (SheetConfigError, SheetParseError, OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
