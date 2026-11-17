/* Every search box in the portal searches when Enter is pressed (the same as typing). */
(function () {
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target || e.target.tagName !== 'INPUT') return;
    var t = e.target;
    var idAndClass = ((t.id || '') + ' ' + (t.className || '') + ' ' + (t.placeholder || '') + ' ' + (t.name || '')).toLowerCase();
    var looksLikeSearch = t.type === 'search' || /search|sr-q|find|\bq\b|studentsearch|gradesearch|viewstudentsearch|g-sn|regsubjsearch/i.test(idAndClass);
    if (!looksLikeSearch) return;
    e.preventDefault();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
  });
})();
