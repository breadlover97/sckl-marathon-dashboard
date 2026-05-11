#!/usr/bin/env python3
"""Fetch privacy-safe Strava running activities for the SCKL dashboard."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities"
STRAVA_ATHLETE_URL = "https://www.strava.com/api/v3/athlete"
DEFAULT_OUTPUT = "data/strava-activities.json"
PER_PAGE = 200


class StravaConfigError(Exception):
    pass


class StravaApiError(Exception):
    pass


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise StravaConfigError(f"Missing required environment variable: {name}")
    return value


def refresh_access_token(session: requests.Session, client_id: str, client_secret: str, refresh_token: str) -> dict[str, Any]:
    response = session.post(
        STRAVA_TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=30,
    )
    if response.status_code != 200:
        raise StravaApiError(f"Token refresh failed with HTTP {response.status_code}: {response.text[:200]}")
    payload = response.json()
    if not payload.get("access_token"):
        raise StravaApiError("Token refresh response did not include an access token")
    return payload


def fetch_activities(session: requests.Session, access_token: str, after: int | None, before: int | None) -> list[dict[str, Any]]:
    activities: list[dict[str, Any]] = []
    page = 1
    while True:
        params: dict[str, Any] = {"page": page, "per_page": PER_PAGE}
        if after:
            params["after"] = after
        if before:
            params["before"] = before
        response = session.get(
            STRAVA_ACTIVITIES_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            params=params,
            timeout=30,
        )
        if response.status_code != 200:
            raise StravaApiError(f"Activities request failed with HTTP {response.status_code}: {response.text[:200]}")
        page_items = response.json()
        if not isinstance(page_items, list):
            raise StravaApiError("Activities response was not a list")
        activities.extend(page_items)
        if len(page_items) < PER_PAGE:
            break
        page += 1
    return activities


def fetch_athlete(session: requests.Session, access_token: str) -> dict[str, Any]:
    response = session.get(
        STRAVA_ATHLETE_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    if response.status_code != 200:
        raise StravaApiError(f"Athlete request failed with HTTP {response.status_code}: {response.text[:200]}")
    payload = response.json()
    if not isinstance(payload, dict):
        raise StravaApiError("Athlete response was not an object")
    return payload


def local_date(activity: dict[str, Any]) -> str:
    value = activity.get("start_date_local") or activity.get("start_date") or ""
    if not value:
        return ""
    return str(value).split("T", 1)[0]


def sanitize_activity(activity: dict[str, Any]) -> dict[str, Any]:
    activity_id = activity.get("id")
    distance_km = round(float(activity.get("distance") or 0) / 1000, 3)
    return {
        "id": str(activity_id) if activity_id is not None else "",
        "name": activity.get("name") or "Strava Run",
        "date": local_date(activity),
        "start_date_local": activity.get("start_date_local"),
        "distance_km": distance_km,
        "moving_time_seconds": int(activity.get("moving_time") or 0),
        "elapsed_time_seconds": int(activity.get("elapsed_time") or 0),
        "elevation_gain_m": round(float(activity.get("total_elevation_gain") or 0), 1),
        "type": activity.get("type"),
        "sport_type": activity.get("sport_type"),
        "average_speed_mps": float(activity.get("average_speed") or 0),
        "average_heartrate": round(float(activity.get("average_heartrate") or 0), 1) if activity.get("average_heartrate") else None,
        "max_heartrate": int(activity.get("max_heartrate") or 0) if activity.get("max_heartrate") else None,
        "average_cadence": round(float(activity.get("average_cadence") or 0), 1) if activity.get("average_cadence") else None,
        "calories": round(float(activity.get("calories") or 0), 1) if activity.get("calories") else None,
        "strava_url": f"https://www.strava.com/activities/{activity_id}" if activity_id else "",
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Strava runs for the SCKL marathon dashboard.")
    parser.add_argument("--output", default=os.environ.get("STRAVA_ACTIVITIES_OUTPUT", DEFAULT_OUTPUT))
    parser.add_argument("--after", type=int, help="Unix timestamp lower bound for activities")
    parser.add_argument("--before", type=int, help="Unix timestamp upper bound for activities")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and validate without writing output")
    args = parser.parse_args()

    try:
        client_id = require_env("STRAVA_CLIENT_ID")
        client_secret = require_env("STRAVA_CLIENT_SECRET")
        refresh_token = require_env("STRAVA_REFRESH_TOKEN")
        session = requests.Session()
        token_payload = refresh_access_token(session, client_id, client_secret, refresh_token)
        athlete = fetch_athlete(session, token_payload["access_token"])
        raw_activities = fetch_activities(session, token_payload["access_token"], args.after, args.before)
        runs = [
            sanitize_activity(activity)
            for activity in raw_activities
            if (activity.get("sport_type") or activity.get("type")) == "Run"
        ]
        payload = {
            "metadata": {
                "source": "strava-api",
                "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "included_activities": len(runs),
                "rotated_refresh_token": bool(token_payload.get("refresh_token") and token_payload.get("refresh_token") != refresh_token),
                "athlete": {
                    "firstname": athlete.get("firstname"),
                    "lastname": athlete.get("lastname"),
                    "profile": athlete.get("profile"),
                    "profile_medium": athlete.get("profile_medium"),
                },
            },
            "activities": runs,
        }
        if args.dry_run:
            print(f"Fetched {len(runs)} run activity/activities.")
            if payload["metadata"]["rotated_refresh_token"]:
                print("Strava returned a rotated refresh token. Update STRAVA_REFRESH_TOKEN before the next sync.")
            return 0
        write_json(Path(args.output), payload)
        print(f"Wrote {len(runs)} run activity/activities to {args.output}.")
        if payload["metadata"]["rotated_refresh_token"]:
            print("Warning: Strava returned a rotated refresh token. Update STRAVA_REFRESH_TOKEN before the next sync.", file=sys.stderr)
        return 0
    except (StravaConfigError, StravaApiError, requests.RequestException, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
