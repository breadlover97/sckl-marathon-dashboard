#!/usr/bin/env python3
"""Estimate nutrition macros for Google Sheet rows with raw food logs."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Any

import requests

try:
    from fetch_google_sheet import DEFAULT_SHEET_ID, SheetConfigError, credentials_from_env
except ModuleNotFoundError:
    from scripts.fetch_google_sheet import DEFAULT_SHEET_ID, SheetConfigError, credentials_from_env


DEFAULT_NUTRITION_AI_RANGE = "Nutrition!A:T"
DEFAULT_OPENAI_MODEL = "gpt-4.1-mini"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

NUTRITION_HEADERS = [
    "Date",
    "Meal",
    "Food Item",
    "Calories",
    "Protein g",
    "Carbs g",
    "Fat g",
    "Fibre g",
    "Sodium mg",
    "Calorie Target",
    "Protein Target g",
    "Confidence",
    "Assumptions",
    "Source",
    "Notes",
    "Raw Food Log",
    "Estimation Guidelines",
    "AI Status",
    "AI Processed At",
    "AI Error",
]

OUTPUT_START_COLUMN = 2
OUTPUT_END_COLUMN = 20
MACRO_COLUMN_INDEXES = [3, 4, 5, 6, 7, 8]


class NutritionAIError(Exception):
    pass


def build_service(credentials_file: str | None, credentials_json: str | None):
    try:
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise SheetConfigError("Missing Google dependencies. Run: pip install -r requirements.txt") from exc

    credentials = credentials_from_env(credentials_file, credentials_json).with_scopes(SCOPES)
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def read_values(service, spreadsheet_id: str, range_name: str) -> list[list[Any]]:
    result = (
        service.spreadsheets()
        .values()
        .get(
            spreadsheetId=spreadsheet_id,
            range=range_name,
            valueRenderOption="UNFORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    return result.get("values", [])


def normalize_header(value: Any) -> str:
    return "".join(char for char in str(value or "").strip().lower() if char.isalnum())


def header_indexes(headers: list[Any]) -> dict[str, int]:
    return {normalize_header(header): index for index, header in enumerate(headers)}


def row_value(row: list[Any], indexes: dict[str, int], header: str) -> Any:
    index = indexes.get(normalize_header(header))
    if index is None or index >= len(row):
        return ""
    return row[index]


def is_blank(value: Any) -> bool:
    return str(value or "").strip() == ""


def needs_processing(row: list[Any], indexes: dict[str, int], force: bool) -> bool:
    raw_food = str(row_value(row, indexes, "Raw Food Log") or "").strip()
    food_item = str(row_value(row, indexes, "Food Item") or "").strip()
    status = str(row_value(row, indexes, "AI Status") or "").strip().lower()
    if not raw_food and not food_item:
        return False
    if status == "done" and not force:
        return False
    return force or any(is_blank(row[index]) if index < len(row) else True for index in MACRO_COLUMN_INDEXES)


def text_from_response(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                return content["text"]
    raise NutritionAIError("OpenAI response did not include output text")


def nutrition_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "food_item",
            "calories",
            "protein_g",
            "carbs_g",
            "fat_g",
            "fibre_g",
            "sodium_mg",
            "confidence",
            "assumptions",
            "notes",
        ],
        "properties": {
            "food_item": {"type": "string"},
            "calories": {"type": "number"},
            "protein_g": {"type": "number"},
            "carbs_g": {"type": "number"},
            "fat_g": {"type": "number"},
            "fibre_g": {"type": "number"},
            "sodium_mg": {"type": "number"},
            "confidence": {"type": "number"},
            "assumptions": {"type": "string"},
            "notes": {"type": "string"},
        },
    }


def estimate_nutrition(row_context: dict[str, Any], api_key: str, model: str) -> dict[str, Any]:
    payload = {
        "model": model,
        "instructions": (
            "Estimate nutrition for a marathon-training food log. Return conservative, "
            "realistic estimates in metric units. Do not provide medical advice. If portion "
            "sizes are unclear, state the assumptions and lower confidence."
        ),
        "input": json.dumps(row_context, ensure_ascii=False),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "nutrition_estimate",
                "strict": True,
                "schema": nutrition_schema(),
            }
        },
    }
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=45,
    )
    if response.status_code >= 400:
        raise NutritionAIError(f"OpenAI API error {response.status_code}: {response.text[:500]}")
    return json.loads(text_from_response(response.json()))


def output_values(estimate: dict[str, Any], row: list[Any], indexes: dict[str, int], model: str) -> list[Any]:
    processed_at = datetime.now().astimezone().replace(microsecond=0).isoformat()
    calorie_target = row_value(row, indexes, "Calorie Target")
    protein_target = row_value(row, indexes, "Protein Target g")
    return [
        estimate.get("food_item") or row_value(row, indexes, "Food Item"),
        estimate.get("calories", ""),
        estimate.get("protein_g", ""),
        estimate.get("carbs_g", ""),
        estimate.get("fat_g", ""),
        estimate.get("fibre_g", ""),
        estimate.get("sodium_mg", ""),
        calorie_target,
        protein_target,
        estimate.get("confidence", ""),
        estimate.get("assumptions", ""),
        f"openai:{model}",
        estimate.get("notes", ""),
        row_value(row, indexes, "Raw Food Log"),
        row_value(row, indexes, "Estimation Guidelines"),
        "done",
        processed_at,
        "",
    ]


def error_values(message: str, row: list[Any], indexes: dict[str, int]) -> list[Any]:
    processed_at = datetime.now().astimezone().replace(microsecond=0).isoformat()
    values = [""] * (OUTPUT_END_COLUMN - OUTPUT_START_COLUMN)
    values[0] = row_value(row, indexes, "Food Item")
    values[7] = row_value(row, indexes, "Calorie Target")
    values[8] = row_value(row, indexes, "Protein Target g")
    values[13] = row_value(row, indexes, "Raw Food Log")
    values[14] = row_value(row, indexes, "Estimation Guidelines")
    values[15] = "error"
    values[16] = processed_at
    values[17] = message[:500]
    return values


def update_row(service, spreadsheet_id: str, sheet_name: str, row_number: int, values: list[Any]) -> None:
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"{sheet_name}!C{row_number}:T{row_number}",
        valueInputOption="USER_ENTERED",
        body={"values": [values]},
    ).execute()


def ensure_headers(service, spreadsheet_id: str, sheet_name: str) -> None:
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"{sheet_name}!A1:T1",
        valueInputOption="USER_ENTERED",
        body={"values": [NUTRITION_HEADERS]},
    ).execute()


def process_rows(
    service,
    spreadsheet_id: str,
    sheet_name: str,
    range_name: str,
    api_key: str,
    model: str,
    force: bool,
    limit: int,
    dry_run: bool,
) -> tuple[int, int]:
    values = read_values(service, spreadsheet_id, range_name)
    if not values:
        raise NutritionAIError(f"{range_name} returned no rows")

    headers = values[0]
    indexes = header_indexes(headers)
    missing = [header for header in ("Date", "Meal") if normalize_header(header) not in indexes]
    if missing:
        raise NutritionAIError(f"Nutrition tab missing required column(s): {', '.join(missing)}")

    processed = 0
    errors = 0
    for offset, row in enumerate(values[1:], start=2):
        if limit and processed >= limit:
            break
        padded = list(row) + [""] * max(len(headers) - len(row), 0)
        if not needs_processing(padded, indexes, force):
            continue

        row_context = {
            "date": row_value(padded, indexes, "Date"),
            "meal": row_value(padded, indexes, "Meal"),
            "raw_food_log": row_value(padded, indexes, "Raw Food Log") or row_value(padded, indexes, "Food Item"),
            "guidelines": row_value(padded, indexes, "Estimation Guidelines") or row_value(padded, indexes, "Notes"),
            "existing_food_item": row_value(padded, indexes, "Food Item"),
            "calorie_target": row_value(padded, indexes, "Calorie Target"),
            "protein_target_g": row_value(padded, indexes, "Protein Target g"),
        }
        if dry_run:
            print(f"Would process row {offset}: {row_context['meal']} - {row_context['raw_food_log']}")
            processed += 1
            continue

        try:
            estimate = estimate_nutrition(row_context, api_key, model)
            update_row(service, spreadsheet_id, sheet_name, offset, output_values(estimate, padded, indexes, model))
            print(f"Processed nutrition row {offset}.")
            processed += 1
        except Exception as exc:
            errors += 1
            update_row(service, spreadsheet_id, sheet_name, offset, error_values(str(exc), padded, indexes))
            print(f"Error processing row {offset}: {exc}", file=sys.stderr)
    return processed, errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Use OpenAI to estimate nutrition rows in Google Sheets.")
    parser.add_argument("--spreadsheet-id", default=os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID))
    parser.add_argument("--sheet-name", default=os.environ.get("GOOGLE_NUTRITION_SHEET", "Nutrition"))
    parser.add_argument("--range", default=os.environ.get("GOOGLE_NUTRITION_AI_RANGE", DEFAULT_NUTRITION_AI_RANGE))
    parser.add_argument("--model", default=os.environ.get("OPENAI_NUTRITION_MODEL", DEFAULT_OPENAI_MODEL))
    parser.add_argument("--credentials-file", help="Path to a Google service account JSON key")
    parser.add_argument("--credentials-json", help="Raw Google service account JSON")
    parser.add_argument("--limit", type=int, default=int(os.environ.get("NUTRITION_AI_LIMIT", "20")))
    parser.add_argument("--force", action="store_true", help="Reprocess rows even if AI Status is done")
    parser.add_argument("--dry-run", action="store_true", help="Print rows that would be processed without calling OpenAI or writing results")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key and not args.dry_run:
        print("OPENAI_API_KEY is not set; skipping nutrition AI processing.")
        return 0

    try:
        service = build_service(args.credentials_file, args.credentials_json)
        if not args.dry_run:
            ensure_headers(service, args.spreadsheet_id, args.sheet_name)
        processed, errors = process_rows(
            service=service,
            spreadsheet_id=args.spreadsheet_id,
            sheet_name=args.sheet_name,
            range_name=args.range,
            api_key=api_key or "",
            model=args.model,
            force=args.force,
            limit=args.limit,
            dry_run=args.dry_run,
        )
        print(f"Nutrition AI processing complete: {processed} row(s), {errors} error(s).")
        return 1 if errors else 0
    except (SheetConfigError, NutritionAIError, OSError, ValueError, requests.RequestException) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
