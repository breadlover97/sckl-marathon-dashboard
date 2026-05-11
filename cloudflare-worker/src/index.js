const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const NOTE_HEADER_ROW = ["Activity ID", "Date", "Activity", "Note", "Strava URL", "Updated At"];
const SUPPLEMENT_HEADER_ROW = ["Date", "Protein Shake", "Omega 3", "Vitamin D", "Updated At"];
const MAX_NOTE_LENGTH = 500;

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

      if (url.pathname === "/supplements" && request.method === "GET") {
        requireAuth(request, env);
        const supplements = await listSupplements(env);
        return json({ supplements }, corsHeaders);
      }

      if (url.pathname === "/supplements" && request.method === "POST") {
        requireAuth(request, env);
        const payload = await readJson(request);
        const supplement = await upsertSupplement(env, payload);
        return json({ ok: true, supplement }, corsHeaders);
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
  if (contentLength > 4096) {
    const error = new Error("Request body too large");
    error.status = 413;
    throw error;
  }
  try {
    return await request.json();
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

async function listSupplements(env) {
  await ensureSheet(env, supplementSheetName(env), SUPPLEMENT_HEADER_ROW);
  const rows = await sheetsGet(env, `${a1SheetName(supplementSheetName(env))}!A2:E`);
  return rows.map((row) => ({
    date: String(row[0] || "").trim(),
    protein: sheetBool(row[1]),
    omega3: sheetBool(row[2]),
    vitaminD: sheetBool(row[3]),
    updated_at: row[4] || ""
  })).filter((row) => row.date);
}

async function upsertSupplement(env, payload) {
  await ensureSheet(env, supplementSheetName(env), SUPPLEMENT_HEADER_ROW);
  const supplement = {
    date: String(payload.date || "").trim(),
    protein: Boolean(payload.protein),
    omega3: Boolean(payload.omega3),
    vitaminD: Boolean(payload.vitaminD),
    updated_at: new Date().toISOString()
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(supplement.date)) {
    const error = new Error("Missing or invalid date");
    error.status = 400;
    throw error;
  }

  const sheet = a1SheetName(supplementSheetName(env));
  const rows = await sheetsGet(env, `${sheet}!A2:E`);
  const existingIndex = rows.findIndex((row) => String(row[0] || "").trim() === supplement.date);
  const values = [[supplement.date, supplement.protein, supplement.omega3, supplement.vitaminD, supplement.updated_at]];

  if (existingIndex >= 0) {
    const rowNumber = existingIndex + 2;
    await sheetsPut(env, `${sheet}!A${rowNumber}:E${rowNumber}`, values);
  } else {
    await sheetsAppend(env, `${sheet}!A:E`, values);
  }
  return supplement;
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

function supplementSheetName(env) {
  return env.SUPPLEMENTS_SHEET_NAME || "Supplements";
}

function a1SheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

function sheetBool(value) {
  return value === true || String(value || "").toUpperCase() === "TRUE";
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
  const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
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
  return body.access_token;
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
