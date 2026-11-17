// Makes public URLs case-insensitive: /cup-portal/, /Cup-Portal/ etc. redirect to the real folder or file name.
const fs = require('fs');
const path = require('path');

// Returns the canonical path for reqPath, or null if nothing matches.
function canonicalPath(root, reqPath) {
  let decoded;
  try { decoded = decodeURIComponent(reqPath); } catch { return null; }
  const parts = decoded.split('/').filter(Boolean);
  if (!parts.length) return null;
  let cur = root;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const last = i === parts.length - 1;
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return null; }
    const lower = seg.toLowerCase();
    const found = entries.find(e => e.name === seg) || entries.find(e => e.name.toLowerCase() === lower);
    let name;
    if (found) {
      name = found.name;
      if (found.isDirectory()) cur = path.join(cur, found.name);
    } else if (last) {
      // Clean URL: /CUP-CAT/LOGIN matches login.html
      const f = entries.find(e => e.isFile() && e.name.toLowerCase() === lower + '.html');
      if (!f) return null;
      name = f.name.slice(0, -5);
    } else {
      return null;
    }
    out.push(name);
  }
  return '/' + out.join('/');
}

module.exports = function caseRedirect(root) {
  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    let decoded;
    try { decoded = decodeURIComponent(req.path); } catch { return next(); }
    const direct = path.join(root, decoded);
    // Exact match (file, folder, or clean URL): nothing to fix.
    if (fs.existsSync(direct) || fs.existsSync(direct + '.html')) return next();
    const canon = canonicalPath(root, req.path);
    if (!canon) return next();
    const trailing = req.path.endsWith('/') ? '/' : '';
    const qi = req.originalUrl.indexOf('?');
    const query = qi >= 0 ? req.originalUrl.slice(qi) : '';
    return res.redirect(301, canon + trailing + query);
  };
};

module.exports.canonicalPath = canonicalPath;
