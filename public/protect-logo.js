// Deterrent only: stops the right-click menu, dragging and selection on logo/seal images.
// A determined user can still reach the image through the browser tools.
(function () {
  var RX = /logo|seal/i;
  function isLogo(el) { return el && el.tagName === 'IMG' && RX.test(el.getAttribute('src') || ''); }
  function mark(root) {
    (root || document).querySelectorAll('img').forEach(function (img) {
      if (!RX.test(img.getAttribute('src') || '')) return;
      img.setAttribute('draggable', 'false');
      img.style.userSelect = 'none';
      img.style.webkitUserSelect = 'none';
      img.style.webkitTouchCallout = 'none';
    });
  }
  document.addEventListener('contextmenu', function (e) { if (isLogo(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { if (isLogo(e.target)) e.preventDefault(); });
  document.addEventListener('selectstart', function (e) { if (isLogo(e.target)) e.preventDefault(); });
  function start() {
    mark();
    new MutationObserver(function () { mark(); }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
