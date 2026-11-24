/* Shared Copy of Grades builder: the student's printed copy and the /verify-document page use this same code,
   so the verification page is laid out exactly like the printout. */
(function () {
  var profile = null, retentionLabel = '';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var PROG_ABBR = function (p) { var m = /\(([^)]+)\)\s*$/.exec(p || ''); return m ? m[1] : (p || ''); };
  function termLabel(t) { return String(t || '').replace(/^1st\b/, 'First').replace(/^2nd\b/, 'Second'); }
  var COLLEGE_NAMES = {
    COACS: 'College of Office Administration and Computer Studies', CAS: 'College of Arts and Sciences', CONM: 'College of Nursing and Midwifery',
    COED: 'College of Education', COBM: 'College of Business and Management', LAW: 'School of Law', GS: 'Graduate School', 'TESDA-TVI': 'TESDA-TVI'
  };
  var COLLEGE_LOGO_PATHS = {
    COACS: '/images/college-oact.png', CAS: '/images/college-arts.png', CONM: '/images/college-nursing.png',
    COED: '/images/college-education.png', COBM: '/images/college-business.png', LAW: '/images/college-law.png',
    GS: '/images/college-graduate.png', 'TESDA-TVI': '/images/tesda-logo.png'
  };
  var DOC_CSS = {
    copy: '@page{size:A4 portrait;margin:0.25in}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000}' +
      '.sheet{position:relative;width:calc(210mm - 0.5in);height:calc(297mm - 0.5in - 10mm);box-sizing:border-box;padding:5mm 9mm 4mm;font-size:8pt;line-height:1.2;overflow:hidden;page-break-after:always;break-after:page}' +
      '.sheet:last-child{page-break-after:auto;break-after:auto}' +
      '.hdr{display:flex;align-items:center;justify-content:center;gap:2mm;text-align:center}.hdr img{width:13mm;height:13mm;object-fit:contain}' +
      '@font-face{font-family:"CUP Courier";src:url(/CUP-PORTAL/fonts/courier-new.ttf) format("truetype")}@font-face{font-family:"CUP Algerian";src:url(/CUP-PORTAL/fonts/algerian.ttf) format("truetype")}@font-face{font-family:"CUP Script";src:url(/CUP-PORTAL/fonts/script-mt-bold.ttf) format("truetype")}.u1{font-family:"CUP Algerian",Algerian,serif;font-size:10pt;font-weight:bold;color:#000}.u2{font-size:6.5pt;color:#000}.c1{font-family:"CUP Script","Script MT Bold",cursive;font-size:14pt;font-weight:normal;font-style:normal;color:#000;margin-top:0.5mm}.addr{font-size:6pt;color:#000}' +
      '.title{text-align:center;font-weight:bold;font-size:10pt;text-decoration:underline;margin:2.5mm 0 5mm}' +
      '.info{display:grid;grid-template-columns:1fr 1fr;column-gap:10mm;row-gap:0.8mm;font-size:7pt;line-height:1.25;grid-auto-flow:column;grid-template-rows:repeat(5,auto);margin-bottom:2mm;font-family:"CUP Courier","Courier New",monospace}.info div{white-space:nowrap;overflow:hidden}.info .k{display:inline-block;width:24mm}.info .kl{display:inline-block;width:16mm}' +
      '.gw{position:relative;overflow:hidden;width:100%}' +
      'table{width:100%;border-collapse:collapse;font-size:7pt;line-height:1;table-layout:fixed;border:0.5pt solid #000}' +
      'th{border-top:0.5pt solid #000;border-bottom:0.5pt solid #000}td{border:0}' +
      'th,td{padding:0 1mm;height:4.4mm;line-height:1;overflow:hidden;white-space:nowrap}th{font-family:Arial,Helvetica,sans-serif;font-size:6pt;font-weight:bold;text-align:center;height:auto;padding:0.8mm 1mm;line-height:1}td{font-family:"CUP Courier","Courier New",monospace}td.c{text-align:center}td.l{text-align:left}' +
      '.wm{position:absolute;inset:0;z-index:10;pointer-events:none;overflow:hidden}.wm-img{position:absolute;inset:0;width:100%;height:100%}' +
      '.wm span{flex:1 1 0;min-height:0;overflow:hidden;display:block;white-space:nowrap;font:bold 6.5pt Arial,Helvetica,sans-serif;line-height:1;color:rgba(0,0,0,.05)}' +
      '.foot{position:absolute;left:9mm;right:9mm;bottom:15mm;display:flex;justify-content:space-between;align-items:flex-end;gap:4mm;font-size:7pt}' +
      '.qr{display:flex;align-items:center;gap:2mm;line-height:1;font-size:7pt;font-family:Arial,Helvetica,sans-serif}.qr img{width:14mm;height:14mm}.vc{font-size:7pt;font-weight:normal;margin-top:0.8mm}' +
      '.tot{min-width:70mm;font-size:6pt;line-height:1;font-family:"CUP Courier","Courier New",monospace}.tot div{font-weight:bold;white-space:nowrap}.tot .tl{display:inline-block;width:42mm}.tot .gpa{margin-top:1.5em}.tot .subj{margin-top:2.5em}' +
      '.disc{margin-top:3mm;font-family:Arial,Helvetica,sans-serif;font-size:6pt;line-height:1;border-top:0.5pt solid #000;padding-top:0.8mm}' +
      '.pf{margin-top:2mm;display:flex;justify-content:space-between;font-family:"CUP Courier","Courier New",monospace;font-size:6pt;font-weight:bold;line-height:1}.bot{margin-top:3mm;overflow:hidden}.botq{float:left}.cert{font-family:Arial,Helvetica,sans-serif;font-size:8pt;line-height:2.1;margin:3mm 0 4mm;text-align:justify}.fl{display:inline-block;border-bottom:0.5pt solid #000;padding:0 1mm;font-weight:bold;line-height:1.1}.cert .fl{display:inline;border-bottom:0;text-decoration:underline;text-decoration-thickness:0.5pt;text-underline-offset:1pt;padding:0 3mm;line-height:inherit}div.cert{line-height:1.25;margin-top:3mm;margin-bottom:6mm}.ret{font-family:"CUP Courier","Courier New",monospace;font-size:7pt;margin-top:1mm}.sigs{overflow:hidden;margin-top:8mm;font-family:Arial,Helvetica,sans-serif;font-size:7.5pt}.sgL{width:88mm;overflow:hidden;float:left}.sgR{width:100mm;overflow:hidden}.sgR{float:right}.pb{margin-bottom:9mm}.cert{font-size:9pt;line-height:2.2}.sigs{font-size:9pt}.sgL,.sgR{width:88mm}.pb{font-weight:bold;font-style:italic;margin-bottom:12mm}.sgn{text-align:center;font-weight:bold;margin-bottom:0.5mm}.ln{border-top:0.5pt solid #000;height:0;margin-bottom:1mm}.lb{text-align:center}.note{font-style:italic;font-size:8pt;margin-top:12mm}.reg .u1{font-size:11pt}.reg .u2{font-size:7pt;font-family:Arial,Helvetica,sans-serif}.reg .hdr img:first-child{position:relative;left:-3mm}.reg .cert{font-family:"CUP Courier","Courier New",monospace;font-size:7.5pt;line-height:2.4}.reg .fl{padding:1.5mm 2mm 0.6mm}.reg .sigs{font-size:6pt}.reg .note{font-size:7pt;font-style:italic}.reg .tot{font-size:7pt;font-weight:bold}.reg .ret{font-size:7pt;font-weight:bold}.reg .cert{font-size:7.5pt;line-height:1.25}.reg .fl{padding:1.5mm 2mm 1mm}.reg .sigs{font-size:8pt}.reg .sgL,.reg .sgR{width:80mm}.reg .ln{width:62mm;margin:0 auto 1mm}.reg .note{font-size:5.5pt;font-style:italic;clear:both;margin-top:8mm}.reg td{font-size:9pt}.reg th{font-size:8pt}.reg .tot{font-size:8pt;font-weight:bold}.reg .ret{font-size:8pt;font-weight:bold}.reg .cert{font-size:8pt;line-height:1}.reg .fl{padding:2.5mm 3mm 1.5mm}.reg .sigs{font-size:9pt}.reg .note{font-size:6pt}.reg .tot .tl{width:56mm}.reg .u1{font-family:Arial,Helvetica,sans-serif;font-size:13pt;font-weight:bold}.reg .u2{font-size:9pt}.reg .title{font-family:Arial,Helvetica,sans-serif;font-size:12pt;font-weight:bold;text-decoration:none}.reg .note{margin-top:19mm}.reg .tot{font-size:9pt;font-weight:bold}.reg .ret{font-size:9pt;font-weight:bold}.reg .hdr{display:block;text-align:center;position:relative;min-height:16mm}.reg .hdr img:first-child{position:absolute;left:-3mm;top:0}.reg .hdr img:last-child:not(:first-child){position:absolute;right:-3mm;top:0}.reg .cert{font-size:9pt;line-height:0.5}.reg .fl{padding:3mm 3mm 2mm}.reg .title{margin:7mm 0 9mm}.reg .note{margin-top:0;padding-top:38mm}.reg .cert{margin:0}.reg .cert{line-height:1.25;margin:3mm 0 6mm}.reg .hdr img:first-child{left:12mm;width:17mm;height:17mm}.tot-flow{float:right;width:max-content;margin:0}.reg td.l+td.l{white-space:normal;height:auto;line-height:1.1;padding:0.6mm 1mm}.reg.sheet{height:calc(297mm - 1.5in - 1mm)}.hdr.cupH{display:block;position:relative;text-align:center;min-height:17mm}.hdr.cupH img{position:absolute;left:10mm;top:0;width:17mm;height:17mm;object-fit:contain}.reg .cert{line-height:1.25}.reg .cert .fl{display:inline-block;border-bottom:0.5pt solid #000;text-decoration:none;padding:0 3mm 0.6mm;line-height:1.1;vertical-align:baseline}.reg .u2{font-size:8pt}',
  };
  // Text and the watermark are drawn as images, so the student number is not text a viewer can turn into a link.
  function textImg(text, px, color, weight) {
    var w = Math.ceil(String(text).length * px * 0.62) + 4, h = Math.ceil(px * 1.3);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><text x="0" y="' + Math.round(px * 0.95) +
      '" font-family="Arial, Helvetica, sans-serif" font-size="' + px + '" font-weight="' + (weight || 'bold') + '" fill="' + (color || '#000') + '">' + esc(text) + '</text></svg>';
    return '<img alt="" style="height:' + h + 'px;width:' + w + 'px;vertical-align:middle" src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '">';
  }
  // Courier New, as an image, so the browser cannot turn the number into a blue phone/number link.
  function courierImg(text, px) {
    var w = Math.ceil(String(text).length * px * 0.6) + 4, h = Math.ceil(px * 1.3);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><text x="0" y="' + Math.round(px * 0.95) +
      '" font-family="Courier New, Courier, monospace" font-size="' + px + '" font-weight="normal" fill="#000">' + esc(text) + '</text></svg>';
    return '<img alt="" style="height:' + h + 'px;width:' + w + 'px;vertical-align:middle" src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '">';
  }
  function wmImg(strip, rows, small, op) {
    var H = rows * 20, W = 1000, lines = '';
    for (var i = 0; i < rows; i++) {
      // Each line starts at a random point, so no line lines up with the one above it.
      lines += '<text x="' + (-Math.round(Math.random() * W * 0.8)) + '" y="' + (i * 20 + 15) + '" font-family="Arial, Helvetica, sans-serif" font-size="' + (small ? 10 : 14) + '" font-weight="bold" fill="#000" fill-opacity="' + (op || 0.05) + '">' + esc(strip.repeat(3)) + '</text>';
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" width="100%" height="100%">' + lines + '</svg>';
    return '<img class="wm-img" alt="" src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '">';
  }
  // Non-breaking hyphens stop Word/Safari turning the student number into a blue link.
  function noLink(v) { return String(v == null ? '' : v).replace(/-/g, '\u2011'); }
  function gradeDocContext() {
    var origin = window.location.origin;
    var college = (profile && profile.college) || '';
    var collegeName = COLLEGE_NAMES[college] || college;
    var stamp = new Date().toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    var wmLine = 'NOT AN OFFICIAL DOCUMENT • ' + profile.student_no + ' • ' + stamp + ' • ' + collegeName.toUpperCase() + ' • CITY UNIVERSITY OF PASAY';
    var prog = PROG_ABBR(profile.program);
    return {
      sid: noLink(profile.student_no), origin: origin, collegeName: collegeName, wmStrip: wmLine + '          ', wmStripStu: 'CITY UNIVERSITY OF PASAY \u2022 ' + profile.student_no + ' \u2022 ' + stamp + ' \u2022 ' + (profile.last_name + ', ' + profile.first_name + (profile.middle_name ? ' ' + String(profile.middle_name).trim().charAt(0).toUpperCase() + '.' : '')).toUpperCase() + ' \u2022 CITY UNIVERSITY OF PASAY          ',
      logo: origin + (COLLEGE_LOGO_PATHS[college] || '/images/cup-logo-seal.png'),
      seal: origin + '/images/logo-1994.png',
      sName: (profile.last_name + ', ' + profile.first_name + (profile.middle_name ? ' ' + String(profile.middle_name).trim().charAt(0).toUpperCase() + '.' : '')).toUpperCase(),
      yrSec: prog + '-' + (profile.year_level || '') + (profile.section || '')
    };
  }
  var univHdr = false;
  function gradeHeader(c, reg) {
    if (!reg) return '<div class="hdr cupH"><img src="' + c.seal + '" alt="City University of Pasay seal"><div>' +
      '<div class="u1">CITY UNIVERSITY OF PASAY</div><div class="u2">(PAMANTASAN NG LUNGSOD NG PASAY)</div><div class="u2">Pasadeña St., F.B Harisson, Pasay City</div></div></div>';
    if (univHdr) return '<div class="hdr"><img src="' + c.seal + '" alt="City University of Pasay seal"><div><div class="u1">CITY UNIVERSITY OF PASAY</div><div class="u2">(PAMANTASAN NG LUNGSOD NG PASAY)</div><div class="u2">Pasadeña St., Pasay City</div></div></div>';
    return '<div class="hdr"><img src="' + c.seal + '" alt="City University of Pasay seal"><div>' +
      '<div class="u1">CITY UNIVERSITY OF PASAY</div><div class="u2">(PAMANTASAN NG LUNGSOD NG PASAY)</div><div class="u2">Pasadeña St., Pasay City</div>' +
      '<div class="c1">' + esc(c.collegeName) + '</div><div class="addr">' + esc(collegeAddr((profile && profile.college) || '')) + '</div></div>' +
      '<img src="' + c.logo + '" alt="College crest"></div>';
  }
  var COLLEGE_ADDR = { CONM: '4th Floor Tramo Wing, Pasay City General Hospital, P. Burgos St, Pasay City' };
  function collegeAddr(code) { return COLLEGE_ADDR[code] || 'City University of Pasay, Pasadeña St, Pasay City'; }
  // Verification block: QR code linking to /verify-document, with the code in words.
  function qrBlock(g, c) {
    if (!g || !g.code) return '';
    return '<div class="qr">' + (g.qr ? '<img src="' + g.qr + '" alt="Verification QR code">' : '') +
      '<div><b>SCAN THE QR CODE TO VERIFY THE AUTHENTICITY<br>OF THIS DOCUMENT.</b><div class="vc" style="font-weight:normal">THIS IS A SYSTEM GENERATED REPORT<br>NO SIGNATURE IS NECESSARY</div></div></div>';
  }
  function titleCase(s) { return String(s || '').toLowerCase().replace(/(^|[\s\-])(\S)/g, function (m, p, ch) { return p + ch.toUpperCase(); }); }
  function certHtml(g, c) {
    var mid = profile.middle_name ? ' ' + String(profile.middle_name).trim().charAt(0).toUpperCase() + '.' : '';
    var name = titleCase(profile.last_name) + ', ' + titleCase(profile.first_name) + mid;
    var fl = function (v) { return '<span class="fl">' + esc(v) + '</span>'; };
    return '<div class="cert">This is to certify that ' + fl(name) + ', a student of this University with student number ' + fl(profile.student_no) +
      ' enrolled in ' + fl(PROG_ABBR(profile.program)) + ' and obtained the following grades during the ' + fl(g.ay + ', ' + termLabel(g.term)) + '.</div>';
  }
  function retHtml() {
    return '<div class="ret"><b>Retention Status</b>: ' + esc(retentionLabel) + '</div>';
  }
  function sigsHtml() {
    return '<div class="sigs"><div class="sgL"><div class="pb">Prepared by:</div><div class="sgn">UNIVERSITY REGISTRAR</div><div class="ln"></div><div class="lb">Records-in-Charge</div></div>' +
      '<div class="sgR"><div class="pb">Verified and Noted by:</div><div class="sgn">&nbsp;</div><div class="ln"></div><div class="lb">University Registrar</div></div><div class="note">Not valid without seal and iteration</div></div>';
  }
  function docCss(reg) {
    if (!reg) return DOC_CSS.copy;
    return DOC_CSS.copy
      .replace('@page{size:A4 portrait;margin:0.25in}', '@page{size:A4 portrait;margin:0.75in}')
      .replace('width:calc(210mm - 0.5in);height:calc(297mm - 0.5in - 10mm);box-sizing:border-box;padding:5mm 9mm 4mm;', 'width:calc(210mm - 1.5in);height:calc(297mm - 1.5in - 2mm);box-sizing:border-box;padding:0;');
  }
  function copyDocHtml(list, reg) {
    var c = gradeDocContext(), sheets = '', ROWS = 20;
    var pv = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date()).forEach(function (x) { pv[x.type] = x.value; });
    var printedAt = pv.day + '-' + pv.month + '-' + pv.year + ' ' + pv.hour + ':' + pv.minute + ' ' + pv.dayPeriod;
    var ORD = ['1st', '2nd', '3rd', '4th'];
    var collegeName = COLLEGE_NAMES[(profile && profile.college) || ''] || (profile && profile.college) || '';
    list.forEach(function (g) {
      var items = g.items || [];
      var chunks = [];
      for (var i = 0; i < Math.max(1, items.length); i += ROWS) chunks.push(items.slice(i, i + ROWS));
      var enrolled = 0, earned = 0;
      items.forEach(function (r) {
        var u = r.units == null ? 0 : Number(r.units);
        enrolled += u;
        if (String(r.remarks || '').toLowerCase() === 'passed') earned += u;
      });
      chunks.forEach(function (chunk, ci) {
        var isLast = ci === chunks.length - 1, rows = '';
        // Only real subject rows are drawn, so the footer never sits on top of empty table rows.
        chunk.forEach(function (r) {
          rows += '<tr><td class="l">' + esc(r.course_code || '') + '</td><td class="l">' + esc(r.descriptive_title || '') + '</td>' +
            (reg ? '' : '<td class="c">' + esc(c.yrSec) + '</td>') + '<td class="c">' + esc(r.final_grade || '') + '</td>' + (reg ? '' : '<td class="c"></td>') +
            '<td class="c">' + esc(r.units == null ? '' : Number(r.units)) + '</td><td class="c">' + esc(r.remarks || '') + '</td></tr>';
        });
        if (isLast && chunk.length < ROWS) rows += '<tr><td colspan="' + (reg ? 5 : 7) + '" class="c"><b>*** Nothing Follows ***</b></td></tr>';
        var totals = isLast ? '<div><span class="tl">Total Credit Units Enrolled</span>: ' + enrolled + '</div>' +
          '<div><span class="tl">Total Credit Units Earned</span>: ' + earned + '</div>' +
          '<div class="gpa"><span class="tl">Grade Point Average</span>: ' + esc(g.gpa || '\u2014') + '</div>' +
          '<div class="subj"><span class="tl">Total Subjects Enrolled</span>: ' + items.length + '</div>' : '';
        var yearText = profile.year_level ? (ORD[Number(profile.year_level) - 1] || profile.year_level) + ' Year' : '';
        sheets += '<div class="sheet' + (reg ? ' reg' : '') + '">' + gradeHeader(c, reg) + '<div class="title">' + (reg ? 'CERTIFICATE OF GRADES' : 'REPORT OF GRADES') + '</div>' +
          (reg ? certHtml(g, c) : '<div class="info">' +
            '<div><span class="kl">Fullname</span>: ' + esc(c.sName) + '</div>' +
            '<div><span class="kl">Gender</span>: ' + esc(profile.gender || '') + '</div>' +
            '<div><span class="kl">College</span>: ' + esc(collegeName) + '</div>' +
            '<div><span class="kl">Program</span>: ' + esc(profile.program || '') + '</div>' +
            '<div><span class="kl">Major</span>: ' + esc(profile.major || '') + '</div>' +
            '<div><span class="k">Student No</span>: ' + courierImg(profile.student_no || '', 9.33) + '</div>' +
            '<div><span class="k">Academic Year</span>: ' + esc(termLabel(g.term) + ' ' + g.ay) + '</div>' +
            '<div><span class="k">Year Level</span>: ' + esc(yearText) + '</div>' +
            '<div><span class="k">Section</span>: ' + esc(profile.section || '') + '</div>' +
            '<div><span class="k">Retention Status</span>: ' + esc(retentionLabel) + '</div>' +
          '</div>') +
          '<div class="gw"><table><colgroup>' + (reg ? '<col style="width:14%"><col style="width:46%"><col style="width:14%"><col style="width:12%"><col style="width:14%">' : '<col style="width:12%"><col style="width:38%"><col style="width:12%"><col style="width:10%"><col style="width:8%"><col style="width:10%"><col style="width:10%">') + '</colgroup>' +
          '<thead><tr><th>CODE</th><th>SUBJECT TITLE</th>' + (reg ? '' : '<th>CLASS<br>SECTION</th>') + '<th>FINAL<br>GRADE</th>' + (reg ? '' : '<th>RE-<br>EXAM</th>') + '<th>CREDIT<br>UNITS</th><th>REMARKS</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<div class="wm" aria-hidden="true">' + (reg ? '' : wmImg(c.wmStripStu, 40, false, 0.07)) + '</div></div>' +
                    '<div class="bot"><div class="botq">' + (reg ? retHtml() : qrBlock(g, c)) + '</div>' + (totals ? '<div class="tot tot-flow">' + totals + '</div>' : '') + '</div>' + (reg ? sigsHtml() : '') +
          (reg ? '' : '<div class="disc">DISCLAIMER: The student bears the responsibility for the proper disposal of the documents printed using the student portal. Any mishandling of printed records is solely the student\'s liability, and the University cannot be held accountable for such incidents.</div>') +
          (reg ? '' : '<div class="pf"><span>Printed from City University of Pasay - Student Portal</span><span style="font-weight:normal">' + esc(printedAt) + '</span></div>') +
          '</div>';
      });
    });
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no"><title>Report of Grades</title><style>' + docCss(reg) + '</style></head><body>' + sheets + '</body></html>';
  }
  function build(opts) {
    profile = opts.profile; retentionLabel = opts.retentionLabel || ''; univHdr = !!opts.univ;
    return copyDocHtml(opts.list, !!opts.registrar);
  }
  window.CupCopyDoc = { build: build };
})();
