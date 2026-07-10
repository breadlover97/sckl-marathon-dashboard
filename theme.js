(function () {
  const storageKey = "sckl-dashboard-theme";
  const themes = ["light", "dark", "editor", "cyberpunk", "glass"];
  const themeLabels = {
    light: "Classic",
    dark: "Night",
    editor: "Focus",
    cyberpunk: "Neon",
    glass: "Glass"
  };
  const themeColors = {
    light: "#f4f7fb",
    dark: "#080d14",
    editor: "#07111c",
    cyberpunk: "#0b0812",
    glass: "#eaf2f8"
  };
  const trainingStartDate = "2026-05-11";
  const raceDate = "2026-10-04";
  const totalTrainingWeeks = 21;

  function utcDateValue(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  }

  function singaporeDateKey() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Singapore",
      year: "numeric"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function setupRaceCountdown() {
    const countdown = document.getElementById("raceCountdown");
    if (!countdown) return;
    const dayMs = 24 * 60 * 60 * 1000;
    const start = utcDateValue(trainingStartDate);
    const race = utcDateValue(raceDate);
    const today = utcDateValue(singaporeDateKey());
    const totalDays = Math.round((race - start) / dayMs) + 1;
    const currentDay = Math.min(Math.max(Math.round((today - start) / dayMs) + 1, 1), totalDays);
    const currentWeek = Math.min(Math.floor((currentDay - 1) / 7) + 1, totalTrainingWeeks);
    countdown.textContent = `Day ${currentDay} of ${totalDays} · Week ${currentWeek} of ${totalTrainingWeeks}`;
  }

  function preferredTheme() {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === "midnight") return "cyberpunk";
      if (themes.includes(saved)) return saved;
    } catch (error) {
      return "light";
    }
    return "light";
  }

  function showToast(message) {
    const region = document.querySelector("[data-toast-region]");
    if (!region || !message) return;
    const toast = document.createElement("div");
    toast.className = "feedback-toast";
    toast.textContent = message;
    region.replaceChildren(toast);
    window.requestAnimationFrame(() => toast.classList.add("visible"));
    window.setTimeout(() => {
      toast.classList.remove("visible");
      window.setTimeout(() => toast.remove(), 200);
    }, 2400);
  }

  function applyTheme(theme, announce = false) {
    const nextTheme = themes.includes(theme) ? theme : "light";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme === "light" || nextTheme === "glass" ? "light" : "dark";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[nextTheme]);
    try {
      window.localStorage.setItem(storageKey, nextTheme);
    } catch (error) {
      // Theme persistence is optional; the visual change still applies.
    }
    if (announce) showToast(`${themeLabels[nextTheme]} appearance applied`);
  }

  function setupNavigation() {
    const toggle = document.querySelector("[data-nav-toggle]");
    const menu = document.querySelector("[data-nav-menu]");
    const scrim = document.querySelector("[data-nav-scrim]");
    if (!toggle || !menu || !scrim) return;

    const close = ({ restoreFocus = false } = {}) => {
      toggle.setAttribute("aria-expanded", "false");
      menu.classList.remove("is-open");
      scrim.classList.remove("visible");
      document.body.classList.remove("nav-open");
      window.setTimeout(() => {
        if (!menu.classList.contains("is-open")) scrim.hidden = true;
      }, 180);
      if (restoreFocus) toggle.focus();
    };

    const open = () => {
      scrim.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      menu.classList.add("is-open");
      document.body.classList.add("nav-open");
      window.requestAnimationFrame(() => scrim.classList.add("visible"));
      menu.querySelector("a, select, button")?.focus({ preventScroll: true });
    };

    toggle.addEventListener("click", () => {
      if (toggle.getAttribute("aria-expanded") === "true") close({ restoreFocus: true });
      else open();
    });
    scrim.addEventListener("click", () => close({ restoreFocus: true }));
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a")) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menu.classList.contains("is-open")) close({ restoreFocus: true });
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 860 && menu.classList.contains("is-open")) close();
    });
  }

  function setupSectionNavigation() {
    const links = Array.from(document.querySelectorAll(".nav-tabs a[href^='#']"));
    const sections = links
      .map((link) => document.querySelector(link.getAttribute("href")))
      .filter(Boolean);
    if (!links.length || !sections.length) return;

    const update = () => {
      const marker = window.scrollY + (document.querySelector(".top-nav")?.offsetHeight || 0) + 120;
      let active = sections[0];
      sections.forEach((section) => {
        if (section.offsetTop <= marker) active = section;
      });
      links.forEach((link) => {
        const isActive = link.getAttribute("href") === `#${active.id}`;
        link.classList.toggle("active", isActive);
        if (isActive) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  applyTheme(preferredTheme());

  window.addEventListener("DOMContentLoaded", () => {
    setupRaceCountdown();
    document.querySelectorAll("[data-theme-select]").forEach((select) => {
      select.value = document.documentElement.dataset.theme || "light";
      select.addEventListener("change", (event) => applyTheme(event.target.value, true));
    });
    setupNavigation();
    setupSectionNavigation();
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[target='_blank']");
      if (!link) return;
      showToast(link.dataset.feedbackMessage || "Opening link in a new tab");
    });
  });
}());
