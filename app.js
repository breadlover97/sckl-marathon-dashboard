const LIVE_DATA_URL = "data/training-plan.json";
const MOCK_DATA_URL = "data/mock-training-plan.json";
const ACTUAL_DATA_URL = "data/strava-activities.json";
const MOCK_ACTUAL_DATA_URL = "data/mock-strava-activities.json";
const SYNC_WORKFLOW_URL = "https://github.com/breadlover97/sckl-marathon-dashboard/actions/workflows/deploy-pages.yml";
const RACE_DATE = "2026-10-04";
const RACE_START_LOCAL = "2026-10-04T03:30:00+08:00";
const GOAL_TIME = "2h 50m";
const GOAL_PACE = "4:02 /km";
const TROPICAL_MARATHON_PACE = "4:15 /km";
const CURRENT_EASY_PACE = "5:15-5:30 /km";

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

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = text(value);
  return div.innerHTML;
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

function phaseClass(phase) {
  const value = String(phase || "").toLowerCase();
  if (value.includes("taper") || value.includes("race")) return "taper";
  if (value.includes("build") || value.includes("specific") || value.includes("peak")) return "build";
  return "base";
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
    };
  });
  return plan;
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

function renderOverview(plan, actuals) {
  const week = currentWeek(plan);
  const actual = summarizeWeekActual(week, actuals);
  const today = singaporeToday();
  const raceStart = new Date(RACE_START_LOCAL);
  const raceDay = parseLocalDate(RACE_DATE);
  const daysToRace = Math.max(daysBetween(today, raceDay), 0);
  const weekIndex = plan.weeks.findIndex((item) => item.week_number === week.week_number) + 1;
  const totalWeeks = plan.weeks.length;

  document.getElementById("raceCountdown").textContent =
    daysToRace === 0 ? "Race day" : `${daysToRace} days to race`;

  document.getElementById("overviewStats").innerHTML = [
    statCard("Race", "SCKL Marathon", `${formatDate.format(raceStart)} flag-off at 3:30am`, true),
    statCard("Goal time", GOAL_TIME, `${GOAL_PACE} goal pace, ${TROPICAL_MARATHON_PACE} tropical estimate`),
    statCard("Current week", `Week ${week.week_number}`, `${week.phase} block, ${weekIndex} of ${totalWeeks}`),
    statCard("This week", `${oneDecimalKm(actual.distance_km)} / ${km(week.target_weekly_mileage_km)}`, `${actual.run_count} Strava run${actual.run_count === 1 ? "" : "s"} logged`),
    statCard("Current baseline", "50-60 km/week", `${CURRENT_EASY_PACE} easy pace, 21 km current long run`),
    statCard("Race shoe", "Nike Alphafly 3", "Fuel plan still open and tracked weekly")
  ].join("");
}

function statCard(label, value, detail, featured = false) {
  return `
    <article class="stat-card ${featured ? "featured" : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function renderCurrentWeek(plan, actuals) {
  const week = currentWeek(plan);
  const actual = summarizeWeekActual(week, actuals);
  const inWeek = isCurrentWeek(week);
  const status = document.getElementById("trackStatus");
  status.textContent = inWeek ? "Current week" : "Next planned week";
  status.className = `status-pill ${inWeek ? "good" : "watch"}`;

  document.getElementById("currentWeekLabel").textContent =
    `Week ${week.week_number}: ${prettyDate(week.week_start_date)} to ${prettyDate(weekEndDate(week))} · ${week.phase}`;

  const dayCards = week.daily_sessions.map((session) => {
    const day = session.day;
    const dayActivities = activitiesForDate(actuals.activities || [], session.date);
    const actualKm = dayActivities.reduce((sum, activity) => sum + Number(activity.distance_km || 0), 0);
    const keyClass = day === "Monday" || day === "Tuesday" ? "key-day" : "";
    const strengthClass = day === "Wednesday" ? "strength-day" : "";
    const longClass = day === "Saturday" || day === "Sunday" && String(session.plan).toLowerCase().includes("race") ? "long-day" : "";
    return `
      <article class="day-card ${keyClass} ${strengthClass} ${longClass}">
        <span>${escapeHtml(day)} · ${escapeHtml(shortDate(session.date))}</span>
        <strong>${oneDecimalKm(session.planned_km)} planned</strong>
        <p>${escapeHtml(session.plan)}</p>
        <div class="actual-line">${oneDecimalKm(actualKm)} actual · ${dayActivities.length} run${dayActivities.length === 1 ? "" : "s"}</div>
      </article>
    `;
  }).join("");

  document.getElementById("currentWeekPlan").innerHTML = `
    <div class="week-summary">
      <div class="week-metric"><span>Target mileage</span><strong>${km(week.target_weekly_mileage_km)}</strong></div>
      <div class="week-metric"><span>Actual mileage</span><strong>${oneDecimalKm(actual.distance_km)}</strong></div>
      <div class="week-metric"><span>Key workout</span><strong>${escapeHtml(week.key_workout)}</strong></div>
      <div class="week-metric"><span>Longest actual</span><strong>${oneDecimalKm(actual.longest_run_km)}</strong></div>
    </div>
    <div class="daily-grid">${dayCards}</div>
    <div class="note-grid">
      <article class="note-card"><span>Long run notes</span><p>${escapeHtml(week.long_run_notes)}</p></article>
      <article class="note-card"><span>Fuel practice</span><p>${escapeHtml(week.fuel_practice)}</p></article>
      <article class="note-card"><span>Sleep / recovery</span><p>${escapeHtml(week.sleep_recovery_focus)}</p></article>
    </div>
  `;
}

function renderPlanTable(plan) {
  const table = document.getElementById("planTable");
  table.innerHTML = plan.weeks.map((week) => {
    const current = isCurrentWeek(week);
    const details = week.daily_sessions.map((session) => {
      return `
        <article class="day-card">
          <span>${escapeHtml(session.day)} · ${escapeHtml(shortDate(session.date))}</span>
          <strong>${oneDecimalKm(session.planned_km)} planned</strong>
          <p>${escapeHtml(session.plan)}</p>
        </article>
      `;
    }).join("");

    return `
      <details class="week-row ${current ? "current" : ""}" ${current ? "open" : ""}>
        <summary>
          <span class="row-label">Week ${week.week_number}</span>
          <span class="row-title">
            <strong>${escapeHtml(week.phase)}</strong>
            <span>${prettyDate(week.week_start_date)} to ${prettyDate(weekEndDate(week))}</span>
          </span>
          <span class="metric-pill mobile-hide">${km(week.target_weekly_mileage_km)}</span>
          <span class="metric-pill mobile-hide">${oneDecimalKm(week.long_run_distance_km)} long</span>
          <span class="metric-pill mobile-hide desktop-only">${escapeHtml(week.key_workout)}</span>
          <span class="metric-pill mobile-hide desktop-only">${escapeHtml(week.strength_training)}</span>
        </summary>
        <div class="week-row-body">
          <div class="daily-grid">${details}</div>
          <div class="note-grid">
            <article class="note-card"><span>Fuel practice</span><p>${escapeHtml(week.fuel_practice)}</p></article>
            <article class="note-card"><span>Recovery focus</span><p>${escapeHtml(week.sleep_recovery_focus)}</p></article>
            <article class="note-card"><span>Notes</span><p>${escapeHtml(week.notes)}</p></article>
          </div>
        </div>
      </details>
    `;
  }).join("");
}

function renderComparison(plan, actuals) {
  const status = document.getElementById("actualStatus");
  status.textContent = actuals.loaded_from === "strava" ? "Strava connected" : actuals.loaded_from === "mock" ? "Mock actuals" : "No actuals";
  status.className = `status-pill ${actuals.loaded_from === "strava" ? "good" : "watch"}`;

  document.getElementById("comparisonGrid").innerHTML = plan.weeks.map((week) => {
    const actual = summarizeWeekActual(week, actuals);
    const planned = Number(week.target_weekly_mileage_km || 0);
    const diff = actual.distance_km - planned;
    const adherence = planned > 0 ? Math.round((actual.distance_km / planned) * 100) : 0;
    const statusText = actual.run_count === 0 ? "No actuals yet" : adherence < 85 ? "Behind plan" : adherence <= 115 ? "On range" : "Over target";
    return `
      <article class="comparison-card ${isCurrentWeek(week) ? "current" : ""}">
        <span>Week ${week.week_number} · ${escapeHtml(week.phase)}</span>
        <strong>${oneDecimalKm(actual.distance_km)} / ${km(planned)}</strong>
        <p>${escapeHtml(statusText)} · ${adherence}% · ${diff >= 0 ? "+" : ""}${diff.toFixed(1)} km</p>
        <small>${actual.run_count} runs · longest ${oneDecimalKm(actual.longest_run_km)} · ${pace(actual.average_pace_seconds)}</small>
      </article>
    `;
  }).join("");
}

function renderActivityFeed(actuals) {
  const activities = [...(actuals.activities || [])].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 16);
  const feed = document.getElementById("activityFeed");
  if (!activities.length) {
    feed.innerHTML = `<div class="empty-state">No Strava runs loaded yet. The mock fallback can be replaced by running scripts/fetch_strava.py.</div>`;
    return;
  }
  feed.innerHTML = activities.map((activity) => `
    <article class="activity-feed-row">
      <div>
        <span>${escapeHtml(prettyDate(activity.date))}</span>
        <strong>${escapeHtml(activity.name)}</strong>
      </div>
      <div>
        <strong>${oneDecimalKm(activity.distance_km)}</strong>
        <span>${duration(activity.moving_time_seconds)} · ${Math.round(Number(activity.elevation_gain_m || 0))} m gain</span>
      </div>
    </article>
  `).join("");
}

function renderBarChart(containerId, weeks, valueKey, options = {}) {
  const container = document.getElementById(containerId);
  const width = 760;
  const height = 284;
  const left = 48;
  const right = 18;
  const top = 24;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const baseline = height - bottom;
  const maxValue = niceMax(Math.max(...weeks.map((week) => Number(week[valueKey] || 0)), 0));
  const current = currentWeek({ weeks });
  const barGap = 4;
  const barWidth = Math.max((plotWidth / weeks.length) - barGap, 8);

  const bars = weeks.map((week, index) => {
    const value = Number(week[valueKey] || 0);
    const barHeight = (value / maxValue) * plotHeight;
    const x = left + index * (plotWidth / weeks.length) + barGap / 2;
    const y = baseline - barHeight;
    const currentLine = week.week_number === current.week_number
      ? `<line class="chart-current" x1="${x + barWidth / 2}" y1="${top - 4}" x2="${x + barWidth / 2}" y2="${baseline}"></line>
         <text class="chart-now-label" x="${x + barWidth / 2 + 5}" y="${top + 8}">Now</text>`
      : "";
    const label = index % 2 === 0 || index === weeks.length - 1
      ? `<text class="chart-label" x="${x + barWidth / 2}" y="${height - 14}" text-anchor="middle">W${week.week_number}</text>`
      : "";
    return `
      ${currentLine}
      <rect class="chart-bar ${phaseClass(week.phase)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"></rect>
      ${label}
    `;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label || "Training chart")}">
      <line class="chart-grid" x1="${left}" y1="${top}" x2="${width - right}" y2="${top}"></line>
      <line class="chart-grid" x1="${left}" y1="${top + plotHeight / 2}" x2="${width - right}" y2="${top + plotHeight / 2}"></line>
      <line class="chart-axis" x1="${left}" y1="${baseline}" x2="${width - right}" y2="${baseline}"></line>
      <line class="chart-axis" x1="${left}" y1="${top}" x2="${left}" y2="${baseline}"></line>
      <text class="chart-label" x="0" y="${top + 4}">${maxValue} km</text>
      <text class="chart-label" x="0" y="${top + plotHeight / 2 + 4}">${maxValue / 2} km</text>
      <text class="chart-label" x="32" y="${baseline + 4}">0</text>
      ${bars}
    </svg>
  `;
}

function renderLineChart(containerId, weeks, valueKey, options = {}) {
  const container = document.getElementById(containerId);
  const width = 760;
  const height = 284;
  const left = 48;
  const right = 18;
  const top = 24;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const baseline = height - bottom;
  const maxValue = niceMax(Math.max(...weeks.map((week) => Number(week[valueKey] || 0)), 0));
  const current = currentWeek({ weeks });
  const step = plotWidth / Math.max(weeks.length - 1, 1);

  const points = weeks.map((week, index) => {
    const x = left + index * step;
    const y = baseline - (Number(week[valueKey] || 0) / maxValue) * plotHeight;
    return { x, y, week };
  });

  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const dots = points.map((point, index) => {
    const currentLine = point.week.week_number === current.week_number
      ? `<line class="chart-current" x1="${point.x}" y1="${top - 4}" x2="${point.x}" y2="${baseline}"></line>
         <text class="chart-now-label" x="${point.x + 5}" y="${top + 8}">Now</text>`
      : "";
    const label = index % 2 === 0 || index === points.length - 1
      ? `<text class="chart-label" x="${point.x}" y="${height - 14}" text-anchor="middle">W${point.week.week_number}</text>`
      : "";
    return `${currentLine}<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="5.2"></circle>${label}`;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label || "Long run chart")}">
      <line class="chart-grid" x1="${left}" y1="${top}" x2="${width - right}" y2="${top}"></line>
      <line class="chart-grid" x1="${left}" y1="${top + plotHeight / 2}" x2="${width - right}" y2="${top + plotHeight / 2}"></line>
      <line class="chart-axis" x1="${left}" y1="${baseline}" x2="${width - right}" y2="${baseline}"></line>
      <line class="chart-axis" x1="${left}" y1="${top}" x2="${left}" y2="${baseline}"></line>
      <polyline class="chart-line" points="${line}"></polyline>
      <text class="chart-label" x="0" y="${top + 4}">${maxValue} km</text>
      <text class="chart-label" x="0" y="${top + plotHeight / 2 + 4}">${maxValue / 2} km</text>
      <text class="chart-label" x="32" y="${baseline + 4}">0</text>
      ${dots}
    </svg>
  `;
}

function niceMax(value) {
  if (value <= 10) return 10;
  if (value <= 40) return Math.ceil(value / 5) * 5;
  if (value <= 120) return Math.ceil(value / 10) * 10;
  return Math.ceil(value / 25) * 25;
}

function renderPhaseBreakdown(plan) {
  const groups = plan.weeks.reduce((result, week) => {
    if (!result[week.phase]) {
      result[week.phase] = {
        phase: week.phase,
        weeks: 0,
        mileage: 0
      };
    }
    result[week.phase].weeks += 1;
    result[week.phase].mileage += Number(week.target_weekly_mileage_km || 0);
    return result;
  }, {});
  const rows = Object.values(groups);
  const maxMileage = Math.max(...rows.map((row) => row.mileage), 1);

  document.getElementById("phaseBreakdown").innerHTML = rows.map((row) => {
    const width = Math.round((row.mileage / maxMileage) * 100);
    return `
      <div class="phase-row">
        <div>
          <span class="phase-label">${escapeHtml(row.phase)}</span>
          <small>${row.weeks} week${row.weeks === 1 ? "" : "s"} · ${km(row.mileage)} planned</small>
        </div>
        <div class="phase-meter" aria-label="${escapeHtml(row.phase)} ${width}% of largest phase load">
          <span style="width: ${width}%"></span>
        </div>
        <strong>${Math.round(row.mileage / row.weeks)} km/wk avg</strong>
      </div>
    `;
  }).join("");
}

function renderDataStatus(plan, actuals) {
  const sourceLabel = plan.loaded_from === "google-sheet" ? "Google Sheet JSON" : "Local mock JSON";
  const sourceDetail = plan.loaded_from === "google-sheet"
    ? `Generated from ${text(plan.metadata?.source, "the configured Google Sheet")}.`
    : "Run scripts/fetch_google_sheet.py to generate data/training-plan.json from the Sheet.";
  const generated = plan.metadata?.generated_at
    ? new Date(plan.metadata.generated_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })
    : "Not generated yet";
  const actualGenerated = actuals.metadata?.generated_at
    ? new Date(actuals.metadata.generated_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })
    : "Not synced yet";
  const actualCount = Number(actuals.metadata?.included_activities || actuals.activities?.length || 0);

  document.getElementById("settingsGrid").innerHTML = `
    <article class="setting-card">
      <span>Planned training source</span>
      <strong>${escapeHtml(sourceLabel)}</strong>
      <p>${escapeHtml(sourceDetail)}</p>
    </article>
    <article class="setting-card">
      <span>Last plan sync</span>
      <strong>${escapeHtml(generated)}</strong>
      <p>The browser reads safe JSON only; Google credentials stay server-side.</p>
    </article>
    <article class="setting-card">
      <span>Strava status</span>
      <strong>${actuals.loaded_from === "strava" ? "Connected JSON" : actuals.loaded_from === "mock" ? "Mock actuals" : "Not connected"}</strong>
      <p>${actuals.loaded_from === "strava" ? `${actualCount} run${actualCount === 1 ? "" : "s"} loaded. Last sync: ${actualGenerated}.` : "Run the sync workflow after adding Strava credentials."}</p>
    </article>
    <article class="setting-card sync-card">
      <span>Manual sync</span>
      <strong>Strava + Sheet</strong>
      <p>Opens GitHub Actions. Click Run workflow there, then refresh this dashboard when it finishes.</p>
      <div class="setting-actions">
        <a class="action-button primary" href="${SYNC_WORKFLOW_URL}" target="_blank" rel="noreferrer">Sync Strava</a>
        <button id="refreshDashboard" class="action-button secondary" type="button">Refresh dashboard</button>
      </div>
    </article>
  `;

  document.getElementById("refreshDashboard")?.addEventListener("click", () => {
    window.location.reload();
  });
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

function render({ plan, actuals }) {
  renderOverview(plan, actuals);
  renderCurrentWeek(plan, actuals);
  renderComparison(plan, actuals);
  renderPlanTable(plan);
  renderBarChart("mileageChart", plan.weeks, "target_weekly_mileage_km", { label: "Planned weekly mileage" });
  renderLineChart("longRunChart", plan.weeks, "long_run_distance_km", { label: "Planned long run distance" });
  renderPhaseBreakdown(plan);
  renderActivityFeed(actuals);
  renderDataStatus(plan, actuals);
  document.getElementById("syncStatus").textContent =
    `${plan.loaded_from === "google-sheet" ? "Google Sheet plan" : "Mock plan"} loaded · ${plan.weeks.length} training weeks`;
}

setupReturnTop();
setupActiveNav();

Promise.all([loadPlan().then(normalizePlan), loadActuals()])
  .then(([plan, actuals]) => render({ plan, actuals }))
  .catch((error) => {
    console.error(error);
    document.getElementById("syncStatus").textContent = "Unable to load mock training plan.";
    document.getElementById("currentWeekPlan").innerHTML =
      `<div class="empty-state">Check that data/mock-training-plan.json exists and preview through a local web server.</div>`;
  });
