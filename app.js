const LIVE_DATA_URL = "data/training-plan.json";
const MOCK_DATA_URL = "data/mock-training-plan.json";
const ACTUAL_DATA_URL = "data/strava-activities.json";
const MOCK_ACTUAL_DATA_URL = "data/mock-strava-activities.json";
const RUN_NOTES_API_URL = String(window.SCKL_CONFIG?.runNotesApiUrl || "").replace(/\/$/, "");
const RACE_DATE = "2026-10-04";
const RUN_NOTES_TOKEN_KEY = "sckl-run-notes-token";
const WELLNESS_STORAGE_KEY = "sckl-wellness-checks";
let latestRenderState = null;
let resizeTimer = null;
let supplementSyncState = { message: "", tone: "" };
let hasScrolledThisWeekToToday = false;

const wellnessChecks = [
  { key: "protein", label: "Protein shake", shortLabel: "Protein" },
  { key: "omega3", label: "Omega 3", shortLabel: "O3" },
  { key: "vitaminD", label: "Vitamin D", shortLabel: "D" }
];

const paceZones = [
  {
    label: "Recovery",
    range: "5:45-6:20 /km",
    description: "Very easy running for post-workout days, tired legs, shin-splint caution days, and low-stress aerobic volume."
  },
  {
    label: "Easy aerobic",
    range: "5:10-5:45 /km",
    description: "Your default mileage pace for normal easy runs, commuting aerobic volume, and relaxed run-club days."
  },
  {
    label: "Long run easy",
    range: "5:05-5:40 /km",
    description: "Early and middle portions of long runs, especially before progression finishes, MP blocks, or hilly sections."
  },
  {
    label: "Steady aerobic",
    range: "4:35-5:00 /km",
    description: "Controlled aerobic pressure for medium-long runs, progression finishes, and steady segments without drifting into threshold."
  },
  {
    label: "Marathon effort",
    range: "4:10-4:20 /km",
    description: "Tropical marathon-pace work for long-run finishes, cruise blocks, and race-specific sessions; use effort over exact pace in heat."
  },
  {
    label: "Tempo",
    range: "3:58-4:08 /km",
    description: "Comfortably hard running for 25-45 minute tempos, controlled progression runs, and longer sustained aerobic strength work."
  },
  {
    label: "Lactate threshold",
    range: "3:50-4:00 /km",
    description: "Hard but repeatable pace for 20-30 minute threshold runs, cruise intervals, and sessions like 4-6 x 1 km to 2 km."
  },
  {
    label: "10K / critical velocity",
    range: "3:38-3:46 /km",
    description: "Fast controlled aerobic reps for 800 m to 1.2 km repeats, sharpening workouts, and 10K-specific rhythm."
  },
  {
    label: "VO2 interval",
    range: "3:28-3:38 /km",
    description: "High-end interval pace for 600 m to 1.2 km track reps with jog recoveries, used sparingly when form is strong."
  },
  {
    label: "Repetition / speed",
    range: "80-86s / 400m",
    description: "Fast relaxed speed for 200 m to 400 m reps, strides, and running-economy work with fuller recovery."
  }
];

const trackTargets = [
  ["200m", "38-42s", "Strides, relaxed speed"],
  ["400m", "82-86s", "Main controlled speed range"],
  ["600m", "2:06-2:14", "Aerobic speed"],
  ["800m", "2:52-3:00", "VO2 / controlled interval"],
  ["1 km", "3:38-3:46", "10K / CV reps"],
  ["1.2 km", "4:20-4:28", "Long interval rhythm"],
  ["1.6 km", "5:50-6:05", "Mile-style strength reps"],
  ["MP", "4:10-4:20 /km", "Marathon pace work"]
];

const formatDate = new Intl.DateTimeFormat("en-SG", {
  day: "numeric",
  month: "short",
  year: "numeric"
});

const formatShortDate = new Intl.DateTimeFormat("en-SG", {
  day: "numeric",
  month: "short"
});

const singaporePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Singapore",
  year: "numeric"
});

const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function text(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function escapeHtml(value, fallback = "-") {
  const div = document.createElement("div");
  div.textContent = text(value, fallback);
  return div.innerHTML;
}

function safeExternalUrl(value, allowedHosts = []) {
  try {
    const url = new URL(String(value || ""));
    const isAllowedProtocol = url.protocol === "https:" || url.protocol === "http:";
    const isAllowedHost = !allowedHosts.length || allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return isAllowedProtocol && isAllowedHost ? url.href : "";
  } catch (error) {
    return "";
  }
}

function safeDomId(value, fallback = "item") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function storedRunNotesToken() {
  try {
    return window.localStorage.getItem(RUN_NOTES_TOKEN_KEY) || "";
  } catch (error) {
    return "";
  }
}

function setStoredRunNotesToken(token) {
  try {
    if (token) window.localStorage.setItem(RUN_NOTES_TOKEN_KEY, token);
    else window.localStorage.removeItem(RUN_NOTES_TOKEN_KEY);
  } catch (error) {
    // Run notes still save for this session even if localStorage is blocked.
  }
}

function km(value) {
  return `${Number(value || 0).toFixed(0)} km`;
}

function oneDecimalKm(value) {
  return `${Number(value || 0).toFixed(1)} km`;
}

function parseLocalDate(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function prettyDate(value) {
  const date = parseLocalDate(value);
  return date ? formatDate.format(date) : "-";
}

function shortDate(value) {
  const date = parseLocalDate(value);
  return date ? formatShortDate.format(date) : "-";
}

function singaporeDateParts(value) {
  const parts = singaporePartsFormatter.formatToParts(value).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    year: Number(parts.year)
  };
}

function singaporeToday() {
  const parts = singaporeDateParts(new Date());
  return new Date(parts.year, parts.month - 1, parts.day);
}

function daysBetween(start, end) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round((end - start) / oneDay);
}

function weekEndDate(week) {
  return dateKey(addDays(parseLocalDate(week.week_start_date), 6));
}

function isCurrentWeek(week, today = singaporeToday()) {
  const start = parseLocalDate(week.week_start_date);
  const end = addDays(start, 6);
  return today >= start && today <= end;
}

function currentWeek(plan) {
  const today = singaporeToday();
  return plan.weeks.find((week) => isCurrentWeek(week, today))
    || plan.weeks.find((week) => parseLocalDate(week.week_start_date) > today)
    || plan.weeks[plan.weeks.length - 1];
}

async function fetchJson(url) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.json();
}

async function loadPlan() {
  try {
    const plan = await fetchJson(LIVE_DATA_URL);
    plan.loaded_from = "google-sheet";
    return plan;
  } catch (liveError) {
    console.info("Live Google Sheet plan unavailable; using mock plan.", liveError);
    const plan = await fetchJson(MOCK_DATA_URL);
    plan.loaded_from = "mock";
    return plan;
  }
}

async function loadActuals() {
  try {
    const payload = await fetchJson(ACTUAL_DATA_URL);
    payload.loaded_from = "strava";
    return payload;
  } catch (actualError) {
    console.info("Live Strava activities unavailable; using mock actuals.", actualError);
    try {
      const payload = await fetchJson(MOCK_ACTUAL_DATA_URL);
      payload.loaded_from = "mock";
      return payload;
    } catch (mockError) {
      console.info("No mock actuals available.", mockError);
      return { loaded_from: "none", metadata: { included_activities: 0 }, activities: [] };
    }
  }
}

async function loadRunNotes() {
  if (!RUN_NOTES_API_URL) return {};
  const token = storedRunNotesToken();
  if (!token) return {};
  try {
    const response = await fetch(`${RUN_NOTES_API_URL}/notes?v=${Date.now()}`, {
      cache: "no-store",
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (response.status === 401 || response.status === 403) {
      setStoredRunNotesToken("");
      return {};
    }
    if (!response.ok) throw new Error(`Could not load run notes (${response.status})`);
    const payload = await response.json();
    return (payload.notes || []).reduce((result, note) => {
      if (note.activity_id) result[String(note.activity_id)] = note;
      return result;
    }, {});
  } catch (error) {
    console.info("Run notes unavailable.", error);
    return {};
  }
}

async function loadSupplements() {
  if (!RUN_NOTES_API_URL) return loadWellnessChecks();
  const token = storedRunNotesToken();
  if (!token) return loadWellnessChecks();
  try {
    const response = await fetch(`${RUN_NOTES_API_URL}/supplements?v=${Date.now()}`, {
      cache: "no-store",
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (response.status === 401 || response.status === 403) {
      setStoredRunNotesToken("");
      return loadWellnessChecks();
    }
    if (!response.ok) throw new Error(`Could not load supplements (${response.status})`);
    const payload = await response.json();
    const supplements = (payload.supplements || []).reduce((result, row) => {
      if (!row.date) return result;
      result[row.date] = {
        protein: Boolean(row.protein),
        omega3: Boolean(row.omega3),
        vitaminD: Boolean(row.vitaminD)
      };
      return result;
    }, {});
    const merged = { ...loadWellnessChecks(), ...supplements };
    saveWellnessChecks(merged);
    return merged;
  } catch (error) {
    console.info("Supplement history unavailable.", error);
    return loadWellnessChecks();
  }
}

function normalizePlan(plan) {
  plan.weeks = (plan.weeks || []).map((week) => {
    const sessions = dailySessions(week);
    return {
      ...week,
      daily_sessions: sessions,
      daily_plan: sessions.reduce((result, session) => {
        result[session.day.toLowerCase()] = session.plan;
        return result;
      }, {}),
      target_weekly_mileage_km: Number(week.target_weekly_mileage_km || sessions.reduce((sum, session) => sum + Number(session.planned_km || 0), 0)),
      week_summary: week.week_summary || summarizeWeekText(week, sessions),
    };
  });
  return plan;
}

function summarizeWeekText(week, sessions = dailySessions(week)) {
  const target = Number(week.target_weekly_mileage_km || sessions.reduce((sum, session) => sum + Number(session.planned_km || 0), 0));
  const runCount = sessions.filter((session) => Number(session.planned_km || 0) > 0).length;
  const longRun = Number(week.long_run_distance_km || 0);
  const phase = week.phase || "Training";
  if (String(phase).toLowerCase() === "race week") {
    return `Race week includes ${oneDecimalKm(target)} across ${runCount} planned runs, anchored by the SCKL Marathon.`;
  }
  return `${phase} week with ${oneDecimalKm(target)} across ${runCount} planned runs, anchored by ${week.key_workout || "the key workout"} and a ${oneDecimalKm(longRun)} long run.`;
}

function dailySessions(week) {
  if (Array.isArray(week.daily_sessions) && week.daily_sessions.length) {
    return week.daily_sessions.map((session, index) => ({
      day: session.day || dayNames[index] || "",
      date: session.date || dateKey(addDays(parseLocalDate(week.week_start_date), index)),
      plan: session.plan || "",
      planned_km: Number(session.planned_km || 0),
    }));
  }

  const daily = week.daily_plan || {};
  const start = parseLocalDate(week.week_start_date);
  return dayNames.map((day, index) => {
    const planText = daily[day.toLowerCase()] || "";
    return {
      day,
      date: start ? dateKey(addDays(start, index)) : "",
      plan: planText,
      planned_km: estimateKmFromPlan(planText, day, week),
    };
  });
}

function estimateKmFromPlan(planText, day, week) {
  const value = String(planText || "").toLowerCase();
  if (!value || value.includes("rest") || value.includes("mobility only")) return 0;
  if (day === "Saturday" && Number(week.long_run_distance_km || 0)) return Number(week.long_run_distance_km);
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*km/g)];
  if (!matches.length) return 0;
  const match = matches[matches.length - 1];
  const first = Number(match[1] || 0);
  const second = Number(match[2] || first);
  return (first + second) / 2;
}

function activitiesForDate(activities, date) {
  return activities.filter((activity) => activity.date === date);
}

function renderActualLine(dayActivities, actualText) {
  const linkedActivities = dayActivities
    .map((activity) => ({ ...activity, safe_url: safeExternalUrl(activity.strava_url, ["strava.com"]) }))
    .filter((activity) => activity.safe_url);
  if (linkedActivities.length === 1) {
    const activity = linkedActivities[0];
    return `<a href="${escapeHtml(activity.safe_url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(activity.name)}">${escapeHtml(actualText)}</a>`;
  }
  if (linkedActivities.length > 1) {
    const links = linkedActivities.map((activity, index) => {
      return `<a class="actual-link" href="${escapeHtml(activity.safe_url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(activity.name)}" aria-label="Open ${escapeHtml(activity.name)}">${index + 1}</a>`;
    }).join("");
    return `<span>${escapeHtml(actualText)}</span><span class="actual-links">${links}</span>`;
  }
  return escapeHtml(actualText);
}

function renderDayCard(session, actuals, options = {}) {
  const dayActivities = activitiesForDate(actuals.activities || [], session.date);
  const actualKm = dayActivities.reduce((sum, activity) => sum + Number(activity.distance_km || 0), 0);
  const todayKey = dateKey(singaporeToday());
  const isActive = session.date === todayKey;
  const isPast = Boolean(options.markPast) && String(session.date) < todayKey;
  const isCompleted = dayActivities.length > 0 || actualKm > 0;
  const classes = [
    "day-card",
    isActive ? "active-day" : "",
    isPast ? "past-day" : "",
    isCompleted ? "completed-day" : "",
  ].filter(Boolean).join(" ");
  const completedMark = isPast || isCompleted ? `<span class="completed-mark" aria-label="${isCompleted ? "Completed" : "Past day"}">✓</span>` : "";
  const actualText = `${oneDecimalKm(actualKm)} actual · ${dayActivities.length} run${dayActivities.length === 1 ? "" : "s"}`;
  const actualLine = options.showActual || isCompleted
    ? `<div class="actual-line">${renderActualLine(dayActivities, actualText)}</div>`
    : "";

  return `
    <article class="${classes}" ${isActive ? `aria-current="date"` : ""}>
      <div class="day-card-head">
        <span>${escapeHtml(session.day)} · ${escapeHtml(shortDate(session.date))}</span>
        ${completedMark}
      </div>
      <strong>${oneDecimalKm(session.planned_km)}<br>planned</strong>
      <p>${escapeHtml(session.plan)}</p>
      ${actualLine}
      ${renderDaySupplements(session)}
    </article>
  `;
}

function summarizeWeekActual(week, actuals) {
  const start = parseLocalDate(week.week_start_date);
  const end = addDays(start, 6);
  const activities = (actuals.activities || []).filter((activity) => {
    const date = parseLocalDate(activity.date);
    return date && date >= start && date <= end;
  });
  const distance = activities.reduce((sum, activity) => sum + Number(activity.distance_km || 0), 0);
  const movingSeconds = activities.reduce((sum, activity) => sum + Number(activity.moving_time_seconds || 0), 0);
  const elevation = activities.reduce((sum, activity) => sum + Number(activity.elevation_gain_m || 0), 0);
  const longest = activities.reduce((best, activity) => {
    return Number(activity.distance_km || 0) > Number(best?.distance_km || 0) ? activity : best;
  }, null);
  return {
    activities,
    distance_km: distance,
    run_count: activities.length,
    moving_time_seconds: movingSeconds,
    elevation_gain_m: elevation,
    longest_run_km: Number(longest?.distance_km || 0),
    average_pace_seconds: distance > 0 ? movingSeconds / distance : 0,
  };
}

function pace(secondsPerKm) {
  const value = Math.round(Number(secondsPerKm || 0));
  if (!value) return "-";
  const minutes = Math.floor(value / 60);
  const seconds = String(value % 60).padStart(2, "0");
  return `${minutes}:${seconds} /km`;
}

function duration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "-";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function syncTime(value) {
  if (!value) return "Not synced yet";
  return new Date(value).toLocaleString("en-SG", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Singapore"
  });
}

function timeAgo(value) {
  if (!value) return "";
  const elapsedMs = Math.max(Date.now() - new Date(value).getTime(), 0);
  const totalMinutes = Math.floor(elapsedMs / 60000);
  if (totalMinutes < 1) return "just now";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m ago`;
}

function lastSyncedText(label, value, fallback) {
  if (!value) return fallback;
  return `${label} last synced ${syncTime(value)} (${timeAgo(value)})`;
}

function heartRate(value) {
  return value ? `${Math.round(Number(value))} bpm` : "-";
}

function cadence(value) {
  if (!value) return "-";
  return `${Math.round(Number(value) * 2)} spm`;
}

function activityPace(activity) {
  const distance = Number(activity.distance_km || 0);
  const moving = Number(activity.moving_time_seconds || 0);
  return distance > 0 && moving > 0 ? pace(moving / distance) : "-";
}

function loadWellnessChecks() {
  try {
    return JSON.parse(window.localStorage.getItem(WELLNESS_STORAGE_KEY) || "{}");
  } catch (error) {
    return {};
  }
}

function saveWellnessChecks(state) {
  try {
    window.localStorage.setItem(WELLNESS_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Local wellness tracking is optional; ignore storage failures.
  }
}

function setSupplementSyncMessage(message, tone = "") {
  supplementSyncState = { message, tone };
  document.querySelectorAll("[data-supplement-sync-status]").forEach((node) => {
    node.textContent = message;
    node.className = `supplement-sync-message ${tone}`.trim();
  });
}

function wellnessCompletedCount(dayState = {}) {
  return wellnessChecks.filter((item) => dayState[item.key]).length;
}

function supplementStatus(date) {
  const dayState = loadWellnessChecks()[date] || {};
  const completed = wellnessCompletedCount(dayState);
  const items = wellnessChecks.map((item) => {
    const done = Boolean(dayState[item.key]);
    return `<span class="supplement-status-pill ${done ? "done" : ""}" title="${escapeHtml(item.label)} ${done ? "recorded" : "not recorded"}">${escapeHtml(item.shortLabel)}</span>`;
  }).join("");
  return { completed, items };
}

function renderSupplementInput(date) {
  const dayState = loadWellnessChecks()[date] || {};
  const completed = wellnessCompletedCount(dayState);
  const items = wellnessChecks.map((item) => {
    const checked = dayState[item.key] ? "checked" : "";
    return `
      <label class="supplement-toggle" title="${escapeHtml(item.label)}">
        <input type="checkbox" data-wellness-check data-date="${escapeHtml(date)}" data-key="${escapeHtml(item.key)}" ${checked}>
        <span>${escapeHtml(item.shortLabel)}</span>
      </label>
    `;
  }).join("");

  return `
    <div class="week-supplement-input" data-wellness-input-date="${escapeHtml(date)}">
      <div>
        <span>Today's supplements</span>
        <strong>${completed}/${wellnessChecks.length}</strong>
      </div>
      <div class="supplement-toggles" aria-label="${completed} of ${wellnessChecks.length} supplements recorded">${items}</div>
      <small class="supplement-sync-message ${escapeHtml(supplementSyncState.tone, "")}" data-supplement-sync-status>${escapeHtml(supplementSyncState.message, "")}</small>
    </div>
  `;
}

function renderDaySupplements(session) {
  const { completed, items } = supplementStatus(session.date);

  return `
    <div class="day-supplement-line" data-wellness-row-date="${escapeHtml(session.date)}">
      <span>Supplements</span>
      <small>${completed}/${wellnessChecks.length}</small>
      <div class="supplement-status-list" aria-label="${completed} of ${wellnessChecks.length} supplements recorded">${items}</div>
    </div>
  `;
}

function planDayTooltip(week, session, dayActivities, actualKm, completed) {
  const activityNames = dayActivities.map((activity) => activity.name).filter(Boolean).join(", ");
  const plannedKm = Number(session.planned_km || 0);
  const details = [
    `Week ${week.week_number} · ${week.phase}`,
    `${session.day}, ${prettyDate(session.date)}`,
    `Planned: ${plannedKm > 0 ? oneDecimalKm(plannedKm) : "Rest"}`,
    `Actual: ${dayActivities.length ? `${oneDecimalKm(actualKm)} from ${dayActivities.length} run${dayActivities.length === 1 ? "" : "s"}` : "No run logged"}`,
    `Supplements: ${completed}/${wellnessChecks.length}`,
    `Session: ${session.plan || "No planned session"}`
  ];
  if (activityNames) details.splice(4, 0, `Activities: ${activityNames}`);
  return details.join("\n");
}

function sessionType(session) {
  const plannedKm = Number(session.planned_km || 0);
  const plan = String(session.plan || "").toLowerCase();
  if (plannedKm <= 0 || plan.includes("rest")) return "Rest";
  if (plan.includes("long run")) return "Long";
  if (plan.includes("strength") || plan.includes("pt ")) return "PT";
  if (plan.includes("hill")) return "Hills";
  if (plan.includes("400") || plan.includes("600") || plan.includes("800") || plan.includes("1k") || plan.includes("interval")) return "Workout";
  if (plan.includes("recovery")) return "Recovery";
  if (plan.includes("easy")) return "Easy";
  return "Run";
}

function renderCalendarDay(week, session, actuals) {
  const dayActivities = activitiesForDate(actuals.activities || [], session.date);
  const actualKm = dayActivities.reduce((sum, activity) => sum + Number(activity.distance_km || 0), 0);
  const todayKey = dateKey(singaporeToday());
  const isActive = session.date === todayKey;
  const isPast = String(session.date) < todayKey;
  const isCompleted = dayActivities.length > 0 || actualKm > 0;
  const { completed, items } = supplementStatus(session.date);
  const plannedKm = Number(session.planned_km || 0);
  const actualText = dayActivities.length ? oneDecimalKm(actualKm) : "-";
  const tooltip = planDayTooltip(week, session, dayActivities, actualKm, completed);
  const tooltipId = `calendar-tip-${safeDomId(`${week.week_number}-${session.date}`)}`;
  const type = sessionType(session);
  const plannedLabel = plannedKm > 0 ? oneDecimalKm(plannedKm) : "Rest";
  const classes = [
    "calendar-day",
    isActive ? "active-day" : "",
    isPast ? "past-day" : "",
    isCompleted ? "completed-day" : "",
    plannedKm <= 0 ? "rest-day" : "",
  ].filter(Boolean).join(" ");

  return `
    <button class="${classes}" type="button" data-calendar-day aria-expanded="false" aria-describedby="${tooltipId}" aria-label="${escapeHtml(tooltip)}">
      <div class="calendar-day-head">
        <span>${escapeHtml(session.day.slice(0, 3))}</span>
        <strong>${escapeHtml(shortDate(session.date))}</strong>
      </div>
      <div class="calendar-day-main">
        <span>${escapeHtml(type)}</span>
        <strong>${escapeHtml(plannedLabel)}</strong>
        <small>Actual ${escapeHtml(actualText)}</small>
      </div>
      <div class="calendar-supplements" data-wellness-row-date="${escapeHtml(session.date)}">
        <span>${completed}/${wellnessChecks.length}</span>
        <div class="supplement-status-list" aria-label="${completed} of ${wellnessChecks.length} supplements recorded">${items}</div>
      </div>
      <div class="calendar-tooltip" id="${tooltipId}" role="tooltip">
        <strong>${escapeHtml(session.day)} · ${escapeHtml(prettyDate(session.date))}</strong>
        <em>${escapeHtml(type)} · ${escapeHtml(plannedLabel)} planned</em>
        <span>${escapeHtml(session.plan || "No planned session")}</span>
        <small>${escapeHtml(dayActivities.length ? `Actual: ${oneDecimalKm(actualKm)} across ${dayActivities.length} run${dayActivities.length === 1 ? "" : "s"}` : "Actual: no run logged")}</small>
      </div>
    </button>
  `;
}

function renderCalendarWeek(week, actuals) {
  const current = isCurrentWeek(week);
  const actual = summarizeWeekActual(week, actuals);
  const days = week.daily_sessions.map((session) => renderCalendarDay(week, session, actuals)).join("");
  const runDays = week.daily_sessions.filter((session) => Number(session.planned_km || 0) > 0).length;

  return `
    <section class="calendar-week ${current ? "current" : ""}" data-week-number="${escapeHtml(week.week_number)}" ${current ? `data-current-week="true"` : ""}>
      <div class="calendar-week-meta">
        <div>
          <span>Week ${escapeHtml(week.week_number)} · ${escapeHtml(week.phase)}</span>
          <strong>${prettyDate(week.week_start_date)} to ${prettyDate(weekEndDate(week))}</strong>
        </div>
        <div class="calendar-week-stats" aria-label="Week mileage summary">
          <span>${km(week.target_weekly_mileage_km)} planned</span>
          <span>${oneDecimalKm(actual.distance_km)} actual</span>
          <span>${runDays} runs</span>
        </div>
      </div>
      <div class="calendar-days">${days}</div>
    </section>
  `;
}

function phaseGroups(weeks) {
  return weeks.reduce((groups, week) => {
    const last = groups[groups.length - 1];
    if (last && last.phase === week.phase) {
      last.weeks.push(week);
      return groups;
    }
    groups.push({
      key: `${safeDomId(week.phase)}-${week.week_number}`,
      phase: week.phase,
      weeks: [week]
    });
    return groups;
  }, []);
}

function summarizePhaseGroup(group, actuals) {
  return group.weeks.reduce((summary, week) => {
    const actual = summarizeWeekActual(week, actuals);
    summary.plannedKm += Number(week.target_weekly_mileage_km || 0);
    summary.actualKm += Number(actual.distance_km || 0);
    summary.runDays += week.daily_sessions.filter((session) => Number(session.planned_km || 0) > 0).length;
    summary.startDate = summary.startDate || week.week_start_date;
    summary.endDate = weekEndDate(week);
    summary.hasCurrent = summary.hasCurrent || isCurrentWeek(week);
    return summary;
  }, {
    actualKm: 0,
    endDate: "",
    hasCurrent: false,
    plannedKm: 0,
    runDays: 0,
    startDate: ""
  });
}

function renderCalendarPhaseGroup(group, actuals, openPhases) {
  const summary = summarizePhaseGroup(group, actuals);
  const isOpen = openPhases ? openPhases.has(group.key) : summary.hasCurrent;
  const weeks = group.weeks.map((week) => renderCalendarWeek(week, actuals)).join("");
  const weekLabel = group.weeks.length === 1 ? "1 week" : `${group.weeks.length} weeks`;

  return `
    <details class="calendar-phase-group ${summary.hasCurrent ? "current" : ""}" data-phase-key="${escapeHtml(group.key)}" ${isOpen ? "open" : ""}>
      <summary>
        <span class="phase-title">
          <small>${escapeHtml(group.phase)}</small>
          <strong>${prettyDate(summary.startDate)} to ${prettyDate(summary.endDate)}</strong>
        </span>
        <span class="phase-stat">${escapeHtml(weekLabel)}</span>
        <span class="phase-stat">${km(summary.plannedKm)} planned</span>
        <span class="phase-stat">${oneDecimalKm(summary.actualKm)} actual</span>
        <span class="phase-stat">${summary.runDays} runs</span>
      </summary>
      <div class="calendar-phase-body">
        <div class="calendar-day-labels" aria-hidden="true">
          <span></span>
          ${dayNames.map((day) => `<span>${escapeHtml(day.slice(0, 3))}</span>`).join("")}
        </div>
        ${weeks}
      </div>
    </details>
  `;
}

function renderTrainingDayProgress(plan) {
  const today = singaporeToday();
  const raceDay = parseLocalDate(RACE_DATE);
  const planStart = parseLocalDate(plan.weeks[0]?.week_start_date);
  if (!planStart || !raceDay) {
    document.getElementById("raceCountdown").textContent = "Training day loading";
    return;
  }
  const totalDays = Math.max(daysBetween(planStart, raceDay) + 1, 1);
  const rawDay = daysBetween(planStart, today) + 1;
  const currentDay = Math.min(Math.max(rawDay, 1), totalDays);
  const week = currentWeek(plan);
  const totalWeeks = Math.max(plan.weeks.length, 1);
  const currentWeekNumber = Math.min(Math.max(Number(week?.week_number || 1), 1), totalWeeks);
  document.getElementById("raceCountdown").textContent =
    `Day ${currentDay} of ${totalDays} · Week ${currentWeekNumber} of ${totalWeeks}`;
}

function renderCurrentWeek(plan, actuals) {
  const week = currentWeek(plan);
  const actual = summarizeWeekActual(week, actuals);
  const status = document.getElementById("trackStatus");
  status.textContent = lastSyncedText("Strava", actuals.metadata?.generated_at, "Strava not synced");
  status.className = "status-pill";
  const planned = Number(week.target_weekly_mileage_km || 0);
  const progress = planned > 0 ? Math.min((actual.distance_km / planned) * 100, 140) : 0;

  document.getElementById("currentWeekLabel").textContent =
    `Week ${week.week_number}: ${prettyDate(week.week_start_date)} to ${prettyDate(weekEndDate(week))} · ${week.phase}`;

  const dayCards = week.daily_sessions.map((session) => renderDayCard(session, actuals, { showActual: true, markPast: true })).join("");

  document.getElementById("currentWeekPlan").innerHTML = `
    <div class="week-progress">
      <div>
        <span>This week progress</span>
        <strong>${oneDecimalKm(actual.distance_km)} / ${km(week.target_weekly_mileage_km)}</strong>
      </div>
      <div class="progress-track" aria-label="This week mileage progress">
        <span style="width: ${progress}%"></span>
      </div>
      ${renderSupplementInput(dateKey(singaporeToday()))}
    </div>
    <div class="daily-grid">${dayCards}</div>
  `;
  scrollThisWeekToToday();
}

function scrollThisWeekToToday() {
  if (hasScrolledThisWeekToToday) return;
  window.requestAnimationFrame(() => {
    const grid = document.querySelector("#currentWeekPlan .daily-grid");
    const activeDay = grid?.querySelector(".day-card.active-day");
    if (!grid || !activeDay || grid.scrollWidth <= grid.clientWidth) return;
    const target = activeDay.offsetLeft - ((grid.clientWidth - activeDay.clientWidth) / 2);
    grid.scrollTo({ left: Math.max(0, target), behavior: "auto" });
    hasScrolledThisWeekToToday = true;
  });
}

function renderPlanTable(plan, actuals) {
  const table = document.getElementById("planTable");
  const planStatus = document.getElementById("planSyncStatus");
  if (planStatus) {
    planStatus.textContent = lastSyncedText("Sheet", plan.metadata?.generated_at, "Sheet not synced");
    planStatus.className = "status-pill";
  }
  const currentPhaseGroups = document.querySelectorAll(".calendar-phase-group");
  const openPhases = openPhaseKeys();
  const shouldPreserveOpenState = currentPhaseGroups.length > 0;
  const rows = phaseGroups(plan.weeks)
    .map((group) => renderCalendarPhaseGroup(group, actuals, shouldPreserveOpenState ? openPhases : null))
    .join("");
  table.innerHTML = `
    <div class="calendar-plan" aria-label="Week-by-week calendar training plan">
      ${rows}
    </div>
  `;
  updateWeekToggleLabel();
}

function openPhaseKeys() {
  return new Set(
    Array.from(document.querySelectorAll(".calendar-phase-group[open]"))
      .map((group) => group.dataset.phaseKey)
      .filter(Boolean)
  );
}

function restoreOpenPhases(openPhases) {
  if (!openPhases?.size) return;
  document.querySelectorAll(".calendar-phase-group").forEach((group) => {
    group.open = openPhases.has(group.dataset.phaseKey);
  });
  updateWeekToggleLabel();
}

function updateWeekToggleLabel() {
  const button = document.getElementById("toggleWeeks");
  if (!button) return;
  button.textContent = "Current week";
  button.setAttribute("aria-label", "Jump to current week in the training plan");
}

function setupWeekToggle() {
  const button = document.getElementById("toggleWeeks");
  const planTable = document.getElementById("planTable");
  if (!button || !planTable) return;

  button.addEventListener("click", () => {
    const currentWeek = document.querySelector("[data-current-week='true']");
    const phase = currentWeek?.closest(".calendar-phase-group");
    if (phase) phase.open = true;
    window.requestAnimationFrame(() => {
      currentWeek?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
}

function closeCalendarTooltips(except = null) {
  document.querySelectorAll("[data-calendar-day].tooltip-open").forEach((day) => {
    if (day === except) return;
    day.classList.remove("tooltip-open");
    day.setAttribute("aria-expanded", "false");
  });
}

function setupCalendarTooltips() {
  document.addEventListener("click", (event) => {
    const day = event.target.closest("[data-calendar-day]");
    if (!day) {
      closeCalendarTooltips();
      return;
    }
    const isOpen = day.classList.contains("tooltip-open");
    closeCalendarTooltips(day);
    day.classList.toggle("tooltip-open", !isOpen);
    day.setAttribute("aria-expanded", String(!isOpen));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeCalendarTooltips();
  });
}

function renderRunNotePanel(activity, runNotes) {
  const note = runNotes[String(activity.id)]?.note || "";
  if (!RUN_NOTES_API_URL || !activity.id) {
    return `<div class="empty-state compact-empty">Run notes are unavailable until the Cloudflare Worker is configured.</div>`;
  }
  const stravaUrl = safeExternalUrl(activity.strava_url, ["strava.com"]);
  return `
    <div class="activity-detail-grid">
      <div>
        <span>Run note</span>
        <p>Saved to the Google Sheet <code>Run Notes</code> tab for this Strava activity.</p>
      </div>
      <div class="activity-detail-metrics">
        <span>${oneDecimalKm(activity.distance_km)}</span>
        <span>${activityPace(activity)}</span>
        <span>${heartRate(activity.average_heartrate)}</span>
      </div>
    </div>
    <form class="run-note-form" data-run-note-form data-activity-id="${escapeHtml(activity.id)}" data-activity-date="${escapeHtml(activity.date)}" data-activity-name="${escapeHtml(activity.name)}" data-activity-url="${escapeHtml(stravaUrl)}">
      <textarea name="note" maxlength="500" aria-label="Run note for ${escapeHtml(activity.name)}">${escapeHtml(note, "")}</textarea>
      <button type="submit">Save</button>
    </form>
  `;
}

function renderActivityFeed(actuals, runNotes = {}) {
  const activities = [...(actuals.activities || [])].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 16);
  const feed = document.getElementById("activityFeed");
  if (!activities.length) {
    feed.innerHTML = `<div class="empty-state">No Strava runs loaded yet. The mock fallback can be replaced by running scripts/fetch_strava.py.</div>`;
    return;
  }
  const totalDistance = activities.reduce((sum, activity) => sum + Number(activity.distance_km || 0), 0);
  const totalMoving = activities.reduce((sum, activity) => sum + Number(activity.moving_time_seconds || 0), 0);
  const athlete = actuals.metadata?.athlete || {};
  const athleteName = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || "Tai Zhi";
  const profileImage = safeExternalUrl(athlete.profile_medium || athlete.profile || "");
  const activityRows = activities.map((activity, index) => {
    const stravaUrl = safeExternalUrl(activity.strava_url, ["strava.com"]);
    const activityName = stravaUrl
      ? `<a class="activity-name-link" href="${escapeHtml(stravaUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(activity.name)}</a>`
      : escapeHtml(activity.name);
    const note = runNotes[String(activity.id)]?.note || "";
    const detailId = `activity-detail-${safeDomId(activity.id, `row-${index}`)}`;
    const noteLabel = note ? "Edit note" : "Note";
    return `
      <tr class="activity-main-row">
        <td>${escapeHtml(prettyDate(activity.date))}</td>
        <td><strong>${activityName}</strong></td>
        <td><strong>${oneDecimalKm(activity.distance_km)}</strong></td>
        <td>${duration(activity.moving_time_seconds)}</td>
        <td>${activityPace(activity)}</td>
        <td>${heartRate(activity.average_heartrate)}</td>
        <td>${cadence(activity.average_cadence)}</td>
        <td>${Math.round(Number(activity.elevation_gain_m || 0))} m</td>
        <td>
          <button class="table-action-button ${note ? "has-note" : ""}" type="button" data-activity-toggle aria-expanded="false" aria-controls="${detailId}">
            ${escapeHtml(noteLabel)}
          </button>
        </td>
      </tr>
      <tr id="${detailId}" class="activity-detail-row" hidden>
        <td colspan="9">
          <div class="activity-detail-panel">
            ${renderRunNotePanel(activity, runNotes)}
          </div>
        </td>
      </tr>
    `;
  }).join("");
  feed.innerHTML = `
    <div class="activity-table-shell">
      <div class="activity-table-summary">
        <div class="athlete-summary">
          ${profileImage ? `<img src="${escapeHtml(profileImage)}" alt="">` : `<span class="athlete-avatar-fallback">TZ</span>`}
          <strong>${escapeHtml(athleteName)}</strong>
        </div>
        <span>${activities.length} runs · ${oneDecimalKm(totalDistance)} · ${duration(totalMoving)}</span>
      </div>
      <div class="activity-table-scroll">
        <table class="activity-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Activity</th>
              <th>Distance</th>
              <th>Moving</th>
              <th>Avg pace</th>
              <th>Avg HR</th>
              <th>Avg cadence</th>
              <th>Elev</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>${activityRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function actualWeekValue(week, actuals, metric) {
  const actual = summarizeWeekActual(week, actuals);
  const weekStart = parseLocalDate(week.week_start_date);
  if (!actual.run_count) return weekStart && weekStart <= singaporeToday() ? 0 : null;
  return metric === "longest_run_km" ? actual.longest_run_km : actual.distance_km;
}

function linePath(points) {
  let open = false;
  return points.reduce((path, point) => {
    if (point.value === null || point.value === undefined) {
      open = false;
      return path;
    }
    const command = open ? "L" : "M";
    open = true;
    return `${path}${command}${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
  }, "").trim();
}

function chartLayout() {
  const compact = window.matchMedia("(max-width: 640px)").matches;
  return {
    baseline: compact ? 188 : 242,
    bottom: compact ? 32 : 42,
    height: compact ? 220 : 284,
    labelEvery: compact ? 5 : 2,
    left: compact ? 34 : 48,
    plannedDot: compact ? 4.2 : 5.2,
    right: compact ? 10 : 18,
    top: compact ? 20 : 24,
    actualDot: compact ? 3.8 : 4.6,
    width: compact ? 360 : 760
  };
}

function renderBarChart(containerId, weeks, valueKey, options = {}) {
  const container = document.getElementById(containerId);
  const { actualDot, baseline, bottom, height, labelEvery, left, right, top, width } = chartLayout();
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const actualValues = weeks.map((week) => actualWeekValue(week, options.actuals || { activities: [] }, options.actualMetric || "distance_km"));
  const maxValue = niceMax(Math.max(...weeks.map((week) => Number(week[valueKey] || 0)), ...actualValues.filter((value) => value !== null), 0));
  const current = currentWeek({ weeks });
  const barGap = 4;
  const barWidth = Math.max((plotWidth / weeks.length) - barGap, 8);
  const hoverPoints = [];

  const bars = weeks.map((week, index) => {
    const value = Number(week[valueKey] || 0);
    const barHeight = (value / maxValue) * plotHeight;
    const x = left + index * (plotWidth / weeks.length) + barGap / 2;
    const y = baseline - barHeight;
    hoverPoints.push({
      date: week.week_start_date,
      label: `Week ${week.week_number}`,
      phase: week.phase,
      value,
      actualValue: actualValues[index],
      x: x + barWidth / 2,
      y
    });
    const currentLine = week.week_number === current.week_number
      ? `<line class="chart-current" x1="${x + barWidth / 2}" y1="${top - 4}" x2="${x + barWidth / 2}" y2="${baseline}"></line>
         <text class="chart-now-label" x="${x + barWidth / 2 + 5}" y="${top + 8}">Now</text>`
      : "";
    const label = index % labelEvery === 0 || index === weeks.length - 1
      ? `<text class="chart-label" x="${x + barWidth / 2}" y="${height - 14}" text-anchor="middle">W${week.week_number}</text>`
      : "";
    return `
      ${currentLine}
      <rect class="chart-bar planned" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"></rect>
      ${label}
    `;
  }).join("");

  const actualPoints = hoverPoints.map((point) => {
    const value = point.actualValue;
    return {
      ...point,
      value,
      y: value === null ? null : baseline - (Number(value || 0) / maxValue) * plotHeight
    };
  });
  const actualLine = linePath(actualPoints);
  const actualDots = actualPoints
    .filter((point) => point.value !== null)
    .map((point) => `<circle class="chart-dot actual" cx="${point.x}" cy="${point.y}" r="${actualDot}"></circle>`)
    .join("");

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label || "Training chart")}">
      <line class="chart-grid" x1="${left}" y1="${top}" x2="${width - right}" y2="${top}"></line>
      <line class="chart-grid" x1="${left}" y1="${top + plotHeight / 2}" x2="${width - right}" y2="${top + plotHeight / 2}"></line>
      <line class="chart-axis" x1="${left}" y1="${baseline}" x2="${width - right}" y2="${baseline}"></line>
      <line class="chart-axis" x1="${left}" y1="${top}" x2="${left}" y2="${baseline}"></line>
      <text class="chart-label" x="0" y="${top + 4}">${maxValue} km</text>
      <text class="chart-label" x="0" y="${top + plotHeight / 2 + 4}">${maxValue / 2} km</text>
      <text class="chart-label" x="32" y="${baseline + 4}">0</text>
      ${bars}
      ${actualLine ? `<path class="chart-actual-line" d="${actualLine}"></path>${actualDots}` : ""}
      ${chartHoverMarkup(left, top, plotWidth, plotHeight, baseline)}
    </svg>
  `;
  setupChartHover(container, hoverPoints, { width, height, left, right, top, baseline, plotWidth, plotHeight, valueLabel: options.valueLabel || "Distance" });
}

function renderLineChart(containerId, weeks, valueKey, options = {}) {
  const container = document.getElementById(containerId);
  const { actualDot, baseline, bottom, height, labelEvery, left, plannedDot, right, top, width } = chartLayout();
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const actualValues = weeks.map((week) => actualWeekValue(week, options.actuals || { activities: [] }, options.actualMetric || "longest_run_km"));
  const maxValue = niceMax(Math.max(...weeks.map((week) => Number(week[valueKey] || 0)), ...actualValues.filter((value) => value !== null), 0));
  const current = currentWeek({ weeks });
  const step = plotWidth / Math.max(weeks.length - 1, 1);

  const points = weeks.map((week, index) => {
    const x = left + index * step;
    const y = baseline - (Number(week[valueKey] || 0) / maxValue) * plotHeight;
    return {
      x,
      y,
      week,
      date: week.week_start_date,
      label: `Week ${week.week_number}`,
      phase: week.phase,
      value: Number(week[valueKey] || 0),
      actualValue: actualValues[index]
    };
  });

  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const actualPoints = points.map((point) => {
    const value = point.actualValue;
    return {
      ...point,
      value,
      y: value === null ? null : baseline - (Number(value || 0) / maxValue) * plotHeight
    };
  });
  const actualLine = linePath(actualPoints);
  const dots = points.map((point, index) => {
    const currentLine = point.week.week_number === current.week_number
      ? `<line class="chart-current" x1="${point.x}" y1="${top - 4}" x2="${point.x}" y2="${baseline}"></line>
         <text class="chart-now-label" x="${point.x + 5}" y="${top + 8}">Now</text>`
      : "";
    const label = index % labelEvery === 0 || index === points.length - 1
      ? `<text class="chart-label" x="${point.x}" y="${height - 14}" text-anchor="middle">W${point.week.week_number}</text>`
      : "";
    return `${currentLine}<circle class="chart-dot planned" cx="${point.x}" cy="${point.y}" r="${plannedDot}"></circle>${label}`;
  }).join("");
  const actualDots = actualPoints
    .filter((point) => point.value !== null)
    .map((point) => `<circle class="chart-dot actual" cx="${point.x}" cy="${point.y}" r="${actualDot}"></circle>`)
    .join("");

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label || "Long run chart")}">
      <line class="chart-grid" x1="${left}" y1="${top}" x2="${width - right}" y2="${top}"></line>
      <line class="chart-grid" x1="${left}" y1="${top + plotHeight / 2}" x2="${width - right}" y2="${top + plotHeight / 2}"></line>
      <line class="chart-axis" x1="${left}" y1="${baseline}" x2="${width - right}" y2="${baseline}"></line>
      <line class="chart-axis" x1="${left}" y1="${top}" x2="${left}" y2="${baseline}"></line>
      <polyline class="chart-line planned" points="${line}"></polyline>
      ${actualLine ? `<path class="chart-actual-line" d="${actualLine}"></path>${actualDots}` : ""}
      <text class="chart-label" x="0" y="${top + 4}">${maxValue} km</text>
      <text class="chart-label" x="0" y="${top + plotHeight / 2 + 4}">${maxValue / 2} km</text>
      <text class="chart-label" x="32" y="${baseline + 4}">0</text>
      ${dots}
      ${chartHoverMarkup(left, top, plotWidth, plotHeight, baseline)}
    </svg>
  `;
  setupChartHover(container, points, { width, height, left, right, top, baseline, plotWidth, plotHeight, valueLabel: options.valueLabel || "Distance" });
}

function renderPaceGuide() {
  const container = document.getElementById("paceGuide");
  if (!container) return;
  const zoneRows = paceZones.map((zone) => `
    <tr>
      <td><strong>${escapeHtml(zone.label)}</strong></td>
      <td>${escapeHtml(zone.range)}</td>
      <td>${escapeHtml(zone.description)}</td>
    </tr>
  `).join("");
  const targetRows = trackTargets.map(([distance, target, purpose]) => `
    <article class="pace-chip">
      <span>${escapeHtml(distance)}</span>
      <strong>${escapeHtml(target)}</strong>
      <small>${escapeHtml(purpose)}</small>
    </article>
  `).join("");
  container.innerHTML = `
    <div class="activity-table-scroll pace-table-scroll">
      <table class="activity-table pace-table">
        <thead>
          <tr>
            <th>Zone</th>
            <th>Target</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>${zoneRows}</tbody>
      </table>
    </div>
    <div class="pace-track-grid">${targetRows}</div>
  `;
}

const chartTooltipSize = {
  width: 232,
  height: 118,
  gap: 14
};

function chartHoverMarkup(left, top, plotWidth, plotHeight, baseline) {
  return `
    <g class="chart-hover" aria-hidden="true">
      <line class="chart-crosshair" data-hover-v x1="${left}" y1="${top}" x2="${left}" y2="${baseline}"></line>
      <line class="chart-crosshair" data-hover-h x1="${left}" y1="${top}" x2="${left + plotWidth}" y2="${top}"></line>
      <circle class="chart-hover-dot" data-hover-dot cx="${left}" cy="${top}" r="5"></circle>
      <g class="chart-tooltip" data-hover-tip>
        <rect class="chart-tooltip-bg" width="${chartTooltipSize.width}" height="${chartTooltipSize.height}" rx="10"></rect>
        <text class="chart-tooltip-title" data-hover-week x="16" y="21"></text>
        <text class="chart-tooltip-date" data-hover-date x="16" y="39"></text>
        <line class="chart-tooltip-divider" x1="16" y1="53" x2="${chartTooltipSize.width - 16}" y2="53"></line>
        <text class="chart-tooltip-label" x="16" y="70">Phase</text>
        <text class="chart-tooltip-phase" data-hover-phase x="${chartTooltipSize.width - 16}" y="70" text-anchor="end"></text>
        <circle class="tooltip-marker planned" cx="20" cy="91" r="4"></circle>
        <text class="chart-tooltip-label" x="34" y="91">Planned</text>
        <text class="chart-tooltip-planned" data-hover-value x="${chartTooltipSize.width - 16}" y="91" text-anchor="end"></text>
        <circle class="tooltip-marker actual" cx="20" cy="109" r="4"></circle>
        <text class="chart-tooltip-label" x="34" y="109">Actual</text>
        <text class="chart-tooltip-actual" data-hover-actual x="${chartTooltipSize.width - 16}" y="109" text-anchor="end"></text>
      </g>
    </g>
    <rect class="chart-hit-area" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"></rect>
  `;
}

function setupChartHover(container, points, dims) {
  const svg = container.querySelector("svg");
  const hitArea = container.querySelector(".chart-hit-area");
  const hover = container.querySelector(".chart-hover");
  if (!svg || !hitArea || !hover || !points.length) return;

  const vLine = container.querySelector("[data-hover-v]");
  const hLine = container.querySelector("[data-hover-h]");
  const dot = container.querySelector("[data-hover-dot]");
  const tip = container.querySelector("[data-hover-tip]");
  const weekText = container.querySelector("[data-hover-week]");
  const dateText = container.querySelector("[data-hover-date]");
  const phaseText = container.querySelector("[data-hover-phase]");
  const valueText = container.querySelector("[data-hover-value]");
  const actualText = container.querySelector("[data-hover-actual]");

  const nearestPoint = (x) => {
    return points.reduce((best, point) => {
      return Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best;
    }, points[0]);
  };

  const moveCrosshair = (event) => {
    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) return;
    const pointInSvg = svg.createSVGPoint();
    pointInSvg.x = event.clientX;
    pointInSvg.y = event.clientY;
    const svgPoint = pointInSvg.matrixTransform(screenMatrix.inverse());
    const rawX = svgPoint.x;
    const x = Math.min(Math.max(rawX, dims.left), dims.left + dims.plotWidth);
    const point = nearestPoint(x);
    const preferredTooltipX = x > dims.width - chartTooltipSize.width - dims.right - chartTooltipSize.gap
      ? x - chartTooltipSize.width - chartTooltipSize.gap
      : x + chartTooltipSize.gap;
    const tooltipX = Math.max(4, Math.min(preferredTooltipX, dims.width - chartTooltipSize.width - 4));
    const tooltipY = Math.max(
      dims.top + 4,
      Math.min(point.y - chartTooltipSize.height - 10, dims.baseline - chartTooltipSize.height - 8)
    );

    hover.style.opacity = "1";
    vLine.setAttribute("x1", x);
    vLine.setAttribute("x2", x);
    hLine.setAttribute("y1", point.y);
    hLine.setAttribute("y2", point.y);
    hLine.setAttribute("x1", dims.left);
    hLine.setAttribute("x2", dims.left + dims.plotWidth);
    dot.setAttribute("cx", point.x);
    dot.setAttribute("cy", point.y);
    tip.setAttribute("transform", `translate(${tooltipX}, ${tooltipY})`);
    weekText.textContent = point.label;
    dateText.textContent = `Week starts ${prettyDate(point.date)}`;
    phaseText.textContent = point.phase || "-";
    valueText.textContent = oneDecimalKm(point.value);
    actualText.textContent = point.actualValue === null || point.actualValue === undefined ? "-" : oneDecimalKm(point.actualValue);
  };

  hitArea.addEventListener("pointerenter", moveCrosshair);
  hitArea.addEventListener("pointermove", moveCrosshair);

  hitArea.addEventListener("pointerleave", () => {
    hover.style.opacity = "0";
  });
}

function niceMax(value) {
  if (value <= 10) return 10;
  if (value <= 40) return Math.ceil(value / 5) * 5;
  if (value <= 120) return Math.ceil(value / 10) * 10;
  return Math.ceil(value / 25) * 25;
}

function renderMileageLegend() {
  document.getElementById("phaseBreakdown").innerHTML = `
    <div class="chart-legend">
      <span><i class="legend-bar"></i>Planned target</span>
      <span><i class="legend-line actual"></i>Actual logged</span>
    </div>
  `;
}

function setupReturnTop() {
  const button = document.getElementById("returnTop");
  if (!button) return;

  const updateVisibility = () => {
    button.classList.toggle("visible", window.scrollY > 420);
  };

  button.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  window.addEventListener("scroll", updateVisibility, { passive: true });
  updateVisibility();
}

function setupActiveNav() {
  const links = Array.from(document.querySelectorAll(".nav-tabs a[href^='#']"));
  const sections = links.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);

  const setActiveLink = (id) => {
    links.forEach((link) => {
      const isActive = link.getAttribute("href") === `#${id}`;
      link.classList.toggle("active", isActive);
      if (isActive) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  };

  const update = () => {
    const navHeight = document.querySelector(".top-nav")?.offsetHeight || 0;
    const marker = window.scrollY + navHeight + Math.min(window.innerHeight * 0.22, 180);
    let active = sections[0];
    sections.forEach((section) => {
      if (section.offsetTop <= marker) active = section;
    });
    if (active?.id) setActiveLink(active.id);
  };

  links.forEach((link) => {
    link.addEventListener("click", () => {
      const id = link.getAttribute("href")?.slice(1);
      if (id) setActiveLink(id);
    });
  });
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

function setupRunNotesForms() {
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-run-note-form]");
    if (!form) return;
    event.preventDefault();
    if (!RUN_NOTES_API_URL) return;

    const button = form.querySelector("button");
    const note = form.querySelector("textarea")?.value || "";
    let token = storedRunNotesToken();
    if (!token) {
      token = window.prompt("Enter run notes passcode") || "";
      if (!token) return;
      setStoredRunNotesToken(token);
    }

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Saving";
    try {
      const response = await fetch(`${RUN_NOTES_API_URL}/notes`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          activity_id: form.dataset.activityId,
          date: form.dataset.activityDate,
          name: form.dataset.activityName,
          note,
          strava_url: form.dataset.activityUrl
        })
      });
      if (response.status === 401 || response.status === 403) {
        setStoredRunNotesToken("");
        throw new Error("Passcode rejected");
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      button.textContent = "Saved";
      const toggle = form.closest(".activity-detail-row")?.previousElementSibling?.querySelector("[data-activity-toggle]");
      if (toggle) {
        toggle.textContent = note.trim() ? "Edit note" : "Note";
        toggle.classList.toggle("has-note", Boolean(note.trim()));
      }
      setTimeout(() => {
        button.textContent = originalText;
      }, 1200);
    } catch (error) {
      console.error(error);
      button.textContent = "Retry";
    } finally {
      button.disabled = false;
    }
  });
}

function setupActivityDetails() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-activity-toggle]");
    if (!button) return;
    const detail = document.getElementById(button.getAttribute("aria-controls"));
    if (!detail) return;
    const willOpen = detail.hidden;
    detail.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
  });
}

function rerenderSupplementViews() {
  if (!latestRenderState) return;
  const opened = openPhaseKeys();
  renderCurrentWeek(latestRenderState.plan, latestRenderState.actuals);
  renderPlanTable(latestRenderState.plan, latestRenderState.actuals);
  restoreOpenPhases(opened);
}

function setupWellnessTracker() {
  document.addEventListener("change", async (event) => {
    const checkbox = event.target.closest("[data-wellness-check]");
    if (!checkbox) return;
    const state = loadWellnessChecks();
    const date = checkbox.dataset.date;
    const key = checkbox.dataset.key;
    if (!date || !key) return;
    const previousDayState = { ...(state[date] || {}) };
    state[date] = {
      ...(state[date] || {}),
      [key]: checkbox.checked
    };
    saveWellnessChecks(state);
    setSupplementSyncMessage("Saving to Google Sheets...", "saving");
    rerenderSupplementViews();

    const result = await saveSupplementCheck(date, state[date]);
    if (result.ok) {
      setSupplementSyncMessage(result.message, result.tone || "ok");
      return;
    }

    const rollbackState = loadWellnessChecks();
    rollbackState[date] = previousDayState;
    saveWellnessChecks(rollbackState);
    setSupplementSyncMessage(result.message, "error");
    rerenderSupplementViews();
  });
}

async function saveSupplementCheck(date, dayState) {
  if (!RUN_NOTES_API_URL) return { ok: true, message: "Saved locally only.", tone: "saving" };
  let token = storedRunNotesToken();
  if (!token) {
    token = window.prompt("Enter dashboard passcode") || "";
    setStoredRunNotesToken(token);
  }
  if (!token) return { ok: false, message: "Not saved. Dashboard passcode is required." };

  try {
    const response = await fetch(`${RUN_NOTES_API_URL}/supplements`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        date,
        protein: Boolean(dayState.protein),
        omega3: Boolean(dayState.omega3),
        vitaminD: Boolean(dayState.vitaminD)
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      setStoredRunNotesToken("");
      return { ok: false, message: "Not saved. Passcode was rejected." };
    }
    if (response.status === 403) {
      return {
        ok: false,
        message: "Not saved. Google Sheet permission is still Reader, not Editor."
      };
    }
    if (!response.ok) {
      return { ok: false, message: `Not saved. ${payload.error || `Worker returned ${response.status}`}` };
    }
    return { ok: true, message: "Saved to Google Sheets.", tone: "ok" };
  } catch (error) {
    console.error(error);
    return { ok: false, message: "Not saved. Could not reach the sync Worker." };
  }
}

function render({ plan, actuals, runNotes }) {
  latestRenderState = { actuals, plan, runNotes };
  renderTrainingDayProgress(plan);
  renderCurrentWeek(plan, actuals);
  renderPlanTable(plan, actuals);
  renderBarChart("mileageChart", plan.weeks, "target_weekly_mileage_km", { actuals, actualMetric: "distance_km", label: "Planned and actual weekly mileage", valueLabel: "Mileage" });
  renderLineChart("longRunChart", plan.weeks, "long_run_distance_km", { actuals, actualMetric: "longest_run_km", label: "Planned and actual long run distance", valueLabel: "Long run" });
  renderPaceGuide();
  renderMileageLegend();
  renderActivityFeed(actuals, runNotes);
  document.getElementById("syncStatus").textContent =
    `${plan.loaded_from === "google-sheet" ? "Google Sheet plan" : "Mock plan"} loaded · ${plan.weeks.length} training weeks`;
}

function setupResponsiveCharts() {
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!latestRenderState) return;
      const { actuals, plan } = latestRenderState;
      renderBarChart("mileageChart", plan.weeks, "target_weekly_mileage_km", { actuals, actualMetric: "distance_km", label: "Planned and actual weekly mileage", valueLabel: "Mileage" });
      renderLineChart("longRunChart", plan.weeks, "long_run_distance_km", { actuals, actualMetric: "longest_run_km", label: "Planned and actual long run distance", valueLabel: "Long run" });
    }, 160);
  });
}

setupReturnTop();
setupActiveNav();
setupWeekToggle();
setupRunNotesForms();
setupActivityDetails();
setupWellnessTracker();
setupCalendarTooltips();
setupResponsiveCharts();

Promise.all([loadPlan().then(normalizePlan), loadActuals(), loadRunNotes(), loadSupplements()])
  .then(([plan, actuals, runNotes]) => render({ plan, actuals, runNotes }))
  .catch((error) => {
    console.error(error);
    document.getElementById("syncStatus").textContent = "Unable to load mock training plan.";
    document.getElementById("currentWeekPlan").innerHTML =
      `<div class="empty-state">Check that data/mock-training-plan.json exists and preview through a local web server.</div>`;
  });
