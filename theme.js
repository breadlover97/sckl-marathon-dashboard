(function () {
  const storageKey = "sckl-dashboard-theme";
  const themes = ["light", "dark", "editor", "cyberpunk"];

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

  function applyTheme(theme) {
    const nextTheme = themes.includes(theme) ? theme : "light";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme === "light" ? "light" : "dark";
    try {
      window.localStorage.setItem(storageKey, nextTheme);
    } catch (error) {
      // Theme persistence is optional; the visual change still applies.
    }
  }

  applyTheme(preferredTheme());

  window.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-theme-select]").forEach((select) => {
      select.value = document.documentElement.dataset.theme || "light";
      select.addEventListener("change", (event) => applyTheme(event.target.value));
    });
  });
}());
