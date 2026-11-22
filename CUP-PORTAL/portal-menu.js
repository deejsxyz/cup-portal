// Shared by the CUP Portal pages. On narrow screens the green navigation bar shows only
// the date and time (left) and a hamburger button (right). The hamburger opens a menu
// from the left side that holds the page's navigation buttons, the user name and Log Out.
// On wide screens the page is left exactly as it was.
(function () {
  var mq = window.matchMedia('(max-width: 900px)');
  var CSS = [
    '.pm-bar{display:none;align-items:center;justify-content:flex-start;gap:10px;padding:3px 14px;background:#0f4d12;color:#fff;width:100%;}',
    '.pm-college{color:#fff;font-weight:800;font-size:14px;letter-spacing:.06em;white-space:nowrap;}',
    '.pm-college:empty{display:none;}',
    '.pm-bar .live-clock{position:static !important;display:block !important;margin:0 !important;bottom:auto !important;right:auto !important;width:auto !important;text-align:right !important;white-space:normal;max-width:64%;color:#fff !important;font-size:11px !important;line-height:1.2 !important;min-width:0;margin-left:auto !important;}',
    '.pm-burger{display:flex;flex-direction:column;justify-content:center;gap:4px;width:34px;height:26px;padding:0;margin-left:0;background:transparent;border:0;cursor:pointer;flex:0 0 auto;align-items:flex-start;}',
    '.pm-burger span{display:block;width:24px;height:2.5px;border-radius:2px;background:#fff;}',
    '.pm-home-link{display:block;color:#fff;font-weight:700;text-decoration:none;padding:8px 10px;letter-spacing:.04em;}',
    '.pm-drawer{position:fixed;top:0;bottom:0;left:0;width:min(300px,85vw);background:#0f4d12;color:#fff;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;transform:translateX(-105%);transition:transform .2s ease;z-index:1000;box-shadow:4px 0 16px rgba(0,0,0,.35);}',
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
    '.pm-drawer nav.colleges{display:flex !important;flex-direction:column !important;gap:8px !important;}',
    '.pm-drawer nav.colleges button{width:100%;margin:0 !important;text-align:left;}',
    '.pm-drawer #acctDrop{position:static !important;box-shadow:none !important;margin-top:6px;min-width:0 !important;}',
    '.pm-drawer #acctDrop a, .pm-drawer #acctDrop button{box-sizing:border-box !important;width:100%;font-size:14px;}',
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
    var who = document.getElementById('acctMenu') || document.getElementById('who') || document.getElementById('whoName') || document.getElementById('userName');
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
    // Pages can set data-home on the header to add a HOME link at the top of the menu, above the page sections.
    var homeHref = header.getAttribute('data-home');
    if (homeHref) {
      var home = document.createElement('a');
      home.className = 'pm-home-link';
      home.href = homeHref;
      home.textContent = 'HOME';
      drawer.appendChild(home);
    }
    if (nav) drawer.appendChild(nav);
    if (logout) drawer.appendChild(logout);

    var scrim = document.createElement('div');
    scrim.className = 'pm-scrim';

    // Pages with a logo at the left leave room so the hamburger sits to the right of it.
    // Pages with a logo at the left: line the hamburger up with the left edge of the page title.
    function alignBar() {
      if (!header.querySelector('.seal')) return;
      var nm = header.querySelector('.top .name');
      var left = 116;
      if (nm) left = Math.max(0, Math.round(nm.getBoundingClientRect().left - header.getBoundingClientRect().left));
      // Nudge 10px left so the hamburger lines up with the title text.
      bar.style.paddingLeft = Math.max(0, left - 10) + 'px';
    }
    alignBar();
    window.addEventListener('resize', alignBar);
    window.addEventListener('load', alignBar);
    // The title font can load after the page, which moves the title; re-align when that happens.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(alignBar);
    var titleEl = header.querySelector('.top .name');
    if (titleEl && window.ResizeObserver) new ResizeObserver(alignBar).observe(titleEl);
    // Keep re-checking for a few seconds in case the header settles after load.
    var alignTries = 0;
    var alignTimer = setInterval(function () { alignBar(); if (++alignTries > 15) clearInterval(alignTimer); }, 200);
    bar.appendChild(burger);
    // Shows the abbreviation of the college that is open (set by the page), right after the hamburger.
    var collegeTag = document.createElement('span');
    collegeTag.id = 'pmCollege';
    collegeTag.className = 'pm-college';
    bar.appendChild(collegeTag);
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
    // Capture phase, so it still runs when the page's own handlers stop the click (the college buttons do).
    drawer.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button[data-panel], a, nav.colleges button') : null;
      if (t) setTimeout(shut, 0);
    }, true);

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
