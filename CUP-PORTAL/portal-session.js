// Shared by every CUP Portal page that needs a login.
// 1. Logs the user out after 5 minutes with no activity on the page.
// 2. Logs the user out when the tab or browser was closed: each login sets a
//    flag in this tab's sessionStorage, and closing the tab clears it. A page
//    opened with no flag is treated as a new visit, so the user must log in again.
// Refreshing the page keeps the flag, so a refresh does not log anyone out.
(function () {
  var KEY = 'cupPortalTab';
  var me = document.currentScript;
  var logoutUrl = me.getAttribute('data-logout');
  var loginUrl = me.getAttribute('data-login');
  var reloadOnEnd = me.getAttribute('data-expire') === 'reload';
  var IDLE_MS = 5 * 60 * 1000;

  function tabHasFlag() {
    try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return true; }
  }

  function endSession() {
    var finish = function () {
      if (reloadOnEnd) {
        // Stay on this page; it will show its login form because the session is gone.
        try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
        window.location.reload();
      } else {
        window.location.replace(loginUrl);
      }
    };
    fetch(logoutUrl, { method: 'POST', credentials: 'same-origin', keepalive: true }).then(finish, finish);
  }

  if (!tabHasFlag()) { endSession(); return; }

  var timer = null;
  function resetIdle() {
    clearTimeout(timer);
    timer = setTimeout(endSession, IDLE_MS);
  }
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(function (ev) {
    document.addEventListener(ev, resetIdle, { passive: true });
  });
  resetIdle();
})();
