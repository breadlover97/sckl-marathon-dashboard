const NUTRITION_DATA_URL = "data/nutrition.json";
const MOCK_NUTRITION_DATA_URL = "data/mock-nutrition.json";
const SUPPLEMENTS_DATA_URL = "data/supplements.json";
const MOCK_SUPPLEMENTS_DATA_URL = "data/mock-supplements.json";

const formatDate = new Intl.DateTimeFormat("en-SG", {
  day: "numeric",
  month: "short",
  year: "numeric"
});

function text(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function escapeHtml(value, fallback = "-") {
  const div = document.createElement("div");
  div.textContent = text(value, fallback);
  return div.innerHTML;
}

function parseLocalDate(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function prettyDate(value) {
  const date = parseLocalDate(value);
  return date ? formatDate.format(date) : "-";
}

function round(value, digits = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(digits) : "-";
}

function kcal(value) {
  return `${Math.round(Number(value || 0))} kcal`;
}

function grams(value) {
  return `${round(value, 0)}g`;
}

function milligrams(value) {
  const number = Number(value || 0);
  return number > 0 ? `${Math.round(number)}mg` : "-";
}

function percent(value) {
  return value === null || value === undefined || value === "" ? "-" : `${round(value, 0)}%`;
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

function modelLabel(source) {
  const sources = Array.isArray(source) ? source : String(source || "").split(",");
  const openAiSource = sources
    .map((item) => String(item || "").trim())
    .find((item) => item.toLowerCase().startsWith("openai:"));
  return openAiSource ? openAiSource.replace(/^openai:/i, "") : "-";
}

function nutritionModel(payload) {
  const mealSource = payload.meals.map((meal) => meal.source).find(Boolean);
  const daySource = payload.days.map((day) => day.source).find(Boolean);
  return modelLabel(mealSource || daySource || "");
}

async function fetchJson(url) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.json();
}

async function loadNutrition() {
  try {
    const payload = await fetchJson(NUTRITION_DATA_URL);
    return { ...normalizeNutrition(payload), loaded_from: "google-sheet" };
  } catch (error) {
    console.info("Live nutrition unavailable; using mock nutrition.", error);
    try {
      const payload = await fetchJson(MOCK_NUTRITION_DATA_URL);
      return { ...normalizeNutrition(payload), loaded_from: "mock" };
    } catch (mockError) {
      console.info("No mock nutrition available.", mockError);
      return normalizeNutrition({ metadata: { included_days: 0, included_meals: 0 }, days: [], nutrition: [] });
    }
  }
}

async function loadSupplements() {
  try {
    const payload = await fetchJson(SUPPLEMENTS_DATA_URL);
    if (!Array.isArray(payload.days) || !payload.days.length) {
      throw new Error("Supplement history has not been synced yet.");
    }
    return normalizeSupplements(payload);
  } catch (error) {
    console.info("Live supplements unavailable; using mock supplements.", error);
    try {
      const payload = await fetchJson(MOCK_SUPPLEMENTS_DATA_URL);
      return normalizeSupplements(payload);
    } catch (mockError) {
      console.info("No mock supplements available.", mockError);
      return normalizeSupplements({ metadata: { included_days: 0 }, days: [] });
    }
  }
}

function normalizeNutrition(payload) {
  const meals = Array.isArray(payload.nutrition) ? payload.nutrition : [];
  const days = Array.isArray(payload.days) && payload.days.length
    ? payload.days
    : aggregateDays(meals);
  return {
    metadata: payload.metadata || {},
    days: [...days].sort((a, b) => String(b.date).localeCompare(String(a.date))),
    meals: [...meals].sort((a, b) => `${b.date} ${b.meal}`.localeCompare(`${a.date} ${a.meal}`)),
  };
}

function normalizeSupplements(payload) {
  const days = Array.isArray(payload.days) ? payload.days : [];
  return {
    metadata: payload.metadata || {},
    days: [...days].sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };
}

function supplementsByDate(days) {
  return days.reduce((result, day) => {
    if (day.date) result[day.date] = day;
    return result;
  }, {});
}

function nutritionByDate(days) {
  return days.reduce((result, day) => {
    if (day.date) result[day.date] = day;
    return result;
  }, {});
}

function supplementShortLabel(label) {
  const words = String(label || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "Item";
  if (words.length > 1 && words[1].length <= 2) return `${words[0]} ${words[1]}`;
  return words[0];
}

function monthLabel(value) {
  const date = parseLocalDate(value);
  if (!date) return "Unscheduled";
  return new Intl.DateTimeFormat("en-SG", { month: "long", year: "numeric" }).format(date);
}

function monthKey(value) {
  const date = parseLocalDate(value);
  if (!date) return "unscheduled";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function groupCalendarDays(dates, nutritionDays, supplementDays) {
  return dates.reduce((groups, date) => {
    const key = monthKey(date);
    const last = groups[groups.length - 1];
    const entry = {
      date,
      nutrition: nutritionDays[date] || null,
      supplements: supplementDays[date] || null,
    };
    if (last && last.key === key) {
      last.days.push(entry);
      return groups;
    }
    groups.push({ key, label: monthLabel(date), days: [entry] });
    return groups;
  }, []);
}

function aggregateDays(meals) {
  const byDate = meals.reduce((result, meal) => {
    if (!meal.date) return result;
    const day = result[meal.date] || {
      date: meal.date,
      calories: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      fibre_g: 0,
      sodium_mg: 0,
      meal_count: 0,
      meals: []
    };
    day.calories += Number(meal.calories || 0);
    day.protein_g += Number(meal.protein_g || 0);
    day.carbs_g += Number(meal.carbs_g || 0);
    day.fat_g += Number(meal.fat_g || 0);
    day.fibre_g += Number(meal.fibre_g || 0);
    day.sodium_mg += Number(meal.sodium_mg || 0);
    day.calorie_target = day.calorie_target || meal.calorie_target || null;
    day.protein_target_g = day.protein_target_g || meal.protein_target_g || null;
    day.meal_count += 1;
    day.meals.push(meal);
    result[meal.date] = day;
    return result;
  }, {});
  return Object.values(byDate);
}

function latestDay(days) {
  return [...days].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;
}

function renderSummary(payload) {
  const container = document.getElementById("nutritionSummary");
  const status = document.getElementById("nutritionStatus");
  const syncStatus = document.getElementById("nutritionSyncStatus");
  const day = latestDay(payload.days);
  const latestCalories = day ? kcal(day.calories) : "-";
  const latestProtein = day ? grams(day.protein_g) : "-";
  const avgCalories = day?.seven_day_average_calories ? kcal(day.seven_day_average_calories) : "-";
  const avgProtein = day?.seven_day_average_protein_g ? grams(day.seven_day_average_protein_g) : "-";
  const syncLabel = payload.loaded_from === "google-sheet" ? "Nutrition" : "Mock nutrition";
  const syncedText = lastSyncedText(syncLabel, payload.metadata?.generated_at, `${syncLabel} not synced`);
  const model = nutritionModel(payload);
  status.textContent = syncedText;
  syncStatus.textContent = `${syncedText} · ${payload.days.length} day${payload.days.length === 1 ? "" : "s"}`;
  container.innerHTML = `
    <article class="week-metric"><span>Latest date</span><strong>${escapeHtml(day ? prettyDate(day.date) : "-")}</strong></article>
    <article class="week-metric"><span>Latest calories</span><strong>${escapeHtml(latestCalories)}</strong></article>
    <article class="week-metric"><span>Latest protein</span><strong>${escapeHtml(latestProtein)}</strong></article>
    <article class="week-metric"><span>7-day calories</span><strong>${escapeHtml(avgCalories)}</strong></article>
    <article class="week-metric"><span>7-day protein</span><strong>${escapeHtml(avgProtein)}</strong></article>
    <article class="week-metric"><span>AI model</span><strong>${escapeHtml(model)}</strong></article>
    <article class="week-metric"><span>Meal rows</span><strong>${escapeHtml(payload.meals.length)}</strong></article>
  `;
}

function progressCell(value, target, formatter) {
  if (!target) return escapeHtml(formatter(value));
  const pct = Math.min((Number(value || 0) / Number(target || 0)) * 100, 999);
  return `
    <div class="nutrition-target-cell">
      <strong>${escapeHtml(formatter(value))}</strong>
      <span>Target ${escapeHtml(formatter(target))}</span>
      <div class="progress-track mini-track"><i style="width:${Math.min(pct, 100).toFixed(0)}%"></i></div>
    </div>
  `;
}

function renderSupplementPills(day) {
  const items = Array.isArray(day?.items) ? day.items : [];
  if (!items.length) return `<span class="nutrition-calendar-empty">No supplements</span>`;
  return items.map((item) => {
    const done = Boolean(item.taken);
    return `<span class="nutrition-status-pill ${done ? "done" : ""}" title="${escapeHtml(item.label)} ${done ? "taken" : "not taken"}">${escapeHtml(supplementShortLabel(item.label))}</span>`;
  }).join("");
}

function renderCalendarDay(entry) {
  const nutrition = entry.nutrition;
  const supplements = entry.supplements;
  const supplementTotal = Number(supplements?.total_count || supplements?.items?.length || 0);
  const supplementDone = Number(supplements?.completed_count || 0);
  const mealCount = Number(nutrition?.meal_count || nutrition?.meals?.length || 0);
  const hasNutrition = Boolean(nutrition && (Number(nutrition.calories || 0) || Number(nutrition.protein_g || 0) || mealCount));

  return `
    <article class="nutrition-calendar-day ${hasNutrition ? "has-nutrition" : ""} ${supplementTotal ? "has-supplements" : ""}">
      <div class="nutrition-calendar-head">
        <span>${escapeHtml(prettyDate(entry.date))}</span>
        <strong>${supplementTotal ? `${supplementDone}/${supplementTotal}` : "-"}</strong>
      </div>
      <div class="nutrition-calendar-macros">
        <strong>${hasNutrition ? escapeHtml(kcal(nutrition.calories)) : "-"}</strong>
        <span>${hasNutrition ? `${escapeHtml(grams(nutrition.protein_g))} protein` : "No meals"}</span>
      </div>
      <div class="nutrition-calendar-meta">
        <span>${mealCount ? `${mealCount} meal${mealCount === 1 ? "" : "s"}` : "0 meals"}</span>
      </div>
      <div class="nutrition-status-list" aria-label="${supplementDone} of ${supplementTotal} supplements taken">
        ${renderSupplementPills(supplements)}
      </div>
    </article>
  `;
}

function renderCalendar(nutritionDays, supplementDays) {
  const container = document.getElementById("nutritionCalendar");
  const byNutrition = nutritionByDate(nutritionDays);
  const bySupplements = supplementsByDate(supplementDays);
  const dates = [...new Set([...Object.keys(byNutrition), ...Object.keys(bySupplements)])].sort();
  if (!dates.length) {
    container.innerHTML = `<div class="empty-state">Nutrition and supplement history will appear after the next sync.</div>`;
    return;
  }
  const groups = groupCalendarDays(dates, byNutrition, bySupplements);
  container.innerHTML = groups.map((group, index) => `
    <details class="calendar-phase-group nutrition-calendar-group" ${index === groups.length - 1 ? "open" : ""}>
      <summary>
        <span class="phase-title">${escapeHtml(group.label)}</span>
        <span class="phase-stat">${escapeHtml(group.days.length)} days</span>
      </summary>
      <div class="nutrition-calendar-grid">
        ${group.days.map(renderCalendarDay).join("")}
      </div>
    </details>
  `).join("");
}

function mealRows(meals) {
  function noteText(meal) {
    return meal.assumptions || meal.notes || "-";
  }
  return meals.map((meal) => `
    <tr>
      <td data-label="Meal">${escapeHtml(meal.meal || "Unspecified")}</td>
      <td data-label="Food"><strong>${escapeHtml(meal.food_item || "-")}</strong></td>
      <td data-label="Calories">${meal.calories ? escapeHtml(kcal(meal.calories)) : "-"}</td>
      <td data-label="Protein">${meal.protein_g ? escapeHtml(grams(meal.protein_g)) : "-"}</td>
      <td data-label="Carbs">${meal.carbs_g ? escapeHtml(grams(meal.carbs_g)) : "-"}</td>
      <td data-label="Fat">${meal.fat_g ? escapeHtml(grams(meal.fat_g)) : "-"}</td>
      <td data-label="Fibre">${meal.fibre_g ? escapeHtml(grams(meal.fibre_g)) : "-"}</td>
      <td data-label="Sodium">${milligrams(meal.sodium_mg)}</td>
      <td data-label="Confidence">${percent(meal.confidence)}</td>
      <td data-label="Source">${escapeHtml(meal.source || "-")}</td>
      <td class="nutrition-note-cell" data-label="Notes"><span title="${escapeHtml(noteText(meal))}">${escapeHtml(noteText(meal))}</span></td>
    </tr>
  `).join("");
}

function renderMeals(days) {
  const container = document.getElementById("nutritionMeals");
  if (!days.length) {
    container.innerHTML = `<div class="empty-state">Meal-level nutrition will appear here after rows are added to the Nutrition tab.</div>`;
    return;
  }
  container.innerHTML = days.map((day, index) => `
    <details class="calendar-phase-group nutrition-day-group" ${index === 0 ? "open" : ""}>
      <summary>
        <span>${escapeHtml(prettyDate(day.date))}</span>
        <strong>${escapeHtml(kcal(day.calories))} · ${escapeHtml(grams(day.protein_g))} protein · ${escapeHtml(day.meal_count || day.meals?.length || 0)} meals</strong>
      </summary>
      <div class="activity-table-scroll">
        <table class="activity-table nutrition-table">
          <thead>
            <tr>
              <th>Meal</th>
              <th>Food item</th>
              <th>Calories</th>
              <th>Protein</th>
              <th>Carbs</th>
              <th>Fat</th>
              <th>Fibre</th>
              <th>Sodium</th>
              <th>Confidence</th>
              <th>Source</th>
              <th>Assumptions / notes</th>
            </tr>
          </thead>
          <tbody>${mealRows(day.meals || [])}</tbody>
        </table>
      </div>
    </details>
  `).join("");
}

function setupReturnTop() {
  const button = document.getElementById("returnTop");
  if (!button) return;
  button.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  window.addEventListener("scroll", () => {
    button.classList.toggle("show", window.scrollY > 500);
  }, { passive: true });
}

function scrollToHashTarget() {
  const id = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : "";
  const target = id ? document.getElementById(id) : null;
  if (!target) return;
  window.requestAnimationFrame(() => {
    target.scrollIntoView({ block: "start" });
  });
}

function render(payload) {
  renderSummary(payload.nutrition);
  renderCalendar(payload.nutrition.days, payload.supplements.days);
  renderMeals(payload.nutrition.days);
  scrollToHashTarget();
}

setupReturnTop();

Promise.all([loadNutrition(), loadSupplements()])
  .then(([nutrition, supplements]) => render({ nutrition, supplements }))
  .catch((error) => {
    console.error(error);
    document.getElementById("nutritionStatus").textContent = "Nutrition unavailable";
    document.getElementById("nutritionCalendar").innerHTML = `<div class="empty-state">Unable to load nutrition calendar.</div>`;
    document.getElementById("nutritionMeals").innerHTML = `<div class="empty-state">Unable to load meal-level nutrition data.</div>`;
  });
