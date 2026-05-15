const NUTRITION_DATA_URL = "data/nutrition.json";
const MOCK_NUTRITION_DATA_URL = "data/mock-nutrition.json";

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
  status.textContent = payload.loaded_from === "google-sheet" ? "Google Sheet nutrition" : "Mock nutrition";
  syncStatus.textContent = `${payload.loaded_from === "google-sheet" ? "Google Sheet" : "Mock"} nutrition loaded · ${payload.days.length} day${payload.days.length === 1 ? "" : "s"}`;
  container.innerHTML = `
    <article class="week-metric"><span>Latest date</span><strong>${escapeHtml(day ? prettyDate(day.date) : "-")}</strong></article>
    <article class="week-metric"><span>Latest calories</span><strong>${escapeHtml(latestCalories)}</strong></article>
    <article class="week-metric"><span>Latest protein</span><strong>${escapeHtml(latestProtein)}</strong></article>
    <article class="week-metric"><span>7-day calories</span><strong>${escapeHtml(avgCalories)}</strong></article>
    <article class="week-metric"><span>7-day protein</span><strong>${escapeHtml(avgProtein)}</strong></article>
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

function renderDailyTable(days) {
  const container = document.getElementById("nutritionDaily");
  if (!days.length) {
    container.innerHTML = `<div class="empty-state">No nutrition rows have been synced yet. Add meal rows to the Nutrition tab, then run the sync workflow.</div>`;
    return;
  }
  const rows = days.map((day) => `
    <tr>
      <td><strong>${escapeHtml(prettyDate(day.date))}</strong></td>
      <td>${progressCell(day.calories, day.calorie_target, kcal)}</td>
      <td>${progressCell(day.protein_g, day.protein_target_g, grams)}</td>
      <td>${escapeHtml(grams(day.carbs_g))}</td>
      <td>${escapeHtml(grams(day.fat_g))}</td>
      <td>${Number(day.fibre_g || 0) ? escapeHtml(grams(day.fibre_g)) : "-"}</td>
      <td>${milligrams(day.sodium_mg)}</td>
      <td>${day.seven_day_average_calories ? escapeHtml(kcal(day.seven_day_average_calories)) : "-"}</td>
      <td>${day.seven_day_average_protein_g ? escapeHtml(grams(day.seven_day_average_protein_g)) : "-"}</td>
      <td>${percent(day.confidence)}</td>
      <td>${escapeHtml(day.assumptions || day.notes || "-")}</td>
    </tr>
  `).join("");
  container.innerHTML = `
    <div class="activity-table-scroll">
      <table class="activity-table nutrition-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Calories</th>
            <th>Protein</th>
            <th>Carbs</th>
            <th>Fat</th>
            <th>Fibre</th>
            <th>Sodium</th>
            <th>7-day kcal</th>
            <th>7-day protein</th>
            <th>AI confidence</th>
            <th>Assumptions / notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function mealRows(meals) {
  return meals.map((meal) => `
    <tr>
      <td>${escapeHtml(meal.meal || "Unspecified")}</td>
      <td><strong>${escapeHtml(meal.food_item || "-")}</strong></td>
      <td>${meal.calories ? escapeHtml(kcal(meal.calories)) : "-"}</td>
      <td>${meal.protein_g ? escapeHtml(grams(meal.protein_g)) : "-"}</td>
      <td>${meal.carbs_g ? escapeHtml(grams(meal.carbs_g)) : "-"}</td>
      <td>${meal.fat_g ? escapeHtml(grams(meal.fat_g)) : "-"}</td>
      <td>${meal.fibre_g ? escapeHtml(grams(meal.fibre_g)) : "-"}</td>
      <td>${milligrams(meal.sodium_mg)}</td>
      <td>${percent(meal.confidence)}</td>
      <td>${escapeHtml(meal.source || "-")}</td>
      <td>${escapeHtml(meal.assumptions || meal.notes || "-")}</td>
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

function render(payload) {
  renderSummary(payload);
  renderDailyTable(payload.days);
  renderMeals(payload.days);
}

setupReturnTop();

loadNutrition()
  .then(render)
  .catch((error) => {
    console.error(error);
    document.getElementById("nutritionStatus").textContent = "Nutrition unavailable";
    document.getElementById("nutritionDaily").innerHTML = `<div class="empty-state">Unable to load nutrition data.</div>`;
    document.getElementById("nutritionMeals").innerHTML = `<div class="empty-state">Unable to load meal-level nutrition data.</div>`;
  });
