const LIVE_DATA_URL = "data/training-plan.json";
const MOCK_DATA_URL = "data/mock-training-plan.json";
const ACTUAL_DATA_URL = "data/strava-activities.json";
const MOCK_ACTUAL_DATA_URL = "data/mock-strava-activities.json";
const RUN_NOTES_API_URL = String(window.SCKL_CONFIG?.runNotesApiUrl || "").replace(/\/$/, "");
const RACE_DATE = "2026-10-04";
const RACE_START_LOCAL = "2026-10-04T03:30:00+08:00";
const GOAL_TIME = "2h 50m";
const GOAL_PACE = "4:02 /km";
const TROPICAL_MARATHON_PACE = "4:15 /km";
const CURRENT_EASY_PACE = "5:15-5:30 /km";
const WELLNESS_STORAGE_KEY = "sckl-wellness-checks";
let latestRenderState = null;
let resizeTimer = null;

const wellnessChecks = [
  { key: "protein", label: "Protein shake" },
  { key: "omega3", label: "Omega 3" },
  { key: "vitaminD", label: "Vitamin D" }
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
  if (value.includes("taper") || value.includes("race week")) return "taper";
  if (value.includes("recovery")) return "recovery";
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

async function loadRunNotes() {
  if (!RUN_NOTES_API_URL) return {};
  try {
    const payload = await fetchJson(`${RUN_NOTES_API_URL}/notes`);
    return (payload.notes || []).reduce((result, note) => {
      if (note.activity_id) result[String(note.activity_id)] = note;
      return result;
    }, {});
  } catch (error) {
    console.info("Run notes unavailable.", error);
    return {};
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
  const linkedActivities = dayActivities.filter((activity) => activity.strava_url);
  if (linkedActivities.length === 1) {
    const activity = linkedActivities[0];
    return `<a href="${escapeHtml(activity.strava_url)}" target="_blank" rel="noreferrer" title="${escapeHtml(activity.name)}">${escapeHtml(actualText)}</a>`;
  }
  if (linkedActivities.length > 1) {
    const links = linkedActivities.map((activity, index) => {
      return `<a class="actual-link" href="${escapeHtml(activity.strava_url)}" target="_blank" rel="noreferrer" title="${escapeHtml(activity.name)}" aria-label="Open ${escapeHtml(activity.name)}">${index + 1}</a>`;
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
  const isCompleted = dayActivities.length > 0 || actualKm > 0;
  const classes = [
    "day-card",
    isActive ? "active-day" : "",
    isCompleted ? "completed-day" : "",
  ].filter(Boolean).join(" ");
  const completedMark = isCompleted ? `<span class="completed-mark" aria-label="Completed">✓</span>` : "";
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

function renderWellnessTracker() {
  const today = dateKey(singaporeToday());
  const todayState = loadWellnessChecks()[today] || {};
  const completed = wellnessChecks.filter((item) => todayState[item.key]).length;
  const items = wellnessChecks.map((item) => {
    const checked = todayState[item.key] ? "checked" : "";
    return `
      <label class="wellness-check">
        <input type="checkbox" data-wellness-check data-date="${today}" data-key="${escapeHtml(item.key)}" ${checked}>
        <span>${escapeHtml(item.label)}</span>
      </label>
    `;
  }).join("");

  return `
    <article class="wellness-card">
      <div class="wellness-head">
        <div>
          <span>Daily nutrition check</span>
          <strong>Supplements</strong>
        </div>
        <small data-wellness-count>${completed}/${wellnessChecks.length}</small>
      </div>
      <div class="wellness-list">${items}</div>
    </article>
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
  status.textContent = actuals.metadata?.generated_at
    ? `Strava synced ${syncTime(actuals.metadata.generated_at)}`
    : "Strava not synced";
  status.className = "status-pill";
  const planned = Number(week.target_weekly_mileage_km || 0);
  const progress = planned > 0 ? Math.min((actual.distance_km / planned) * 100, 140) : 0;

  document.getElementById("currentWeekLabel").textContent =
    `Week ${week.week_number}: ${prettyDate(week.week_start_date)} to ${prettyDate(weekEndDate(week))} · ${week.phase}`;

  const dayCards = week.daily_sessions.map((session) => renderDayCard(session, actuals, { showActual: true })).join("");

  document.getElementById("currentWeekPlan").innerHTML = `
    <div class="week-progress">
      <div>
        <span>This week progress</span>
        <strong>${oneDecimalKm(actual.distance_km)} / ${km(week.target_weekly_mileage_km)}</strong>
      </div>
      <div class="progress-track" aria-label="This week mileage progress">
        <span style="width: ${progress}%"></span>
      </div>
    </div>
    ${renderWellnessTracker()}
    <div class="daily-grid">${dayCards}</div>
    <div class="note-grid">
      <article class="note-card"><span>Long run notes</span><p>${escapeHtml(week.long_run_notes)}</p></article>
      <article class="note-card"><span>Fuel practice</span><p>${escapeHtml(week.fuel_practice)}</p></article>
      <article class="note-card"><span>Sleep / recovery</span><p>${escapeHtml(week.sleep_recovery_focus)}</p></article>
    </div>
  `;
}

function renderPlanTable(plan, actuals) {
  const table = document.getElementById("planTable");
  const planStatus = document.getElementById("planSyncStatus");
  if (planStatus) {
    planStatus.textContent = plan.metadata?.generated_at
      ? `Sheet synced ${syncTime(plan.metadata.generated_at)}`
      : "Sheet not synced";
    planStatus.className = "status-pill";
  }
  table.innerHTML = plan.weeks.map((week) => {
    const current = isCurrentWeek(week);
    const details = week.daily_sessions.map((session) => renderDayCard(session, actuals)).join("");

    return `
      <details class="week-row ${current ? "current" : ""}" ${current ? "open" : ""}>
        <summary>
          <span class="row-label">Week ${week.week_number}</span>
          <span class="row-title">
            <strong>${escapeHtml(week.phase)}</strong>
            <span>${prettyDate(week.week_start_date)} to ${prettyDate(weekEndDate(week))}</span>
          </span>
          <span class="row-summary-text">${escapeHtml(week.week_summary)}</span>
        </summary>
        <div class="week-row-body">
          <div class="daily-grid">${details}</div>
          <p class="week-notes-line"><strong>Notes:</strong> ${escapeHtml(week.notes || "No notes for this week.")}</p>
        </div>
      </details>
    `;
  }).join("");
}

function renderRunNoteControl(activity, runNotes) {
  const note = runNotes[String(activity.id)]?.note || "";
  if (!RUN_NOTES_API_URL || !activity.id) return "-";
  return `
    <form class="run-note-form" data-run-note-form data-activity-id="${escapeHtml(activity.id)}" data-activity-date="${escapeHtml(activity.date)}" data-activity-name="${escapeHtml(activity.name)}" data-activity-url="${escapeHtml(activity.strava_url || "")}">
      <textarea name="note" aria-label="Run note for ${escapeHtml(activity.name)}">${escapeHtml(note)}</textarea>
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
  const profileImage = athlete.profile_medium || athlete.profile || "";
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
              <th>Elapsed</th>
              <th>Avg HR</th>
              <th>Avg cadence</th>
              <th>Elev</th>
              <th>Notes</th>
              <th>Link</th>
            </tr>
          </thead>
          <tbody>
            ${activities.map((activity) => `
              <tr>
                <td>${escapeHtml(prettyDate(activity.date))}</td>
                <td><strong>${escapeHtml(activity.name)}</strong></td>
                <td><strong>${oneDecimalKm(activity.distance_km)}</strong></td>
                <td>${duration(activity.moving_time_seconds)}</td>
                <td>${activityPace(activity)}</td>
                <td>${duration(activity.elapsed_time_seconds)}</td>
                <td>${heartRate(activity.average_heartrate)}</td>
                <td>${cadence(activity.average_cadence)}</td>
                <td>${Math.round(Number(activity.elevation_gain_m || 0))} m</td>
                <td>${renderRunNoteControl(activity, runNotes)}</td>
                <td>${activity.strava_url ? `<a href="${escapeHtml(activity.strava_url)}" target="_blank" rel="noreferrer">Open</a>` : "-"}</td>
              </tr>
            `).join("")}
          </tbody>
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

function chartHoverMarkup(left, top, plotWidth, plotHeight, baseline) {
  return `
    <g class="chart-hover" aria-hidden="true">
      <line class="chart-crosshair" data-hover-v x1="${left}" y1="${top}" x2="${left}" y2="${baseline}"></line>
      <line class="chart-crosshair" data-hover-h x1="${left}" y1="${top}" x2="${left + plotWidth}" y2="${top}"></line>
      <circle class="chart-hover-dot" data-hover-dot cx="${left}" cy="${top}" r="5"></circle>
      <g class="chart-tooltip" data-hover-tip>
        <rect class="chart-tooltip-bg" width="198" height="92" rx="8"></rect>
        <text class="chart-tooltip-title" data-hover-date x="12" y="20"></text>
        <circle class="tooltip-marker phase" cx="16" cy="39" r="3.5"></circle>
        <text class="chart-tooltip-phase" data-hover-phase x="26" y="43"></text>
        <circle class="tooltip-marker planned" cx="16" cy="61" r="3.5"></circle>
        <text class="chart-tooltip-planned" data-hover-value x="26" y="65"></text>
        <circle class="tooltip-marker actual" cx="16" cy="79" r="3.5"></circle>
        <text class="chart-tooltip-actual" data-hover-actual x="26" y="83"></text>
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
    const tooltipX = x > dims.width - 238 ? x - 210 : x + 12;
    const tooltipY = Math.max(dims.top + 4, Math.min(point.y - 102, dims.baseline - 106));

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
    dateText.textContent = `${point.label} · ${prettyDate(point.date)}`;
    phaseText.textContent = `Phase: ${point.phase || "-"}`;
    valueText.textContent = `Planned: ${oneDecimalKm(point.value)}`;
    actualText.textContent = `Actual: ${point.actualValue === null || point.actualValue === undefined ? "-" : oneDecimalKm(point.actualValue)}`;
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
    let token = window.localStorage.getItem("sckl-run-notes-token") || "";
    if (!token) {
      token = window.prompt("Enter run notes passcode") || "";
      if (!token) return;
      window.localStorage.setItem("sckl-run-notes-token", token);
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
        window.localStorage.removeItem("sckl-run-notes-token");
        throw new Error("Passcode rejected");
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      button.textContent = "Saved";
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

function setupWellnessTracker() {
  document.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-wellness-check]");
    if (!checkbox) return;
    const state = loadWellnessChecks();
    const date = checkbox.dataset.date;
    const key = checkbox.dataset.key;
    if (!date || !key) return;
    state[date] = {
      ...(state[date] || {}),
      [key]: checkbox.checked
    };
    saveWellnessChecks(state);

    const card = checkbox.closest(".wellness-card");
    const count = card?.querySelector("[data-wellness-count]");
    if (count) {
      const checked = card.querySelectorAll("[data-wellness-check]:checked").length;
      count.textContent = `${checked}/${wellnessChecks.length}`;
    }
  });
}

function render({ plan, actuals, runNotes }) {
  latestRenderState = { actuals, plan, runNotes };
  renderTrainingDayProgress(plan);
  renderCurrentWeek(plan, actuals);
  renderPlanTable(plan, actuals);
  renderBarChart("mileageChart", plan.weeks, "target_weekly_mileage_km", { actuals, actualMetric: "distance_km", label: "Planned and actual weekly mileage", valueLabel: "Mileage" });
  renderLineChart("longRunChart", plan.weeks, "long_run_distance_km", { actuals, actualMetric: "longest_run_km", label: "Planned and actual long run distance", valueLabel: "Long run" });
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
setupRunNotesForms();
setupWellnessTracker();
setupResponsiveCharts();

Promise.all([loadPlan().then(normalizePlan), loadActuals(), loadRunNotes()])
  .then(([plan, actuals, runNotes]) => render({ plan, actuals, runNotes }))
  .catch((error) => {
    console.error(error);
    document.getElementById("syncStatus").textContent = "Unable to load mock training plan.";
    document.getElementById("currentWeekPlan").innerHTML =
      `<div class="empty-state">Check that data/mock-training-plan.json exists and preview through a local web server.</div>`;
  });
