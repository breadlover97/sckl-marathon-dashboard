const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";
const STRAVA_ACTIVITY_URL = "https://www.strava.com/api/v3/activities";
const PER_PAGE = 200;
const CACHE_KEY = "activities-json";
const REFRESH_TOKEN_KEY = "refresh-token";
const STATUS_KEY = "sync-status";
const DEFAULT_AFTER_TIMESTAMP = 1777593600; // 2026-05-01T00:00:00Z
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/api/strava/activities" && (request.method === "GET" || request.method === "HEAD")) {
        const payload = request.method === "HEAD" ? null : await readActivityPayload(env);
        return jsonResponse(payload, request, env);
      }

      if (url.pathname === "/api/strava/status" && request.method === "GET") {
        const status = await readJsonKv(env, STATUS_KEY, {});
        return jsonResponse(status, request, env);
      }

      if (url.pathname === "/api/strava/sync" && request.method === "POST") {
        if (!isAuthorized(request, env)) return jsonResponse({ error: "Unauthorized" }, request, env, 401);
        const payload = await refreshAllActivities(env);
        return jsonResponse(payload, request, env);
      }

      if (url.pathname === "/api/strava/webhook" && request.method === "GET") {
        return handleWebhookVerification(url, request, env);
      }

      if (url.pathname === "/api/strava/webhook" && request.method === "POST") {
        const event = await request.json().catch(() => null);
        if (!event) return jsonResponse({ error: "Invalid JSON" }, request, env, 400);
        ctx.waitUntil(handleWebhookEventSafe(event, env));
        return jsonResponse({ ok: true }, request, env);
      }

      return jsonResponse({ error: "Not found" }, request, env, 404);
    } catch (error) {
      await writeStatus(env, { ok: false, error: String(error), updated_at: nowIso() });
      return jsonResponse({ error: String(error) }, request, env, 500);
    }
  },
};

async function handleWebhookEventSafe(event, env) {
  try {
    await handleWebhookEvent(event, env);
  } catch (error) {
    await writeStatus(env, {
      ok: false,
      error: String(error),
      last_event: event,
      updated_at: nowIso(),
      stage: "webhook-error",
    });
  }
}

async function handleWebhookVerification(url, request, env) {
  const verifyToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (!challenge || verifyToken !== env.STRAVA_VERIFY_TOKEN) {
    return jsonResponse({ error: "Invalid verify token" }, request, env, 403);
  }
  return jsonResponse({ "hub.challenge": challenge }, request, env);
}

async function handleWebhookEvent(event, env) {
  await writeStatus(env, { ok: true, last_event: event, updated_at: nowIso(), stage: "received-webhook" });

  if (event.object_type !== "activity") {
    await writeStatus(env, { ok: true, last_event: event, updated_at: nowIso(), stage: "ignored-non-activity" });
    return;
  }

  if (event.aspect_type === "delete") {
    await removeActivity(env, String(event.object_id));
    await writeStatus(env, { ok: true, last_event: event, updated_at: nowIso(), stage: "deleted-activity" });
    return;
  }

  if (event.aspect_type === "create" || event.aspect_type === "update") {
    let activity = null;
    try {
      activity = await fetchActivity(env, event.object_id);
    } catch (error) {
      if (error instanceof StravaHttpError && (error.status === 403 || error.status === 404)) {
        await writeStatus(env, {
          ok: true,
          warning: String(error),
          last_event: event,
          updated_at: nowIso(),
          stage: "webhook-activity-unavailable",
        });
        return;
      }
      throw error;
    }
    await upsertActivity(env, activity, event);
    await writeStatus(env, { ok: true, last_event: event, updated_at: nowIso(), stage: "upserted-activity" });
  }
}

async function refreshAllActivities(env) {
  await writeStatus(env, { ok: true, updated_at: nowIso(), stage: "manual-full-sync-started" });
  const accessToken = await accessTokenFor(env);
  await writeStatus(env, { ok: true, updated_at: nowIso(), stage: "manual-full-sync-token-ok" });
  const after = Number(env.STRAVA_AFTER_TIMESTAMP || DEFAULT_AFTER_TIMESTAMP);
  const rawActivities = [];

  for (let page = 1; ; page += 1) {
    await writeStatus(env, { ok: true, updated_at: nowIso(), stage: "manual-full-sync-fetching-page", page });
    const url = new URL(STRAVA_ACTIVITIES_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("after", String(after));

    const response = await stravaFetch(url.toString(), accessToken);
    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) throw new Error("Strava activities response was not a list");
    rawActivities.push(...pageItems);
    if (pageItems.length < PER_PAGE) break;
  }

  const activities = rawActivities
    .filter((activity) => RUN_TYPES.has(activity.sport_type || activity.type))
    .map(sanitizeActivity)
    .sort(sortActivitiesDesc);

  const payload = payloadForActivities(activities, {
    source: "strava-worker",
    sync_type: "manual-full-sync",
  });

  await env.STRAVA_CACHE.put(CACHE_KEY, JSON.stringify(payload));
  await writeStatus(env, { ok: true, updated_at: nowIso(), stage: "manual-full-sync", activities: activities.length });
  return payload;
}

async function fetchActivity(env, activityId) {
  await writeStatus(env, { ok: true, updated_at: nowIso(), stage: "webhook-fetch-activity-started", activity_id: String(activityId) });
  const accessToken = await accessTokenFor(env);
  await writeStatus(env, { ok: true, updated_at: nowIso(), stage: "webhook-fetch-activity-token-ok", activity_id: String(activityId) });
  const response = await stravaFetch(`${STRAVA_ACTIVITY_URL}/${activityId}`, accessToken);
  return response.json();
}

async function upsertActivity(env, rawActivity, event) {
  const payload = await readActivityPayload(env);
  const activities = Array.isArray(payload.activities) ? payload.activities : [];
  const id = String(rawActivity.id || event.object_id || "");
  const nextActivities = activities.filter((activity) => String(activity.id) !== id);

  if (RUN_TYPES.has(rawActivity.sport_type || rawActivity.type)) {
    nextActivities.push(sanitizeActivity(rawActivity));
  }

  const nextPayload = payloadForActivities(nextActivities.sort(sortActivitiesDesc), {
    source: "strava-worker",
    sync_type: "webhook",
    last_event_at: event.event_time ? new Date(Number(event.event_time) * 1000).toISOString() : nowIso(),
  });

  await env.STRAVA_CACHE.put(CACHE_KEY, JSON.stringify(nextPayload));
}

async function removeActivity(env, activityId) {
  const payload = await readActivityPayload(env);
  const activities = Array.isArray(payload.activities) ? payload.activities : [];
  const nextActivities = activities.filter((activity) => String(activity.id) !== String(activityId));
  await env.STRAVA_CACHE.put(
    CACHE_KEY,
    JSON.stringify(payloadForActivities(nextActivities, { source: "strava-worker", sync_type: "webhook-delete" })),
  );
}

async function readActivityPayload(env) {
  const cached = await readJsonKv(env, CACHE_KEY, null);
  const bootstrap = await readBootstrapPayload(env);

  if (bootstrap && (!cached || payloadTime(bootstrap) > payloadTime(cached))) {
    await env.STRAVA_CACHE.put(CACHE_KEY, JSON.stringify(bootstrap));
    return bootstrap;
  }

  if (cached) return cached;
  if (bootstrap) return bootstrap;

  return payloadForActivities([], { source: "strava-worker", sync_type: "empty" });
}

async function readBootstrapPayload(env) {
  const bootstrapUrl = env.BOOTSTRAP_ACTIVITIES_URL;
  if (!bootstrapUrl) return null;

  const response = await fetch(bootstrapUrl, { headers: { accept: "application/json" } });
  if (!response.ok) return null;

  const payload = await response.json();
  payload.metadata = {
    ...(payload.metadata || {}),
    source: payload.metadata?.source || "bootstrap-json",
    worker_bootstrapped_at: nowIso(),
  };
  return payload;
}

function payloadTime(payload) {
  const timestamp = Date.parse(payload?.metadata?.generated_at || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function accessTokenFor(env) {
  const refreshToken = await env.STRAVA_CACHE.get(REFRESH_TOKEN_KEY) || env.STRAVA_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("Missing Strava refresh token");

  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetchWithRetries(STRAVA_TOKEN_URL, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });

  if (!response.ok) {
    throw new Error(`Strava token refresh failed with HTTP ${response.status}: ${await safeText(response)}`);
  }

  const token = await response.json();
  if (!token.access_token) throw new Error("Strava token refresh did not return an access token");
  if (token.refresh_token && token.refresh_token !== refreshToken) {
    await env.STRAVA_CACHE.put(REFRESH_TOKEN_KEY, token.refresh_token);
  }
  return token.access_token;
}

async function stravaFetch(url, accessToken) {
  const response = await fetchWithRetries(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new StravaHttpError(response.status, redactUrl(url), await safeText(response));
  }
  return response;
}

class StravaHttpError extends Error {
  constructor(status, url, body) {
    super(`Strava request failed for ${url} with HTTP ${status}: ${body}`);
    this.name = "StravaHttpError";
    this.status = status;
  }
}

function redactUrl(url) {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}

async function fetchWithRetries(url, options = {}) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, options);
    if (!RETRY_STATUSES.has(response.status) || attempt === 3) return response;
    lastResponse = response;
    await sleep(attempt * 1000);
  }
  return lastResponse;
}

function sanitizeActivity(activity) {
  const id = activity.id ? String(activity.id) : "";
  return {
    id,
    name: activity.name || "Strava Run",
    date: localDate(activity),
    start_date_local: activity.start_date_local || activity.start_date || "",
    distance_km: roundKm(Number(activity.distance || 0) / 1000),
    moving_time_seconds: Number(activity.moving_time || 0),
    elapsed_time_seconds: Number(activity.elapsed_time || 0),
    elevation_gain_m: Math.round(Number(activity.total_elevation_gain || 0) * 10) / 10,
    type: activity.type || activity.sport_type || "Run",
    sport_type: activity.sport_type || activity.type || "Run",
    average_speed_mps: activity.average_speed ? Number(activity.average_speed) : null,
    average_heartrate: activity.average_heartrate ? Math.round(Number(activity.average_heartrate) * 10) / 10 : null,
    average_cadence: activity.average_cadence ? Math.round(Number(activity.average_cadence) * 10) / 10 : null,
    strava_url: id ? `https://www.strava.com/activities/${id}` : "",
  };
}

function payloadForActivities(activities, metadata = {}) {
  return {
    metadata: {
      ...metadata,
      generated_at: nowIso(),
      included_activities: activities.length,
    },
    activities,
  };
}

function localDate(activity) {
  const value = activity.start_date_local || activity.start_date || "";
  return String(value).split("T", 1)[0];
}

function sortActivitiesDesc(a, b) {
  return Date.parse(b.start_date_local || b.date || "") - Date.parse(a.start_date_local || a.date || "");
}

function isAuthorized(request, env) {
  const auth = request.headers.get("authorization") || "";
  return Boolean(env.STRAVA_SYNC_SECRET && auth === `Bearer ${env.STRAVA_SYNC_SECRET}`);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.CORS_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function jsonResponse(payload, request, env, status = 200) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function readJsonKv(env, key, fallback) {
  const value = await env.STRAVA_CACHE.get(key);
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function writeStatus(env, status) {
  await env.STRAVA_CACHE.put(STATUS_KEY, JSON.stringify(status));
}

async function safeText(response) {
  const text = await response.text();
  return text.slice(0, 300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundKm(value) {
  return Math.round(value * 1000) / 1000;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
