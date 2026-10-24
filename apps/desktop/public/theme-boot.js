/* global document */
// Applies the saved theme before the first paint (no flash on startup).
// External file because the Tauri CSP forbids inline scripts. Mirrors parseTheme() in src/theme.ts.
(function () {
  var root = document.documentElement;
  var themes = { 'glass-dark': 'dark', 'glass-light': 'light', 'glass-cyberpunk': 'dark' };
  var theme = 'glass-dark';
  var reduced = false;
  try {
    var saved = localStorage.getItem('hermes.theme');
    if (saved && Object.prototype.hasOwnProperty.call(themes, saved)) theme = saved;
    else if (saved === 'light') theme = 'glass-light';
    reduced = localStorage.getItem('hermes.reducedTransparency') === '1';
  } catch {
    /* storage unavailable: default theme */
  }
  root.dataset.theme = theme;
  root.style.colorScheme = themes[theme];
  if (reduced) root.dataset.transparency = 'reduced';
})();
