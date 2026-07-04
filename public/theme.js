/* Shared dark-mode + language toggle.
 * Usage: define window.PAGE_I18N = { he: {...}, en: {...} } BEFORE this script
 * to enable the language button; omit it for dark-mode-only pages.
 * Elements opt in with data-i18n="key" (textContent) / data-i18n-ph="key" (placeholder).
 * Dynamic strings: window.t("key"). Re-render on the "langchange" window event.
 */
(function () {
  // Apply theme immediately to avoid a light flash before DOM ready
  let theme = localStorage.getItem("theme") || "light";
  document.documentElement.classList.toggle("dark", theme === "dark");

  let lang = localStorage.getItem("lang") || "he";
  const hasI18N = () => !!window.PAGE_I18N;

  window.getLang = () => (hasI18N() ? lang : "he");
  window.t = (key) => {
    const dict = hasI18N() ? window.PAGE_I18N[lang] || {} : {};
    return dict[key] !== undefined ? dict[key] : key;
  };

  function applyLang() {
    if (!hasI18N()) return;
    const dict = window.PAGE_I18N[lang] || {};
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) el.textContent = dict[key];
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      const key = el.getAttribute("data-i18n-ph");
      if (dict[key] !== undefined) el.placeholder = dict[key];
    });
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
    if (dict.pageTitle) document.title = dict.pageTitle;
    const btn = document.getElementById("themeLangBtn");
    if (btn) btn.textContent = lang === "he" ? "EN" : "עב";
    window.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
  }

  function applyTheme() {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const btn = document.getElementById("themeDarkBtn");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  }

  window.toggleTheme = function () {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", theme);
    applyTheme();
  };

  window.toggleLang = function () {
    lang = lang === "he" ? "en" : "he";
    localStorage.setItem("lang", lang);
    applyLang();
  };

  document.addEventListener("DOMContentLoaded", function () {
    // Inject floating toolbar unless the page brings its own buttons
    if (!document.getElementById("themeDarkBtn")) {
      const bar = document.createElement("div");
      bar.className = "theme-toolbar";
      let html = '<button id="themeDarkBtn" class="theme-tool-btn" onclick="toggleTheme()">🌙</button>';
      if (hasI18N()) html += '<button id="themeLangBtn" class="theme-tool-btn" onclick="toggleLang()">EN</button>';
      bar.innerHTML = html;
      document.body.appendChild(bar);
    }
    applyTheme();
    applyLang();
  });
})();
