/**
 * Frontend Security & Code Protection Module
 * Disables inspection, right-click, keyboard shortcuts, console output, and anti-debugging traps.
 */
(function () {
  'use strict';

  // 1. Disable Right-Click Context Menu
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  }, false);

  // 2. Disable Keyboard Shortcuts (F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, Ctrl+U, Ctrl+S)
  document.addEventListener('keydown', function (e) {
    // F12 key
    if (e.keyCode === 123) {
      e.preventDefault();
      return false;
    }
    // Ctrl+Shift+I (Inspect element), Ctrl+Shift+J (Console), Ctrl+Shift+C (Element picker)
    if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) {
      e.preventDefault();
      return false;
    }
    // Ctrl+U (View Source) and Ctrl+S (Save Page)
    if (e.ctrlKey && (e.keyCode === 85 || e.keyCode === 83)) {
      e.preventDefault();
      return false;
    }
  }, false);

  // 3. Override Console Logging to prevent inspection via Console tab
  (function () {
    const emptyFn = function () {};
    window.console.log = emptyFn;
    window.console.warn = emptyFn;
    window.console.error = emptyFn;
    window.console.debug = emptyFn;
    window.console.info = emptyFn;
  })();

  // 4. Anti-Debugging Loop: Freezes DevTools if opened by an inspector
  setInterval(function () {
    const start = performance.now();
    (function () {}['constructor']('debugger')());
    const end = performance.now();
    if (end - start > 100) {
      document.body.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0f172a;color:#ef4444;font-family:sans-serif;font-size:24px;font-weight:bold;">Security Warning: Inspection / Developer Tools Access Denied.</div>';
    }
  }, 1000);
})();
