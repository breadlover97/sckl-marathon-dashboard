#!/usr/bin/env python3
"""Sync planned training sessions from Google Sheets into Google Calendar."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

try:
    from fetch_google_sheet import (
        DEFAULT_RANGE,
        DEFAULT_SHEET_ID,
        SheetConfigError,
        SheetParseError,
        build_plan,
        fetch_sheet_values,
    )
except ImportError:  # pragma: no cover - allows package-style execution.
    from scripts.fetch_google_sheet import (
        DEFAULT_RANGE,
        DEFAULT_SHEET_ID,
        SheetConfigError,
        SheetParseError,
        build_plan,
        fetch_sheet_values,
    )


CALENDAR_SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",
]
DEFAULT_TIMEZONE = "Asia/Singapore"
DEFAULT_CALENDAR_COLOR_ID = "11"  # Google Calendar event color: tomato/red.
SYNC_MARKER_KEY = "scklCalendarSync"
SYNC_MARKER_VALUE = "training-plan-v1"
PLAN_ID_KEY = "scklPlanId"
SOURCE_DATE_KEY = "scklSourceDate"
SOURCE_DAY_KEY = "scklSourceDay"


class CalendarSyncError(Exception):
    pass


@dataclass(frozen=True)
class DesiredEvent:
    plan_id: str
    title: str
    start: datetime
    end: datetime
    source_date: str
    source_day: str


def parse_iso_date(value: str | None, label: str) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise CalendarSyncError(f"{label} must be YYYY-MM-DD") from exc


def km_label(value: Any) -> str:
    number = float(value or 0)
    if number.is_integer():
        return str(int(number))
    return f"{number:g}"


def planned_km(session: dict[str, Any]) -> float:
    try:
        return float(session.get("planned_km") or 0)
    except (TypeError, ValueError):
        return 0.0


def is_wednesday(session: dict[str, Any]) -> bool:
    return str(session.get("day") or "").strip().lower() == "wednesday"


def pt_title(session: dict[str, Any]) -> str | None:
    text = str(session.get("plan") or "").lower()
    if "pt" not in text:
        return None
    if "lower body" in text:
        return "PT (LB)"
    if "upper body" in text:
        return "PT (UB)"
    if "strength" in text:
        return "PT Strength"
    return "PT"


def is_standalone_community_run(session: dict[str, Any]) -> bool:
    text = str(session.get("plan") or "").lower()
    return planned_km(session) <= 10 and "swoosh" in text and "long run" not in text


def is_race(session: dict[str, Any]) -> bool:
    text = str(session.get("plan") or "").lower()
    return "race:" in text or ("marathon" in text and planned_km(session) >= 40)


def is_track_workout(session: dict[str, Any]) -> bool:
    day = str(session.get("day") or "").strip().lower()
    if day not in {"monday", "tuesday"}:
        return False
    text = str(session.get("plan") or "").lower()
    if "warmup" not in text:
        return False
    track_markers = (
        "200m",
        "300m",
        "400m",
        "500m",
        "600m",
        "800m",
        "1 km",
        "1200m",
        "sets",
        "jog",
    )
    return any(marker in text for marker in track_markers)


def is_long_run(session: dict[str, Any]) -> bool:
    if is_race(session):
        return False
    text = str(session.get("plan") or "").lower()
    day = str(session.get("day") or "").strip().lower()
    return "long run" in text or (day == "saturday" and planned_km(session) >= 18)


def event_title(session: dict[str, Any]) -> str:
    text = str(session.get("plan") or "").lower()
    km = km_label(planned_km(session))

    if is_race(session):
        return "KL Marathon"
    if is_track_workout(session):
        return f"{km}km intervals"
    if "race" in text:
        return f"{km}km race"
    if "shakeout" in text:
        return f"{km}km shakeout"
    if is_long_run(session):
        if "progressive" in text:
            return f"{km}km progressive long run"
        if "hilly" in text:
            return f"{km}km hilly long run"
        return f"{km}km long run"
    if "cross team run" in text:
        return f"{km}km easy + Cross Team Run"
    if "race-pace" in text or "race pace" in text:
        return f"{km}km easy + race-pace touches"
    if "medium" in text and "stride" in text:
        return f"{km}km medium + strides"
    if "stride" in text:
        return f"{km}km easy + strides"
    if "rolling" in text:
        return f"{km}km rolling easy"
    if "medium" in text:
        return f"{km}km medium easy"
    if "recovery" in text:
        return f"{km}km recovery"
    if "relaxed" in text:
        return f"{km}km relaxed"
    if "easy" in text:
        return f"{km}km easy"
    return f"{km}km run"


def plan_id_for(session: dict[str, Any]) -> str:
    source_date = str(session.get("date") or "").strip()
    day = re.sub(r"[^a-z0-9]+", "-", str(session.get("day") or "").strip().lower()).strip("-")
    return f"sckl-{source_date}-{day}"


def pt_plan_id_for(session: dict[str, Any]) -> str:
    return f"sckl-{str(session.get('date') or '').strip()}-pt"


def local_dt(day: date, hour: int, minute: int, timezone: ZoneInfo) -> datetime:
    return datetime.combine(day, time(hour, minute), tzinfo=timezone)


def choose_times(
    session: dict[str, Any],
    timezone: ZoneInfo,
    dates_with_late_commitments: set[str],
) -> tuple[datetime, datetime]:
    session_date = date.fromisoformat(str(session["date"]))
    date_key = session_date.isoformat()

    if is_race(session):
        start = local_dt(session_date, 3, 30, timezone)
        return start, local_dt(session_date, 8, 0, timezone)
    if "shakeout" in str(session.get("plan") or "").lower():
        start = local_dt(session_date, 7, 30, timezone)
        return start, start + timedelta(hours=1)
    if is_long_run(session):
        start = local_dt(session_date, 6, 30, timezone)
        return start, start + timedelta(hours=2)
    if is_track_workout(session):
        start = local_dt(session_date, 19, 0, timezone)
        return start, start + timedelta(hours=2)
    if "pm" in str(session.get("plan") or "").lower():
        start = local_dt(session_date, 19, 0, timezone)
        return start, start + timedelta(hours=2)
    if date_key in dates_with_late_commitments:
        start = local_dt(session_date, 7, 30, timezone)
        return start, start + timedelta(hours=1)

    start = local_dt(session_date, 21, 30, timezone)
    return start, start + timedelta(hours=1)


def load_plan(args: argparse.Namespace) -> dict[str, Any]:
    if args.input_json:
        with open(args.input_json, "r", encoding="utf-8") as handle:
            return json.load(handle)

    values = fetch_sheet_values(
        args.spreadsheet_id,
        args.sheet_range,
        args.credentials_file,
        args.credentials_json,
    )
    return build_plan(values, f"google-sheet:{args.spreadsheet_id}:{args.sheet_range}")


def credentials_from_env(credentials_file: str | None, credentials_json: str | None):
    try:
        from google.oauth2 import service_account
    except ImportError as exc:
        raise CalendarSyncError("Missing Google dependencies. Run: pip install -r requirements.txt") from exc

    json_value = credentials_json or os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if json_value:
        try:
            info = json.loads(json_value)
        except json.JSONDecodeError as exc:
            raise CalendarSyncError("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON") from exc
        return service_account.Credentials.from_service_account_info(info, scopes=CALENDAR_SCOPES)

    file_value = credentials_file or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if file_value:
        return service_account.Credentials.from_service_account_file(file_value, scopes=CALENDAR_SCOPES)

    raise CalendarSyncError("Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON for Google Calendar access")


def build_calendar_service(credentials_file: str | None, credentials_json: str | None):
    try:
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise CalendarSyncError("Missing Google dependencies. Run: pip install -r requirements.txt") from exc

    credentials = credentials_from_env(credentials_file, credentials_json)
    return build("calendar", "v3", credentials=credentials, cache_discovery=False)


def parse_event_datetime(value: str | None, timezone: ZoneInfo) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone)


def list_calendar_events(
    service: Any,
    calendar_id: str,
    start_date: date,
    end_date: date,
    timezone: ZoneInfo,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    page_token = None
    time_min = local_dt(start_date, 0, 0, timezone).isoformat()
    time_max = local_dt(end_date + timedelta(days=1), 0, 0, timezone).isoformat()
    while True:
        result = (
            service.events()
            .list(
                calendarId=calendar_id,
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime",
                pageToken=page_token,
                maxResults=2500,
                **kwargs,
            )
            .execute()
        )
        events.extend(result.get("items", []))
        page_token = result.get("nextPageToken")
        if not page_token:
            return events


def private_props(event: dict[str, Any]) -> dict[str, str]:
    return event.get("extendedProperties", {}).get("private", {}) or {}


def is_managed_event(event: dict[str, Any]) -> bool:
    return private_props(event).get(SYNC_MARKER_KEY) == SYNC_MARKER_VALUE


def dates_with_late_commitments(
    service: Any | None,
    calendar_id: str,
    start_date: date,
    end_date: date,
    timezone: ZoneInfo,
    training_titles: set[str],
) -> set[str]:
    if service is None:
        return set()

    late_dates: set[str] = set()
    for event in list_calendar_events(service, calendar_id, start_date, end_date, timezone):
        if is_managed_event(event):
            continue
        if event.get("transparency") == "transparent":
            continue
        if event.get("summary") in training_titles:
            continue
        start_info = event.get("start", {})
        end_info = event.get("end", {})
        if "dateTime" not in start_info or "dateTime" not in end_info:
            continue
        end_time = parse_event_datetime(end_info.get("dateTime"), timezone)
        if end_time and end_time.timetz().replace(tzinfo=None) > time(21, 0):
            local_start = parse_event_datetime(start_info.get("dateTime"), timezone)
            if local_start:
                late_dates.add(local_start.date().isoformat())
    return late_dates


def build_desired_events(
    plan: dict[str, Any],
    timezone: ZoneInfo,
    late_dates: set[str],
    start_date: date | None,
    end_date: date | None,
    include_wednesdays: bool,
) -> list[DesiredEvent]:
    events: list[DesiredEvent] = []
    for week in plan.get("weeks", []):
        for session in week.get("daily_sessions", []):
            source_date = str(session.get("date") or "").strip()
            if not source_date:
                continue
            session_day = date.fromisoformat(source_date)
            if start_date and session_day < start_date:
                continue
            if end_date and session_day > end_date:
                continue

            strength_title = pt_title(session)
            if strength_title:
                strength_start = local_dt(session_day, 11, 0, timezone)
                events.append(
                    DesiredEvent(
                        plan_id=pt_plan_id_for(session),
                        title=strength_title,
                        start=strength_start,
                        end=strength_start + timedelta(hours=1),
                        source_date=source_date,
                        source_day=f"{str(session.get('day') or '').strip()} PT",
                    )
                )

            if planned_km(session) <= 0 or is_standalone_community_run(session):
                continue
            if is_wednesday(session) and not include_wednesdays:
                continue
            start, end = choose_times(session, timezone, late_dates)
            events.append(
                DesiredEvent(
                    plan_id=plan_id_for(session),
                    title=event_title(session),
                    start=start,
                    end=end,
                    source_date=source_date,
                    source_day=str(session.get("day") or "").strip(),
                )
            )
    return events


def event_body(event: DesiredEvent, color_id: str, timezone_name: str) -> dict[str, Any]:
    return {
        "summary": event.title,
        "description": "",
        "start": {"dateTime": event.start.isoformat(), "timeZone": timezone_name},
        "end": {"dateTime": event.end.isoformat(), "timeZone": timezone_name},
        "colorId": color_id,
        "reminders": {"useDefault": False, "overrides": []},
        "extendedProperties": {
            "private": {
                SYNC_MARKER_KEY: SYNC_MARKER_VALUE,
                PLAN_ID_KEY: event.plan_id,
                SOURCE_DATE_KEY: event.source_date,
                SOURCE_DAY_KEY: event.source_day,
            }
        },
    }


def event_matches(event: dict[str, Any], desired: DesiredEvent, color_id: str, timezone: ZoneInfo) -> bool:
    start = parse_event_datetime(event.get("start", {}).get("dateTime"), timezone)
    end = parse_event_datetime(event.get("end", {}).get("dateTime"), timezone)
    props = private_props(event)
    reminders = event.get("reminders", {})
    return (
        event.get("summary") == desired.title
        and start == desired.start
        and end == desired.end
        and event.get("colorId") == color_id
        and reminders.get("useDefault") is False
        and reminders.get("overrides", []) == []
        and props.get(SYNC_MARKER_KEY) == SYNC_MARKER_VALUE
        and props.get(PLAN_ID_KEY) == desired.plan_id
    )


def same_moment(value: str | None, expected: datetime, timezone: ZoneInfo) -> bool:
    parsed = parse_event_datetime(value, timezone)
    return parsed == expected


def find_adoption_candidate(
    service: Any,
    calendar_id: str,
    desired: DesiredEvent,
    timezone: ZoneInfo,
) -> dict[str, Any] | None:
    events = list_calendar_events(
        service,
        calendar_id,
        desired.start.date(),
        desired.start.date(),
        timezone,
        q=desired.title,
    )
    for event in events:
        if is_managed_event(event):
            continue
        if event.get("summary") != desired.title:
            continue
        if not same_moment(event.get("start", {}).get("dateTime"), desired.start, timezone):
            continue
        if not same_moment(event.get("end", {}).get("dateTime"), desired.end, timezone):
            continue
        return event
    return None


def sync_events(
    service: Any | None,
    calendar_id: str,
    desired_events: list[DesiredEvent],
    timezone: ZoneInfo,
    timezone_name: str,
    color_id: str,
    apply: bool,
    delete_stale: bool,
) -> dict[str, int]:
    counts = {"create": 0, "update": 0, "adopt": 0, "delete": 0, "unchanged": 0}
    if not desired_events:
        return counts

    desired_by_id = {event.plan_id: event for event in desired_events}
    start_date = min(event.start.date() for event in desired_events)
    end_date = max(event.end.date() for event in desired_events)
    managed_by_id: dict[str, dict[str, Any]] = {}

    if service is not None:
        managed_events = list_calendar_events(
            service,
            calendar_id,
            start_date,
            end_date,
            timezone,
            privateExtendedProperty=f"{SYNC_MARKER_KEY}={SYNC_MARKER_VALUE}",
        )
        for event in managed_events:
            plan_id = private_props(event).get(PLAN_ID_KEY)
            if plan_id:
                managed_by_id[plan_id] = event

    for desired in desired_events:
        existing = managed_by_id.get(desired.plan_id)
        if existing:
            if event_matches(existing, desired, color_id, timezone):
                counts["unchanged"] += 1
                continue
            counts["update"] += 1
            if apply and service is not None:
                service.events().patch(
                    calendarId=calendar_id,
                    eventId=existing["id"],
                    body=event_body(desired, color_id, timezone_name),
                    sendUpdates="none",
                ).execute()
            continue

        candidate = find_adoption_candidate(service, calendar_id, desired, timezone) if service is not None else None
        if candidate:
            counts["adopt"] += 1
            if apply and service is not None:
                service.events().patch(
                    calendarId=calendar_id,
                    eventId=candidate["id"],
                    body=event_body(desired, color_id, timezone_name),
                    sendUpdates="none",
                ).execute()
            continue

        counts["create"] += 1
        if apply and service is not None:
            service.events().insert(
                calendarId=calendar_id,
                body=event_body(desired, color_id, timezone_name),
                sendUpdates="none",
            ).execute()

    if delete_stale:
        for plan_id, event in managed_by_id.items():
            if plan_id in desired_by_id:
                continue
            counts["delete"] += 1
            if apply and service is not None:
                service.events().delete(
                    calendarId=calendar_id,
                    eventId=event["id"],
                    sendUpdates="none",
                ).execute()

    return counts


def print_preview(events: list[DesiredEvent], limit: int) -> None:
    print(f"Prepared {len(events)} desired calendar event(s).")
    for event in events[:limit]:
        print(f"- {event.start:%Y-%m-%d %a %H:%M}-{event.end:%H:%M}: {event.title}")
    if len(events) > limit:
        print(f"... {len(events) - limit} more")


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync SCKL training plan rows into Google Calendar.")
    parser.add_argument("--spreadsheet-id", default=os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID))
    parser.add_argument("--sheet-range", default=os.environ.get("GOOGLE_SHEET_RANGE", DEFAULT_RANGE))
    parser.add_argument("--calendar-id", default=os.environ.get("GOOGLE_CALENDAR_ID", "primary"))
    parser.add_argument("--timezone", default=os.environ.get("TRAINING_CALENDAR_TIMEZONE", DEFAULT_TIMEZONE))
    parser.add_argument("--color-id", default=os.environ.get("TRAINING_CALENDAR_COLOR_ID", DEFAULT_CALENDAR_COLOR_ID))
    parser.add_argument("--start-date", default=os.environ.get("TRAINING_CALENDAR_START_DATE"))
    parser.add_argument("--end-date", default=os.environ.get("TRAINING_CALENDAR_END_DATE"))
    parser.add_argument("--input-json", help="Use an existing training-plan JSON file instead of reading Google Sheets")
    parser.add_argument("--credentials-file", help="Path to a Google service account JSON key")
    parser.add_argument("--credentials-json", help="Raw Google service account JSON")
    parser.add_argument("--include-wednesdays", action="store_true", help="Also sync Wednesday sessions")
    parser.add_argument("--no-calendar-awareness", action="store_true", help="Do not move easy runs to AM after late commitments")
    parser.add_argument("--delete-stale", action="store_true", help="Delete previously managed events no longer present in the plan")
    parser.add_argument("--apply", action="store_true", help="Write changes to Google Calendar. Omit for dry-run preview.")
    parser.add_argument("--preview-limit", type=int, default=20)
    args = parser.parse_args()

    try:
        timezone = ZoneInfo(args.timezone)
        start_date = parse_iso_date(args.start_date, "--start-date")
        end_date = parse_iso_date(args.end_date, "--end-date")
        plan = load_plan(args)

        initial_events = build_desired_events(
            plan,
            timezone,
            late_dates=set(),
            start_date=start_date,
            end_date=end_date,
            include_wednesdays=args.include_wednesdays,
        )
        if not initial_events:
            print("No planned training sessions found for the requested range.")
            return 0

        service = None
        if args.apply or not args.no_calendar_awareness:
            service = build_calendar_service(args.credentials_file, args.credentials_json)

        late_dates = set()
        if service is not None and not args.no_calendar_awareness:
            training_titles = {event.title for event in initial_events}
            late_dates = dates_with_late_commitments(
                service,
                args.calendar_id,
                min(event.start.date() for event in initial_events),
                max(event.end.date() for event in initial_events),
                timezone,
                training_titles,
            )

        desired_events = build_desired_events(
            plan,
            timezone,
            late_dates=late_dates,
            start_date=start_date,
            end_date=end_date,
            include_wednesdays=args.include_wednesdays,
        )
        print_preview(desired_events, args.preview_limit)
        counts = sync_events(
            service=service,
            calendar_id=args.calendar_id,
            desired_events=desired_events,
            timezone=timezone,
            timezone_name=args.timezone,
            color_id=args.color_id,
            apply=args.apply,
            delete_stale=args.delete_stale,
        )
        mode = "Applied" if args.apply else "Dry run"
        print(
            f"{mode}: {counts['create']} create, {counts['adopt']} adopt, "
            f"{counts['update']} update, {counts['delete']} delete, {counts['unchanged']} unchanged."
        )
        if not args.apply:
            print("Re-run with --apply to write these changes.")
        return 0
    except (CalendarSyncError, SheetConfigError, SheetParseError, OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
