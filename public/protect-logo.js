// Deterrent: logo and seal images show as a 10 x 10 placeholder in the page source and the Elements tab,
// and the real logo is drawn as a CSS background. Also blocks right-click save, drag and selection.
// A determined user can still reach the real image through the browser's network tools.
(function () {
  var RX = /logo|seal/i;
  var PH = '/images/blank-10x10.png';
  var store = new WeakMap();
  function isLogo(el) { return el && el.tagName === 'IMG' && (store.has(el) || RX.test(el.getAttribute('src') || '')); }
  function mark() {
    document.querySelectorAll('img').forEach(function (img) {
      var src = img.getAttribute('src') || '';
      var real = store.get(img);
      if (!real) {
        if (!RX.test(src) || src === PH) return;
        real = src;
        store.set(img, real);
      }
      img.setAttribute('draggable', 'false');
      img.style.userSelect = 'none';
      img.style.webkitUserSelect = 'none';
      img.style.webkitTouchCallout = 'none';
      img.style.backgroundImage = 'url("' + real + '")';
      img.style.backgroundSize = 'contain';
      img.style.backgroundRepeat = 'no-repeat';
      img.style.backgroundPosition = 'center';
      if (src !== PH) img.setAttribute('src', PH);
    });
  }
  document.addEventListener('contextmenu', function (e) { if (isLogo(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { if (isLogo(e.target)) e.preventDefault(); });
  document.addEventListener('selectstart', function (e) { if (isLogo(e.target)) e.preventDefault(); });
  function start() {
    mark();
    new MutationObserver(function () { mark(); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
