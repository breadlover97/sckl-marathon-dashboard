const LIVE_DATA_URL = "data/training-plan.json";
const MOCK_DATA_URL = "data/mock-training-plan.json";
const ACTUAL_DATA_URL = "data/strava-activities.json";
const MOCK_ACTUAL_DATA_URL = "data/mock-strava-activities.json";
const RACE_DATE = "2026-10-04";
const ACTIVITY_PAGE_SIZE = 10;
let latestRenderState = null;
let resizeTimer = null;
let hasScrolledThisWeekToToday = false;
let hasScrolledPlanToToday = false;
let activityFeedVisibleCount = ACTIVITY_PAGE_SIZE;

const paceZones = [
  {
    label: "Recovery",
    range: "5:45-6:20 /km",
    anchor: "No target",
    use: "Reset days",
    description: "Very easy running for post-workout days, tired legs, shin-splint caution days, and low-stress aerobic volume."
  },
  {
    label: "Easy aerobic",
    range: "5:10-5:45 /km",
    anchor: "By effort",
    use: "Daily mileage",
    description: "Your default mileage pace for normal easy runs, commuting aerobic volume, and relaxed run-club days."
  },
  {
    label: "Long run easy",
    range: "5:05-5:40 /km",
    anchor: "By effort",
    use: "Long run base",
    description: "Early and middle portions of long runs, especially before progression finishes, MP blocks, or hilly sections."
  },
  {
    label: "Steady aerobic",
    range: "4:35-5:00 /km",
    anchor: "Controlled",
    use: "Progressions",
    description: "Controlled aerobic pressure for medium-long runs, progression finishes, and steady segments without drifting into threshold."
  },
  {
    label: "Marathon effort",
    range: "4:10-4:20 /km",
    anchor: "MP",
    use: "Race-specific work",
    description: "Tropical marathon-pace work for long-run finishes, cruise blocks, and race-specific sessions; use effort over exact pace in heat."
  },
  {
    label: "Tempo",
    range: "3:58-4:08 /km",
    anchor: "6-10 km blocks",
    use: "Aerobic strength",
    description: "Comfortably hard running for 25-45 minute tempos, controlled progression runs, and longer sustained aerobic strength work."
  },
  {
    label: "Lactate threshold",
    range: "3:50-4:00 /km",
    anchor: "1.6 km: 6:10-6:24",
    use: "Cruise intervals",
    description: "Hard but repeatable pace for 20-30 minute threshold runs, cruise intervals, and sessions like 4-6 x 1 km to 2 km."
  },
  {
    label: "10K / critical velocity",
    range: "3:38-3:46 /km",
    anchor: "1 km: 3:38-3:46",
    use: "Fast aerobic reps",
    description: "Fast controlled aerobic reps for 800 m to 1.2 km repeats, sharpening workouts, and 10K-specific rhythm."
  },
  {
    label: "VO2 interval",
    range: "3:28-3:38 /km",
    anchor: "800m: 2:46-2:54",
    use: "Interval work",
    description: "High-end interval pace for 600 m to 1.2 km track reps with jog recoveries, used sparingly when form is strong."
  },
  {
    label: "Repetition / speed",
    range: "80-86s / 400m",
    anchor: "400m: 80-86s",
    use: "Speed economy",
    description: "Fast relaxed speed for 200 m to 400 m reps, strides, and running-economy work with fuller recovery."
  }
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

const formatMonth = new Intl.DateTimeFormat("en-SG", {
  month: "long",
  year: "numeric"
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
  const actualText = `Actual ${oneDecimalKm(actualKm)} · ${dayActivities.length} run${dayActivities.length === 1 ? "" : "s"}`;
  const actualLine = options.showActual || isCompleted
    ? `<div class="actual-line">${renderActualLine(dayActivities, actualText)}</div>`
    : "";

  return `
    <article class="${classes}" ${isActive ? `aria-current="date"` : ""}>
      <div class="day-card-head">
        <span>${escapeHtml(session.day)} · ${escapeHtml(shortDate(session.date))}</span>
        ${completedMark}
      </div>
      <strong>${oneDecimalKm(session.planned_km)}<br>plan</strong>
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

function planDayTooltip(week, session, dayActivities, actualKm) {
  const activityNames = dayActivities.map((activity) => activity.name).filter(Boolean).join(", ");
  const plannedKm = Number(session.planned_km || 0);
  const details = [
    `Week ${week.week_number} · ${week.phase}`,
    `${session.day}, ${prettyDate(session.date)}`,
    `Planned: ${plannedKm > 0 ? oneDecimalKm(plannedKm) : "Rest"}`,
    `Actual: ${dayActivities.length ? `${oneDecimalKm(actualKm)} from ${dayActivities.length} run${dayActivities.length === 1 ? "" : "s"}` : "No run logged"}`,
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
  const plannedKm = Number(session.planned_km || 0);
  const actualText = dayActivities.length ? oneDecimalKm(actualKm) : "-";
  const tooltip = planDayTooltip(week, session, dayActivities, actualKm);
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
        <small>Planned</small>
      </div>
      <div class="calendar-day-actual">
        <span>Actual</span>
        <strong>${escapeHtml(actualText)}</strong>
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

function comparisonPercent(actual, planned) {
  const plannedValue = Number(planned || 0);
  if (!plannedValue) return 0;
  return Math.max(0, Math.min((Number(actual || 0) / plannedValue) * 100, 100));
}

function renderPlanActualMeter(planned, actual, label) {
  return `
    <div class="plan-actual-meter" aria-label="${escapeHtml(label)}">
      <span style="width: ${comparisonPercent(actual, planned).toFixed(1)}%"></span>
    </div>
  `;
}

function renderCalendarWeek(week, actuals) {
  const current = isCurrentWeek(week);
  const actual = summarizeWeekActual(week, actuals);
  const days = week.daily_sessions.map((session) => renderCalendarDay(week, session, actuals)).join("");
  const runDays = week.daily_sessions.filter((session) => Number(session.planned_km || 0) > 0).length;
  const actualRuns = Number(actual.run_count || 0);

  return `
    <section class="calendar-week ${current ? "current" : ""}" data-week-number="${escapeHtml(week.week_number)}" ${current ? `data-current-week="true"` : ""}>
      <div class="calendar-week-meta">
        <div>
          <span>Week ${escapeHtml(week.week_number)} · ${escapeHtml(week.phase)}</span>
          <strong>${prettyDate(week.week_start_date)} to ${prettyDate(weekEndDate(week))}</strong>
        </div>
        <div class="calendar-week-stats" aria-label="Week mileage summary">
          <div class="week-stat-row">
            <span>Planned</span>
            <strong>${km(week.target_weekly_mileage_km)}</strong>
          </div>
          <div class="week-stat-row actual">
            <span>Actual</span>
            <strong>${oneDecimalKm(actual.distance_km)}</strong>
          </div>
          ${renderPlanActualMeter(week.target_weekly_mileage_km, actual.distance_km, "Week actual mileage compared with planned mileage")}
          <div class="week-run-comparison" aria-label="Week planned and actual run count">
            <span><small>Planned runs</small><strong>${runDays}</strong></span>
            <span><small>Actual runs</small><strong>${actualRuns}</strong></span>
          </div>
        </div>
      </div>
      <div class="calendar-days">${days}</div>
    </section>
  `;
}

function monthKey(value) {
  const date = parseLocalDate(value);
  if (!date) return "unscheduled";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(value) {
  const date = parseLocalDate(value);
  return date ? formatMonth.format(date) : "Unscheduled";
}

function monthGroups(weeks) {
  return weeks.reduce((groups, week) => {
    const key = monthKey(week.week_start_date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.weeks.push(week);
      return groups;
    }
    groups.push({
      key,
      label: monthLabel(week.week_start_date),
      weeks: [week]
    });
    return groups;
  }, []);
}

function summarizeMonthGroup(group, actuals) {
  return group.weeks.reduce((summary, week) => {
    const actual = summarizeWeekActual(week, actuals);
    summary.plannedKm += Number(week.target_weekly_mileage_km || 0);
    summary.actualKm += Number(actual.distance_km || 0);
    summary.runDays += week.daily_sessions.filter((session) => Number(session.planned_km || 0) > 0).length;
    summary.actualRuns += Number(actual.run_count || 0);
    summary.startDate = summary.startDate || week.week_start_date;
    summary.endDate = weekEndDate(week);
    summary.hasCurrent = summary.hasCurrent || isCurrentWeek(week);
    return summary;
  }, {
    actualKm: 0,
    actualRuns: 0,
    endDate: "",
    hasCurrent: false,
    plannedKm: 0,
    runDays: 0,
    startDate: ""
  });
}

function renderCalendarMonthGroup(group, actuals, openGroups) {
  const summary = summarizeMonthGroup(group, actuals);
  const isOpen = openGroups ? openGroups.has(group.key) : summary.hasCurrent;
  const weeks = group.weeks.map((week) => renderCalendarWeek(week, actuals)).join("");
  const weekLabel = group.weeks.length === 1 ? "1 week" : `${group.weeks.length} weeks`;

  return `
    <details class="calendar-phase-group ${summary.hasCurrent ? "current" : ""}" data-plan-group-key="${escapeHtml(group.key)}" ${isOpen ? "open" : ""}>
      <summary>
        <span class="phase-title">
          <small>${escapeHtml(group.label)}</small>
          <strong>${prettyDate(summary.startDate)} to ${prettyDate(summary.endDate)}</strong>
        </span>
        <span class="phase-count">${escapeHtml(weekLabel)}</span>
        <div class="phase-mileage" aria-label="Month mileage summary">
          <span class="phase-mileage-item planned">
            <small>Planned km</small>
            <strong>${km(summary.plannedKm)}</strong>
          </span>
          <span class="phase-mileage-item actual">
            <small>Actual km</small>
            <strong>${oneDecimalKm(summary.actualKm)}</strong>
          </span>
          ${renderPlanActualMeter(summary.plannedKm, summary.actualKm, "Month actual mileage compared with planned mileage")}
          <span class="phase-mileage-item planned">
            <small>Planned runs</small>
            <strong>${summary.runDays}</strong>
          </span>
          <span class="phase-mileage-item actual">
            <small>Actual runs</small>
            <strong>${summary.actualRuns}</strong>
          </span>
        </div>
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
        <span>This week</span>
        <strong>${oneDecimalKm(actual.distance_km)} / ${km(week.target_weekly_mileage_km)}</strong>
      </div>
      <div class="progress-track" aria-label="This week mileage progress">
        <span style="width: ${progress}%"></span>
      </div>
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
  const currentPlanGroups = document.querySelectorAll(".calendar-phase-group");
  const openGroups = openPlanGroupKeys();
  const shouldPreserveOpenState = currentPlanGroups.length > 0;
  const rows = monthGroups(plan.weeks)
    .map((group) => renderCalendarMonthGroup(group, actuals, shouldPreserveOpenState ? openGroups : null))
    .join("");
  table.innerHTML = `
    <div class="calendar-plan" aria-label="Week-by-week calendar training plan">
      ${rows}
    </div>
  `;
  updateWeekToggleLabel();
  updatePlanGroupToggleLabel();
  scrollPlanToToday();
}

function openPlanGroupKeys() {
  return new Set(
    Array.from(document.querySelectorAll(".calendar-phase-group[open]"))
      .map((group) => group.dataset.planGroupKey)
      .filter(Boolean)
  );
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
      scrollPlanToToday({ force: true, behavior: "smooth" });
    });
    updatePlanGroupToggleLabel();
  });
}

function scrollPlanToToday(options = {}) {
  if (hasScrolledPlanToToday && !options.force) return;
  window.requestAnimationFrame(() => {
    const activeDay = document.querySelector(".calendar-week.current .calendar-day.active-day");
    const grid = activeDay?.closest(".calendar-days");
    if (!grid || !activeDay || grid.scrollWidth <= grid.clientWidth) return;
    const target = activeDay.offsetLeft - ((grid.clientWidth - activeDay.clientWidth) / 2);
    grid.scrollTo({ left: Math.max(0, target), behavior: options.behavior || "auto" });
    hasScrolledPlanToToday = true;
  });
}

function updatePlanGroupToggleLabel() {
  const button = document.getElementById("togglePlanGroups");
  if (!button) return;
  const groups = Array.from(document.querySelectorAll(".calendar-phase-group"));
  const allOpen = groups.length > 0 && groups.every((group) => group.open);
  button.textContent = allOpen ? "Close all" : "Expand all";
  button.setAttribute("aria-label", allOpen ? "Close all months in the training plan" : "Expand all months in the training plan");
  button.disabled = groups.length === 0;
}

function setupPlanGroupToggle() {
  const button = document.getElementById("togglePlanGroups");
  if (!button) return;

  button.addEventListener("click", () => {
    const groups = Array.from(document.querySelectorAll(".calendar-phase-group"));
    if (!groups.length) return;
    const shouldOpen = groups.some((group) => !group.open);
    groups.forEach((group) => {
      group.open = shouldOpen;
    });
    updatePlanGroupToggleLabel();
  });

  document.addEventListener("toggle", (event) => {
    if (!event.target.closest?.(".calendar-phase-group")) return;
    updatePlanGroupToggleLabel();
  }, true);
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

function activitySortValue(activity) {
  const timestamp = Date.parse(activity.start_date_local || activity.date || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function renderActivityFeed(actuals) {
  const allActivities = [...(actuals.activities || [])].sort((a, b) => activitySortValue(b) - activitySortValue(a));
  const feed = document.getElementById("activityFeed");
  if (!allActivities.length) {
    feed.innerHTML = `<div class="empty-state">No Strava runs loaded yet. The mock fallback can be replaced by running scripts/fetch_strava.py.</div>`;
    return;
  }
  activityFeedVisibleCount = Math.min(Math.max(activityFeedVisibleCount, 0), allActivities.length);
  const activities = allActivities.slice(0, activityFeedVisibleCount);
  const totalDistance = allActivities.reduce((sum, activity) => sum + Number(activity.distance_km || 0), 0);
  const totalMoving = allActivities.reduce((sum, activity) => sum + Number(activity.moving_time_seconds || 0), 0);
  const athlete = actuals.metadata?.athlete || {};
  const athleteName = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || "Tai Zhi";
  const profileImage = safeExternalUrl(athlete.profile_medium || athlete.profile || "");
  const activityRows = activities.map((activity) => {
    const stravaUrl = safeExternalUrl(activity.strava_url, ["strava.com"]);
    const activityName = stravaUrl
      ? `<a class="activity-name-link" href="${escapeHtml(stravaUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(activity.name)}</a>`
      : escapeHtml(activity.name);
    return `
      <tr class="activity-main-row">
        <td data-label="Date">${escapeHtml(prettyDate(activity.date))}</td>
        <td data-label="Activity"><strong>${activityName}</strong></td>
        <td data-label="Distance"><strong>${oneDecimalKm(activity.distance_km)}</strong></td>
        <td data-label="Moving">${duration(activity.moving_time_seconds)}</td>
        <td data-label="Avg pace">${activityPace(activity)}</td>
        <td data-label="Avg HR">${heartRate(activity.average_heartrate)}</td>
        <td data-label="Cadence">${cadence(activity.average_cadence)}</td>
        <td data-label="Elev">${Math.round(Number(activity.elevation_gain_m || 0))} m</td>
      </tr>
    `;
  }).join("");
  const remaining = Math.max(allActivities.length - activityFeedVisibleCount, 0);
  const nextCount = Math.min(ACTIVITY_PAGE_SIZE, remaining || ACTIVITY_PAGE_SIZE);
  const tableMarkup = `
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
          </tr>
        </thead>
        <tbody>${activityRows}</tbody>
      </table>
    </div>
  `;

  const feedActions = [
    remaining > 0 ? `<button class="action-button secondary compact-action" type="button" data-activity-show-more>Show ${nextCount} more</button>` : "",
    activityFeedVisibleCount > ACTIVITY_PAGE_SIZE ? `<button class="action-button secondary compact-action" type="button" data-activity-hide-all>Show first ${ACTIVITY_PAGE_SIZE}</button>` : ""
  ].filter(Boolean).join("");

  feed.innerHTML = `
    <div class="activity-table-shell">
      <div class="activity-table-summary">
        <div class="athlete-summary">
          ${profileImage ? `<img src="${escapeHtml(profileImage)}" alt="">` : `<span class="athlete-avatar-fallback">TZ</span>`}
          <strong>${escapeHtml(athleteName)}</strong>
        </div>
        <span>${activityFeedVisibleCount} of ${allActivities.length} runs shown · ${oneDecimalKm(totalDistance)} · ${duration(totalMoving)}</span>
      </div>
      ${tableMarkup}
      <div class="activity-feed-actions">
        ${feedActions}
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
  const cards = paceZones.map((zone) => `
    <article class="pace-card" tabindex="0" aria-label="${escapeHtml(`${zone.label}: ${zone.range}. ${zone.description}`)}">
      <div class="pace-card-topline">
        <span>${escapeHtml(zone.label)}</span>
        <small>${escapeHtml(zone.use)}</small>
      </div>
      <strong>${escapeHtml(zone.range)}</strong>
      <div class="pace-anchor">${escapeHtml(zone.anchor)}</div>
      <div class="pace-tooltip" role="tooltip">
        <strong>${escapeHtml(zone.label)}</strong>
        <span>${escapeHtml(zone.description)}</span>
      </div>
    </article>
  `).join("");
  container.innerHTML = `<div class="pace-card-grid">${cards}</div>`;
  container.querySelectorAll(".pace-card").forEach((card) => {
    const show = () => card.classList.add("is-tooltip-visible");
    const hide = () => card.classList.remove("is-tooltip-visible");
    card.addEventListener("pointerenter", show);
    card.addEventListener("pointerleave", hide);
    card.addEventListener("focus", show);
    card.addEventListener("blur", hide);
  });
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

function setupActivityFeedControls() {
  document.addEventListener("click", (event) => {
    const showMore = event.target.closest("[data-activity-show-more]");
    const hideAll = event.target.closest("[data-activity-hide-all]");
    if (!showMore && !hideAll) return;
    if (!latestRenderState) return;
    if (showMore) {
      activityFeedVisibleCount += ACTIVITY_PAGE_SIZE;
    } else {
      activityFeedVisibleCount = ACTIVITY_PAGE_SIZE;
    }
    renderActivityFeed(latestRenderState.actuals);
  });
}

function scrollToHashTarget() {
  const id = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : "";
  const target = id ? document.getElementById(id) : null;
  if (!target) return;
  window.requestAnimationFrame(() => {
    target.scrollIntoView({ block: "start" });
  });
}

function render({ plan, actuals }) {
  latestRenderState = { actuals, plan };
  renderTrainingDayProgress(plan);
  renderCurrentWeek(plan, actuals);
  renderPlanTable(plan, actuals);
  renderBarChart("mileageChart", plan.weeks, "target_weekly_mileage_km", { actuals, actualMetric: "distance_km", label: "Planned and actual weekly mileage", valueLabel: "Mileage" });
  renderLineChart("longRunChart", plan.weeks, "long_run_distance_km", { actuals, actualMetric: "longest_run_km", label: "Planned and actual long run distance", valueLabel: "Long run" });
  renderPaceGuide();
  renderMileageLegend();
  renderActivityFeed(actuals);
  document.getElementById("syncStatus").textContent =
    `${plan.loaded_from === "google-sheet" ? "Sheet" : "Mock"} · ${plan.weeks.length} weeks`;
  scrollToHashTarget();
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
setupPlanGroupToggle();
setupActivityFeedControls();
setupCalendarTooltips();
setupResponsiveCharts();

Promise.all([loadPlan().then(normalizePlan), loadActuals()])
  .then(([plan, actuals]) => render({ plan, actuals }))
  .catch((error) => {
    console.error(error);
    document.getElementById("syncStatus").textContent = "Unable to load mock training plan.";
    document.getElementById("currentWeekPlan").innerHTML =
      `<div class="empty-state">Check that data/mock-training-plan.json exists and preview through a local web server.</div>`;
  });
