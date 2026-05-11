const MARATHON_KM = 42.195;
const DEFAULT_SPLITS = [5, 10, 15, 20, 21.1, 25, 30, 35, 40, MARATHON_KM];

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDuration(totalSeconds) {
  const rounded = Math.max(Math.round(Number(totalSeconds || 0)), 0);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function formatPace(secondsPerKm) {
  return `${formatDuration(secondsPerKm)} /km`;
}

function calculatorValues(form) {
  const data = new FormData(form);
  const hours = Number(data.get("hours") || 0);
  const minutes = Number(data.get("minutes") || 0);
  const seconds = Number(data.get("seconds") || 0);
  const distance = Number(data.get("distance") || MARATHON_KM);
  const totalSeconds = Math.max((hours * 3600) + (minutes * 60) + seconds, 1);
  return {
    distance: Math.max(distance, 1),
    totalSeconds
  };
}

function renderSplitTable(secondsPerKm, distance) {
  const table = document.getElementById("splitTable");
  const splitRows = DEFAULT_SPLITS
    .filter((split) => split <= distance)
    .map((split) => {
      return `
        <tr>
          <td>${split === MARATHON_KM ? "Finish" : `${split.toFixed(split % 1 ? 1 : 0)} km`}</td>
          <td><strong>${formatDuration(split * secondsPerKm)}</strong></td>
          <td>${formatPace(secondsPerKm)}</td>
        </tr>
      `;
    }).join("");

  table.innerHTML = `
    <div class="activity-table-scroll">
      <table class="activity-table split-table">
        <thead>
          <tr>
            <th>Checkpoint</th>
            <th>Cumulative</th>
            <th>Pace</th>
          </tr>
        </thead>
        <tbody>${splitRows}</tbody>
      </table>
    </div>
  `;
}

function updateCalculator() {
  const form = document.getElementById("paceCalculator");
  const result = document.getElementById("paceResult");
  if (!form || !result) return;

  const { distance, totalSeconds } = calculatorValues(form);
  const secondsPerKm = totalSeconds / distance;
  result.innerHTML = `
    <div class="week-metric"><span>Estimated finish</span><strong>${formatDuration(totalSeconds)}</strong></div>
    <div class="week-metric"><span>Average pace</span><strong>${formatPace(secondsPerKm)}</strong></div>
    <div class="week-metric"><span>Halfway</span><strong>${formatDuration((distance / 2) * secondsPerKm)}</strong></div>
  `;
  renderSplitTable(secondsPerKm, distance);
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
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("paceCalculator")?.addEventListener("input", updateCalculator);
  setupReturnTop();
  setupActiveNav();
  updateCalculator();
});
