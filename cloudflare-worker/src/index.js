const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const NOTE_HEADER_ROW = ["Activity ID", "Date", "Activity", "Note", "Strava URL", "Updated At"];
const MAX_NOTE_LENGTH = 500;
const MAX_REQUEST_BODY_LENGTH = 4096;
const TOKEN_REFRESH_BUFFER_SECONDS = 60;
let cachedGoogleAccessToken = null;

export default {
  async fetch(request, env) {
    const corsHeaders = cors(env, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/notes" && request.method === "GET") {
        requireAuth(request, env);
        const notes = await listNotes(env);
        return json({ notes }, corsHeaders);
      }

      if (url.pathname === "/notes" && request.method === "POST") {
        requireAuth(request, env);
        const payload = await readJson(request);
        const note = await upsertNote(env, payload);
        return json({ ok: true, note }, corsHeaders);
      }

      return json({ error: "Not found" }, corsHeaders, 404);
    } catch (error) {
      const status = error.status || 500;
      return json({ error: error.message || "Worker error" }, corsHeaders, status);
    }
  }
};

function cors(env, request) {
  const requestOrigin = request.headers.get("Origin") || "";
  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  const origin = allowedOrigin === "*" || allowedOrigin === requestOrigin ? allowedOrigin : "null";
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body, headers, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function requireAuth(request, env) {
  requireEnv(env, "RUN_NOTES_TOKEN");
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("X-Run-Notes-Token")
    || "";
  if (token !== env.RUN_NOTES_TOKEN) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
}

function requireEnv(env, name) {
  if (!env[name]) {
    const error = new Error(`Missing Worker binding: ${name}`);
    error.status = 500;
    throw error;
  }
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_REQUEST_BODY_LENGTH) {
    const error = new Error("Request body too large");
    error.status = 413;
    throw error;
  }
  const body = await request.text();
  if (body.length > MAX_REQUEST_BODY_LENGTH) {
    const error = new Error("Request body too large");
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    const parseError = new Error("Request body must be JSON");
    parseError.status = 400;
    throw parseError;
  }
}

async function listNotes(env) {
  await ensureSheet(env, noteSheetName(env), NOTE_HEADER_ROW);
  const range = `${a1SheetName(noteSheetName(env))}!A2:F`;
  const values = await sheetsGet(env, range);
  return values.map((row) => ({
    activity_id: row[0] || "",
    date: row[1] || "",
    name: row[2] || "",
    note: row[3] || "",
    strava_url: row[4] || "",
    updated_at: row[5] || ""
  })).filter((row) => row.activity_id);
}

async function upsertNote(env, payload) {
  await ensureSheet(env, noteSheetName(env), NOTE_HEADER_ROW);
  const note = {
    activity_id: String(payload.activity_id || "").trim(),
    date: String(payload.date || "").trim(),
    name: String(payload.name || "").trim(),
    note: String(payload.note || "").trim().slice(0, MAX_NOTE_LENGTH),
    strava_url: String(payload.strava_url || "").trim(),
    updated_at: new Date().toISOString()
  };
  if (!note.activity_id) {
    const error = new Error("Missing activity_id");
    error.status = 400;
    throw error;
  }

  const sheet = a1SheetName(noteSheetName(env));
  const rows = await sheetsGet(env, `${sheet}!A2:F`);
  const existingIndex = rows.findIndex((row) => String(row[0] || "") === note.activity_id);
  const values = [[note.activity_id, note.date, note.name, note.note, note.strava_url, note.updated_at]];

  if (existingIndex >= 0) {
    const rowNumber = existingIndex + 2;
    await sheetsPut(env, `${sheet}!A${rowNumber}:F${rowNumber}`, values);
  } else {
    await sheetsAppend(env, `${sheet}!A:F`, values);
  }
  return note;
}

async function ensureSheet(env, title, headerRow) {
  const metadata = await sheetsFetch(env, "", { method: "GET" });
  const exists = metadata.sheets?.some((sheet) => sheet.properties?.title === title);
  if (!exists) {
    await sheetsFetch(env, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          { addSheet: { properties: { title } } }
        ]
      })
    });
  }

  const endColumn = String.fromCharCode(64 + headerRow.length);
  const values = await sheetsGet(env, `${a1SheetName(title)}!A1:${endColumn}1`);
  if (!values.length || values[0].join("|") !== headerRow.join("|")) {
    await sheetsPut(env, `${a1SheetName(title)}!A1:${endColumn}1`, [headerRow]);
  }
}

function noteSheetName(env) {
  return env.RUN_NOTES_SHEET_NAME || "Run Notes";
}

function a1SheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

async function sheetsGet(env, range) {
  const encoded = encodeURIComponent(range);
  const response = await sheetsFetch(env, `/values/${encoded}`, { method: "GET" });
  return response.values || [];
}

async function sheetsPut(env, range, values) {
  const encoded = encodeURIComponent(range);
  return sheetsFetch(env, `/values/${encoded}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values })
  });
}

async function sheetsAppend(env, range, values) {
  const encoded = encodeURIComponent(range);
  return sheetsFetch(env, `/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values })
  });
}

async function sheetsFetch(env, path, init) {
  requireEnv(env, "GOOGLE_SHEET_ID");
  requireEnv(env, "GOOGLE_SERVICE_ACCOUNT_JSON");
  const accessToken = await getAccessToken(env);
  const url = `${SHEETS_BASE_URL}/${env.GOOGLE_SHEET_ID}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || `Google Sheets request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleAccessToken?.value && cachedGoogleAccessToken.expiresAt - TOKEN_REFRESH_BUFFER_SECONDS > now) {
    return cachedGoogleAccessToken.value;
  }

  const serviceAccount = parseServiceAccount(env);
  const claim = {
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
    iss: serviceAccount.client_email,
    scope: SHEETS_SCOPE
  };
  const assertion = await signJwt(serviceAccount.private_key, claim);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      assertion,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer"
    })
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error_description || "Could not get Google access token");
    error.status = response.status;
    throw error;
  }
  cachedGoogleAccessToken = {
    value: body.access_token,
    expiresAt: now + Number(body.expires_in || 3600)
  };
  return body.access_token;
}

function parseServiceAccount(env) {
  const rawSecret = env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const secretName = env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 ? "GOOGLE_SERVICE_ACCOUNT_JSON_B64" : "GOOGLE_SERVICE_ACCOUNT_JSON";
  const candidates = serviceAccountCandidates(rawSecret, Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.client_email && parsed?.private_key) return parsed;
    } catch (error) {
      const repaired = repairJsonMultilineStrings(candidate);
      if (repaired !== candidate) {
        try {
          const parsed = JSON.parse(repaired);
          if (parsed?.client_email && parsed?.private_key) return parsed;
        } catch (repairedError) {
          // Continue to the next candidate before reporting a configuration error.
        }
      }
    }
  }

  const error = new Error(`${secretName} is not valid Google service account JSON. Re-upload the full key as one-line JSON or base64-encoded JSON.`);
  error.status = 500;
  throw error;
}

function serviceAccountCandidates(value, isBase64Only = false) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const candidates = [];
  if (!isBase64Only) candidates.push(raw);
  try {
    candidates.push(atob(raw));
  } catch (error) {
    // The existing secret may be plain JSON, so a base64 decode failure is fine.
  }
  return [...new Set(candidates)];
}

function repairJsonMultilineStrings(value) {
  let repaired = "";
  let inString = false;
  let escaped = false;
  for (const character of String(value)) {
    if (inString && (character === "\n" || character === "\r")) {
      if (character === "\n") repaired += "\\n";
      continue;
    }
    repaired += character;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") inString = !inString;
  }
  return repaired;
}

async function signJwt(privateKeyPem, claim) {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaim = base64Url(JSON.stringify(claim));
  const input = `${encodedHeader}.${encodedClaim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64Url(signature)}`;
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
