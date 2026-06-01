#!/usr/bin/env python3
"""Register the Cloudflare Worker as the Strava webhook callback."""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import requests


PUSH_SUBSCRIPTIONS_URL = "https://www.strava.com/api/v3/push_subscriptions"


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def request_json(method: str, url: str, **kwargs: Any) -> Any:
    response = requests.request(method, url, timeout=30, **kwargs)
    if response.status_code == 204:
        return None
    if response.status_code >= 400:
        raise RuntimeError(f"Strava webhook request failed with HTTP {response.status_code}: {response.text[:300]}")
    return response.json()


def list_subscriptions(client_id: str, client_secret: str) -> list[dict[str, Any]]:
    payload = request_json(
        "GET",
        PUSH_SUBSCRIPTIONS_URL,
        params={"client_id": client_id, "client_secret": client_secret},
    )
    if isinstance(payload, list):
        return payload
    return []


def delete_subscription(subscription_id: int | str, client_id: str, client_secret: str) -> None:
    request_json(
        "DELETE",
        f"{PUSH_SUBSCRIPTIONS_URL}/{subscription_id}",
        params={"client_id": client_id, "client_secret": client_secret},
    )


def create_subscription(client_id: str, client_secret: str, callback_url: str, verify_token: str) -> dict[str, Any]:
    payload = request_json(
        "POST",
        PUSH_SUBSCRIPTIONS_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "callback_url": callback_url,
            "verify_token": verify_token,
        },
    )
    if not isinstance(payload, dict) or not payload.get("id"):
        raise RuntimeError(f"Unexpected Strava subscription response: {payload}")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Register the Strava webhook callback.")
    parser.add_argument("--replace", action="store_true", help="Delete any existing subscription before creating a new one")
    args = parser.parse_args()

    try:
        client_id = require_env("STRAVA_CLIENT_ID")
        client_secret = require_env("STRAVA_CLIENT_SECRET")
        callback_url = require_env("STRAVA_WEBHOOK_CALLBACK_URL")
        verify_token = require_env("STRAVA_VERIFY_TOKEN")

        subscriptions = list_subscriptions(client_id, client_secret)
        matching = [item for item in subscriptions if item.get("callback_url") == callback_url]
        if matching and not args.replace:
            print(f"Strava webhook already registered for {callback_url}.")
            return 0

        if subscriptions and not args.replace:
            callbacks = ", ".join(str(item.get("callback_url")) for item in subscriptions)
            raise RuntimeError(
                "A Strava webhook subscription already exists for this app. "
                f"Existing callback(s): {callbacks}. Re-run with --replace to switch callbacks."
            )

        for subscription in subscriptions:
            if subscription.get("id"):
                delete_subscription(subscription["id"], client_id, client_secret)
                print(f"Deleted existing Strava webhook subscription {subscription['id']}.")

        created = create_subscription(client_id, client_secret, callback_url, verify_token)
        print(f"Registered Strava webhook subscription {created['id']} for {callback_url}.")
        return 0
    except (RuntimeError, requests.RequestException) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
