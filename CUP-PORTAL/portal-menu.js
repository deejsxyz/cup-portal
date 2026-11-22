// Shared by the CUP Portal pages. On narrow screens the green navigation bar shows only
// the date and time (left) and a hamburger button (right). The hamburger opens a menu
// from the left side that holds the page's navigation buttons, the user name and Log Out.
// On wide screens the page is left exactly as it was.
(function () {
  var mq = window.matchMedia('(max-width: 900px)');
  var CSS = [
    '.pm-bar{display:none;align-items:center;justify-content:space-between;gap:10px;padding:8px 14px;background:#0f4d12;color:#fff;min-height:44px;width:100%;}',
    '.pm-bar .live-clock{position:static !important;display:block !important;margin:0 !important;bottom:auto !important;right:auto !important;width:auto !important;text-align:right !important;white-space:normal;color:#fff !important;font-size:11px !important;}',
    '.pm-burger{display:flex;flex-direction:column;justify-content:center;gap:5px;width:44px;height:40px;padding:9px;margin-left:0;background:transparent;border:0;cursor:pointer;flex:0 0 auto;}',
    '.pm-burger span{display:block;height:3px;border-radius:2px;background:#fff;}',
    '.pm-drawer{position:fixed;top:0;bottom:0;left:0;width:min(300px,85vw);background:#0f4d12;color:#fff;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;transform:translateX(-105%);transition:transform .2s ease;z-index:1000;box-shadow:4px 0 16px rgba(0,0,0,.35);}',
    '.pm-drawer.open{transform:none;}',
    '.pm-scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .2s;z-index:999;}',
    '.pm-scrim.open{opacity:1;pointer-events:auto;}',
    '.pm-head{display:flex;justify-content:space-between;align-items:center;}',
    '.pm-head strong{font-size:15px;letter-spacing:.04em;text-transform:uppercase;}',
    '.pm-close{background:none;border:0;color:#fff;font-size:30px;line-height:1;cursor:pointer;padding:0 4px;}',
    '.pm-drawer .pm-who{font-weight:700;font-size:14px;color:#fff;}',
    '.pm-drawer .pm-who:empty{display:none !important;}',
    '.pm-drawer nav, .pm-drawer .nav{position:static !important;background:none !important;padding:0 !important;height:auto !important;display:block !important;box-shadow:none !important;}',
    '.pm-drawer .tabs, .pm-drawer nav > div{display:flex !important;flex-direction:column !important;align-items:stretch !important;gap:6px !important;}',
    '.pm-drawer .tabs > *, .pm-drawer nav > a, .pm-drawer nav > button{width:100%;text-align:left;}',
    '.pm-drawer nav a{display:block;color:#fff;text-decoration:none;padding:8px 10px;}',
    '.pm-drawer button{width:100%;text-align:left;}',
    '.pm-drawer .logout, .pm-drawer #logout{text-align:center;}',
    '.pm-drawer .menu .dd{position:static !important;box-shadow:none !important;border:0 !important;min-width:0 !important;background:none !important;padding:0 0 0 12px !important;}',
    '.pm-drawer .menu .dd.open{display:flex !important;flex-direction:column !important;gap:4px !important;}',
    '.pm-drawer .menu .dd button{background:rgba(255,255,255,.08) !important;color:#fff !important;}',
    '.pm-drawer .menu > .tab{display:block !important;width:100%;position:relative;padding-right:34px !important;text-align:left;}',
    '.pm-drawer .menu > .tab::after{content:"\\25BE";position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:14px;transition:transform .15s ease;}',
    '.pm-drawer .menu > .tab[aria-expanded="true"]::after{transform:translateY(-50%) rotate(180deg);}'
  ].join('\n');

  function init() {
    var header = document.querySelector('header');
    if (!header) return;
    var nav = header.querySelector('nav');
    var logout = document.getElementById('logout');
    var clock = document.getElementById('liveClock');
    var who = document.getElementById('who') || document.getElementById('whoName') || document.getElementById('userName');
    if (!nav && !logout) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Remember where each piece lived so the desktop layout can be put back exactly.
    var moved = [];
    function remember(el) { if (el) moved.push({ el: el, parent: el.parentNode, next: el.nextSibling }); }
    [nav, logout, clock, who].forEach(remember);

    var bar = document.createElement('div');
    bar.className = 'pm-bar';
    var burger = document.createElement('button');
    burger.type = 'button';
    burger.className = 'pm-burger';
    burger.setAttribute('aria-label', 'Open menu');
    burger.setAttribute('aria-expanded', 'false');
    burger.innerHTML = '<span></span><span></span><span></span>';

    var drawer = document.createElement('div');
    drawer.className = 'pm-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    var head = document.createElement('div');
    head.className = 'pm-head';
    head.innerHTML = '<strong>Menu</strong>';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pm-close';
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.textContent = '×';
    head.appendChild(closeBtn);
    drawer.appendChild(head);
    if (who) { who.classList.add('pm-who'); drawer.appendChild(who); }
    if (nav) drawer.appendChild(nav);
    if (logout) drawer.appendChild(logout);

    var scrim = document.createElement('div');
    scrim.className = 'pm-scrim';

    // Pages with a logo at the left leave room so the hamburger sits to the right of it.
    if (header.querySelector('.seal')) bar.style.paddingLeft = '116px';
    bar.appendChild(burger);
    if (clock) bar.appendChild(clock);
    header.appendChild(bar);
    document.body.appendChild(drawer);
    document.body.appendChild(scrim);

    function open() {
      drawer.classList.add('open'); scrim.classList.add('open');
      burger.setAttribute('aria-expanded', 'true'); drawer.setAttribute('aria-hidden', 'false');
    }
    function shut() {
      drawer.classList.remove('open'); scrim.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false'); drawer.setAttribute('aria-hidden', 'true');
    }
    burger.addEventListener('click', open);
    closeBtn.addEventListener('click', shut);
    scrim.addEventListener('click', shut);
    // Choosing a page section closes the menu so the section is visible.
    drawer.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button[data-panel], a') : null;
      if (t) setTimeout(shut, 0);
    });

    function restore() {
      moved.forEach(function (m) {
        if (!m.el || !m.parent) return;
        m.parent.insertBefore(m.el, m.next && m.next.parentNode === m.parent ? m.next : null);
      });
    }
    function apply() {
      if (mq.matches) {
        bar.style.display = 'flex';
        if (clock) bar.appendChild(clock);
        if (nav) drawer.insertBefore(nav, logout && logout.parentNode === drawer ? logout : null);
        if (logout) drawer.appendChild(logout);
        if (who) drawer.insertBefore(who, drawer.children[1] || null);
      } else {
        shut();
        bar.style.display = 'none';
        restore();
      }
    }
    mq.addEventListener ? mq.addEventListener('change', apply) : mq.addListener(apply);
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
