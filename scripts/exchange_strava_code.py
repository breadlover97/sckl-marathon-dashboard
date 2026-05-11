#!/usr/bin/env python3
"""Exchange a one-time Strava OAuth code for tokens."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path

import requests


STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
DEFAULT_OUTPUT = "generated/strava_token.json"


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Exchange a Strava authorization code for a refresh token.")
    parser.add_argument("--code", required=True, help="One-time code from the Strava OAuth redirect URL")
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    try:
        response = requests.post(
            STRAVA_TOKEN_URL,
            data={
                "client_id": require_env("STRAVA_CLIENT_ID"),
                "client_secret": require_env("STRAVA_CLIENT_SECRET"),
                "code": args.code,
                "grant_type": "authorization_code",
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Token exchange failed with HTTP {response.status_code}: {response.text[:300]}")

        payload = response.json()
        output = {
            "access_token": payload.get("access_token"),
            "refresh_token": payload.get("refresh_token"),
            "expires_at": payload.get("expires_at"),
            "scope": payload.get("scope"),
            "athlete": {
                "id": payload.get("athlete", {}).get("id"),
                "username": payload.get("athlete", {}).get("username"),
                "firstname": payload.get("athlete", {}).get("firstname"),
                "lastname": payload.get("athlete", {}).get("lastname"),
            },
        }
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(output, handle, indent=2)
            handle.write("\n")
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        print(f"Wrote Strava token details to {path}.")
        print("Use the refresh_token value as STRAVA_REFRESH_TOKEN.")
        return 0
    except (RuntimeError, requests.RequestException, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
