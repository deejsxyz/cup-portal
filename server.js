// Serves the static site and saves application requests to Neon (PostgreSQL).
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Neon connection string comes from the DATABASE_URL environment variable on Render.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

// Photo uploads (base64) need a larger body limit; every other route keeps 10kb.
app.use((req, res, next) => (req.path.startsWith('/api/cat/sections/attachments')
  ? express.json({ limit: '9mb' })
  : req.path.startsWith('/api/cat/sections/photo') || req.path === '/api/cat/profile/photo'
  ? express.json({ limit: '3mb' })
  : req.path.startsWith('/api/admin/import') || req.path.startsWith('/api/registrar/')
  ? express.json({ limit: '10mb' })
  : express.json({ limit: '50kb' }))(req, res, next));
// Case-insensitive page links: /cup-portal/, /Cup-Portal/ redirect to the real folder.
app.use(require('./case-redirect')(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// CUP Portal lives in its own top-level folder. Accept any capitalization of the folder name.
app.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith('/cup-portal') && req.path !== '/CUP-PORTAL' && !req.path.startsWith('/CUP-PORTAL/')) {
    const rest = req.path.slice('/cup-portal'.length);
    const qi = req.originalUrl.indexOf('?');
    return res.redirect(301, '/CUP-PORTAL' + rest + (qi >= 0 ? req.originalUrl.slice(qi) : ''));
  }
  next();
});
app.get('/CUP-PORTAL/registrar/:college', (req, res, next) => {
  const code = REG_COLLEGES.find((c) => c.toLowerCase() === String(req.params.college).toLowerCase());
  if (!code) return next();
  res.sendFile(path.join(__dirname, 'CUP-PORTAL', 'registrar', 'dashboard.html'), (err) => { if (err) next(err); });
});
app.use('/CUP-PORTAL', express.static(path.join(__dirname, 'CUP-PORTAL'), { extensions: ['html'] }));


app.post('/api/applications', async (req, res) => {
  const fullName = String(req.body.fullName || '').trim().slice(0, 150);
  const program = String(req.body.program || '').trim().slice(0, 100);
  if (!fullName) {
    return res.status(400).json({ error: 'Full name is required.' });
  }
  try {
    await pool.query(
      'INSERT INTO applications (full_name, program) VALUES ($1, $2)',
      [fullName, program]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Failed to save application:', err.message);
    res.status(500).json({ error: 'Could not save the request.' });
  }
});

app.get('/api/cat-stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM cat_stats');
    const stats = { total_registrations: 0, total_successful_applications: 0 };
    result.rows.forEach((row) => { stats[row.key] = Number(row.value); });
    // Registrations count applicant accounts only; admin accounts are not counted.
    const reg = await pool.query("SELECT COUNT(*)::int AS n FROM accounts WHERE role = 'applicant'");
    stats.total_registrations = reg.rows[0].n;
    res.json(stats);
  } catch (err) {
    console.error('Failed to read CUP-CAT stats:', err.message);
    res.status(500).json({ error: 'Could not load the statistics.' });
  }
});


// ---- CUP CAT account creation ----
// Sends email through Brevo's web API (Render's free plan blocks SMTP ports).
// opts: { html, sender } — sender defaults to the CUP Central Portal name.
async function sendEmail(to, subject, text, opts) {
  const { html, sender = 'CUP Central Portal', attachments } = opts || {};
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: sender, email: process.env.SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text,
      ...(html ? { htmlContent: html } : {}),
      ...(attachments ? { attachment: attachments } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error('Brevo responded ' + res.status + ': ' + detail);
  }
}

// Sends each new student their temporary password and a "Click to Login" button. The button opens
// /api/portal/setup, which signs the student in for the password change and opens the change-password page.
function emailEscape(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Stop switch for credential emails from batch uploads: emails not yet sent are skipped while this is on.
let welcomeEmailsStopped = false;
async function sendPortalWelcomeEmails(req, items) {
  const origin = process.env.PORTAL_BASE_URL || `https://${req.get('host')}`;
  for (let i = 0; i < items.length; i += 10) {
    if (welcomeEmailsStopped) { console.log('Welcome emails stopped; skipped ' + (items.length - i)); return; }
    await Promise.all(items.slice(i, i + 10).map(async (it) => {
      const link = origin + '/api/portal/setup?token=' + encodeURIComponent(setupTokenFor(String(it.student_no).toLowerCase()));
      const greet = it.name ? ' ' + it.name : '';
      const text = [
        `Hello${greet},`,
        '',
        'Your CUP Student Portal account has been created.',
        '',
        `Username (student number): ${it.student_no}`,
        `Temporary password: ${it.temp}`,
        '',
        'Open the "Click to Login" button in this email. You will be asked to change your password the first time you log in.',
        '',
        'If you did not expect this email, please contact the Office of the University Registrar.',
      ].join('\n');
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.5">
<p>Hello${emailEscape(greet)},</p>
<p>Your CUP Student Portal account has been created.</p>
<p>Username (student number): <strong>${emailEscape(it.student_no)}</strong><br>Temporary password: <strong>${emailEscape(it.temp)}</strong></p>
<p style="margin:24px 0"><a href="${emailEscape(link)}" style="display:inline-block;background:#2d5a1e;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Click to Login</a></p>
<p>You will be asked to change your password the first time you log in.</p>
<p style="font-size:13px;color:#6b7280">If you did not expect this email, please contact the Office of the University Registrar.</p>
</div>`;
      try {
        await sendEmail(it.to, 'Your CUP Student Central Portal Account', text, { html });
      } catch (err) {
        console.error('Welcome email failed for ' + it.student_no + ': ' + err.message);
      }
    }));
  }
}

// Signed, expiring link for a student's first login. It carries no password; it only signs the student in
// while the account still must change its temporary password.
function setupTokenFor(username, reset) {
  const payload = Buffer.from(JSON.stringify({ u: username, r: reset ? 1 : 0, e: Date.now() + 24 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update('setup.' + payload).digest('base64url');
  return payload + '.' + sig;
}
function readSetupToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', SESSION_SECRET).update('setup.' + payload).digest('base64url');
  const a = Buffer.from(sig), c = Buffer.from(want);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!data || !data.u || !(data.e > Date.now())) return null;
  return { u: String(data.u), r: data.r === 1 };
}

// ----- Staff welcome emails and first-login password change (University Registrar, College Registrar, CSC) -----
const STAFF_MUST_CHANGE_MSG = 'Use the Click to Login button in your welcome email to change your temporary password first.';
function portalBase(req) { return process.env.PORTAL_BASE_URL || `https://${req.get('host')}`; }
function staffSetupTokenFor(kind, username) {
  const payload = Buffer.from(JSON.stringify({ k: kind, u: username, e: Date.now() + 7 * 24 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update('staffsetup.' + payload).digest('base64url');
  return payload + '.' + sig;
}
function readStaffSetupToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', SESSION_SECRET).update('staffsetup.' + payload).digest('base64url');
  const a = Buffer.from(sig), c = Buffer.from(want);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!data || !data.k || !data.u || !(data.e > Date.now())) return null;
  return { k: String(data.k), u: String(data.u) };
}
function staffLoginPage(kind, college) {
  if (kind === 'csc') return '/CUP-PORTAL/csc/';
  if (kind === 'nstp') return '/CUP-PORTAL/nstp/';
  if (kind === 'registrar') return '/CUP-PORTAL/college-registrar/?college=' + encodeURIComponent(college || '');
  return '/CUP-PORTAL/registrar/';
}
// Sends the welcome email with a Click to Login button. Returns true when the email was sent.
async function sendStaffWelcome(req, o) {
  const link = o.link || (portalBase(req) + '/CUP-PORTAL/staff/first-login/?token=' + encodeURIComponent(staffSetupTokenFor(o.kind, o.username)));
  const greet = o.name ? ' ' + o.name : '';
  const text = [
    `Hello${greet},`,
    '',
    'Your CUP Central Portal account has been created.',
    '',
    `Username: ${o.username}`,
    `Temporary password: ${o.temp}`,
    '',
    'Open the "Click to Login" button in this email. You will be asked to change your temporary password the first time you log in.',
    '',
    'If you did not expect this email, please contact the Office of the University Registrar.',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.5">
<p>Hello${emailEscape(greet)},</p>
<p>Your CUP Central Portal account has been created.</p>
<p>Username: <strong>${emailEscape(o.username)}</strong><br>Temporary password: <strong>${emailEscape(o.temp)}</strong></p>
<p style="margin:24px 0"><a href="${emailEscape(link)}" style="display:inline-block;background:#2d5a1e;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Click to Login</a></p>
<p>You will be asked to change your temporary password the first time you log in.</p>
<p style="font-size:13px;color:#6b7280">If you did not expect this email, please contact the Office of the University Registrar.</p>
</div>`;
  try {
    await sendEmail(o.to, 'Your CUP Central Portal Account', text, { html });
    return true;
  } catch (err) {
    console.error('Welcome email failed for ' + o.username + ': ' + err.message);
    return false;
  }
}

function hashCode(email, code) {
  return crypto.createHash('sha256').update(email + ':' + code).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

// Renew the sliding session on every API call, so saving a section also keeps the user logged in.
app.use('/api/', (req, res, next) => {
  const id = readSession(req);
  if (id && !/\/logout$/.test(req.path)) setSessionCookie(req, res, id);
  next();
});

app.post('/api/cat/otp', async (req, res) => {
  const regNow = await getRegistrationState();
  if (!regNow.open || regNow.quotaReached) return res.status(403).json({ error: regNow.open ? QUOTA_MSG : REG_CLOSED_MSG });
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const firstName = String(req.body.firstName || '').trim().slice(0, 100);
  const lastName = String(req.body.lastName || '').trim().slice(0, 100);
  try {
    const existing = await pool.query(
      'SELECT 1 FROM accounts WHERE email = $1 OR (lower(first_name) = lower($2) AND lower(last_name) = lower($3)) LIMIT 1',
      [email, firstName, lastName]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'User already registered' });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO otp_codes (email, code_hash, expires_at, attempts)
       VALUES ($1, $2, now() + interval '10 minutes', 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
      [email, hashCode(email, code)]
    );
    await sendEmail(
      email,
      'Your One-time-PIN (OTP)',
      'Your CUP CAT verification code is ' + code + '. It expires in 10 minutes. If you did not request this code, you can ignore this email.',
      { sender: 'CUP CAT Online Application System' }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send OTP:', err.message);
    res.status(500).json({ error: 'Could not send the code. Please try again.' });
  }
});

app.post('/api/cat/otp/verify', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const otp = String(req.body.otp || '').trim().slice(0, 6);
  try {
    const row = await pool.query('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email = $1', [email]);
    if (row.rowCount === 0 || new Date(row.rows[0].expires_at) < new Date()) {
      return res.status(400).json({ error: 'The code has expired. Please request a new one.' });
    }
    if (row.rows[0].attempts >= 5) {
      return res.status(429).json({ error: 'Too many wrong attempts. Please request a new code.' });
    }
    if (row.rows[0].code_hash !== hashCode(email, otp)) {
      await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return res.status(400).json({ error: 'The code is incorrect.' });
    }
    await pool.query('UPDATE otp_codes SET verified_at = now() WHERE email = $1', [email]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to verify OTP:', err.message);
    res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
});

// Profile: change the photo any time (the form lock does not apply to it).
app.post('/api/cat/profile/photo', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const photo = req.body && req.body.photo;
  if (typeof photo !== 'string' || photo.length > 2800000 || !isImageDataUrl(photo)) {
    return res.status(400).json({ error: 'Please upload a valid image under 2MB.' });
  }
  try {
    await pool.query(
      `INSERT INTO cat_sections (account_id, section, data, submitted_at) VALUES ($1, 'photo', $2, now())
       ON CONFLICT (account_id, section) DO UPDATE SET data = cat_sections.data || EXCLUDED.data, submitted_at = now()`,
      [id, JSON.stringify({ photo })]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update your photo.' });
  }
});

// Profile: the birthdate can be changed only once; after that it is locked.
// Change password while signed in: old password must match; new password must be confirmed and not reused.
app.post('/api/cat/profile/password', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const oldPassword = String((req.body && req.body.oldPassword) || '');
  const newPassword = String((req.body && req.body.newPassword) || '');
  const confirmPassword = String((req.body && req.body.confirmPassword) || '');
  if (!oldPassword) return res.status(400).json({ error: 'Enter your old password.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New password and confirmation do not match.' });
  try {
    const acc = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id]);
    if (!acc.rowCount) return res.status(401).json({ error: 'Not logged in.' });
    if (!verifyPassword(oldPassword, acc.rows[0].password_hash)) {
      return res.status(400).json({ error: 'Your old password is incorrect.' });
    }
    const past = await pool.query('SELECT password_hash FROM password_history WHERE account_id = $1', [id]);
    const previous = [acc.rows[0].password_hash, ...past.rows.map((r) => r.password_hash)];
    if (previous.some((h) => verifyPassword(newPassword, h))) {
      return res.status(400).json({ error: 'You cannot reuse a previous password. Please choose a new one.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO password_history (account_id, password_hash) VALUES ($1, $2)', [id, acc.rows[0].password_hash]);
      await client.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change your password. Please try again.' });
  }
});

app.post('/api/cat/profile/dob', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const dob = String((req.body && req.body.dateOfBirth) || '');
  if (!validDate(dob) || dob < '1900-01-01' || dob > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Enter a valid birthdate.' });
  }
  try {
    const r = await pool.query(
      'UPDATE accounts SET date_of_birth = $1, dob_changed = true WHERE id = $2 AND dob_changed = false RETURNING id', [dob, id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Your birthdate has already been changed once and is now locked.' });
    res.json({ ok: true, dateOfBirth: dob });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update your birthdate.' });
  }
});

// Password reset, step 1: find the account by email and send a code.
app.post('/api/cat/reset/request', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  try {
    const acc = await pool.query('SELECT 1 FROM accounts WHERE email = $1', [email]);
    const fac = acc.rowCount === 0 ? await pool.query("SELECT 1 FROM reg_users WHERE role = 'faculty' AND email = $1 AND archived_at IS NULL", [email]) : null;
    if (acc.rowCount === 0 && fac.rowCount === 0) {
      return res.status(404).json({ error: 'No account found with this email.' });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO otp_codes (email, code_hash, expires_at, attempts)
       VALUES ($1, $2, now() + interval '10 minutes', 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, verified_at = NULL`,
      [email, hashCode(email, code)]
    );
    await sendEmail(
      email,
      'Your One-time-PIN (OTP)',
      'Your CUP CAT password reset code is ' + code + '. It expires in 10 minutes. If you did not request a password reset, you can ignore this email.',
      { sender: 'CUP CAT Online Application System' }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send reset code:', err.message);
    res.status(500).json({ error: 'Could not send the code. Please try again.' });
  }
});

// Password reset, step 2: check the emailed code.
app.post('/api/cat/reset/verify', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 200);
  const otp = String((req.body && req.body.otp) || '').trim().slice(0, 6);
  try {
    const row = await pool.query('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email = $1', [email]);
    if (row.rowCount === 0 || new Date(row.rows[0].expires_at) < new Date()) {
      return res.status(400).json({ error: 'The code has expired. Please request a new one.' });
    }
    if (row.rows[0].attempts >= 5) {
      return res.status(429).json({ error: 'Too many wrong attempts. Please request a new code.' });
    }
    if (row.rows[0].code_hash !== hashCode(email, otp)) {
      await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return res.status(400).json({ error: 'The code is incorrect.' });
    }
    await pool.query('UPDATE otp_codes SET verified_at = now() WHERE email = $1', [email]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to verify reset code:', err.message);
    res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
});

// Password reset, step 3: set the new password, only after the code was verified.
app.post('/api/cat/reset/confirm', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 200);
  const password = String((req.body && req.body.password) || '');
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  try {
    const row = await pool.query('SELECT verified_at, expires_at FROM otp_codes WHERE email = $1', [email]);
    if (row.rowCount === 0 || !row.rows[0].verified_at || new Date(row.rows[0].expires_at) < new Date()) {
      return res.status(400).json({ error: 'Please verify the code first.' });
    }
    const acc = await pool.query('SELECT id, password_hash FROM accounts WHERE email = $1', [email]);
    if (acc.rowCount === 0) {
      // Faculty accounts (registrar records) reset the same way, matched by their email.
      const fac = await pool.query("SELECT id, password_hash FROM reg_users WHERE role = 'faculty' AND email = $1 AND archived_at IS NULL", [email]);
      if (fac.rowCount === 0) return res.status(404).json({ error: 'No account found with this email.' });
      if (verifyPassword(password, fac.rows[0].password_hash)) {
        return res.status(400).json({ error: 'You cannot reuse your current password. Please choose a new one.' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE reg_users SET password_hash = $2, must_change_password = FALSE, password_changed_at = now() WHERE id = $1', [fac.rows[0].id, hashPassword(password)]);
        await client.query('DELETE FROM otp_codes WHERE email = $1', [email]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return res.json({ ok: true });
    }
    const accountId = acc.rows[0].id;
    // The new password must not match the current password or any earlier one.
    const past = await pool.query('SELECT password_hash FROM password_history WHERE account_id = $1', [accountId]);
    const previous = [acc.rows[0].password_hash, ...past.rows.map((r) => r.password_hash)];
    if (previous.some((h) => verifyPassword(password, h))) {
      return res.status(400).json({ error: 'You cannot reuse a previous password. Please choose a new one.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO password_history (account_id, password_hash) VALUES ($1, $2)', [accountId, acc.rows[0].password_hash]);
      await client.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hashPassword(password), accountId]);
      await client.query('DELETE FROM otp_codes WHERE email = $1', [email]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to reset password:', err.message);
    res.status(500).json({ error: 'Could not reset the password. Please try again.' });
  }
});

app.post('/api/cat/accounts', async (req, res) => {
  const regNow = await getRegistrationState();
  if (!regNow.open || regNow.quotaReached) return res.status(403).json({ error: regNow.open ? QUOTA_MSG : REG_CLOSED_MSG });
  const b = req.body || {};
  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const category = clean(b.category, 100);
  const firstName = clean(b.firstName, 100);
  const middleName = clean(b.middleName, 100);
  const lastName = clean(b.lastName, 100);
  const nameExtension = clean(b.nameExtension, 20);
  const dob = clean(b.dateOfBirth, 10);
  const email = clean(b.email, 200).toLowerCase();
  const password = String(b.password || '');

  const dobDate = new Date(dob + 'T00:00:00Z');
  if (!category || !firstName || !lastName || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(dobDate) || dobDate.toISOString().slice(0, 10) !== dob || !email) {
    return res.status(400).json({ error: 'Please complete all required fields with a valid date of birth.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const codeRow = await client.query('SELECT verified_at, expires_at FROM otp_codes WHERE email = $1 FOR UPDATE', [email]);
    const verifiedRecently = codeRow.rowCount > 0 && codeRow.rows[0].verified_at &&
      new Date(codeRow.rows[0].expires_at) > new Date(Date.now() - 10 * 60 * 1000);
    if (!verifiedRecently) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Please verify your email with the OTP first.' });
    }
    const dup = await client.query(
      'SELECT 1 FROM accounts WHERE email = $1 OR (lower(first_name) = lower($2) AND lower(last_name) = lower($3)) LIMIT 1',
      [email, firstName, lastName]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'User already registered' });
    }
    await client.query(
      `INSERT INTO accounts (category, first_name, middle_name, last_name, name_extension, date_of_birth, email, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [category, firstName, middleName || null, lastName, nameExtension || null, dob, email, hashPassword(password)]
    );
    await client.query('DELETE FROM otp_codes WHERE email = $1', [email]);
    await client.query("UPDATE cat_stats SET value = value + 1 WHERE key = 'total_registrations'");
    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ error: 'User already registered' });
    }
    console.error('Failed to create account:', err.message);
    res.status(500).json({ error: 'Could not create the account. Please try again.' });
  } finally {
    client.release();
  }
});

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === check.length && crypto.timingSafeEqual(check, expected);
}

const SESSION_SECRET = process.env.SESSION_SECRET || process.env.DATABASE_URL || 'cup_pasay_permanent_session_secret_2026';
const SESSION_MS = 10 * 60 * 1000; // logged out after 10 minutes of inactivity; renewed on each activity ping

function signSession(body) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
}

function readSession(req) {
  const m = /(?:^|;\s*)cat_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = signSession(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    return d.exp > Date.now() ? d.id : null;
  } catch (e) {
    return null;
  }
}

// Sliding session: every authenticated request pushes the expiry 10 minutes ahead.
function setSessionCookie(req, res, id) {
  const body = Buffer.from(JSON.stringify({ id, exp: Date.now() + SESSION_MS })).toString('base64url');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `cat_session=${body}.${signSession(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
}

app.post('/api/cat/login', async (req, res) => {
  const byApplicant = req.body && req.body.mode === 'applicant';
  const identifier = String((req.body && req.body.identifier) || '').trim().slice(0, 254);
  const email = identifier.toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!identifier || !password) {
    return res.status(400).json({ error: byApplicant ? 'Please enter your Applicant ID and password.' : 'Please enter your email and password.' });
  }
  try {
    // Applicant ID login only works once an Applicant ID has been generated (after submission).
    const { rows } = byApplicant
      ? await pool.query('SELECT id, password_hash, role FROM accounts WHERE applicant_id = $1', [identifier])
      : await pool.query('SELECT id, password_hash, role FROM accounts WHERE email = $1', [email]);
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ error: byApplicant ? 'Incorrect Applicant ID or password.' : 'Incorrect email or password.' });
    }
    setSessionCookie(req, res, rows[0].id);
    res.json({ ok: true, role: rows[0].role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in. Please try again.' });
  }
});

// ---- Registrar Portal: University Registrar (super admin from Render env) and college registrars ----
const REG_SESSION_MS = 5 * 60 * 1000;
const REG_COLLEGES = ['COACS', 'CAS', 'CONM', 'COED', 'COBM', 'LAW', 'GS', 'TESDA-TVI'];
// The University's programs. Enrollment accepts the full name or the code in brackets, and stores the full name.
const REG_PROGRAMS = ["Bachelor of Science in Office Administration (BSOA)", "Associate in Computer Technology (ACT)", "Bachelor of Arts in Political Science (ABPS)", "Bachelor of Science in Nursing (BSN)", "Bachelor in Elementary Education (BEEd)", "Bachelor in Secondary Education (BSEd)", "Bachelor of Science in Business Administration (BSBA)", "Juris Doctor (J.D.)", "Master's in Legal Studies (MLS)", "Teaching Certificate Program (TCP)", "Master's in Public Administration (MPA)", "Master of Arts in Education (MAEd)", "Bookkeeping", "Event Management"];
// Which programs each college offers. Enrollment rejects a program the college does not offer.
const COLLEGE_FULL_NAMES = {
  COACS: 'College of Office Administration and Computer Studies',
  CAS: 'College of Arts and Sciences',
  CONM: 'College of Nursing and Midwifery',
  COED: 'College of Education',
  COBM: 'College of Business and Management',
  LAW: 'School of Law',
  GS: 'Graduate School',
  'TESDA-TVI': 'TESDA-TVI',
};
// Each college's logo, shown in the student portal header.
const COLLEGE_LOGOS = {
  COACS: '/images/college-oact.png', CAS: '/images/college-arts.png', CONM: '/images/college-nursing.png',
  COED: '/images/college-education.png', COBM: '/images/college-business.png', LAW: '/images/college-law.png',
  GS: '/images/college-graduate.png', 'TESDA-TVI': '/images/tesda-logo.png',
};
const REG_PROGRAM_COLLEGES ={"COACS": ["Bachelor of Science in Office Administration (BSOA)", "Associate in Computer Technology (ACT)"], "CAS": ["Bachelor of Arts in Political Science (ABPS)"], "CONM": ["Bachelor of Science in Nursing (BSN)"], "COED": ["Bachelor in Elementary Education (BEEd)", "Bachelor in Secondary Education (BSEd)"], "COBM": ["Bachelor of Science in Business Administration (BSBA)"], "LAW": ["Juris Doctor (J.D.)", "Master's in Legal Studies (MLS)"], "GS": ["Juris Doctor (J.D.)", "Teaching Certificate Program (TCP)", "Master's in Public Administration (MPA)", "Master of Arts in Education (MAEd)"], "TESDA-TVI": ["Bookkeeping", "Event Management"]};
const STRICT_EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;
const STRICT_CONTACT_RE = /^(09\d{9}|\+639\d{9})$/;
function testStudentNo() { return String(process.env.TEST_STUDENT_NO || '__none__').trim(); }
function testFacultyUser() { return String(process.env.TEST_FACULTY_USERNAME || '__none__').trim().toLowerCase(); }
function testRegistrarUser() { return String(process.env.TEST_REGISTRAR_USERNAME || '__none__').trim().toLowerCase(); }
// One test registrar login per college: <COLLEGE>_USERNAME / <COLLEGE>_PASSWORD (e.g. TESDA_TVI_USERNAME).
function collegeTestEnvBase(college) { return String(college).toUpperCase().replace(/[^A-Z0-9]+/g, '_'); }
function testCollegeRegistrarUsers() { return REG_COLLEGES.map((c) => String(process.env[collegeTestEnvBase(c) + '_USERNAME'] || '').trim().toLowerCase()).filter(Boolean); }
function superAdminUser() { return String(process.env.SUPER_ADMIN_USERNAME || '__none__').trim().toLowerCase(); }
function isHiddenStudentRow(s) {
  if (!s) return false;
  const sn = String(s.student_no || '').trim();
  if (sn && sn.toLowerCase() === testStudentNo().toLowerCase()) return true;
  if (String(s.first_name || '').trim().toLowerCase() === 'test' && String(s.last_name || '').trim().toLowerCase() === 'student') return true;
  if (String(s.program || '').trim().toLowerCase() === 'test program') return true;
  return false;
}
function isHiddenUserRow(u) {
  if (!u) return false;
  const un = String(u.username || '').trim().toLowerCase();
  const sn = String(u.student_no || '').trim().toLowerCase();
  const nm = String(u.name || '').trim().toLowerCase();
  if (un === testFacultyUser() || un === testStudentNo().toLowerCase() || un === testRegistrarUser() || testCollegeRegistrarUsers().includes(un) || un === superAdminUser() || un === 'superadmin') return true;
  if (sn && sn === testStudentNo().toLowerCase()) return true;
  if (nm === 'test faculty' || nm === 'test student' || nm === 'test registrar' || nm === 'student, test' || nm === 'faculty, test') return true;
  if (String(u.first_name || '').trim().toLowerCase() === 'test' && ['faculty', 'student', 'registrar'].includes(String(u.last_name || '').trim().toLowerCase())) return true;
  return false;
}
function isHiddenLogRow(l) {
  if (!l) return false;
  const actor = String(l.actor || '').trim().toLowerCase();
  const detail = String(l.detail || '').trim().toLowerCase();
  const hiddenActors = [testFacultyUser(), testStudentNo().toLowerCase(), testRegistrarUser(), ...testCollegeRegistrarUsers(), superAdminUser(), 'superadmin', 'test faculty', 'test student', 'test registrar'];
  if (hiddenActors.includes(actor)) return true;
  if (testStudentNo() !== '__none__' && detail.includes(testStudentNo().toLowerCase())) return true;
  if (testFacultyUser() !== '__none__' && detail.includes(testFacultyUser())) return true;
  return false;
}
// Programs that have majors. Students in these programs must have one of the listed majors.
const REG_MAJORS = {"Bachelor in Secondary Education (BSEd)": ["English", "Mathematics", "General Science", "Filipino", "Social Studies"], "Bachelor of Science in Business Administration (BSBA)": ["Financial Management", "Human Resource Management", "Operations Management", "Marketing Management"]};
function canonicalMajor(program, raw) {
  const list = REG_MAJORS[program];
  if (!list) return '';
  const v = String(raw || '').trim().toLowerCase();
  return list.find((m) => m.toLowerCase() === v) || null;
}
// e.g. "Bachelor in Secondary Education (BSEd)" + "English" -> "Bachelor in Secondary Education Major in English (BSEd)"
function majorLabel(program, major) {
  const m = program.match(/^(.*?)\s*\(([^)]+)\)$/);
  return m ? `${m[1]} Major in ${major} (${m[2]})` : `${program} Major in ${major}`;
}
// Program choices shown on enrollment forms. Programs with majors list one entry per major.
const REG_PROGRAM_OPTIONS = Object.fromEntries(Object.entries(REG_PROGRAM_COLLEGES).map(([c, progs]) => [c, progs.flatMap((p) =>
  REG_MAJORS[p] ? REG_MAJORS[p].map((m) => ({ label: majorLabel(p, m), program: p, major: m })) : [{ label: p, program: p, major: '' }])]));
// Resolve a chosen label (or a plain program name without majors) to { program, major } for a college.
function resolveProgramChoice(college, raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  const opt = (REG_PROGRAM_OPTIONS[college] || []).find((o) => o.label.toLowerCase() === v);
  return opt ? { program: opt.program, major: opt.major } : null;
}
const CIVIL_STATUSES = ['Single', 'Married', 'Widowed', 'Separated', 'Solo Parent'];
function canonicalCivil(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return CIVIL_STATUSES.find((c) => c.toLowerCase() === v) || null;
}
function canonicalProgram(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  for (const name of REG_PROGRAMS) {
    const m = name.match(/\(([^)]+)\)$/);
    if (name.toLowerCase() === v || (m && m[1].toLowerCase() === v)) return name;
  }
  return null;
}
const regAttempts = new Map(); // ip -> { count, resetAt }
function regSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
// NSTP sessions use the same signed cookie; readRegSession ignores the nstp role so registrar routes stay closed to NSTP accounts.
function readRegCookie(req) {
  const m = /(?:^|;\s*)reg_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = signSession(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!d.exp || d.exp < Date.now()) return null;
    return d;
  } catch { return null; }
}
function readNstpSession(req) {
  const d = readRegCookie(req);
  if (!d || d.role !== 'nstp') return null;
  return { role: 'nstp', id: d.id };
}
function readRegSession(req) {
  const m = /(?:^|;\s*)reg_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = signSession(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!d.exp || d.exp < Date.now()) return null;
    if (d.role === 'superadmin') return { role: 'superadmin', college: null, id: null };
    if (d.role === 'registrar' && REG_COLLEGES.includes(d.college)) return { role: 'registrar', college: d.college, id: d.id };
    if (d.role === 'records' && REG_COLLEGES.includes(d.college)) return { role: 'registrar', college: d.college, id: d.id, records: true };
    return null;
  } catch { return null; }
}
function setRegCookie(req, res, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + REG_SESSION_MS })).toString('base64url');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `reg_session=${body}.${signSession(body)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}
function requireRegistrar(req, res, next) {
  const s = readRegSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in.' });
  if (s.records && req.method !== 'GET' && !req.path.endsWith('/grades/approve')) return res.status(403).json({ error: 'Records-in-Charge can only view.' });
  req.reg = s;
  next();
}
// Step 2 (Pre-enrollment) is for the College Registrar of the student's college only, not the University Registrar or Records-in-Charge.
function requireCollegeRegistrar(req, res, next) {
  const s = readRegSession(req);
  if (!s || s.role !== 'registrar' || s.records) return res.status(403).json({ error: 'Step 2 is for the College Registrar only.' });
  req.reg = s;
  next();
}
function requireSuperAdmin(req, res, next) {
  const s = readRegSession(req);
  if (!s || s.role !== 'superadmin') return res.status(403).json({ error: 'University Registrar only.' });
  req.reg = s;
  next();
}


// Sliding session for registrar and portal requests (renews 5-minute inactivity timer on each activity)
app.use('/api/registrar/', (req, res, next) => {
  const s = readRegSession(req);
  if (s && !/\/logout$/.test(req.path)) setRegCookie(req, res, s);
  next();
});
app.use('/api/portal/', (req, res, next) => {
  const s = readPortalSession(req);
  if (s && !/\/logout$/.test(req.path)) setPortalCookie(req, res, s);
  next();
});
app.use('/api/faculty/', (req, res, next) => {
  const s = readPortalSession(req);
  if (s && !/\/logout$/.test(req.path)) setPortalCookie(req, res, s);
  next();
});
app.use('/api/student/', (req, res, next) => {
  const s = readPortalSession(req);
  if (s && !/\/logout$/.test(req.path)) setPortalCookie(req, res, s);
  next();
});

app.use('/api/nstp/', (req, res, next) => {
  const s = readNstpSession(req);
  if (s && !/\/logout$/.test(req.path)) setRegCookie(req, res, { role: 'nstp', id: s.id });
  next();
});

app.post('/api/registrar/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = regAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  if (rec.count >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const username = String((req.body && req.body.username) || '').trim().slice(0, 200);
  const password = String((req.body && req.body.password) || '').slice(0, 200);
  if (!username || !password) return res.status(400).json({ error: 'Please enter your username and password.' });
  // The college login page sends its college; a college account can only sign in on its own college's page.
  const pageCollege = String((req.body && req.body.college) || '').trim().toUpperCase();
  // Each portal is independent: 'college' (College Registrar Portal) or 'university' (University Registrar Portal).
  const portal = (req.body && req.body.portal) === 'nstp' ? 'nstp' : ((req.body && req.body.portal) === 'college' || REG_COLLEGES.includes(pageCollege)) ? 'college' : 'university';

  if (portal === 'nstp') {
    // NSTP Officer accounts only. College accounts cannot sign in here.
    try {
      const { rows } = await pool.query("SELECT id, password_hash, must_change_password, username FROM accounts WHERE role = 'nstp' AND archived_at IS NULL AND (username = $1 OR email = $1)", [username.toLowerCase()]);
      const row = rows[0];
      if (row && verifyPassword(password, row.password_hash)) {
        if (row.must_change_password) return res.json({ ok: true, must_change: true, token: staffSetupTokenFor('nstp', row.username) });
        regAttempts.delete(ip);
        setRegCookie(req, res, { role: 'nstp', id: row.id });
        return res.json({ ok: true, role: 'nstp' });
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not log in. Please try again.' });
    }
    rec.count += 1;
    regAttempts.set(ip, rec);
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const suUser = process.env.SUPER_ADMIN_USERNAME || '';
  const suPass = process.env.SUPER_ADMIN_PASSWORD || '';
  if (portal === 'university' && suUser && suPass && regSafeEqual(username, suUser) && regSafeEqual(password, suPass)) {
    regAttempts.delete(ip);
    setRegCookie(req, res, { role: 'superadmin' });
    return res.json({ ok: true, role: 'superadmin' });
  }
  if (suUser && suPass && regSafeEqual(username, suUser) && regSafeEqual(password, suPass)) {
    return res.status(403).json({ error: 'University Registrar accounts sign in on the University Registrar Portal.' });
  }
  try {
    const { rows } = await pool.query("SELECT id, role, password_hash, college, must_change_password, username FROM accounts WHERE role IN ('registrar', 'university', 'uniregistrar') AND archived_at IS NULL AND (username = $1 OR email = $1)", [username.toLowerCase()]);
    if (rows.length && rows[0].role === 'uniregistrar' && verifyPassword(password, rows[0].password_hash)) {
      if (portal !== 'university') return res.status(403).json({ error: 'University Registrar accounts sign in on the University Registrar Portal.' });
      if (rows[0].must_change_password) return res.json({ ok: true, must_change: true, token: staffSetupTokenFor('uniregistrar', rows[0].username) });
      regAttempts.delete(ip);
      setRegCookie(req, res, { role: 'superadmin' });
      return res.json({ ok: true, role: 'superadmin' });
    }
    if (rows.length && rows[0].college && rows[0].must_change_password && verifyPassword(password, rows[0].password_hash)) return res.json({ ok: true, must_change: true, token: staffSetupTokenFor(rows[0].role === 'university' ? 'university' : 'registrar', rows[0].username) });
    if (rows.length && rows[0].college && verifyPassword(password, rows[0].password_hash)) {
      const isRecords = rows[0].role === 'university';
      if (portal === 'college' && isRecords) {
        return res.status(403).json({ error: 'Records-in-Charge accounts sign in on the University Registrar Portal.' });
      }
      if (portal === 'university' && !isRecords) {
        return res.status(403).json({ error: 'College Registrar accounts sign in on the College Registrar Portal.' });
      }
      if (REG_COLLEGES.includes(pageCollege) && rows[0].college !== pageCollege) {
        return res.status(403).json({ error: 'This account belongs to ' + rows[0].college + '. Please log in on the ' + rows[0].college + ' registrar page.' });
      }
      regAttempts.delete(ip);
      const role = isRecords ? 'records' : 'registrar';
      setRegCookie(req, res, { role, college: rows[0].college, id: rows[0].id });
      return res.json({ ok: true, role, college: rows[0].college });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not log in. Please try again.' });
  }
  rec.count += 1;
  regAttempts.set(ip, rec);
  res.status(401).json({ error: 'Incorrect username or password.' });
});

app.get('/api/registrar/me', async (req, res) => {
  const s = readRegSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in.' });
  let fullName = s.role === 'superadmin' ? 'Superadmin' : '';
  if (s.id) {
    try {
      const { rows } = await pool.query('SELECT first_name, middle_name, last_name, name_extension FROM accounts WHERE id = $1', [s.id]);
      if (rows.length) {
        const r = rows[0];
        // Display as: First M. Last Ext (middle initial, extension only if any)
        const mi = String(r.middle_name || '').trim().charAt(0);
        fullName = [String(r.first_name || '').trim(), mi ? mi.toUpperCase() + '.' : '', String(r.last_name || '').trim(), String(r.name_extension || '').trim()].filter(Boolean).join(' ');
      }
    } catch (err) { console.error(err); }
  }
  res.json({ ok: true, role: s.records ? 'records' : s.role, college: s.college, collegeName: COLLEGE_FULL_NAMES[s.college] || '', fullName, colleges: REG_COLLEGES });
});

// A college registrar changes their own password. A 6-digit code is emailed first, the same as for students.
function registrarAccountEmail(id) {
  // Matches the account by ID for every registrar-side role (registrar, records, university).
  return pool.query("SELECT email FROM accounts WHERE id = $1 AND archived_at IS NULL", [id]).then((r) => (r.rows[0] && r.rows[0].email) || '');
}
app.post('/api/registrar/password/otp', async (req, res) => {
  const s = readRegSession(req);
  if (!s || s.role !== 'registrar' || !s.id) return res.status(401).json({ error: 'Not logged in.' });
  const email = String(await registrarAccountEmail(s.id)).trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: "No email is registered for your account. Contact the University Registrar's Office." });
  try {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO otp_codes (email, code_hash, expires_at, attempts)
       VALUES ($1, $2, now() + interval '10 minutes', 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, verified_at = NULL`,
      [email, hashCode(email, code)]);
    await sendEmail(email, 'Your One-time-PIN (OTP)',
      'Your password change code is ' + code + '. It expires in 10 minutes. If you did not request this, you can ignore this email.');
    res.json({ ok: true, email_hint: maskEmail(email) });
  } catch (err) {
    console.error('Failed to send password code:', err.message);
    res.status(500).json({ error: 'Could not send the code. Please try again.' });
  }
});
app.post('/api/registrar/change-password', async (req, res) => {
  const s = readRegSession(req);
  if (!s || s.role !== 'registrar' || !s.id) return res.status(401).json({ error: 'Not logged in.' });
  const b = req.body || {};
  const current = String(b.current || ''), next = String(b.new || ''), otp = String(b.otp || '').trim().slice(0, 6);
  if (!current) return res.status(400).json({ error: 'Enter your current password.' });
  if (next.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  try {
    const email = String(await registrarAccountEmail(s.id)).trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: "No email is registered for your account. Contact the University Registrar's Office." });
    const { rows } = await pool.query("SELECT password_hash FROM accounts WHERE id = $1 AND archived_at IS NULL", [s.id]);
    if (!rows.length || !verifyPassword(current, rows[0].password_hash)) return res.status(401).json({ error: 'Your current password is wrong.' });
    if (verifyPassword(next, rows[0].password_hash)) return res.status(400).json({ error: 'Choose a password different from the current one.' });
    const row = await pool.query('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email = $1', [email]);
    if (!row.rows.length || new Date(row.rows[0].expires_at) < new Date()) return res.status(400).json({ error: 'The code has expired. Please request a new one.' });
    if (row.rows[0].attempts >= 5) return res.status(429).json({ error: 'Too many wrong attempts. Please request a new code.' });
    if (!otp || row.rows[0].code_hash !== hashCode(email, otp)) {
      await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return res.status(400).json({ error: 'The code is incorrect.' });
    }
    await pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [s.id, hashPassword(next)]);
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);
    logAction(req, s.id, 'password changed', 'Registrar account ' + s.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change the password.' });
  }
});

// ----- NSTP Portal: one NSTP account per college, created by the University Registrar (Accounts) -----
const NSTP_COLLEGES = ['CONM', 'COACS', 'CAS', 'COED', 'COBM', 'LAW'];
const NSTP_CODES = ['NSTP 1', 'ROTC 1'];
async function requireNstp(req, res, next) {
  const s = readNstpSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { rows } = await pool.query("SELECT 1 FROM accounts WHERE id = $1 AND role = 'nstp' AND archived_at IS NULL", [s.id]);
    if (!rows.length) return res.status(401).json({ error: 'Not logged in.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not check your sign-in.' });
  }
  req.nstp = s;
  next();
}
app.post('/api/nstp/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'reg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/nstp/me', requireNstp, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT first_name, middle_name, last_name, name_extension FROM accounts WHERE id = $1', [req.nstp.id]);
    const r = rows[0] || {};
    const mi = String(r.middle_name || '').trim().charAt(0);
    const fullName = [String(r.first_name || '').trim(), mi ? mi.toUpperCase() + '.' : '', String(r.last_name || '').trim(), String(r.name_extension || '').trim()].filter(Boolean).join(' ');
    res.json({ ok: true, fullName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your account.' });
  }
});
// Verified students of the college. Subject and instructor are per student, so two instructors can teach one subject in a section.
// Final grade shows only once the University Registrar has approved it.
app.get('/api/nstp/students', requireNstp, async (req, res) => {
  if (await blockIfEnrollmentClosed(req, res)) return;
  const college = String(req.query.college || '').toUpperCase();
  if (!NSTP_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
    const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
    const [students, grades] = await Promise.all([
      pool.query(`SELECT s.student_no, s.last_name, s.first_name, COALESCE(s.middle_name, '') AS middle_name, COALESCE(s.name_extension, '') AS extension,
                         COALESCE(s.email, '') AS email, COALESCE(s.contact_number, '') AS contact_number, s.year_level, s.section, s.program,
                         COALESCE(s.nstp_subject, '') AS nstp_subject, s.nstp_enrolled_at, u.name AS instructor
                    FROM reg_students s LEFT JOIN reg_users u ON u.id = s.nstp_instructor_id
                   WHERE s.college = $1 AND s.status IN ('enrolled','pre-registered') AND s.step1_status = 'verified'
                   ORDER BY s.year_level, s.section, s.last_name, s.first_name`, [college]),
      pool.query("SELECT student_no, course_code, final_grade FROM reg_grades WHERE college = $1 AND course_code = ANY($2::text[]) AND status = 'approved'", [college, NSTP_CODES]),
    ]);
    const gradesBy = new Map();
    for (const g of grades.rows) gradesBy.set(g.student_no, [...(gradesBy.get(g.student_no) || []), g]);
    const out = students.rows.map((s) => {
      const mine = gradesBy.get(s.student_no) || [];
      const g = (s.nstp_subject ? mine.find((x) => x.course_code === s.nstp_subject) : mine[0]) || null;
      return {
        student_no: s.student_no, last_name: s.last_name, first_name: s.first_name, middle_name: s.middle_name, extension: s.extension,
        email: s.email, contact_number: s.contact_number, year_level: s.year_level, section: s.section, program: s.program,
        subject: s.nstp_subject || (g ? g.course_code : ''), final_grade: g ? g.final_grade : '',
        enrolled: !!s.nstp_enrolled_at, instructor: s.instructor || '',
      };
    });
    res.json({ students: out, term: m.grading_semester || '', academic_year: m.grading_ay || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the NSTP list.' });
  }
});

// NSTP enrollment: sets the subject (CWTS = NSTP 1, ROTC = ROTC 1) and instructor for the checked students. Enrolled students cannot be enrolled again.
app.post('/api/nstp/students/enroll', requireNstp, async (req, res) => {
  if (await blockIfEnrollmentClosed(req, res)) return;
  const b = req.body || {};
  const college = String(b.college || '').toUpperCase();
  const nos = Array.isArray(b.student_nos) ? [...new Set(b.student_nos.map(String))] : [];
  const subject = String(b.subject || '');
  const name = String(b.instructor || '').trim().replace(/\s+/g, ' ');
  if (!NSTP_COLLEGES.includes(college) || !nos.length) return res.status(400).json({ error: 'Check at least one student.' });
  if (!NSTP_CODES.includes(subject)) return res.status(400).json({ error: 'Choose CWTS (NSTP 1) or ROTC (ROTC 1).' });
  if (!name) return res.status(400).json({ error: "Type the instructor's name." });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fac = await client.query('SELECT id, name FROM reg_users WHERE LOWER(name) = LOWER($1)', [name]);
    if (!fac.rows.length) throw Object.assign(new Error('nofac'), { user: 'No faculty account has that name. Type the name exactly as it appears in Faculty Accounts.' });
    if (fac.rows.length > 1) throw Object.assign(new Error('dupfac'), { user: 'More than one faculty account has that name. Ask the University Registrar to fix the duplicate.' });
    const r = await client.query(
      `UPDATE reg_students SET nstp_subject = $1, nstp_instructor_id = $2, nstp_enrolled_at = now()
        WHERE college = $3 AND student_no = ANY($4::text[]) AND status IN ('enrolled','pre-registered')
          AND step1_status = 'verified' AND nstp_enrolled_at IS NULL RETURNING student_no`,
      [subject, fac.rows[0].id, college, nos]);
    await client.query('COMMIT');
    logAction(req, 'NSTP Officer', 'NSTP students enrolled', college + ' · ' + subject + ' · ' + r.rowCount + ' student(s) · ' + fac.rows[0].name);
    res.json({ ok: true, enrolled: r.rowCount, skipped: nos.length - r.rowCount, instructor: fac.rows[0].name, subject });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.user) return res.status(400).json({ error: err.user });
    console.error(err);
    res.status(500).json({ error: 'Could not enroll the students.' });
  } finally {
    client.release();
  }
});

app.post('/api/registrar/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'reg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// University Registrar creates a college registrar account (stored in the accounts table).
app.post('/api/registrar/accounts', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const college = String(b.college || '');
  const name = String(b.name || '').trim().slice(0, 150);
  const password = String(b.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    await pool.query(
      "INSERT INTO accounts (category, first_name, last_name, email, password_hash, role, college) VALUES ('REGISTRAR', $1, $2, $3, $4, 'registrar', $5)",
      [name || college, college, email, hashPassword(password), college]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email already has an account.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// Student list: a college registrar sees only their own college's enrolled students.
app.get('/api/registrar/students', requireRegistrar, async (req, res) => {
  const college = req.reg.role === 'registrar' ? req.reg.college : String(req.query.college || '');
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const { rows } = await pool.query(
      `SELECT student_no, last_name, first_name, middle_name, name_extension, gender, birthday::text AS birthday, program, year_level, section, email, contact_number, civil_status,
              (SELECT u.archived_at FROM reg_users u WHERE u.student_no = reg_students.student_no LIMIT 1) AS account_archived,
              status, (csc_paid_at IS NOT NULL) AS csc_paid
       FROM reg_students WHERE college = $1 AND status IN ('enrolled','pre-registered') ORDER BY last_name, first_name`, [college]);
    res.json({ college, students: rows.filter((s) => !isHiddenStudentRow(s)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load students.' });
  }
});

// University enrollment: student numbers are issued here, in one sequence for the whole University.
app.post('/api/registrar/enroll', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const year = String(b.year || '');
  const sem = String(b.semester || '');
  if (!rows.length || rows.length > 5000) return res.status(400).json({ error: 'Upload between 1 and 5000 rows.' });
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'Enter the enrollment year, for example 2026.' });
  if (!/^[1-3]$/.test(sem)) return res.status(400).json({ error: 'Choose the semester.' });
  const prefix = `${year}-${sem}-`;
  const result = { created: 0, errors: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('reg-enroll'))");
    const cur = await client.query(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(student_no FROM 8 FOR 7) AS INT)), 0) AS n FROM reg_students WHERE student_no LIKE $1", [prefix + '%']);
    let seq = cur.rows[0].n;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const line = i + 2;
      const college = String(r.college || '').trim();
      const first = String(r.first_name || '').trim().slice(0, 100);
      const last = String(r.last_name || '').trim().slice(0, 100);
      const program = canonicalProgram(r.program);
      const major = program ? canonicalMajor(program, r.major) : '';
      if (!REG_COLLEGES.includes(college) || !first || !last || !program) {
        result.errors.push({ line, error: 'Missing college, name or program, or the college code or program is not recognized.' });
        continue;
      }
      if (program && !(REG_PROGRAM_COLLEGES[college] || []).includes(program)) {
        result.errors.push({ line, error: program + ' is not offered by ' + college + '.' });
        continue;
      }
      if (major === null) {
        result.errors.push({ line, error: 'Choose a major from the list for ' + program + '.' });
        continue;
      }
      let studentNo = String(r.student_no || '').trim();
      if (studentNo && !/^\d{4}-\d-\d{7}-\d{2}$/.test(studentNo)) {
        result.errors.push({ line, error: 'Student number must look like 2025-1-0000000-01.' });
        continue;
      }
      if (!studentNo) { seq += 1; studentNo = prefix + String(seq).padStart(7, '0') + '-01'; }
      const birthday = String(r.birthday || '').trim() || null;
      const yearLevel = Number(r.year_level) || 1;
      await client.query('SAVEPOINT row_save');
      try {
        await client.query(
          `INSERT INTO reg_students (student_no, college, first_name, middle_name, last_name, gender, birthday, email, contact_number, program, year_level, section, status, enrolled_at, major)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'enrolled', now(), $13)`,
          [studentNo, college, first, String(r.middle_name || '').trim().slice(0, 100) || null, last,
           String(r.gender || '').trim().slice(0, 10) || null, birthday,
           String(r.email || '').trim().toLowerCase().slice(0, 254) || null,
           String(r.contact_number || '').trim().slice(0, 11) || null,
           program, yearLevel, String(r.section || 'A').trim().slice(0, 10) || 'A', major]);
        await client.query('RELEASE SAVEPOINT row_save');
        result.created += 1;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT row_save');
        result.errors.push({ line, error: err.code === '23505' ? 'Student number already exists.' : 'Could not save this row. Check the birthday format (YYYY-MM-DD).' });
      }
    }
    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Upload failed.' });
  } finally {
    client.release();
  }
});

// Grades list: a college registrar sees only their own college; the University Registrar sees any college.
app.get('/api/registrar/grades', requireRegistrar, async (req, res) => {
  const college = req.reg.role === 'registrar' ? req.reg.college : String(req.query.college || '');
  if (college && !REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
  const status = String(req.query.status || '');
  const where = [];
  const args = [];
  if (college) { args.push(college); where.push('g.college = $' + args.length); }
  if (['submitted', 'approved'].includes(status)) { args.push(status); where.push('g.status = $' + args.length); }
  try {
    const { rows } = await pool.query(
      `SELECT g.student_no, g.college, g.course_code, g.final_grade, g.remarks, g.instructor, g.term, g.academic_year, g.status, g.updated_at, g.approved_at,
              st.first_name, st.last_name, st.program
       FROM reg_grades g JOIN reg_students st ON st.student_no = g.student_no
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY g.college, st.last_name, st.first_name, g.academic_year, g.term, g.course_code`, args);
    res.json({ grades: rows.filter((g) => !isHiddenStudentRow(g)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load grades.' });
  }
});

// Activity log (University Registrar only).
app.get('/api/registrar/logs', requireSuperAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT at, actor, action, detail, ip FROM reg_logs ORDER BY at DESC LIMIT 500');
  res.json({ logs: rows.filter((l) => !isHiddenLogRow(l)) });
});

// Student records: search students across colleges, and see one student's grades (University Registrar).
app.get('/api/registrar/student-search', requireSuperAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ students: [] });
  const { rows } = await pool.query(
    `SELECT student_no, first_name, last_name, college, program, year_level, section, status FROM reg_students
     WHERE student_no ILIKE $1 OR last_name ILIKE $1 OR first_name ILIKE $1
     ORDER BY college, last_name, first_name LIMIT 100`, ['%' + q + '%']);
  res.json({ students: rows.filter((s) => !isHiddenStudentRow(s)) });
});
app.get('/api/registrar/student-grades', requireSuperAdmin, async (req, res) => {
  const studentNo = String(req.query.student_no || '').trim();
  const { rows } = await pool.query(
    `SELECT course_code, final_grade, term, academic_year, status, approved_at FROM reg_grades
     WHERE student_no = $1 ORDER BY academic_year, term, course_code`, [studentNo]);
  res.json({ grades: rows });
});

// ---- Certificates of grades ----
// Subject lists: each college registrar uploads its own subjects with units.
// Grading scale (same as the University's grading system used by CONM).
const ALLOWED_GRADES = ['1.00', '1.25', '1.50', '1.75', '2.00', '2.25', '2.50', '2.75', '3.00', '4.00', '5.00', 'X', 'INC', 'W', 'NG', ''];
function computeServerRemark(grade) {
  const passed = ['1.00', '1.25', '1.50', '1.75', '2.00', '2.25', '2.50', '2.75', '3.00'];
  if (passed.includes(grade)) return 'PASSED';
  if (grade === '4.00') return 'CONDITIONAL';
  if (grade === '5.00') return 'FAILED';
  if (grade === 'X') return 'ABSENT FROM EXAMINATION';
  if (grade === 'INC') return 'INCOMPLETE';
  if (grade === 'W') return 'DROPPED';
  if (grade === 'NG') return 'NO GRADE';
  return '';
}
function normalizeGrade(raw) {
  if (!raw || String(raw).trim() === '') return '';
  let c = String(raw).trim().toUpperCase();
  if (/^\d+(\.\d+)?$/.test(c)) { const n = Number(c); if (n >= 1 && n <= 5) c = n.toFixed(2); }
  if (ALLOWED_GRADES.includes(c)) return c;
  throw new Error('Invalid grade: ' + raw);
}
const remarksFor = computeServerRemark;
function docVerifyKey() { return process.env.DOC_VERIFY_KEY || process.env.SESSION_SECRET || ''; }
function integrityCode(studentNo, ay, term, rows) {
  const canon = rows.map((r) => [r.course_code, r.final_grade, r.remarks, r.units, r.term, r.academic_year].join('|')).sort().join('\n');
  const mac = crypto.createHmac('sha256', docVerifyKey()).update(`${studentNo}\n${ay}\n${term}\n${canon}`).digest('hex').slice(0, 20).toUpperCase();
  return mac.match(/.{4}/g).join('-');
}
function computeGwa(rows) {
  let points = 0, units = 0;
  for (const r of rows) {
    const g = parseFloat(r.final_grade), u = parseFloat(r.units);
    if (!isNaN(g) && !isNaN(u) && u > 0) { points += g * u; units += u; }
  }
  return units > 0 ? (points / units).toFixed(2) : '';
}
// Approved grades of a student, joined with the college's subject list, grouped by academic year and term.
async function loadCertificateTerms(studentNo, onlyAy, onlyTerm) {
  const st = await pool.query('SELECT student_no, first_name, middle_name, last_name, college, program, year_level, section FROM reg_students WHERE student_no = $1', [studentNo]);
  if (!st.rows.length) return null;
  const g = await pool.query(
    `SELECT g.course_code, g.final_grade, g.remarks, g.term, g.academic_year, COALESCE(c.descriptive_title, '') AS descriptive_title, COALESCE(c.units, 0) AS units
     FROM reg_grades g LEFT JOIN reg_courses c ON c.college = g.college AND c.course_code = g.course_code
     WHERE g.student_no = $1 AND g.status = 'approved' ORDER BY g.academic_year, g.term, g.course_code`, [studentNo]);
  const groups = new Map();
  for (const r of g.rows) {
    const k = r.academic_year + '|' + r.term;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...r, remarks: r.remarks || computeServerRemark(r.final_grade) });
  }
  const terms = [];
  for (const [k, rows] of groups) {
    const [ay, term] = k.split('|');
    if (onlyAy && onlyTerm && (ay !== onlyAy || term !== onlyTerm)) continue;
    terms.push({ academic_year: ay, term, rows, gwa: computeGwa(rows), units_total: rows.reduce((a, r) => a + (parseFloat(r.units) || 0), 0), code: integrityCode(studentNo, ay, term, rows) });
  }
  return { student: st.rows[0], terms };
}
// The student (own record) or the University Registrar (any student) gets the certificate data.
app.get('/api/portal/certificate', async (req, res) => {
  const reg = readRegSession(req);
  const portal = readPortalSession(req);
  let studentNo = String(req.query.student_no || '').trim();
  const isStudent = portal && portal.role === 'student' && !portal.mc;
  if (!isStudent && !(reg && (reg.role === 'superadmin' || reg.role === 'registrar'))) return res.status(401).json({ error: 'Not logged in.' });
  if (isStudent) studentNo = portal.student_no;
  if (!studentNo) return res.status(400).json({ error: 'Student number is required.' });
  try {
    const data = await loadCertificateTerms(studentNo, String(req.query.ay || ''), String(req.query.term || ''));
    if (!data) return res.status(404).json({ error: 'Student not found.' });
    if (reg && reg.role === 'registrar' && data.student.college !== reg.college) return res.status(403).json({ error: 'This student belongs to another college.' });
    res.json({ student: data.student, terms: data.terms, issued: new Date().toISOString().slice(0, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the certificate.' });
  }
});
// Public check of a printed certificate (from its QR code or typed code).
app.get('/verify-document', async (req, res) => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sid = String(req.query.sid || '').trim();
  const ay = String(req.query.ay || '').trim();
  const term = String(req.query.term || '').trim();
  const code = String(req.query.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const page = (body) => res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verify certificate</title></head><body style="font-family:Arial,sans-serif;max-width:560px;margin:30px auto;padding:0 16px">${body}</body></html>`);
  if (!sid || !ay || !term || !code) {
    return page(`<h2>Verify a certificate of grades</h2><form method="GET" action="/verify-document">
      <p><label>Student number<br><input name="sid" value="${esc(sid)}" style="width:100%;padding:6px"></label></p>
      <p><label>Academic year (e.g. 2026-2027)<br><input name="ay" value="${esc(ay)}" style="width:100%;padding:6px"></label></p>
      <p><label>Term (1st or 2nd)<br><input name="term" value="${esc(term)}" style="width:100%;padding:6px"></label></p>
      <p><label>Verification code<br><input name="code" value="${esc(code)}" style="width:100%;padding:6px"></label></p>
      <button type="submit" style="padding:8px 14px">Verify</button></form>`);
  }
  try {
    const data = await loadCertificateTerms(sid, ay, term);
    const t = data && data.terms[0];
    const a = Buffer.from(t ? t.code : 'x'), b = Buffer.from(code);
    if (t && a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return page(`<h2 style="color:#047857">Valid</h2><p>This certificate matches the approved grade records for student number <b>${esc(sid)}</b>, A.Y. ${esc(ay)}, ${esc(term)} term.</p>`);
    }
    return page(`<h2 style="color:#b91c1c">Does not match</h2><p>This code does not match the current records for student number <b>${esc(sid)}</b>, A.Y. ${esc(ay)}, ${esc(term)} term. The certificate may have been changed or the grades may have changed since it was issued.</p>`);
  } catch (err) {
    console.error('verify error:', err);
    return page('<h2>Error</h2><p>Could not check this certificate right now.</p>');
  }
});

// Subject lists per college: a college registrar uploads its own; the University Registrar can upload for any college.
app.get('/api/registrar/courses', requireRegistrar, async (req, res) => {
  const college = req.reg.role === 'registrar' ? req.reg.college : String(req.query.college || '');
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
  const { rows } = await pool.query('SELECT course_code, descriptive_title, units, year_level, semester FROM reg_courses WHERE college = $1 ORDER BY year_level NULLS LAST, course_code', [college]);
  res.json({ college, courses: rows });
});
app.post('/api/registrar/courses/batch', requireRegistrar, async (req, res) => {
  const college = req.reg.role === 'registrar' ? req.reg.college : String((req.body || {}).college || '');
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
  const rows = parseCsvText((req.body || {}).csv);
  if (!rows.length) return res.status(400).json({ error: 'The CSV file is empty.' });
  if (rows.length > 1000) return res.status(400).json({ error: 'Upload at most 1000 subjects at a time.' });
  const errors = [], clean = [], seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 2;
    const code = String(r.course_code || '').trim().toUpperCase().slice(0, 50);
    const title = String(r.descriptive_title || r.title || '').trim().slice(0, 200);
    const units = Number(r.units);
    if (!code) return errors.push(`Row ${line}: course_code is required.`);
    if (!title) return errors.push(`Row ${line}: descriptive_title is required.`);
    if (!Number.isFinite(units) || units < 0 || units > 99) return errors.push(`Row ${line}: units must be a number from 0 to 99.`);
    if (seen.has(code)) return errors.push(`Row ${line}: ${code} appears twice in the file.`);
    const yl = String(r.year_level || '').trim();
    const yearLevel = yl === '' ? null : Number(yl);
    if (yearLevel !== null && (!Number.isInteger(yearLevel) || yearLevel < 1 || yearLevel > 4)) return errors.push(`Row ${line}: year_level must be 1 to 4.`);
    const semester = String(r.semester || '').trim() || null;
    if (semester && !REG_SEMESTERS.includes(semester)) return errors.push(`Row ${line}: semester must be 1st Semester, 2nd Semester or Summer.`);
    seen.add(code);
    clean.push({ code, title, units, yearLevel, semester });
  });
  if (errors.length) return res.status(400).json({ error: 'Nothing was saved. Fix these rows and upload again.', errors });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of clean) {
      await client.query(
        `INSERT INTO reg_courses (college, course_code, descriptive_title, units, year_level, semester) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (college, course_code) DO UPDATE SET descriptive_title = EXCLUDED.descriptive_title, units = EXCLUDED.units, year_level = EXCLUDED.year_level, semester = EXCLUDED.semester`,
        [college, c.code, c.title, c.units, c.yearLevel, c.semester]);
    }
    await client.query('COMMIT');
    logAction(req, req.reg.role === 'registrar' ? college + ' registrar' : 'University Registrar', 'subjects uploaded', college + ': ' + clean.length + ' subject(s)');
    res.json({ ok: true, saved: clean.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Nothing was saved because of a server error.' });
  } finally {
    client.release();
  }
});

// Activity log (University Registrar only).
app.get('/api/registrar/logs', requireSuperAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT at, actor, action, detail, ip FROM reg_logs ORDER BY at DESC LIMIT 500');
  res.json({ logs: rows.filter((l) => !isHiddenLogRow(l)) });
});

// Student records: search students across colleges, and see one student's grades (University Registrar).
app.get('/api/registrar/student-search', requireSuperAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ students: [] });
  const { rows } = await pool.query(
    `SELECT student_no, first_name, last_name, college, program, year_level, section, status FROM reg_students
     WHERE student_no ILIKE $1 OR last_name ILIKE $1 OR first_name ILIKE $1
     ORDER BY college, last_name, first_name LIMIT 100`, ['%' + q + '%']);
  res.json({ students: rows.filter((s) => !isHiddenStudentRow(s)) });
});
app.get('/api/registrar/student-grades', requireSuperAdmin, async (req, res) => {
  const studentNo = String(req.query.student_no || '').trim();
  const { rows } = await pool.query(
    `SELECT course_code, final_grade, term, academic_year, status, approved_at FROM reg_grades
     WHERE student_no = $1 ORDER BY academic_year, term, course_code`, [studentNo]);
  res.json({ grades: rows });
});

// Certificate of grades: approved grades only. The University Registrar can print any student's; a student only their own.
app.get('/api/portal/certificate', async (req, res) => {
  const reg = readRegSession(req);
  const portal = readPortalSession(req);
  let studentNo = String(req.query.student_no || '').trim();
  if (reg && reg.role === 'superadmin') { /* any student */ }
  else if (portal && portal.role === 'student' && !portal.mc) studentNo = portal.student_no;
  else return res.status(401).json({ error: 'Not logged in.' });
  if (!studentNo) return res.status(400).json({ error: 'Student number is required.' });
  try {
    const st = await pool.query('SELECT student_no, first_name, middle_name, last_name, college, program, year_level, section FROM reg_students WHERE student_no = $1', [studentNo]);
    if (!st.rows.length) return res.status(404).json({ error: 'Student not found.' });
    const g = await pool.query(
      "SELECT course_code, final_grade, term, academic_year FROM reg_grades WHERE student_no = $1 AND status = 'approved' ORDER BY academic_year, term, course_code", [studentNo]);
    res.json({ student: st.rows[0], grades: g.rows, issued: new Date().toISOString().slice(0, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the certificate.' });
  }
});

// University Registrar approves a college's submitted grades (all of them, or only one academic year).
app.post('/api/registrar/grades/approve', (req, res, next) => {
  const s = readRegSession(req);
  if (!s || !(s.role === 'superadmin' || s.records)) return res.status(403).json({ error: 'University Registrar only.' });
  req.reg = s;
  next();
}, async (req, res) => {
  const college = req.reg.records ? req.reg.college : String((req.body || {}).college || '');
  const ay = String((req.body || {}).academic_year || '');
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
  try {
    const r = ay
      ? await pool.query("UPDATE reg_grades SET status = 'approved', approved_at = now() WHERE college = $1 AND status = 'submitted' AND academic_year = $2", [college, ay])
      : await pool.query("UPDATE reg_grades SET status = 'approved', approved_at = now() WHERE college = $1 AND status = 'submitted'", [college]);
    logAction(req, 'University Registrar', 'grades approved', college + (ay ? ' ' + ay : '') + ': ' + r.rowCount);
    const affected = await pool.query('SELECT DISTINCT student_no FROM reg_grades WHERE college = $1', [college]);
    await runStep1(affected.rows.map((x) => x.student_no)).catch((err) => console.error(err));
    res.json({ ok: true, approved: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not approve the grades.' });
  }
});

// Approve only the grades ticked in the Grades Approval table (University Registrar only).
app.post('/api/registrar/grades/approve-selected', (req, res, next) => {
  const s = readRegSession(req);
  if (!s || !(s.role === 'superadmin' || s.records)) return res.status(403).json({ error: 'University Registrar only.' });
  req.reg = s;
  next();
}, async (req, res) => {
  const college = req.reg.records ? req.reg.college : String((req.body || {}).college || '');
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
  const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 2000) : [];
  const clean = items.map((x) => ({
    no: String((x && x.student_no) || '').trim(), code: String((x && x.course_code) || '').trim(),
    ay: String((x && x.academic_year) || '').trim(), term: String((x && x.term) || '').trim()
  })).filter((x) => x.no && x.code && x.ay && x.term);
  if (!clean.length) return res.status(400).json({ error: 'Tick at least one grade.' });
  try {
    const r = await pool.query(
      `UPDATE reg_grades g SET status = 'approved', approved_at = now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS k(no, code, ay, term)
        WHERE g.college = $1 AND g.status = 'submitted'
          AND g.student_no = k.no AND g.course_code = k.code AND g.academic_year = k.ay AND g.term = k.term`,
      [college, clean.map((x) => x.no), clean.map((x) => x.code), clean.map((x) => x.ay), clean.map((x) => x.term)]);
    logAction(req, 'University Registrar', 'grades approved (selected)', college + ': ' + r.rowCount);
    const affected = [...new Set(clean.map((x) => x.no))];
    await runStep1(affected).catch((err) => console.error(err));
    res.json({ ok: true, approved: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not approve the selected grades.' });
  }
});

// Activity log: sign-ins, password changes, account creation, grade saves and approvals.
function logAction(req, actor, action, detail) {
  const ip = String(req && req.ip || '').slice(0, 64);
  pool.query('INSERT INTO reg_logs (actor, action, detail, ip) VALUES ($1,$2,$3,$4)', [String(actor || '').slice(0, 150), action, String(detail || '').slice(0, 500), ip])
    .catch((err) => console.error('reg_logs:', err.message));
}

// ---- Portal logins for faculty and students (accounts created by the University Registrar) ----
const PORTAL_SESSION_MS = 5 * 60 * 1000;
function setPortalCookie(req, res, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + PORTAL_SESSION_MS })).toString('base64url');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `portal_session=${body}.${signSession(body)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}
function readPortalSession(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('portal_session='));
  if (!raw) return null;
  const m = raw.slice('portal_session='.length).match(/^(.+)$/);
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = signSession(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!d.exp || d.exp < Date.now()) return null;
    return { id: d.id, role: d.role, college: d.college || null, student_no: d.student_no || null, name: d.name || '', mc: !!d.mc };
  } catch { return null; }
}
function requirePortal(role) {
  return (req, res, next) => {
    const s = readPortalSession(req);
    if (!s || (role && s.role !== role)) return res.status(401).json({ error: 'Not logged in.' });
    if (s.mc) return res.status(403).json({ error: 'You must change your temporary password first.', must_change: true });
    req.portal = s;
    next();
  };
}

app.post('/api/portal/login', async (req, res) => {
  const username = String((req.body || {}).username || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });
  try {
    // The University Registrar's superadmin login also opens the test faculty or student account, for the portal it was used on.
    const portal = String((req.body || {}).portal || '');
    const suU = String(process.env.SUPER_ADMIN_USERNAME || '').trim().toLowerCase();
    const suP = process.env.SUPER_ADMIN_PASSWORD || '';
    const viaSuper = !!(suU && suP && regSafeEqual(username, suU) && regSafeEqual(password, suP));
    let lookupName = username;
    if (viaSuper) {
      lookupName = portal === 'faculty' ? String(process.env.TEST_FACULTY_USERNAME || '').trim().toLowerCase()
        : portal === 'student' ? String(process.env.TEST_STUDENT_NO || '').trim().toLowerCase() : '';
      if (!lookupName) return res.status(400).json({ error: 'The test account for this portal is not set up.' });
    }
    const { rows } = await pool.query('SELECT id, role, password_hash, college, student_no, name, must_change_password FROM reg_users WHERE username = $1 AND archived_at IS NULL', [lookupName]);
    if (!rows.length || (!viaSuper && !verifyPassword(password, rows[0].password_hash))) {
      logAction(req, username, 'sign-in failed', 'Wrong username or password');
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    logAction(req, username, 'sign-in', rows[0].role);
    const u = rows[0];
    setPortalCookie(req, res, { id: u.id, role: u.role, college: u.college, student_no: u.student_no, name: u.name, mc: u.must_change_password });
    res.json({ ok: true, role: u.role, must_change: u.must_change_password });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});
app.get('/api/portal/setup', async (req, res) => {
  const info = readSetupToken(req.query.token);
  if (!info) return res.redirect('/CUP-PORTAL/student/login');
  try {
    const { rows } = await pool.query('SELECT id, role, college, student_no, name, must_change_password FROM reg_users WHERE username = $1 AND archived_at IS NULL', [info.u]);
    const u = rows[0];
    if (!u || !u.must_change_password) return res.redirect('/CUP-PORTAL/student/login');
    setPortalCookie(req, res, { id: u.id, role: u.role, college: u.college, student_no: u.student_no, name: u.name, mc: true, rs: info.r });
    res.redirect('/CUP-PORTAL/change-password');
  } catch (err) {
    console.error(err);
    res.redirect('/CUP-PORTAL/student/login');
  }
});
app.post('/api/portal/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'portal_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/portal/me', (req, res) => {
  const s = readPortalSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ ok: true, role: s.role, college: s.college, student_no: s.student_no, name: s.name, must_change: s.mc, reset: !!s.rs });
});

// Change the temporary password (also used on first login). Re-issues the session without the flag.
app.post('/api/portal/change-password', async (req, res) => {
  const s = readPortalSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in.' });
  const current = String((req.body || {}).current || '');
  const next = String((req.body || {}).new || '');
  if (next.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  try {
    const { rows } = await pool.query('SELECT password_hash, must_change_password FROM reg_users WHERE id = $1', [s.id]);
    const viaReset = !!s.rs && !!rows.length && rows[0].must_change_password === true;
    if (!rows.length || (!viaReset && !verifyPassword(current, rows[0].password_hash))) return res.status(401).json({ error: 'Your current password is wrong.' });
    if (verifyPassword(next, rows[0].password_hash)) return res.status(400).json({ error: 'Choose a password different from the current one.' });
    await pool.query('UPDATE reg_users SET password_hash = $1, must_change_password = FALSE, password_changed_at = now() WHERE id = $2', [hashPassword(next), s.id]);
    logAction(req, s.id, 'password changed', 'Portal account ' + s.id);
    setPortalCookie(req, res, { id: s.id, role: s.role, college: s.college, student_no: s.student_no, name: s.name, mc: false });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change the password.' });
  }
});

// University Registrar creates faculty and student accounts.
app.post('/api/registrar/portal-users', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  const role = String(b.role || '');
  const name = String(b.name || '').trim().slice(0, 150);
  const password = String(b.password || '');
  if (!['faculty', 'student'].includes(role)) return res.status(400).json({ error: 'Choose faculty or student.' });
  try {
    const temp = generateTempPassword();
    if (role === 'faculty') {
      const username = await autoStaffUsername(b.first_name, b.last_name);
      const college = String(b.college || '');
      if (!REG_COLLEGES.includes(college) && college !== 'NSTP') return res.status(400).json({ error: 'Choose a valid college.' });
      if (!username || !name) return res.status(400).json({ error: 'Name and username are required.' });
      const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
      const emailProblem = await facultyEmailProblem(email);
      if (emailProblem) return res.status(400).json({ error: emailProblem });
      if (college === 'NSTP') {
        // NSTP Officer: one account with no college, signs in on the NSTP Portal.
        const first = String(b.first_name || '').trim().slice(0, 100), last = String(b.last_name || '').trim().slice(0, 100);
        if (!first || !last) return res.status(400).json({ error: 'Last name and first name are required.' });
        const officer = await pool.query(
          "INSERT INTO accounts (category, first_name, middle_name, last_name, name_extension, email, password_hash, role, college, username, must_change_password) VALUES ('REGISTRAR',$1,'',$2,'',$3,$4,'nstp','',$5,TRUE) RETURNING id",
          [first, last, email, hashPassword(temp), username]);
        logAction(req, 'University Registrar', 'NSTP officer account created', email);
        const sent = await sendStaffWelcome(req, { kind: 'nstp', to: email, name: first + ' ' + last, username, temp });
        return res.json({ ok: true, id: officer.rows[0].id, username, temp_password: temp, email_sent: sent });
      }
      const r = await pool.query(
        'INSERT INTO reg_users (role, username, password_hash, name, college, must_change_password, email) VALUES ($1,$2,$3,$4,$5,TRUE,$6) RETURNING id',
        ['faculty', username, hashPassword(temp), name, college, email]);
      const emailed = await sendStaffWelcome(req, { kind: 'faculty', to: email, name, username, temp, college, link: portalBase(req) + '/api/portal/setup?token=' + encodeURIComponent(setupTokenFor(username)) });
      return res.json({ ok: true, id: r.rows[0].id, username, temp_password: temp, email_sent: emailed });
    }
    const studentNo = String(b.student_no || '').trim();
    const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
    if (!email) return res.status(400).json({ error: 'Enter the student email address.' });
    if (!STRICT_EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const prefix = await activeEnrollPrefix();
    if (!prefix) return res.status(400).json({ error: 'Set the grading period first (Accounts, Grading period).' });
    const st = await pool.query('SELECT student_no, college, program FROM reg_students WHERE student_no = $1 AND student_no LIKE $2', [studentNo, prefix + '%']);
    if (!st.rows.length) return res.status(404).json({ error: 'Student number not found in the active enrollment.' });
    if (b.program && canonicalProgram(b.program) !== canonicalProgram(st.rows[0].program)) {
      return res.status(400).json({ error: 'The program does not match the enrolled record for this student number.' });
    }
    if (b.college && String(b.college) !== st.rows[0].college) {
      return res.status(400).json({ error: 'The college does not match the enrolled record for this student number.' });
    }
    await pool.query('UPDATE reg_students SET email = $2 WHERE student_no = $1', [studentNo, email]);
    const r = await pool.query(
      'INSERT INTO reg_users (role, username, password_hash, name, college, student_no, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id',
      ['student', studentNo.toLowerCase(), hashPassword(temp), name || studentNo, st.rows[0].college, studentNo]);
    sendPortalWelcomeEmails(req, [{ to: email, student_no: studentNo.toLowerCase(), name, temp }]);
    res.json({ ok: true, id: r.rows[0].id, username: studentNo.toLowerCase(), temp_password: temp });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username already has an account.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// University Registrar: list portal accounts (faculty and students), for assigning courses.
app.get('/api/registrar/portal-users', requireSuperAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT u.id, u.role, u.name, u.first_name, u.last_name, u.username, u.college, u.student_no, u.must_change_password, u.archived_at, s.program, s.major, s.year_level FROM reg_users u LEFT JOIN reg_students s ON s.student_no = u.student_no ORDER BY u.role, u.college, u.name");
  res.json({ users: rows.filter((u) => !isHiddenUserRow(u)).map((u) => ({ ...u, program: u.program ? (canonicalProgram(u.program) || u.program) : u.program })) });
});

// Bulk archive / restore / permanent delete of portal accounts (University Registrar).
// Archiving blocks sign-in and keeps grades, records and logs. Deleting removes only the login account
// and its faculty assignments; student records and grades are kept.
function parseIds(body) {
  const list = Array.isArray(body && body.ids) ? body.ids : [];
  const ids = [...new Set(list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
  return ids;
}
app.post('/api/registrar/portal-users/archive', requireSuperAdmin, async (req, res) => {
  const ids = parseIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one account.' });
  try {
    const r = await pool.query('UPDATE reg_users SET archived_at = now() WHERE id = ANY($1::int[]) AND archived_at IS NULL RETURNING username', [ids]);
    logAction(req, 'University Registrar', 'accounts archived', r.rowCount + ' account(s): ' + r.rows.map((x) => x.username).join(', ').slice(0, 300));
    res.json({ ok: true, count: r.rowCount });
  } catch (err) { console.error('archive:', err.message); res.status(500).json({ error: 'Could not archive the accounts.' }); }
});
app.post('/api/registrar/portal-users/restore', requireSuperAdmin, async (req, res) => {
  const ids = parseIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one account.' });
  try {
    const r = await pool.query('UPDATE reg_users SET archived_at = NULL WHERE id = ANY($1::int[]) AND archived_at IS NOT NULL RETURNING username', [ids]);
    logAction(req, 'University Registrar', 'accounts restored', r.rowCount + ' account(s): ' + r.rows.map((x) => x.username).join(', ').slice(0, 300));
    res.json({ ok: true, count: r.rowCount });
  } catch (err) { console.error('restore:', err.message); res.status(500).json({ error: 'Could not restore the accounts.' }); }
});
app.post('/api/registrar/portal-users/delete', requireSuperAdmin, async (req, res) => {
  const ids = parseIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one account.' });
  if (String((req.body || {}).confirm || '') !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT id, username FROM reg_users WHERE id = ANY($1::int[]) AND archived_at IS NOT NULL', [ids]);
    const keep = target.rows.map((x) => x.id);
    if (!keep.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only archived accounts can be deleted.' }); }
    await client.query('DELETE FROM reg_assignments WHERE user_id = ANY($1::int[])', [keep]);
    await client.query('DELETE FROM reg_subject_assignments WHERE user_id = ANY($1::int[])', [keep]);
    // Students whose NSTP instructor was deleted lose that link, and schedule rows of their subjects are cleared.
    await client.query('UPDATE reg_students SET nstp_instructor_id = NULL WHERE nstp_instructor_id = ANY($1::int[])', [keep]);
    await cleanAllOrphanSchedules(client);
    const r = await client.query('DELETE FROM reg_users WHERE id = ANY($1::int[])', [keep]);
    await client.query('COMMIT');
    logAction(req, 'University Registrar', 'accounts deleted', r.rowCount + ' account(s): ' + target.rows.map((x) => x.username).join(', ').slice(0, 300));
    res.json({ ok: true, count: r.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('delete:', err.message);
    res.status(500).json({ error: 'Could not delete the accounts.' });
  } finally { client.release(); }
});

// Reset a portal account's password to a new temporary one (University Registrar).
app.post('/api/registrar/portal-users/:id/reset-password', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid account.' });
  const temp = generateTempPassword();
  try {
    const r = await pool.query(
      'UPDATE reg_users SET password_hash = $1, must_change_password = TRUE, password_changed_at = NULL WHERE id = $2 RETURNING role, username, name',
      [hashPassword(temp), id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Account not found.' });
    const acct = r.rows[0];
    logAction(req, 'University Registrar', 'password reset', acct.role + ' ' + acct.username);
    const who = await pool.query(
      'SELECT COALESCE(u.email, s.email) AS email FROM reg_users u LEFT JOIN reg_students s ON s.student_no = u.student_no WHERE u.id = $1', [id]);
    const to = String(who.rows[0] && who.rows[0].email || '').trim();
    if (!to) return res.json({ ok: true, username: acct.username, email_sent: false, no_email: true, temp_password: temp });
    const origin = process.env.PORTAL_BASE_URL || `https://${req.get('host')}`;
    const isStudent = acct.role === 'student';
    const link = origin + '/api/portal/setup?token=' + encodeURIComponent(setupTokenFor(String(acct.username).toLowerCase(), true));
    const idLabel = isStudent ? 'Student number' : 'Username';
    const greet = acct.name ? ' ' + acct.name : '';
    const text = [
      `Hello${greet},`,
      '',
      'Your password has been reset.',
      '',
      `${idLabel}: ${acct.username}`,
      '',
      'Use the "Reset Password" button in this email to set a new password.',
      '',
      'If you did not request this, please contact the Office of the University Registrar.',
    ].join('\n');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.5">
<p>Hello${emailEscape(greet)},</p>
<p>Your password has been reset.</p>
<p>${idLabel}: <strong>${emailEscape(acct.username)}</strong></p>
<p style="margin:24px 0"><a href="${emailEscape(link)}" style="display:inline-block;background:#2d5a1e;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Reset Password</a></p>
<p style="font-size:13px;color:#6b7280">If you did not request this, please contact the Office of the University Registrar.</p>
</div>`;
    try {
      await sendEmail(to, isStudent ? 'Your CUP Student Central Portal Account' : 'Your CUP Central Portal Account', text, { html });
    } catch (err) {
      console.error('Reset email failed for ' + acct.username + ': ' + err.message);
      return res.json({ ok: true, username: acct.username, email_sent: false, temp_password: temp });
    }
    const hint = maskEmail(to);
    return res.json({ ok: true, username: acct.username, email_sent: true, email_hint: hint });
  } catch (err) {
    console.error('reset-password:', err.message);
    res.status(500).json({ error: 'Could not reset the password.' });
  }
});

// Active enrollment period from the Grading period settings. Student numbers look like 2026-1-0000001,
// where 2026 is the enrollment year (the first year of the academic year) and 1 is the semester (1, 2, or 3 for summer).
// Remarks are derived from the final grade, never typed by hand (same rule as the CONM portal).
const REG_GRADES = ['1.00', '1.25', '1.50', '1.75', '2.00', '2.25', '2.50', '2.75', '3.00', '4.00', '5.00', 'X', 'INC', 'W', 'NG'];
const REG_SEMESTERS = ['1st Semester', '2nd Semester', 'Summer'];
function registrarRemark(grade) {
  if (['1.00','1.25','1.50','1.75','2.00','2.25','2.50','2.75','3.00'].includes(grade)) return 'PASSED';
  if (grade === '4.00') return 'CONDITIONAL';
  if (grade === '5.00') return 'FAILED';
  if (grade === 'X') return 'ABSENT FROM EXAMINATION';
  if (grade === 'INC') return 'INCOMPLETE';
  if (grade === 'W') return 'DROPPED';
  if (grade === 'NG') return 'NO GRADE';
  return '';
}

// Which college a registrar request acts on: a college registrar always acts on their own college;
// the University Registrar names the college in the request.
function regCollege(req, given) {
  if (req.reg && req.reg.role === 'registrar') return req.reg.college;
  if (req.reg && req.reg.role === 'superadmin') { const c = String(given || ''); return REG_COLLEGES.includes(c) ? c : null; }
  return null;
}

async function activeEnrollPrefix() {
  const { rows } = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const sem = { '1st Semester': '1', '2nd Semester': '2', 'Summer': '3' }[m.grading_semester];
  const ay = String(m.grading_ay || '').match(/^(\d{4})-\d{4}$/);
  if (!sem || !ay) return null;
  return `${ay[1]}-${sem}-`;
}
app.get('/api/registrar/enrolled-student', requireSuperAdmin, async (req, res) => {
  const prefix = await activeEnrollPrefix();
  if (!prefix) return res.status(400).json({ error: 'Set the grading period first.' });
  const no = String(req.query.no || '').trim();
  const r = await pool.query(
    `SELECT s.student_no, s.last_name, s.first_name, s.middle_name, s.email, s.college, s.program, s.major,
            EXISTS (SELECT 1 FROM reg_users u WHERE u.student_no = s.student_no) AS has_account
       FROM reg_students s WHERE s.student_no = $1 AND s.student_no LIKE $2`, [no, prefix + '%']);
  if (!r.rows.length) return res.json({ found: false });
  const x = r.rows[0];
  res.json({ found: true, student: { ...x, program: canonicalProgram(x.program) || x.program, major: x.major || '' } });
});
app.post('/api/registrar/student-accounts/batch', requireSuperAdmin, async (req, res) => {
  const prefix = await activeEnrollPrefix();
  if (!prefix) return res.status(400).json({ error: 'Set the grading period first (Accounts, Grading period).' });
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 500) return res.status(400).json({ error: 'Enter between 1 and 500 students.' });
  const nos = rows.map((r) => String((r || {}).student_no || '').trim());
  const recs = await pool.query(
    `SELECT s.student_no, s.last_name, s.first_name, s.middle_name, s.college, EXISTS (SELECT 1 FROM reg_users u WHERE u.student_no = s.student_no) AS has_account
       FROM reg_students s WHERE s.student_no = ANY($1::text[]) AND s.student_no LIKE $2`, [nos, prefix + '%']);
  const byNo = new Map(recs.rows.map((r) => [r.student_no, r]));
  const errors = [];
  const seen = new Set();
  const plan = [];
  rows.forEach((raw, i) => {
    const r = raw || {};
    const line = i + 1;
    const sn = String(r.student_no || '').trim();
    if (!sn) return;
    const rec = byNo.get(sn);
    if (seen.has(sn)) return errors.push({ line, error: 'Duplicate student number in this list.' });
    seen.add(sn);
    if (!rec) return errors.push({ line, error: 'Not in the active enrollment.' });
    if (rec.has_account) return errors.push({ line, error: 'This student already has an account.' });
    const last = String(r.last_name || rec.last_name || '').trim().slice(0, 100);
    const first = String(r.first_name || rec.first_name || '').trim().slice(0, 100);
    const middle = String(r.middle_name || rec.middle_name || '').trim().slice(0, 100);
    const email = String(r.email || '').trim().toLowerCase().slice(0, 254);
    if (!email) return errors.push({ line, error: 'Email address is required.' });
    const temp = String(r.temp_password || '');
    if (!last || !first) return errors.push({ line, error: 'Last name and first name are required.' });
    if (!/^(?=(?:.*\d){5})(?=(?:.*[A-Za-z]){2})[A-Za-z0-9]{7}$/.test(temp)) return errors.push({ line, error: 'Temporary password must be 5 digits and 2 letters.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errors.push({ line, error: 'Email address is not valid.' });
    plan.push({ sn, name: last + ', ' + first + (middle ? ' ' + middle : ''), college: rec.college, email, temp, last, first, middle });
  });
  if (errors.length) return res.status(400).json({ error: 'Nothing was created. Fix the rows listed below and try again.', errors });
  if (!plan.length) return res.status(400).json({ error: 'Enter at least one student number.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query(
        'INSERT INTO reg_users (role, username, password_hash, name, college, student_no, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,TRUE)',
        ['student', p.sn.toLowerCase(), hashPassword(p.temp), p.name, p.college, p.sn]);
      if (p.email) await client.query('UPDATE reg_students SET email = $2 WHERE student_no = $1', [p.sn, p.email]);
    }
    await client.query('COMMIT');
    sendPortalWelcomeEmails(req, plan.filter((p) => p.email).map((p) => ({ to: p.email, student_no: p.sn, name: p.name, temp: p.temp })));
    logAction(req, 'University Registrar', 'student accounts created (table)', plan.length + ' account(s)');
    res.json({ ok: true, created: plan.map((p) => ({ student_no: p.sn, name: p.name, college: p.college, temp_password: p.temp })) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'One of these students already has an account. Nothing was created.' });
    console.error('student-accounts batch:', err.message);
    res.status(500).json({ error: 'Could not create the accounts. Nothing was created.' });
  } finally { client.release(); }
});

// ---- Batch accounts (University Registrar): CSV text in, credentials out. All-or-nothing like CONM. ----
function generateTempPassword() {
  // 5 digits and 2 letters, in random order (7 characters).
  const digits = '0123456789';
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const chars = [];
  for (let i = 0; i < 5; i++) chars.push(digits[crypto.randomInt(digits.length)]);
  for (let i = 0; i < 2; i++) chars.push(letters[crypto.randomInt(letters.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
function parseCsvText(text) {
  const rows = [];
  let field = '', row = [], q = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}
app.post('/api/registrar/portal-users/batch', requireSuperAdmin, async (req, res) => {
  const role = String((req.body || {}).role || '');
  if (!['faculty', 'student'].includes(role)) return res.status(400).json({ error: 'Choose faculty or student.' });
  const rows = parseCsvText((req.body || {}).csv);
  if (!rows.length) return res.status(400).json({ error: 'The CSV file is empty.' });
  if (rows.length > 2000) return res.status(400).json({ error: 'Upload at most 2000 rows at a time.' });
  const errors = [];
  const plan = [];
  const seen = new Set();
  try {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = i + 2;
      if (role === 'faculty') {
        const username = String(r.username || '').toLowerCase();
        const college = String(r.college || '').toUpperCase();
        const name = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ').trim();
        if (!username || !r.first_name || !r.last_name) { errors.push(`Row ${line}: username, first_name and last_name are required.`); continue; }
        if (!REG_COLLEGES.includes(college)) { errors.push(`Row ${line}: college '${r.college || ''}' is not recognized.`); continue; }
        if (seen.has(username)) { errors.push(`Row ${line}: username '${username}' appears twice in the file.`); continue; }
        seen.add(username);
        const exists = await pool.query('SELECT 1 FROM reg_users WHERE username = $1', [username]);
        if (exists.rows.length) { errors.push(`Row ${line}: username '${username}' already has an account.`); continue; }
        plan.push({ username, name, college, student_no: null });
      } else {
        const studentNo = String(r.student_no || '').trim();
        if (!studentNo) { errors.push(`Row ${line}: student_no is required.`); continue; }
        const key = studentNo.toLowerCase();
        if (seen.has(key)) { errors.push(`Row ${line}: student number '${studentNo}' appears twice in the file.`); continue; }
        seen.add(key);
        const st = await pool.query('SELECT student_no, first_name, last_name, college FROM reg_students WHERE student_no = $1', [studentNo]);
        if (!st.rows.length) { errors.push(`Row ${line}: student number '${studentNo}' is not in the University enrollment.`); continue; }
        const exists = await pool.query('SELECT 1 FROM reg_users WHERE username = $1', [key]);
        if (exists.rows.length) { errors.push(`Row ${line}: student '${studentNo}' already has an account.`); continue; }
        plan.push({ username: key, name: `${st.rows[0].last_name}, ${st.rows[0].first_name}`, college: st.rows[0].college, student_no: studentNo });
      }
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not check the file.' });
  }
  if (errors.length) return res.status(400).json({ error: 'Nothing was created. Fix these rows and upload again.', errors });

  const client = await pool.connect();
  const created = [];
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      const temp = generateTempPassword();
      await client.query(
        'INSERT INTO reg_users (role, username, password_hash, name, college, student_no, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,TRUE)',
        [role, p.username, hashPassword(temp), p.name, p.college, p.student_no]);
      created.push({ username: p.username, name: p.name, college: p.college, temp_password: temp });
    }
    await client.query('COMMIT');
    logAction(req, 'University Registrar', 'batch accounts', role + ': ' + created.length + ' created');
    res.json({ ok: true, created });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Nothing was created because of a server error. Try again.' });
  } finally {
    client.release();
  }
});

// University Registrar assigns a faculty member a course for a term.
app.post('/api/registrar/assignments', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  const userId = parseInt(b.user_id, 10);
  const course = String(b.course_code || '').trim().slice(0, 50);
  const term = String(b.term || '').trim().slice(0, 10);
  const ay = String(b.academic_year || '').trim();
  if (!userId || !course || !term || !/^\d{4}-\d{4}$/.test(ay)) return res.status(400).json({ error: 'Faculty, course, term and academic year (YYYY-YYYY) are required.' });
  try {
    const u = await pool.query("SELECT college FROM reg_users WHERE id = $1 AND role = 'faculty'", [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Faculty account not found.' });
    await pool.query(
      `INSERT INTO reg_assignments (user_id, college, course_code, term, academic_year) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, course_code, term, academic_year) DO NOTHING`,
      [userId, u.rows[0].college, course, term, ay]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the assignment.' });
  }
});

// ---- Faculty portal: the subjects this faculty member teaches, the class roster and grade encoding ----
function facultyCanTeach(userId, college, code, year, section, term, ay) {
  return pool.query(
    `SELECT 1 FROM reg_subject_assignments WHERE user_id = $1 AND college = $2 AND course_code = $3 AND term = $4 AND academic_year = $5
        AND $6 = ANY(years) AND $7 = ANY(sections) LIMIT 1`,
    [userId, college, code, term, ay, year, section]).then((r) => r.rows.length > 0);
}
async function activeTerm() {
  const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
  const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
  return { term: m.grading_semester || '', ay: m.grading_ay || '' };
}

// Subjects this faculty member teaches in a college, for the active term.
app.get('/api/faculty/college-assignments', requirePortal('faculty'), async (req, res) => {
  const college = String(req.query.college || '');
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const t = await activeTerm();
    if (!t.term || !t.ay) return res.json({ term: '', academic_year: '', assignments: [] });
    const r = await pool.query(
      `SELECT sa.course_code, c.descriptive_title, sa.years, sa.sections
         FROM reg_subject_assignments sa
         LEFT JOIN reg_courses c ON c.college = sa.college AND c.course_code = sa.course_code
        WHERE sa.user_id = $1 AND sa.college = $2 AND sa.term = $3 AND sa.academic_year = $4
        ORDER BY sa.course_code`,
      [req.portal.id, college, t.term, t.ay]);
    res.json({ term: t.term, academic_year: t.ay, assignments: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your subjects.' });
  }
});

// Class roster for one subject, year level and section, with grades on file.
app.get('/api/faculty/sheet', requirePortal('faculty'), async (req, res) => {
  const college = String(req.query.college || '');
  const code = String(req.query.course_code || '').trim();
  const year = Number(req.query.year);
  const section = String(req.query.section || '').trim();
  if (!REG_COLLEGES.includes(college) || !code || !Number.isInteger(year) || !section) return res.status(400).json({ error: 'Choose a subject, year level and section.' });
  try {
    const t = await activeTerm();
    if (!(await facultyCanTeach(req.portal.id, college, code, year, section, t.term, t.ay))) return res.status(403).json({ error: 'This subject is not assigned to you for this year level and section.' });
    const r = await pool.query(
      `SELECT s.student_no, s.last_name, s.first_name, s.middle_name, s.program, e.year_level, e.section,,
              g.final_grade, g.remarks,
              (SELECT u.name FROM reg_subject_assignments sa JOIN reg_users u ON u.id = sa.user_id WHERE sa.user_id = $8::int AND sa.college = $4 AND sa.course_code = $1 AND sa.term = $2 AND sa.academic_year = $3 AND $5 = ANY(sa.years) AND $6 = ANY(sa.sections) LIMIT 1) AS instructor
         FROM reg_enrollments e
         JOIN reg_students s ON s.student_no = e.student_no
         LEFT JOIN reg_grades g ON g.student_no = e.student_no AND g.course_code = $1 AND g.term = $2 AND g.academic_year = $3
        WHERE e.college = $4 AND e.term = $2 AND e.academic_year = $3 AND e.year_level = $5 AND e.section = $6
          AND e.subjects @> $7::jsonb
          AND EXISTS (SELECT 1 FROM reg_subject_assignments sa WHERE sa.user_id = $8::int AND sa.college = $4 AND sa.course_code = $1 AND sa.term = $2 AND sa.academic_year = $3 AND $5 = ANY(sa.years) AND $6 = ANY(sa.sections))
        ORDER BY s.last_name, s.first_name`,
      [code, t.term, t.ay, college, year, section, JSON.stringify([{ course_code: code }]), String(req.portal.id)]);
    res.json({ students: r.rows.filter((s) => !isHiddenStudentRow(s)), term: t.term, academic_year: t.ay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the class roster.' });
  }
});

// Official Report of Grades, filled from the class roster and saved grades (faculty download).
const PDFDocument = require('pdfkit');
const REPORT_SEAL = path.join(__dirname, 'CUP-PORTAL', 'forms', 'seal.jpeg');
// Remarks on the form: 4.00 conditional, 5.00 failed, 3.00 and below passed, INC incomplete, W dropped, X absent from examination.
// Faculty name as "First M.I. Last" (middle initial with a period); falls back to splitting "Last, First Middle".
function facultyDisplayName(u) {
  if (!u) return '';
  const first = String(u.first_name || '').trim();
  const middle = String(u.middle_name || '').trim();
  const last = String(u.last_name || '').trim();
  if (first || last) {
    const mi = middle ? middle.charAt(0).toUpperCase() + '.' : '';
    return [first, mi, last].filter(Boolean).join(' ');
  }
  const n = String(u.name || '').trim();
  if (!n) return '';
  const pieces = n.split(',').map((x) => x.trim());
  return pieces[1] ? pieces[1] + ' ' + pieces[0] : n;
}
function reportRemark(g) {
  if (g == null || g === '') return '';
  const v = String(g).trim();
  if (v === 'INC') return 'INCOMPLETE';
  if (v === 'W') return 'DROPPED';
  if (v === 'X') return 'ABSENT FROM EXAMINATION';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n === 4) return 'CONDITIONAL';
  return n <= 3 ? 'PASSED' : 'FAILED';
}
function reportGrade(g) {
  if (g == null || g === '') return '';
  const n = Number(g);
  return Number.isFinite(n) ? n.toFixed(2) : String(g);
}
// Printed-record workbooks are locked; corrections go through the registrar, not the file.
const XLSX_PROTECT_PASSWORD = process.env.XLSX_PROTECT_PASSWORD || '22262730';
// ----- Certificate of Grades (registrar) -----
const COG_TEMPLATE = path.join(__dirname, 'CUP-PORTAL', 'forms', 'Certificate_of_Grades_Template.xlsx');
const COG_MAX_SUBJECTS = 14; // rows 12-25 of the template; row 26 holds the GPA line
const COG_SPECIAL = new Set(['W', 'X', 'INC', 'NG', '-']);
function cogTermLabel(t) { return ({ '1st Semester': 'First Semester', '2nd Semester': 'Second Semester' })[t] || t; }
function cogStatus(failPct, enrolledUnits, flags) {
  if (flags.misaligned) return 'IRREGULAR';
  if (failPct < 25) return 'REGULAR';
  if (failPct < 50) return 'WARNING';
  if (failPct < 76) return enrolledUnits >= 6 ? 'PROBATION' : 'WARNING';
  return enrolledUnits >= 9 ? 'PERMANENT DISQUALIFICATION' : 'PROBATION';
}
// rows: [{ units, grade, outOfTerm }]. W, X, INC, NG, 4.00 and "-" are failed and carry no units toward GPA.
// flags: { misaligned }. outOfTerm marks subjects that do not belong to this year level and semester.
// GPA rule: every subject with a grade counts, weighted by units.
// Numeric grades use their value. X, W, INC, NG and a dash count as 5.00.
// Failed grades: 5.00, INC, X, W (retention policy) and 4.00. Everything else with a grade passes.
// GPA shows only when the counted units and the passed units are each at least 9.
function cogCompute(rows, flags) {
  let enrolled = 0, failed = 0, counted = 0, passed = 0, sumGU = 0, outUnits = 0;
  rows.forEach((r) => {
    const u = Number(r.units) || 0;
    enrolled += u;
    if (r.outOfTerm) outUnits += u;
    const g = String(r.grade == null ? '' : r.grade).trim();
    if (!g) return; // no grade entered yet
    const numeric = /^\d+(\.\d+)?$/.test(g) && !COG_SPECIAL.has(g);
    const n = numeric ? Number(g) : 5;
    const isPass = !RETENTION_FAIL.includes(g) && g !== '4.00' && g !== '4'; // failed: 5.00, INC, X, W and 4.00
    counted += u; sumGU += n * u;
    if (isPass) passed += u; else failed += u;
  });
  const gpa = counted >= 9 && passed >= 9 ? (sumGU / counted).toFixed(2) : '-';
  const failPct = enrolled > 0 ? (failed / enrolled) * 100 : 0;
  const outOfTermShare = enrolled > 0 ? outUnits / enrolled : 0;
  return { gpa, status: cogStatus(failPct, enrolled, Object.assign({ outOfTermShare }, flags)) };
}
app.get('/api/registrar/certificate-of-grades.xlsx', requireRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  const no = String(req.query.student_no || '').trim();
  const ay = String(req.query.academic_year || '').trim();
  const term = String(req.query.term || '').trim();
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  if (!/^\d{4}-\d-\d{7}-\d{2}$/.test(no) || !ay || !term) return res.status(400).json({ error: 'Open a student and choose the academic year and semester first.' });
  try {
    const st = await pool.query('SELECT student_no, last_name, first_name, middle_name, program, major FROM reg_students WHERE student_no = $1', [no]);
    if (!st.rows.length) return res.status(404).json({ error: 'Student not found.' });
    const s = st.rows[0];
    const en = await pool.query('SELECT year_level, section, subjects FROM reg_enrollments WHERE student_no = $1 AND college = $2 AND academic_year = $3 AND term = $4', [no, college, ay, term]);
    if (!en.rows.length) return res.status(404).json({ error: 'This student has no enrollment for the selected academic year and semester.' });
    const e = en.rows[0];
    const subjects = Array.isArray(e.subjects) ? e.subjects : [];
    if (subjects.length > COG_MAX_SUBJECTS) return res.status(400).json({ error: 'This term has more than ' + COG_MAX_SUBJECTS + ' subjects, which the certificate cannot hold.' });
    const codes = subjects.map((x) => x.course_code);
    const cs = await pool.query('SELECT course_code, descriptive_title, units, year_level, semester FROM reg_courses WHERE course_code = ANY($1) ORDER BY (college = $2) DESC', [codes, college]);
    const course = new Map();
    cs.rows.forEach((c) => { if (!course.has(c.course_code)) course.set(c.course_code, c); });
    const gr = await pool.query('SELECT course_code, final_grade FROM reg_grades WHERE student_no = $1 AND college = $2 AND term = $3 AND academic_year = $4', [no, college, term, ay]);
    const grade = new Map(gr.rows.map((g) => [g.course_code, g.final_grade]));
    const rows = subjects.map((x) => {
      const c = course.get(x.course_code) || {};
      const g = grade.has(x.course_code) ? grade.get(x.course_code) : '';
      const outOfTerm = !!c.course_code && !(Number(c.year_level) === Number(e.year_level) && c.semester === term);
      return { code: x.course_code, units: Number(c.units) || 0, grade: g == null ? '' : String(g), outOfTerm };
    });
    // Year-level alignment: the first enrollment's year level should advance one per academic year.
    const startYr = (v) => parseInt(String(v).split('-')[0], 10);
    const first = await pool.query('SELECT academic_year, year_level FROM reg_enrollments WHERE student_no = $1 ORDER BY academic_year ASC LIMIT 1', [no]);
    const flags = { misaligned: await irregularByBand(no, college, e.year_level) };
    const { gpa, status } = cogCompute(rows, flags);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(COG_TEMPLATE);
    const ws = wb.getWorksheet('COG') || wb.worksheets[0];
    const bold = (cell) => { cell.style = Object.assign({}, cell.style, { font: Object.assign({}, cell.font, { bold: true }) }); };
    const mi = (n) => (n && n.trim() ? ' ' + n.trim()[0].toUpperCase() + '.' : '');
    const program = (s.program || '').match(/\(([^)]+)\)/); // "Bachelor of Science in Nursing (BSN)" -> BSN
    const progCode = program ? program[1] : String(s.program || '');
    ws.getCell('H7').value = s.last_name + ', ' + s.first_name + mi(s.middle_name);
    ws.getCell('K8').value = s.student_no;
    ws.getCell('W8').value = s.major ? progCode + '-' + String(s.major).trim() : progCode;
    ws.getCell('O9').value = ay + ', ' + cogTermLabel(term);

    rows.forEach((r, i) => {
      const row = 12 + i;
      ws.getCell('B' + row).value = i + 1;
      ws.getCell('D' + row).value = r.code;
      { const dc = ws.getCell('D' + row); dc.alignment = Object.assign({}, dc.alignment, { horizontal: 'left' }); }
      { const uc = ws.getCell('N' + row); uc.value = r.units; uc.alignment = Object.assign({}, uc.alignment, { horizontal: 'center', vertical: 'middle' }); }
      ws.getCell('Q' + row).value = r.grade === '' ? '' : (Number.isFinite(Number(r.grade)) ? Number(r.grade).toFixed(2) : r.grade);
      ws.getCell('T' + row).value = reportRemark(r.grade);
    });
    for (let row = 12 + rows.length; row <= 25; row++) {
      ['B', 'D', 'N', 'Q', 'T'].forEach((c) => { ws.getCell(c + row).value = null; });
    }
    ws.getCell('B26').value = rows.length >= 15 ? 15 : null; // row 26 numbers only when used; the marker/GPA row stays clear
    const markRow = 12 + rows.length;
    const mark = ws.getCell('D' + markRow);
    mark.value = '***NOTHING FOLLOWS***';
    mark.style = Object.assign({}, mark.style, { font: Object.assign({}, mark.font, { bold: true, italic: true }) });

    const gpaCell = ws.getCell('Q26');
    gpaCell.value = gpa;
    if (gpa === '-') bold(gpaCell);
    ws.getCell('B27').value = status;
    bold(ws.getCell('B27'));

    const reg = { name: 'UNIVERSITY REGISTRAR' };
    if (req.reg.id) {
      const u = await pool.query('SELECT first_name, middle_name, last_name, name FROM reg_users WHERE id = $1', [req.reg.id]);
      if (u.rows.length) {
        const x = u.rows[0];
        reg.name = x.first_name && x.last_name ? x.first_name + mi(x.middle_name) + ' ' + x.last_name : (x.name || reg.name);
      }
    }
    ws.getCell('A32').value = reg.name.toUpperCase();
    bold(ws.getCell('A32'));

    wb.eachSheet((sh) => sh.protect(XLSX_PROTECT_PASSWORD, { selectLockedCells: true, selectUnlockedCells: true }));
    const file = ('COG_' + no + '_' + ay + '_' + term).replace(/[^A-Za-z0-9_-]+/g, '_') + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + file + '"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('certificate of grades', err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build the certificate of grades.' });
  }
});
// Sheets hold 30 students. Group headers (MALE, FEMALE, ...) sit on a row of their own but are not counted,
// so a sheet with headers runs longer. A header waits for the next student, so it never ends a sheet.
function paginateReport(entries, perPage) {
  const pages = [[]];
  let n = 0, pending = [];
  for (const e of entries) {
    if (!e.st) { pending.push(e); continue; }
    if (n === perPage) { pages.push([]); n = 0; }
    pages[pages.length - 1].push(...pending, e);
    pending = [];
    n += 1;
  }
  return pages;
}

app.get('/api/faculty/report-of-grades.xlsx', requirePortal('faculty'), async (req, res) => {
  const college = String(req.query.college || '');
  const code = String(req.query.course_code || '').trim();
  const year = Number(req.query.year);
  const section = String(req.query.section || '').trim();
  if (!REG_COLLEGES.includes(college) || !code || !Number.isInteger(year) || !section) return res.status(400).json({ error: 'Choose a subject, year level and section first.' });
  try {
    const t = await activeTerm();
    if (!(await facultyCanTeach(req.portal.id, college, code, year, section, t.term, t.ay))) return res.status(403).json({ error: 'This subject is not assigned to you for this year level and section.' });
    const course = await pool.query('SELECT descriptive_title, units FROM reg_courses WHERE college = $1 AND course_code = $2', [college, code]);
    const r = await pool.query(
      `SELECT s.student_no, s.last_name, s.first_name, s.middle_name, s.gender, s.program, s.major, e.year_level,
              g.final_grade,
              (SELECT u.name FROM reg_subject_assignments sa JOIN reg_users u ON u.id = sa.user_id WHERE sa.user_id = $8::int AND sa.college = $4 AND sa.course_code = $1 AND sa.term = $2 AND sa.academic_year = $3 AND $5 = ANY(sa.years) AND $6 = ANY(sa.sections) LIMIT 1) AS instructor
         FROM reg_enrollments e
         JOIN reg_students s ON s.student_no = e.student_no
         LEFT JOIN reg_grades g ON g.student_no = e.student_no AND g.course_code = $1 AND g.term = $2 AND g.academic_year = $3
        WHERE e.college = $4 AND e.term = $2 AND e.academic_year = $3 AND e.year_level = $5 AND e.section = $6
          AND e.subjects @> $7::jsonb
          AND EXISTS (SELECT 1 FROM reg_subject_assignments sa WHERE sa.user_id = $8::int AND sa.college = $4 AND sa.course_code = $1 AND sa.term = $2 AND sa.academic_year = $3 AND $5 = ANY(sa.years) AND $6 = ANY(sa.sections))
        ORDER BY s.last_name, s.first_name`,
      [code, t.term, t.ay, college, year, section, JSON.stringify([{ course_code: code }]), String(req.portal.id)]);
    const FIRST_ROW = 12, LAST_ROW = 41, PER_PAGE = LAST_ROW - FIRST_ROW + 1, TPL_MARK = 42;
    // Males first, then females (each alphabetical), then anyone with no gender recorded.
    const GROUPS = [['MALE', 'Male'], ['FEMALE', 'Female'], ['GENDER NOT SPECIFIED', null]];
    const entries = [];
    GROUPS.forEach(([label, gender]) => {
      const list = r.rows.filter((s) => (gender ? s.gender === gender : s.gender !== 'Male' && s.gender !== 'Female'));
      if (!list.length) return;
      entries.push({ label });
      list.forEach((st) => entries.push({ st }));
    });
    const wb = new ExcelJS.Workbook();
    const tplBook = new ExcelJS.Workbook();
    await tplBook.xlsx.readFile(path.join(__dirname, 'CUP-PORTAL', 'forms', 'Official_Report_of_Grades_Template.xlsx'));
    const tpl = tplBook.getWorksheet('Report of Grades') || tplBook.worksheets[0];
    const c = course.rows[0] || {};
    const instructor = (r.rows[0] && r.rows[0].instructor) || '';
    const pageList = paginateReport(entries, PER_PAGE);
    const pages = pageList.length;
    const extras = pageList.map((sl) => Math.max(0, sl.length - PER_PAGE));
    const firstRow = r.rows[0] || {};
    const firstProg = canonicalProgram(firstRow.program) || firstRow.program || '';
    const progAbbr = (firstProg.match(/\(([^)]+)\)\s*$/) || [null, firstProg])[1] || 'BSN';
    const fu = await pool.query('SELECT name, first_name, middle_name, last_name FROM reg_users WHERE id = $1', [req.portal.id]);
    const facultyName = facultyDisplayName(fu.rows[0]);
    const names = Array.from({ length: pages }, (_, pg) => (pg === 0 ? 'Report of Grades' : 'Report of Grades (' + (pg + 1) + ')'));
    for (let pg = 0; pg < pages; pg++) {
      const last = pg === pages - 1;
      const slice = pageList[pg];
      // Group-header rows push the bottom section down by the same number of rows (extra).
      const extra = extras[pg];
      const R = (n) => (n >= TPL_MARK ? n + extra : n);
      const TM = TPL_MARK + extra, LAST_EFF = LAST_ROW + extra;
      // "Nothing follows" goes directly under the last row of this sheet.
      const markRow = FIRST_ROW + slice.length;
      const at = (addr) => addr.replace(/\d+/, (d) => String(R(Number(d))));
      const name = names[pg];
      const ws = wb.addWorksheet(name, { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      const maxRow = 65;
      for (let rr = 1; rr <= maxRow; rr++) {
        const srcRow = tpl.getRow(rr);
        const dr = R(rr);
        if (srcRow.height) ws.getRow(dr).height = srcRow.height;
        for (let cc = 1; cc <= 27; cc++) {
          const src = tpl.getCell(rr, cc);
          const dst = ws.getCell(dr, cc);
          if (src.value !== null && src.value !== undefined) dst.value = src.value;
          dst.style = src.style;
        }
      }
      // Extra band rows take the style of the last student row.
      for (let k = 1; k <= extra; k++) for (let cc = 1; cc <= 27; cc++) ws.getCell(LAST_ROW + k, cc).style = tpl.getCell(LAST_ROW, cc).style;
      (tpl.model.merges || []).forEach((range) => {
        const top = Number(String(range).match(/\d+/)[0]);
        const t2 = R(top);
        // The template's row-47 merge only moves with the marker when the marker stays on that row.
        // A partial sheet's marker row gets its own A:Z merge below, so the template's row merges there are skipped.
        const skip = markRow !== TM && (t2 === TM || t2 === markRow);
        if (top <= maxRow && !skip) ws.mergeCells(String(range).replace(/\d+/g, (d) => String(R(Number(d)))));
      });
      // Extra band rows repeat the merged cells of the last student row, so their columns line up.
      for (let k = 1; k <= extra; k++) {
        (tpl.model.merges || []).forEach((range) => {
          const top = Number(String(range).match(/\d+/)[0]);
          if (top === LAST_ROW) ws.mergeCells(String(range).replace(/\d+/g, (d) => String(Number(d) + k)));
        });
      }
      if (markRow !== TM) ws.mergeCells('A' + markRow + ':Z' + markRow);
      // Merging drops the borders of the cells inside a merged block, so the bottom section's styles are copied again.
      for (let rr = TPL_MARK + 1; rr <= maxRow; rr++) {
        for (let cc = 1; cc <= 27; cc++) ws.getCell(R(rr), cc).style = tpl.getCell(rr, cc).style;
      }
      // The grading box closes on the right: a thin right border on column Z for its rows (merged title included).
      for (let rr = TPL_MARK + 2; rr <= 53; rr++) {
        const zc = ws.getCell(R(rr), 26);
        zc.border = Object.assign({}, zc.border, { right: { style: 'thin' } });
      }
      tpl.columns.forEach((col, i) => { if (col.width) ws.getColumn(i + 1).width = col.width; });
      // The University seal is a picture in the template, so copy it onto every sheet.
      tpl.getImages().forEach((im) => {
        const media = tplBook.getImage(im.imageId);
        ws.addImage(wb.addImage({ buffer: media.buffer, extension: media.extension }), im.range);
      });
      ws.getCell('E7').value = t.term + ', A.Y. ' + t.ay;
      ws.getCell('S7').value = COLLEGE_FULL_NAMES[college] || college;
      ws.getCell('E8').value = code + (c.descriptive_title ? ' – ' + c.descriptive_title : '');
      ws.getCell('S8').value = c.units != null ? Number(c.units) : '';
      ws.getCell('E9').value = progAbbr + '-' + year + section;
      ws.getCell('S9').value = instructor;
      let seq = pageList.slice(0, pg).flat().filter((e) => e.st).length;
      slice.forEach((entry, i) => {
        const row = FIRST_ROW + i;
        if (entry.label) {
          ws.getCell('A' + row).value = null;
          ws.getCell('E' + row).value = entry.label;
          ws.getCell('E' + row).style = Object.assign({}, ws.getCell('E' + row).style, { font: { bold: true } });
          return;
        }
        const st = entry.st;
        seq += 1;
        ws.getCell('A' + row).value = seq;
        const prog = canonicalProgram(st.program) || st.program || '';
        const abbr = (prog.match(/\(([^)]+)\)\s*$/) || [null, prog])[1];
        ws.getCell('B' + row).value = st.student_no;
        ws.getCell('E' + row).value = st.last_name + ', ' + st.first_name + (st.middle_name ? ' ' + st.middle_name : '');
        ws.getCell('L' + row).value = abbr + ' - ' + st.year_level;
        const g = st.final_grade;
        ws.getCell('O' + row).value = g == null || g === '' ? null : (/^\d+(\.\d+)?$/.test(String(g)) ? Number(g) : String(g));
        ws.getCell('O' + row).numFmt = '0.00';
      });
      {
        // Every sheet ends with the same bottom section. The marker is centered across the row without merging.
        for (let cc = 2; cc <= 27; cc++) ws.getCell(TM, cc).value = null;
        const markStyle = tpl.getCell('A' + TPL_MARK).style;
        for (let cc = 1; cc <= 26; cc++) {
          const cell = ws.getCell(markRow, cc);
          cell.style = Object.assign({}, cell.style, { alignment: { horizontal: 'center', vertical: 'middle' } }, cc === 1 ? { font: markStyle.font } : {});
        }
        ws.getCell('A' + markRow).value = '*** NOTHING FOLLOWS ***';
        for (let rr = markRow + 1; rr <= LAST_EFF; rr++) ws.getCell('A' + rr).value = null;
        if (markRow !== TM) ws.getCell('A' + TM).value = null;
        // Unused rows under the marker stay visible; the bottom section keeps its fixed place.
        ws.getCell(at('A60')).value = facultyName.toUpperCase();
        ws.getCell(at('A60')).style = Object.assign({}, ws.getCell(at('A60')).style, { font: { bold: true, size: 10 }, alignment: { horizontal: 'center', vertical: 'bottom' } });
        // Grade distribution counts every sheet of the class (student numbers, so header rows are not counted).
        const over = (fn) => names.map((n, i) => fn(n, LAST_ROW + extras[i])).join('+');
        ws.getCell(at('D45')).value = { formula: over((n, last) => "COUNTA('" + n + "'!B12:B" + last + ")") };
        ws.getCell(at('D46')).value = { formula: over((n, last) => "COUNTIF('" + n + "'!V12:V" + last + ",\"PASSED\")") };
        ws.getCell(at('D47')).value = { formula: over((n, last) => "COUNTIF('" + n + "'!V12:V" + last + ",\"FAILED\")") };
        ws.getCell(at('D48')).value = { formula: over((n, last) => "COUNTIF('" + n + "'!V12:V" + last + ",\"INCOMPLETE\")") };
        ws.getCell(at('D49')).value = { formula: over((n, last) => "COUNTIF('" + n + "'!V12:V" + last + ",\"DROPPED\")") };
        ws.getCell(at('D50')).value = { formula: over((n, last) => "COUNTIF('" + n + "'!V12:V" + last + ",\"CONDITIONAL\")") };
        ws.getCell(at('D51')).value = { formula: over((n, last) => "COUNTIF('" + n + "'!V12:V" + last + ",\"ABSENT FROM EXAMINATION\")") };
        ws.getCell(at('D52')).value = null;
        ws.getCell(at('D53')).value = null;
      }
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    wb.eachSheet((sh) => sh.protect(XLSX_PROTECT_PASSWORD, { selectLockedCells: true, selectUnlockedCells: true }));
    res.setHeader('Content-Disposition', 'attachment; filename="Official_Report_of_Grades_' + code + '_' + year + section + '.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('report-of-grades:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build the report of grades.' });
  }
});

app.get('/api/faculty/report-of-grades.pdf', requirePortal('faculty'), async (req, res) => {
  const college = String(req.query.college || '');
  const code = String(req.query.course_code || '').trim();
  const year = Number(req.query.year);
  const section = String(req.query.section || '').trim();
  if (!REG_COLLEGES.includes(college) || !code || !Number.isInteger(year) || !section) return res.status(400).json({ error: 'Choose a subject, year level and section first.' });
  try {
    const t = await activeTerm();
    if (!(await facultyCanTeach(req.portal.id, college, code, year, section, t.term, t.ay))) return res.status(403).json({ error: 'This subject is not assigned to you for this year level and section.' });
    const course = await pool.query('SELECT descriptive_title, units FROM reg_courses WHERE college = $1 AND course_code = $2', [college, code]);
    const r = await pool.query(
      `SELECT s.student_no, s.last_name, s.first_name, s.middle_name, s.gender, s.program, s.major, e.year_level,
              g.final_grade,
              (SELECT x->>'instructor_name' FROM jsonb_array_elements(e.subjects) x WHERE x->>'course_code' = $1 LIMIT 1) AS instructor
         FROM reg_enrollments e
         JOIN reg_students s ON s.student_no = e.student_no
         LEFT JOIN reg_grades g ON g.student_no = e.student_no AND g.course_code = $1 AND g.term = $2 AND g.academic_year = $3
        WHERE e.college = $4 AND e.term = $2 AND e.academic_year = $3 AND e.year_level = $5 AND e.section = $6
          AND e.subjects @> $7::jsonb
        ORDER BY s.last_name, s.first_name`,
      [code, t.term, t.ay, college, year, section, JSON.stringify([{ course_code: code }])]);
    // Students: males first, then females (each alphabetical), then anyone with no gender recorded.
    const GROUPS = [['MALE', 'Male'], ['FEMALE', 'Female'], ['GENDER NOT SPECIFIED', null]];
    const entries = [];
    GROUPS.forEach(([label, gender]) => {
      const list = r.rows.filter((s) => (gender ? s.gender === gender : s.gender !== 'Male' && s.gender !== 'Female'));
      if (!list.length) return;
      entries.push({ label });
      list.forEach((st) => entries.push({ st }));
    });
    const PER_PAGE = 30;
    const pageList = paginateReport(entries, PER_PAGE);
    const pages = pageList.length;
    const c = course.rows[0] || {};
    const instructor = (r.rows[0] && r.rows[0].instructor) || '';
    const firstRow = r.rows[0] || {};
    const firstProg = canonicalProgram(firstRow.program) || firstRow.program || '';
    const progAbbr = (firstProg.match(/\(([^)]+)\)\s*$/) || [null, firstProg])[1] || 'BSN';
    const collegeName = COLLEGE_FULL_NAMES[college] || college;
    const fu = await pool.query('SELECT name, first_name, middle_name, last_name FROM reg_users WHERE id = $1', [req.portal.id]);
    const facultyName = facultyDisplayName(fu.rows[0]);
    // Grade distribution counts every student of the class, on every sheet.
    const countRemark = (name) => r.rows.filter((s) => reportRemark(s.final_grade) === name).length;
    const stats = [
      ['Enrolled:', r.rows.length],
      ['Passed:', countRemark('PASSED')],
      ['Failed:', countRemark('FAILED')],
      ['Incomplete:', countRemark('INCOMPLETE')],
      ['Dropped:', countRemark('DROPPED')],
      ['Conditional:', countRemark('CONDITIONAL')],
      ['Absent from Examination:', countRemark('ABSENT FROM EXAMINATION')],
    ];

    // A4 PDF, one page per sheet, with the same layout as the Official Report of Grades form.
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false,
      info: { Title: 'Official Report of Grades - ' + code + ' ' + progAbbr + '-' + year + section, Author: 'City University of Pasay' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Official_Report_of_Grades_' + code + '_' + year + section + '.pdf"');
    doc.pipe(res);

    const L = 20, W = 555, ROW_H = 11, FILL = '#e9efe9';
    const cols = [28, 100, 175, 70, 50, 60, 72]; // No., Student ID, Name, Program & Year, Final Rating, Re-Exam, Remarks
    const colX = [];
    cols.forEach((w, i) => colX.push(i === 0 ? L : colX[i - 1] + cols[i - 1]));
    const box = (x, y, w, h, fill) => {
      if (fill) doc.save().rect(x, y, w, h).fill(fill).restore();
      doc.rect(x, y, w, h).lineWidth(0.5).strokeColor('#8a9a8a').stroke();
    };
    const txt = (str, x, y, w, h, o) => {
      o = o || {};
      const size = o.size || 7.5;
      const font = o.bold ? 'Helvetica-Bold' : o.italic ? 'Helvetica-Oblique' : 'Helvetica';
      doc.font(font).fontSize(size).fillColor('#1d2a1d')
        .text(String(str == null ? '' : str), x + 3, y + (h - size) / 2 - 1, { width: w - 6, align: o.align || 'left', lineBreak: false, ellipsis: true });
    };

    const drawSheet = (pg) => {
      doc.addPage();
      const slice = pageList[pg];
      const sealOk = require('fs').existsSync(REPORT_SEAL);
      if (sealOk) doc.image(REPORT_SEAL, L + 10, 20, { width: 56 });
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text('CITY UNIVERSITY OF PASAY', L, 24, { width: W, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(8).text('(PAMANTASAN NG LUNGSOD NG PASAY)', L, 42, { width: W, align: 'center', lineBreak: false });
      doc.fontSize(7.5).text('Pasadeña St. F.B. Harrison, Pasay City', L, 53, { width: W, align: 'center', lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(12).text('OFFICIAL REPORT OF GRADES', L, 72, { width: W, align: 'center', lineBreak: false });

      // Class details
      const LW = 95, VW = 205, RLW = 95, RVW = W - LW - VW - RLW;
      const info = [
        ['Academic Term / AY:', t.term + ', A.Y. ' + t.ay, 'College / Department:', collegeName],
        ['Course Code & Title:', code + (c.descriptive_title ? ' – ' + c.descriptive_title : ''), 'Credit Units:', c.units != null ? String(Number(c.units)) : ''],
        ['Section & Schedule:', progAbbr + '-' + year + section, 'Instructor / Rank:', instructor],
      ];
      info.forEach((row, i) => {
        const y = 94 + i * 16;
        box(L, y, LW, 16, FILL); box(L + LW, y, VW, 16);
        box(L + LW + VW, y, RLW, 16, FILL); box(L + LW + VW + RLW, y, RVW, 16);
        txt(row[0], L, y, LW, 16, { bold: true, size: 7 });
        txt(row[1], L + LW, y, VW, 16, { size: 8, align: 'center' });
        txt(row[2], L + LW + VW, y, RLW, 16, { bold: true, size: 7 });
        txt(row[3], L + LW + VW + RLW, y, RVW, 16, { size: 8, align: 'center' });
      });

      // Table header
      const TH = 142;
      const heads = ['No.', 'Student ID No.', 'Student Name (Last Name, First Name, M.I.)', 'Program & Year', 'Final Rating', 'Re-Exam / Removal', 'Remarks'];
      heads.forEach((h, i) => { box(colX[i], TH, cols[i], 22, FILL); txt(h, colX[i], TH, cols[i], 22, { bold: true, size: 6.5, align: 'center' }); });

      // Students of this sheet
      let y = TH + 22;
      let seq = pageList.slice(0, pg).flat().filter((e) => e.st).length;
      slice.forEach((entry) => {
        if (entry.label) {
          box(L, y, W, ROW_H);
          txt(entry.label, L, y, W, ROW_H, { bold: true, size: 7 });
          y += ROW_H;
          return;
        }
        const st = entry.st;
        seq += 1;
        const prog = canonicalProgram(st.program) || st.program || '';
        const abbr = (prog.match(/\(([^)]+)\)\s*$/) || [null, prog])[1];
        const values = [
          String(seq),
          st.student_no,
          st.last_name + ', ' + st.first_name + (st.middle_name ? ' ' + st.middle_name : ''),
          abbr + ' - ' + st.year_level,
          reportGrade(st.final_grade),
          '',
          reportRemark(st.final_grade),
        ];
        values.forEach((v, i) => {
          box(colX[i], y, cols[i], ROW_H);
          txt(v, colX[i], y, cols[i], ROW_H, { size: 7, align: i === 2 ? 'left' : 'center', bold: i === 6 });
        });
        y += ROW_H;
      });

      // "Nothing follows" directly under the last student of this sheet
      box(L, y, W, ROW_H);
      txt('*** NOTHING FOLLOWS ***', L, y, W, ROW_H, { italic: true, size: 7, align: 'center' });
      y += ROW_H;

      // Bottom section, right under the marker
      const bY = y + 12;
      box(L, bY, 270, 13, FILL);
      txt('GRADE DISTRIBUTION SUMMARY', L, bY, 270, 13, { bold: true, size: 7, align: 'center' });
      stats.forEach(([label, n], i) => {
        const ry = bY + 13 + i * 11;
        box(L, ry, 170, 11); txt(label, L, ry, 170, 11, { bold: true, size: 7 });
        box(L + 170, ry, 100, 11); txt(n, L + 170, ry, 100, 11, { size: 7, align: 'center' });
      });

      const GX = 300, gcols = [22, 45, 30, 40.5], gRow = 11, gy = bY + 13;
      box(GX, bY, 275, 13, FILL);
      txt('GRADING SYSTEM', GX, bY, 275, 13, { bold: true, size: 7, align: 'center' });
      const leftG = [
        ['1.00', '97-100', 'A+', 'Excellent'], ['1.25', '94-95', 'A', 'Excellent'], ['1.50', '91-93', 'A-', 'Very Good'],
        ['1.75', '88-90', 'B+', 'Very Good'], ['2.00', '85-87', 'B', 'Good'], ['2.25', '82-84', 'B-', 'Good'], ['2.50', '79-81', 'C+', 'Fair'],
      ];
      const rightG = [
        ['2.75', '76-78', 'C', 'Passed'], ['3.00', '75', 'C-', 'Passed'], ['4.00', '70-74', 'F', 'Failed'],
        ['5.00', 'Below 70', '', ''], ['X', 'Absent from Examination', null, null], ['INC', 'Incomplete', null, null], ['W', 'Dropped', null, null],
      ];
      const drawHalf = (x0, rows) => {
        let hx = x0;
        ['No.', 'Percent', 'Letter', 'Descriptive'].forEach((h, i) => {
          box(hx, gy, gcols[i], gRow, FILL); txt(h, hx, gy, gcols[i], gRow, { bold: true, size: 6, align: 'center' }); hx += gcols[i];
        });
        rows.forEach((g, i) => {
          const ry = gy + gRow + i * gRow;
          let cx = x0;
          box(cx, ry, gcols[0], gRow); txt(g[0], cx, ry, gcols[0], gRow, { size: 6.5, align: 'center' }); cx += gcols[0];
          if (g[2] === null) {
            const spanW = gcols[1] + gcols[2] + gcols[3];
            box(cx, ry, spanW, gRow); txt(g[1], cx, ry, spanW, gRow, { size: 6.5, align: 'center' });
            return;
          }
          for (let k = 1; k <= 3; k++) {
            box(cx, ry, gcols[k], gRow); txt(g[k], cx, ry, gcols[k], gRow, { size: 6.5, align: 'center' });
            cx += gcols[k];
          }
        });
      };
      drawHalf(GX, leftG);
      drawHalf(GX + 137.5, rightG);

      // Certification, signatures and no-erasure note
      const cY = bY + 98;
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#1d2a1d').text('I hereby certify that the above grades are true, correct, and computed in accordance with the approved grading system of City University of Pasay.', L, cY, { width: W, lineBreak: false });
      const sY = cY + 22;
      const sigs = [[L, 'Prepared & Submitted by:', 'Signature over Printed Name of Faculty / Date'], [L + 190, 'Verified & Noted by:', 'Department Chair / College Dean / Date'], [L + 380, 'Received & Recorded by:', 'University Registrar / Date']];
      sigs.forEach(([x, head, label]) => {
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#1d2a1d').text(head, x, sY, { width: 170, lineBreak: false });
        doc.moveTo(x, sY + 38).lineTo(x + 170, sY + 38).lineWidth(0.8).strokeColor('#000').stroke();
        doc.font('Helvetica').fontSize(6.5).text(label, x, sY + 41, { width: 170, lineBreak: false });
      });
      if (facultyName) doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(facultyName.toUpperCase(), L, sY + 27, { width: 170, align: 'center', lineBreak: false });
    };

    for (let pg = 0; pg < pages; pg++) drawSheet(pg);
    doc.end();
  } catch (err) {
    console.error('report-of-grades:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build the report of grades.' });
  }
});

// Save grades for a class roster (all or nothing). Remarks are set from the grade, as for registrars.
app.post('/api/faculty/grades/batch', requirePortal('faculty'), async (req, res) => {
  const b = req.body || {};
  const college = String(b.college || '');
  const code = String(b.course_code || '').trim();
  const year = Number(b.year);
  const section = String(b.section || '').trim();
  const grades = Array.isArray(b.grades) ? b.grades : [];
  if (!REG_COLLEGES.includes(college) || !code || !Number.isInteger(year) || !section) return res.status(400).json({ error: 'Choose a subject, year level and section.' });
  if (!grades.length) return res.status(400).json({ error: 'Choose at least one grade.' });
  for (const g of grades) {
    if (g.final_grade && !REG_GRADES.includes(String(g.final_grade))) return res.status(400).json({ error: 'Choose a grade from the list.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await activeTerm();
    if (!t.term || !t.ay) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The grading period is not set.' }); }
    if (!(await facultyCanTeach(req.portal.id, college, code, year, section, t.term, t.ay))) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'This subject is not assigned to you.' }); }
    const roster = await client.query(
      `SELECT student_no FROM reg_enrollments WHERE college = $1 AND term = $2 AND academic_year = $3 AND year_level = $4 AND section = $5 AND subjects @> $6::jsonb`,
      [college, t.term, t.ay, year, section, JSON.stringify([{ course_code: code }])]);
    const allowed = new Set(roster.rows.map((r) => r.student_no));
    const me = await client.query('SELECT name FROM reg_users WHERE id = $1', [req.portal.id]);
    const instructor = (me.rows[0] && me.rows[0].name) || '';
    let saved = 0;
    const touchedNos = new Set();
    for (const g of grades) {
      const no = String(g.student_no || '').trim();
      const grade = String(g.final_grade || '').trim();
      if (!grade || !allowed.has(no)) continue;
      await client.query(
        `INSERT INTO reg_grades (student_no, college, course_code, final_grade, instructor, term, academic_year, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (student_no, course_code, term, academic_year)
         DO UPDATE SET final_grade = EXCLUDED.final_grade, instructor = EXCLUDED.instructor, remarks = EXCLUDED.remarks, updated_at = now(), status = 'submitted', approved_at = NULL`,
        [no, college, code, grade, instructor, t.term, t.ay, registrarRemark(grade)]);
      saved += 1;
      touchedNos.add(no);
    }
    await client.query('COMMIT');
    await runStep1([...touchedNos]).catch((err) => console.error(err));
    logAction(req, req.portal.name || 'faculty', 'grades saved', college + ' ' + code + ' BSN' + year + section + ': ' + saved);
    res.json({ ok: true, saved });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Nothing was saved because of a server error.' });
  } finally {
    client.release();
  }
});


// Student: only grades the University Registrar has approved.
app.get('/api/student/grades', requirePortal('student'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT g.course_code, c.descriptive_title, c.units, g.final_grade, g.remarks, g.term, g.academic_year, g.approved_at
       FROM reg_grades g LEFT JOIN LATERAL (
         SELECT descriptive_title, units FROM reg_courses
          WHERE course_code = g.course_code
          ORDER BY (college = g.college) DESC, college LIMIT 1) c ON true
      WHERE g.student_no = $1 AND g.status = 'approved' ORDER BY g.academic_year, g.term, g.course_code`, [req.portal.student_no]);
  res.json({ grades: rows });
});

// ---- Student status (Retention Policies, section 4.17) ----
// Failure % = units of failed subjects / units enrolled in the term. Failed: 5.00, INC (incomplete), X (absent from examination), W (dropped).
const RETENTION_FAIL = ['5.00', 'INC', 'X', 'W', '4.00', '4'];
function termOrder(term, ay) {
  const rank = /^1st/.test(term) ? 1 : /^2nd/.test(term) ? 2 : 3;
  return ay + '|' + rank;
}
// Result of one evaluated term: the status it moves the student to.
function retentionNext(state, warns, pct) {
  if (state === 'PERMANENT DISQUALIFICATION') return { state, warns };
  if (state === 'PROBATION') {
    if (pct >= 50) return { state: 'PERMANENT DISQUALIFICATION', warns: 0 };
    if (pct === 0) return { state: 'REGULAR', warns: 0 };        // probation lifted after passing all subjects
    return { state: 'PROBATION', warns: 0 };
  }
  if (pct >= 76) return { state: 'PERMANENT DISQUALIFICATION', warns: 0 };
  if (pct >= 50) return { state: 'PROBATION', warns: 0 };
  if (pct >= 25) {
    const w = warns + 1;
    return w >= 2 ? { state: 'PROBATION', warns: 0 } : { state: 'WARNING', warns: w };
  }
  return { state: 'REGULAR', warns: 0 };
}
// IRREGULAR (retention policy): completed units as a share of the college's total curriculum units
// must match the student's year level: under 25% = 1st, 25-50% = 2nd, 51-75% = 3rd, over 75% = 4th.
async function irregularByBand(studentNo, college, yearLevel) {
  const tot = await pool.query('SELECT COALESCE(SUM(units), 0) AS total FROM reg_courses WHERE college = $1', [college]);
  const total = Number(tot.rows[0].total) || 0;
  if (!total) return false;
  const cu = await pool.query('SELECT course_code, units FROM reg_courses WHERE college = $1', [college]);
  const units = new Map(cu.rows.map((c) => [c.course_code, Number(c.units) || 0]));
  const gr = await pool.query('SELECT course_code, final_grade FROM reg_grades WHERE student_no = $1 AND college = $2', [studentNo, college]);
  const notPassed = ['', 'NG', '-', '4.00', '4', ...RETENTION_FAIL];
  let passed = 0;
  gr.rows.forEach((g) => {
    const v = String(g.final_grade == null ? '' : g.final_grade).trim();
    if (notPassed.includes(v)) return;
    passed += units.get(g.course_code) || 0;
  });
  const pct = (passed / total) * 100;
  const band = pct < 25 ? 1 : (pct <= 50 ? 2 : (pct <= 75 ? 3 : 4));
  return band !== Number(yearLevel);
}
async function studentRetentionStatus(studentNo) {
  const st = await pool.query('SELECT college, status, year_level FROM reg_students WHERE student_no = $1', [studentNo]);
  if (!st.rows.length) return null;
  const college = st.rows[0].college;
  const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
  const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
  const en = await pool.query('SELECT term, academic_year, year_level, subjects FROM reg_enrollments WHERE student_no = $1', [studentNo]);
  const gr = await pool.query('SELECT course_code, final_grade, term, academic_year FROM reg_grades WHERE student_no = $1', [studentNo]);
  const cu = await pool.query('SELECT course_code, units, year_level, semester FROM reg_courses WHERE college = $1', [college]);
  const units = new Map(cu.rows.map((c) => [c.course_code, Number(c.units) || 0]));
  const course = new Map(cu.rows.map((c) => [c.course_code, c]));
  const grade = new Map(gr.rows.map((g) => [g.term + '|' + g.academic_year + '|' + g.course_code, g.final_grade]));
  const terms = en.rows.slice().sort((a, b) => (termOrder(a.term, a.academic_year) < termOrder(b.term, b.academic_year) ? -1 : 1));
  const irrBand = await irregularByBand(studentNo, college, st.rows[0].year_level);
  let state = 'REGULAR', warns = 0, last = null, enteringNow = null;
  const currentKey = m.grading_semester && m.grading_ay ? m.grading_semester + '|' + m.grading_ay : '';
  for (const t of terms) {
    const subs = Array.isArray(t.subjects) ? t.subjects : [];
    const key = t.term + '|' + t.academic_year;
    if (key === currentKey) enteringNow = state;
    const total = subs.reduce((n, x) => n + (units.get(x.course_code) || 0), 0);
    const graded = subs.length > 0 && subs.every((x) => { const g = grade.get(key + '|' + x.course_code); return g != null && g !== '' && g !== 'NG'; });
    if (!total || !graded) continue;
    const failed = subs.reduce((n, x) => (RETENTION_FAIL.includes(grade.get(key + '|' + x.course_code)) ? n + (units.get(x.course_code) || 0) : n), 0);
    const pct = Math.round((failed / total) * 100);
    const next = retentionNext(state, warns, pct);
    state = next.state; warns = next.warns;
    last = { term: t.term, academic_year: t.academic_year, pct, status: state };
  }
  const enrolledNow = terms.some((t) => t.term === m.grading_semester && t.academic_year === m.grading_ay);
  const isIrr = () => irrBand;
  if (enrolledNow && enteringNow !== null && !(last && last.term === m.grading_semester && last.academic_year === m.grading_ay)) {
    const irr = isIrr(m.grading_semester, m.grading_ay);
    return { status: irr ? 'IRREGULAR' : enteringNow, basis: 'current', term: m.grading_semester, academic_year: m.grading_ay, enrolled_now: true };
  }
  if (last) {
    const irr = isIrr(last.term, last.academic_year);
    return { status: irr ? 'IRREGULAR' : last.status, basis: 'previous', term: last.term, academic_year: last.academic_year, pct: last.pct, enrolled_now: enrolledNow };
  }
  return { status: 'REGULAR', basis: 'none', term: '', academic_year: '', enrolled_now: enrolledNow };
}
app.get('/api/student/status', requirePortal('student'), async (req, res) => {
  try {
    const r = await studentRetentionStatus(req.portal.student_no);
    if (!r) return res.status(404).json({ error: 'Student record not found.' });
    res.json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the status.' });
  }
});

// ---- Student portal: profile, birthday (once), photo, and password change confirmed by an emailed code ----
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return u.slice(0, 1) + '***@' + d.replace(/^(.).*(\.[^.]+)$/, '$1***$2');
}
app.get('/api/student/profile', requirePortal('student'), async (req, res) => {
  const r = await pool.query(
    `SELECT student_no, first_name, middle_name, last_name, college, program, year_level, section, status, birthday, birthday_changed, email, photo, photo_changed_at
       FROM reg_students WHERE student_no = $1`, [req.portal.student_no]);
  if (!r.rows.length) return res.status(404).json({ error: 'Student record not found.' });
  const s = r.rows[0];
  res.json({
    student_no: s.student_no, first_name: s.first_name, middle_name: s.middle_name || '', last_name: s.last_name,
    college: s.college, college_name: COLLEGE_FULL_NAMES[s.college] || s.college, college_logo: COLLEGE_LOGOS[s.college] || '/images/cup-logo-seal.png',
    program: canonicalProgram(s.program) || s.program, year_level: s.year_level, section: s.section, status: s.status,
    birthday: s.birthday, birthday_changed: s.birthday_changed, email_hint: s.email ? maskEmail(s.email) : '',
    photo: s.photo || null,
    photo_next_change: s.photo_changed_at ? new Date(new Date(s.photo_changed_at).getTime() + PHOTO_CHANGE_DAYS * 86400000).toISOString() : null,
  });
});
app.put('/api/student/birthday', requirePortal('student'), async (req, res) => {
  const b = String((req.body || {}).birthday || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b) || new Date(b) > new Date()) return res.status(400).json({ error: 'Enter a valid birthday.' });
  const r = await pool.query('UPDATE reg_students SET birthday = $2, birthday_changed = TRUE WHERE student_no = $1 AND birthday_changed = FALSE RETURNING student_no', [req.portal.student_no, b]);
  if (!r.rowCount) return res.status(400).json({ error: 'Your birthday can only be edited once. Contact the Registrar to correct it.' });
  logAction(req, 'student ' + req.portal.student_no, 'birthday edited', req.portal.student_no);
  res.json({ ok: true });
});
const PHOTO_CHANGE_DAYS = 30;
app.post('/api/student/photo', requirePortal('student'), async (req, res) => {
  const photo = req.body && req.body.photo;
  if (typeof photo !== 'string' || photo.length > 2800000 || !isImageDataUrl(photo)) return res.status(400).json({ error: 'Upload a JPG or PNG image up to 2 MB.' });
  // The photo can be changed once a month. The first upload is always allowed.
  const r = await pool.query(
    `UPDATE reg_students SET photo = $2, photo_changed_at = now()
      WHERE student_no = $1 AND (photo_changed_at IS NULL OR photo_changed_at < now() - ($3 || ' days')::interval)
      RETURNING student_no`, [req.portal.student_no, photo, String(PHOTO_CHANGE_DAYS)]);
  if (!r.rowCount) {
    const cur = await pool.query('SELECT photo_changed_at FROM reg_students WHERE student_no = $1', [req.portal.student_no]);
    const next = new Date(new Date(cur.rows[0].photo_changed_at).getTime() + PHOTO_CHANGE_DAYS * 86400000);
    return res.status(400).json({ error: 'You can change your photo once a month. You can change it again on ' + next.toISOString().slice(0, 10) + '.' });
  }
  res.json({ ok: true });
});
app.post('/api/student/password/otp', requirePortal('student'), async (req, res) => {
  const st = await pool.query('SELECT email FROM reg_students WHERE student_no = $1', [req.portal.student_no]);
  const email = st.rows[0] && st.rows[0].email;
  if (!email) return res.status(400).json({ error: "No email is registered for your account. Contact the Registrar's Office." });
  try {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO otp_codes (email, code_hash, expires_at, attempts)
       VALUES ($1, $2, now() + interval '10 minutes', 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, verified_at = NULL`,
      [email, hashCode(email, code)]);
    await sendEmail(email, 'Your One-time-PIN (OTP)',
      'Your password change code is ' + code + '. It expires in 10 minutes. If you did not request this, you can ignore this email.');
    res.json({ ok: true, email_hint: maskEmail(email) });
  } catch (err) {
    console.error('Failed to send password code:', err.message);
    res.status(500).json({ error: 'Could not send the code. Please try again.' });
  }
});
app.post('/api/student/password/change', requirePortal('student'), async (req, res) => {
  const b = req.body || {};
  const current = String(b.current || ''), next = String(b.new || ''), otp = String(b.otp || '').trim().slice(0, 6);
  if (next.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  try {
    const st = await pool.query('SELECT email FROM reg_students WHERE student_no = $1', [req.portal.student_no]);
    const email = st.rows[0] && st.rows[0].email;
    if (!email) return res.status(400).json({ error: "No email is registered for your account. Contact the Registrar's Office." });
    const u = await pool.query('SELECT password_hash FROM reg_users WHERE id = $1', [req.portal.id]);
    if (!u.rows.length || !verifyPassword(current, u.rows[0].password_hash)) return res.status(401).json({ error: 'Your current password is wrong.' });
    if (verifyPassword(next, u.rows[0].password_hash)) return res.status(400).json({ error: 'Choose a password different from the current one.' });
    const row = await pool.query('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email = $1', [email]);
    if (!row.rows.length || new Date(row.rows[0].expires_at) < new Date()) return res.status(400).json({ error: 'The code has expired. Please request a new one.' });
    if (row.rows[0].attempts >= 5) return res.status(429).json({ error: 'Too many wrong attempts. Please request a new code.' });
    if (row.rows[0].code_hash !== hashCode(email, otp)) {
      await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return res.status(400).json({ error: 'The code is incorrect.' });
    }
    await pool.query('UPDATE reg_users SET password_hash = $2, must_change_password = FALSE, password_changed_at = now() WHERE id = $1', [req.portal.id, hashPassword(next)]);
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);
    logAction(req, 'student ' + req.portal.student_no, 'password changed', req.portal.student_no);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change the password.' });
  }
});

// College registrar encodes grades for officially enrolled students of their own college only.
app.post('/api/registrar/grades', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const b = req.body || {};
  const studentNo = String(b.student_no || '').trim();
  const course = String(b.course_code || '').trim().slice(0, 50);
  const grade = String(b.final_grade || '').trim().slice(0, 20);
  const instructor = String(b.instructor || '').trim().slice(0, 150);
  const term = String(b.term || '').trim().slice(0, 20);
  const ay = String(b.academic_year || '').trim();
  if (grade && !REG_GRADES.includes(grade)) return res.status(400).json({ error: 'Choose a grade from the list.' });
  if (!studentNo || !course || !term || !/^\d{4}-\d{4}$/.test(ay)) {
    return res.status(400).json({ error: 'Student number, course, term and academic year (YYYY-YYYY) are required.' });
  }
  try {
    const st = await pool.query("SELECT college FROM reg_students WHERE student_no = $1 AND status = 'enrolled'", [studentNo]);
    if (!st.rows.length) return res.status(404).json({ error: 'This student is not officially enrolled.' });
    if (st.rows[0].college !== college) return res.status(403).json({ error: 'This student belongs to another college.' });
    await pool.query(
      `INSERT INTO reg_grades (student_no, college, course_code, final_grade, instructor, term, academic_year, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (student_no, course_code, term, academic_year)
       DO UPDATE SET final_grade = EXCLUDED.final_grade, instructor = EXCLUDED.instructor, remarks = EXCLUDED.remarks, updated_at = now(), status = 'submitted', approved_at = NULL`,
      [studentNo, college, course, grade, instructor, term, ay, registrarRemark(grade)]);
    await runStep1([studentNo]).catch((err) => console.error(err));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the grade.' });
  }
});

// College registrar: complete the record of a student the University has enrolled (student number issued by the University).
app.put('/api/registrar/students/:no', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const no = String(req.params.no || '').trim();
  if (!/^\d{4}-\d-\d{7}-\d{2}$/.test(no)) return res.status(400).json({ error: 'Student number must be in the format xxxx-x-xxxxxxx-xx.' });
  const b = req.body || {};
  const last = String(b.last_name || '').trim().slice(0, 100);
  const first = String(b.first_name || '').trim().slice(0, 100);
  const middle = String(b.middle_name || '').trim().slice(0, 100) || null;
  const gender = ['Male', 'Female'].includes(String(b.gender || '')) ? String(b.gender) : null;
  const birthday = /^\d{4}-\d{2}-\d{2}$/.test(String(b.birthday || '')) ? String(b.birthday) : null;
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254) || null;
  if (!email) return res.status(400).json({ error: 'Email address is required.' });
  const contact = String(b.contact_number || '').trim() || null;
  if (contact && !/^(09\d{9}|\+639\d{9})$/.test(contact)) return res.status(400).json({ error: 'Contact number must be 09XXXXXXXXX or +639XXXXXXXXX.' });
  if (email && !/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const rawProgram = String(b.program || '').trim().slice(0, 200);
  const yearLevel = Number(b.year_level);
  const section = String(b.section || '').trim().slice(0, 10) || 'A';
  if (!last || !first) return res.status(400).json({ error: 'Last name and first name are required.' });
  if (!Number.isInteger(yearLevel) || yearLevel < 1 || yearLevel > 4) return res.status(400).json({ error: 'Choose a year level.' });
  try {
    const st = await pool.query("SELECT college, program FROM reg_students WHERE student_no = $1 AND status = 'enrolled'", [no]);
    if (!st.rows.length) return res.status(404).json({ error: 'This student number has not been issued by the University.' });
    if (st.rows[0].college !== college) return res.status(403).json({ error: 'This student belongs to another college.' });
    const program = rawProgram || st.rows[0].program;
    await pool.query(
      `UPDATE reg_students SET last_name = $2, first_name = $3, middle_name = $4, gender = $5, birthday = $6,
              email = $7, contact_number = $8, program = $9, year_level = $10, section = $11
       WHERE student_no = $1`,
      [no, last, first, middle, gender, birthday, email, contact, program, yearLevel, section]);
    logAction(req, college + ' registrar', 'student record saved', no);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the student record.' });
  }
});

// ---- New Student (enrollment for the active term) ----
// Enrollment context: the active term and A.Y. come from the University's grading period (global settings).
app.get('/api/registrar/enroll-context', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
    const year = Number(req.query.year_level);
  try {
    const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
    const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
    const term = m.grading_semester || '', ay = m.grading_ay || '';
    let subjects = [];
    const section = String(req.query.section || '');
    if (Number.isInteger(year) && year >= 1 && year <= 4) {
      // Only this college's curriculum subjects, across all year levels and semesters.
      const r = await pool.query(
        `SELECT DISTINCT ON (course_code) college, course_code, descriptive_title, units, year_level, semester
         FROM reg_courses
         WHERE college = $1
         ORDER BY course_code, (CASE WHEN semester = $2 THEN 0 ELSE 1 END), year_level NULLS LAST`,
        [college, term]);
      const sorted = r.rows.sort((a, b) => {
        const aCol = a.college === college ? 0 : 1, bCol = b.college === college ? 0 : 1;
        if (aCol !== bCol) return aCol - bCol;
        const aYr = Number(a.year_level) === year ? 0 : 1, bYr = Number(b.year_level) === year ? 0 : 1;
        if (aYr !== bYr) return aYr - bYr;
        return (Number(a.year_level) || 9) - (Number(b.year_level) || 9) || String(a.course_code).localeCompare(String(b.course_code));
      });
      const defaults = term && ay ? await pool.query(
        `SELECT DISTINCT ON (course_code) course_code, user_id FROM reg_subject_assignments
          WHERE college = $1 AND term = $2 AND academic_year = $3 AND ($4 = ANY(years) OR array_length(years, 1) > 0) AND ($5 = ANY(sections) OR $5 = '')
          ORDER BY course_code, (CASE WHEN $4 = ANY(years) THEN 0 ELSE 1 END), id`,
        [college, term, ay, year, section]) : { rows: [] };
      const def = Object.fromEntries(defaults.rows.map((d) => [d.course_code, d.user_id]));
      subjects = sorted.map((x) => ({ ...x, default_instructor_id: def[x.course_code] || null }));
    }
    const f = await pool.query("SELECT id, username, name, first_name, last_name FROM reg_users WHERE role = 'faculty' AND college = $1 AND archived_at IS NULL ORDER BY name", [college]);
    res.json({ term, academic_year: ay, subjects, programs: (REG_PROGRAM_OPTIONS[college] || []).map((o) => o.label), instructors: f.rows.filter((u) => !isHiddenUserRow(u)).map((u) => ({ id: u.id, name: u.name })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the enrollment setup.' });
  }
});

// Enrollment history for one student (college registrar).
// Certificate of Enrollment (Excel), filled from the COE template for an officially enrolled student.
const COE_TEMPLATE = path.join(__dirname, 'CUP-PORTAL', 'forms', 'COE_Template.xlsx');
const COE_STANDING_ABBR = { 'REGULAR': 'REG', 'IRREGULAR': 'IRREG', 'WARNING': 'WARN', 'PROBATION': 'PROB', 'PERMANENT DISQUALIFICATION': 'DISQ' };
app.get('/api/registrar/coe/:no', requireRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  try {
    const no = String(req.params.no || '').trim();
    const st = await pool.query('SELECT * FROM reg_students WHERE student_no = $1 AND college = $2', [no, college]);
    if (!st.rows.length) return res.status(404).json({ error: 'Student not found.' });
    const s = st.rows[0];
    if (s.status !== 'enrolled') return res.status(400).json({ error: 'The student is not officially enrolled yet.' });
    const t = await activeTerm();
    const en = await pool.query('SELECT year_level, section, subjects FROM reg_enrollments WHERE student_no = $1 AND college = $2 AND term = $3 AND academic_year = $4', [no, college, t.term, t.ay]);
    if (!en.rows.length) return res.status(400).json({ error: 'No enrollment for the active term.' });
    const e = en.rows[0];
    const subs = Array.isArray(e.subjects) ? e.subjects : [];
    const codes = subs.map((x) => x.course_code);
    const titles = new Map();
    if (codes.length) {
      const c = await pool.query('SELECT course_code, descriptive_title, units FROM reg_courses WHERE course_code = ANY($1)', [codes]);
      c.rows.forEach((x) => { if (!titles.has(x.course_code)) titles.set(x.course_code, x); });
    }
    const sc = codes.length ? await pool.query(
      'SELECT course_code, days, start_time, end_time, room FROM reg_schedules WHERE college = $1 AND term = $2 AND academic_year = $3 AND year_level = $4 AND section = $5 AND course_code = ANY($6)',
      [college, t.term, t.ay, e.year_level, e.section, codes]) : { rows: [] };
    const ic = codes.length ? await pool.query(
      `SELECT sa.course_code, string_agg(DISTINCT u.name, ', ') AS instructor FROM reg_subject_assignments sa JOIN reg_users u ON u.id = sa.user_id
        WHERE sa.college = $1 AND sa.term = $2 AND sa.academic_year = $3 AND $4 = ANY(sa.years) AND $5 = ANY(sa.sections) AND sa.course_code = ANY($6)
        GROUP BY sa.course_code`,
      [college, t.term, t.ay, e.year_level, e.section, codes]) : { rows: [] };
    const smap = new Map(sc.rows.map((x) => [x.course_code, x]));
    const imap = new Map(ic.rows.map((x) => [x.course_code, x.instructor]));
    const prior = await pool.query('SELECT 1 FROM reg_enrollments WHERE student_no = $1 AND college = $2 AND NOT (term = $3 AND academic_year = $4) LIMIT 1', [no, college, t.term, t.ay]);
    const standing = await studentRetentionStatus(no).catch(() => null);
    const fmtT = (hhmm) => { const m = /^(\d{2}):(\d{2})$/.exec(hhmm || ''); if (!m) return ''; const h = Number(m[1]); return (h % 12 || 12) + ':' + m[2] + ' ' + (h >= 12 ? 'PM' : 'AM'); };

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(COE_TEMPLATE);
    const ws = wb.worksheets[0];
    // White background across the whole certificate.
    const whiteFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    for (let r = 1; r <= 59; r++) {
      for (let c = 1; c <= 33; c++) { ws.getCell(r, c).fill = whiteFill; }
    }
    // Print setup: A4, 0.75 inch margins (top 0.5), whole certificate on one page.
    ws.pageSetup = Object.assign({}, ws.pageSetup, {
      paperSize: 9, // A4
      margins: { left: 0.75, right: 0.75, top: 0.5, bottom: 0.75, header: 0.3, footer: 0.3 },
      fitToPage: true, fitToWidth: 1, fitToHeight: 1,
      printArea: 'A1:AG59'
    });
    const name = [s.last_name, [s.first_name, s.middle_name, s.name_extension].filter((v) => v && String(v).trim()).join(' ')].filter(Boolean).join(', ');
    ws.getCell('A8').value = cogTermLabel(t.term) + ', A.Y. ' + t.ay;
    ws.getCell('F10').value = s.student_no;
    ws.getCell('Q10').value = String(e.year_level) + '-' + String(e.section || '');
    ws.getCell('AB10').value = prior.rows.length ? 'OLD' : 'NEW';
    ws.getCell('F11').value = name.toUpperCase();
    ws.getCell('AB11').value = COE_STANDING_ABBR[standing && standing.status] || (standing && standing.status) || 'REG';
    ws.getCell('F12').value = (COLLEGE_FULL_NAMES[college] || college).toUpperCase();
    // Course: program abbreviation only, e.g. "Bachelor of Science in Nursing (BSN)" -> BSN (with the major after it, e.g. BSBA FINANCIAL MANAGEMENT).
    const progAbbr = ((String(s.program || '').match(/\(([^)]+)\)/) || [])[1] || String(s.program || '')).trim();
    ws.getCell('W12').value = (progAbbr + (s.major ? ' ' + String(s.major).trim() : '')).toUpperCase();
    subs.slice(0, 41).forEach((x, i) => {
      const row = 15 + i;
      const sd = smap.get(x.course_code) || {};
      const tm = sd.start_time && sd.end_time ? fmtT(sd.start_time) + ' - ' + fmtT(sd.end_time) : '';
      const title = x.descriptive_title || (titles.get(x.course_code) || {}).descriptive_title || '';
      const units = x.units != null ? x.units : ((titles.get(x.course_code) || {}).units);
      ws.getCell('A' + row).value = i + 1;
      ws.getCell('B' + row).value = x.course_code;
      ws.getCell('G' + row).value = sd.days || '';
      ws.getCell('J' + row).value = tm;
      ws.getCell('O' + row).value = title;
      ws.getCell('X' + row).value = units == null ? '' : Number(units);
      const inst = imap.get(x.course_code) || '';
      ws.getCell('AA' + row).value = [inst, sd.room ? 'Room ' + sd.room : ''].filter(Boolean).join(' · ');
      // Body of the subject table is 9pt.
      ['A', 'B', 'G', 'J', 'O', 'X', 'AA'].forEach((c) => {
        const cell = ws.getCell(c + row);
        cell.font = Object.assign({}, cell.font, { size: 9 });
      });
    });
    // Fit text in the template's merged cells: header fields shrink to one line; subject cells wrap inside their own cell.
    const colNo = (letters) => letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
    const spanWidth = (from, to) => { let w = 0; for (let i = colNo(from); i <= colNo(to); i++) { w += (ws.getColumn(i).width || 8.43); } return w; };
    const fitHeader = (addr, from, to) => {
      const cell = ws.getCell(addr);
      const v = cell.value == null ? '' : String(cell.value);
      if (!v) return;
      const base = (cell.font && cell.font.size) || 11;
      const W = spanWidth(from, to);
      const need = v.length * 1.35; // uppercase text is wide; be conservative
      const fit = base * W / need;
      // Excel also shrinks the text to fit the cell, so it stays on one line.
      cell.alignment = Object.assign({}, cell.alignment, { wrapText: false, vertical: 'middle', shrinkToFit: true });
      if (fit < base) cell.font = Object.assign({}, cell.font, { size: Math.max(6, Math.floor(fit * 2) / 2) });
    };
    const wrapBody = (addr, from, to, row) => {
      const cell = ws.getCell(addr);
      const v = cell.value == null ? '' : String(cell.value);
      cell.alignment = Object.assign({}, cell.alignment, { wrapText: true, vertical: 'middle' });
      if (!v) return;
      const W = spanWidth(from, to);
      const perLine = W * 11 / 9; // characters per line at 9pt
      const lines = Math.max(1, Math.ceil((v.length * 1.1) / perLine));
      if (lines > 1) {
        const cur = ws.getRow(row).height || 12.75;
        ws.getRow(row).height = Math.max(cur, lines * 11.5);
      }
    };
    [['F10', 'F', 'L'], ['Q10', 'Q', 'V'], ['AB10', 'AB', 'AG'], ['F11', 'F', 'V'], ['AB11', 'AB', 'AG'], ['F12', 'F', 'S'], ['W12', 'W', 'AG'], ['A8', 'A', 'AG']]
      .forEach(([a, f, t2]) => fitHeader(a, f, t2));
    // Student ID, student type and status stay at 9pt.
    ['F10', 'AB10', 'AB11'].forEach((addr) => { const c = ws.getCell(addr); c.font = Object.assign({}, c.font, { size: 9 }); c.alignment = Object.assign({}, c.alignment, { shrinkToFit: false }); });
    for (let row = 15; row <= 15 + Math.min(subs.length, 41) - 1; row++) {
      wrapBody('B' + row, 'B', 'F', row);
      wrapBody('G' + row, 'G', 'I', row);
      wrapBody('J' + row, 'J', 'N', row);
      wrapBody('O' + row, 'O', 'W', row);
      wrapBody('X' + row, 'X', 'Z', row);
      wrapBody('AA' + row, 'AA', 'AG', row);
    }
    const file = ('COE_' + no + '_' + t.ay + '_' + t.term).replace(/[^A-Za-z0-9_-]+/g, '_') + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + file + '"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('certificate of enrollment', err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build the certificate of enrollment.' });
  }
});

app.get('/api/registrar/enrollments', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const no = String(req.query.student_no || '').trim();
  const r = await pool.query(
    'SELECT term, academic_year, year_level, section, subjects, enrolled_at FROM reg_enrollments WHERE student_no = $1 AND college = $2 ORDER BY academic_year DESC, term DESC',
    [no, college]);
  const codes = [...new Set(r.rows.flatMap((e) => (Array.isArray(e.subjects) ? e.subjects : []).map((x) => x.course_code)))];
  const titles = new Map();
  if (codes.length) {
    const c = await pool.query('SELECT course_code, descriptive_title, units FROM reg_courses WHERE course_code = ANY($1)', [codes]);
    c.rows.forEach((x) => { if (!titles.has(x.course_code)) titles.set(x.course_code, { title: x.descriptive_title, units: x.units }); });
  }
  r.rows.forEach((e) => {
    if (Array.isArray(e.subjects)) e.subjects.forEach((x) => {
      const t = titles.get(x.course_code) || {};
      if (!x.descriptive_title) x.descriptive_title = t.title || '';
      if (x.units == null) x.units = t.units == null ? null : Number(t.units);
    });
  });
  // Schedule and instructor of each subject, from the enrollment's own term and section.
  for (const e of r.rows) {
    const subs = Array.isArray(e.subjects) ? e.subjects : [];
    if (!subs.length) continue;
    const codes = subs.map((x) => x.course_code);
    const sc = await pool.query(
      'SELECT course_code, days, start_time, end_time, room FROM reg_schedules WHERE college = $1 AND term = $2 AND academic_year = $3 AND year_level = $4 AND section = $5 AND course_code = ANY($6)',
      [college, e.term, e.academic_year, e.year_level, e.section, codes]);
    const ic = await pool.query(
      `SELECT sa.course_code, string_agg(DISTINCT u.name, ', ') AS instructor FROM reg_subject_assignments sa JOIN reg_users u ON u.id = sa.user_id
        WHERE sa.college = $1 AND sa.term = $2 AND sa.academic_year = $3 AND $4 = ANY(sa.years) AND $5 = ANY(sa.sections) AND sa.course_code = ANY($6)
        GROUP BY sa.course_code`,
      [college, e.term, e.academic_year, e.year_level, e.section, codes]);
    const sm = new Map(sc.rows.map((x) => [x.course_code, x]));
    const im = new Map(ic.rows.map((x) => [x.course_code, x.instructor]));
    subs.forEach((x) => {
      const q = sm.get(x.course_code) || {};
      x.days = q.days || '';
      x.start_time = q.start_time || '';
      x.end_time = q.end_time || '';
      x.room = q.room || '';
      x.instructor = im.get(x.course_code) || '';
    });
  }
  // Old: has enrollment history in an earlier term. New: none.
  const t = await gradingTerm();
  const prior = await pool.query(
    'SELECT 1 FROM reg_enrollments WHERE student_no = $1 AND college = $2 AND NOT (term = $3 AND academic_year = $4) LIMIT 1',
    [no, college, t.term, t.ay]);
  // Academic standing (REGULAR, IRREGULAR, WARNING, PROBATION, PERMANENT DISQUALIFICATION), same rules as the student portal.
  const standingRow = await studentRetentionStatus(no).catch(() => null);
  // Allowable load (retention policy): normal load = total units of this year level and term's curriculum.
  // REGULAR: normal; WARNING: normal - 3; PROBATION: normal - 6; PERMANENT DISQUALIFICATION: not allowed.
  const standingStatus = standingRow ? standingRow.status : '';
  let load = null;
  const curEn = r.rows.find((x) => x.term === t.term && x.academic_year === t.ay);
  if (curEn) {
    const nl = await pool.query('SELECT COALESCE(SUM(units), 0) AS total FROM reg_courses WHERE college = $1 AND year_level = $2 AND (semester = $3 OR semester IS NULL)', [college, curEn.year_level, t.term]);
    const normal = Number(nl.rows[0].total) || 0;
    const enrolled = (Array.isArray(curEn.subjects) ? curEn.subjects : []).reduce((n, x) => n + (Number(x.units) || 0), 0);
    const cut = { WARNING: 3, PROBATION: 6 }[standingStatus] || 0;
    const allowed = standingStatus === 'PERMANENT DISQUALIFICATION' ? 0 : normal - cut;
    load = { standing: standingStatus, normal, allowed, enrolled, over: enrolled > allowed };
  }
  res.json({ enrollments: r.rows, student_type: prior.rows.length ? 'Old' : 'New', standing: standingStatus, load });
});

// Enroll a University-issued student for the active term with the chosen subjects and instructors.
app.post('/api/registrar/enroll-student', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const b = req.body || {};
  const mode = b.mode === 'new' ? 'new' : 'existing';
  let no = String(b.student_no || '').trim();
  if (mode === 'existing' && !/^\d{4}-\d-\d{7}-\d{2}$/.test(no)) return res.status(400).json({ error: 'Student number must be in the format xxxx-x-xxxxxxx-xx.' });
  const last = String(b.last_name || '').trim().slice(0, 100);
  const first = String(b.first_name || '').trim().slice(0, 100);
  const middle = String(b.middle_name || '').trim().slice(0, 100) || null;
  const gender = ['Male', 'Female'].includes(String(b.gender || '')) ? String(b.gender) : null;
  const birthday = /^\d{4}-\d{2}-\d{2}$/.test(String(b.birthday || '')) ? String(b.birthday) : null;
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254) || null;
  if (!email) return res.status(400).json({ error: 'Email address is required.' });
  if (!birthday) return res.status(400).json({ error: 'Birthdate is required to enroll a student.' });
  const contact = String(b.contact_number || '').trim() || null;
  if (contact && !/^(09\d{9}|\+639\d{9})$/.test(contact)) return res.status(400).json({ error: 'Contact number must be 09XXXXXXXXX or +639XXXXXXXXX.' });
  if (email && !/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const yearLevel = Number(b.year_level);
  const section = String(b.section || '').trim().slice(0, 10) || 'A';
  const civil = canonicalCivil(b.civil_status);
  if (await blockIfEnrollmentClosed(req, res)) return;
  const choice = resolveProgramChoice(college, b.program);
  const program = choice ? choice.program : null;
  const major = choice ? choice.major : '';
  const subjects = Array.isArray(b.subjects) ? b.subjects : [];
  if (!last || !first) return res.status(400).json({ error: 'Last name and first name are required.' });
  if (!Number.isInteger(yearLevel) || yearLevel < 1 || yearLevel > 4) return res.status(400).json({ error: 'Choose a year level.' });
  if (mode === 'new') {
    if (!civil) return res.status(400).json({ error: 'Choose the civil status.' });
    if (!choice) return res.status(400).json({ error: 'Choose a program of this college.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const set = await client.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
    const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
    if (!m.grading_semester || !m.grading_ay) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Set the grading period first.' }); }
    if (mode === 'new') {
      // The student number is generated: year from the academic year, semester digit, then unique random digits.
      const ayM = String(m.grading_ay).match(/^(\d{4})-\d{4}$/);
      const semD = { '1st Semester': '1', '2nd Semester': '2', 'Summer': '3' }[m.grading_semester];
      if (!ayM || !semD) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The grading period is not set correctly.' }); }
      no = '';
      for (let i = 0; i < 50 && !no; i++) {
        const cand = `${ayM[1]}-${semD}-${String(crypto.randomInt(0, 10000000)).padStart(7, '0')}-${String(crypto.randomInt(0, 100)).padStart(2, '0')}`;
        const taken = await client.query('SELECT 1 FROM reg_students WHERE student_no = $1', [cand]);
        if (!taken.rows.length) no = cand;
      }
      if (!no) { await client.query('ROLLBACK'); return res.status(500).json({ error: 'Could not generate a student number. Try again.' }); }
      await client.query(
        `INSERT INTO reg_students (student_no, college, last_name, first_name, middle_name, gender, birthday, email, contact_number, program, year_level, section, civil_status, status, enrolled_at, major)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'enrolled',now(),$14)`,
        [no, college, last, first, middle, gender, birthday, email, contact, program, yearLevel, section, civil, major]);
    } else {
      const st = await client.query(
        'SELECT s.college, (SELECT u.archived_at FROM reg_users u WHERE u.student_no = s.student_no LIMIT 1) AS account_archived FROM reg_students s WHERE s.student_no = $1 FOR UPDATE', [no]);
      if (!st.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Student number not found. Use New Student to register a new student.' }); }
      if (st.rows[0].account_archived) { await client.query('ROLLBACK'); return res.status(409).json({ error: "This student's portal account is archived. Restore the account in Accounts first." }); }
      if (st.rows[0].college !== college) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'This student belongs to another college.' }); }
      const already = await client.query('SELECT 1 FROM reg_enrollments WHERE student_no = $1 AND term = $2 AND academic_year = $3', [no, m.grading_semester, m.grading_ay]);
      if (already.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This student is already enrolled for the active term.' }); }
      await client.query(
        `UPDATE reg_students SET last_name = $2, first_name = $3, middle_name = $4, gender = $5, birthday = $6,
                email = $7, contact_number = $8, year_level = $9, section = $10 WHERE student_no = $1`,
        [no, last, first, middle, gender, birthday, email, contact, yearLevel, section]);
    }
    const acct = await client.query('SELECT id FROM reg_users WHERE student_no = $1', [no]);
    let newAccount = false;
    const temp = generateTempPassword();
    if (!acct.rows.length) {
      await client.query(
        'INSERT INTO reg_users (role, username, password_hash, name, college, student_no, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,TRUE)',
        ['student', no.toLowerCase(), hashPassword(temp), [last, first, middle].filter(Boolean).join(' '), college, no]);
      newAccount = true;
    }
    // Validate subjects against all curriculum courses (allowing cross-year and cross-college subjects)
    const curr = await client.query('SELECT course_code, descriptive_title FROM reg_courses ORDER BY (CASE WHEN college = $1 THEN 0 ELSE 1 END)', [college]);
    const titleByCode = new Map();
    curr.rows.forEach((r) => { if (!titleByCode.has(r.course_code)) titleByCode.set(r.course_code, r.descriptive_title); });
    const clean = [];
    const seenSubj = new Set();
    for (const s of subjects) {
      const code = String(s.course_code || '').trim();
      if (!code || seenSubj.has(code)) continue;
      seenSubj.add(code);
      if (!titleByCode.has(code)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Subject ' + code + ' is not in the curriculum catalog.' }); }
      let instructor = null, instructorName = '';
      if (s.instructor_id) {
        const f = await client.query("SELECT id, name FROM reg_users WHERE id = $1 AND role = 'faculty' AND archived_at IS NULL", [Number(s.instructor_id)]);
        if (!f.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Choose a valid faculty instructor.' }); }
        instructor = f.rows[0].id; instructorName = f.rows[0].name;
      }
      clean.push({ course_code: code, descriptive_title: titleByCode.get(code) || '', instructor_id: instructor, instructor_name: instructorName });
    }
    await client.query(
      `INSERT INTO reg_enrollments (student_no, term, academic_year, college, year_level, section, subjects)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (student_no, term, academic_year) DO UPDATE SET year_level = EXCLUDED.year_level, section = EXCLUDED.section, subjects = EXCLUDED.subjects, enrolled_at = now()`,
      [no, m.grading_semester, m.grading_ay, college, yearLevel, section, JSON.stringify(clean)]);
    for (const c of clean) {
      if (!c.instructor_id) continue;
      await client.query(
        `INSERT INTO reg_assignments (user_id, college, course_code, term, academic_year) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, course_code, term, academic_year) DO NOTHING`,
        [c.instructor_id, college, c.course_code, m.grading_semester, m.grading_ay]);
    }
    await client.query('COMMIT');
    if (newAccount && email) sendPortalWelcomeEmails(req, [{ to: email, student_no: no, name: [first, middle, last].filter(Boolean).join(' '), temp }]);
    logAction(req, college + ' registrar', 'student ' + (mode === 'new' ? 'registered and enrolled' : 'enrolled'), no + ' ' + m.grading_semester + ' ' + m.grading_ay);
    res.json({ ok: true, student_no: no, username: no.toLowerCase(), email_sent: !!(newAccount && email) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'That username already has an account.' });
    console.error(err);
    res.status(500).json({ error: 'Could not enroll the student.' });
  } finally {
    client.release();
  }
});


// ---- Faculty (College registrar): register, manage, archive, subject assignments ----
function facultyName(last, first, middle) {
  return [last, [first, middle].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
app.get('/api/registrar/faculty', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  try {
    const u = await pool.query(
      "SELECT id, username, name, first_name, middle_name, last_name, email, archived_at FROM reg_users WHERE role = 'faculty' AND college = $1 ORDER BY archived_at IS NOT NULL, name",
      [college]);
    res.json({ faculty: u.rows.filter((f) => !isHiddenUserRow(f)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load faculty.' });
  }
});

// Faculty email is the address for Forgot Password, so it is required and unique among active faculty.
async function facultyEmailProblem(email, exceptId) {
  if (!email) return 'Enter the faculty email address.';
  if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email)) return 'Enter a valid email address.';
  const taken = await pool.query("SELECT 1 FROM reg_users WHERE role = 'faculty' AND email = $1 AND archived_at IS NULL AND id <> $2", [email, exceptId || 0]);
  if (taken.rowCount) return 'That email is already used by another faculty account.';
  return null;
}

app.post('/api/registrar/faculty', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase().slice(0, 60);
  const temp = String(b.temp_password || '');
  const first = String(b.first_name || '').trim().slice(0, 100);
  const middle = String(b.middle_name || '').trim().slice(0, 100);
  const last = String(b.last_name || '').trim().slice(0, 100);
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) return res.status(400).json({ error: 'Username: 3 to 60 letters, numbers, dots, dashes or underscores.' });
  if (temp.length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
  if (!first || !last) return res.status(400).json({ error: 'First name and last name are required.' });
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  const emailProblem = await facultyEmailProblem(email);
  if (emailProblem) return res.status(400).json({ error: emailProblem });
  try {
    const r = await pool.query(
      `INSERT INTO reg_users (role, username, password_hash, name, first_name, middle_name, last_name, college, must_change_password, email)
       VALUES ('faculty',$1,$2,$3,$4,$5,$6,$7,TRUE,$8) RETURNING id`,
      [username, hashPassword(temp), facultyName(last, first, middle), first, middle || null, last, college, email]);
    logAction(req, college + ' registrar', 'faculty registered', username);
    res.json({ ok: true, id: r.rows[0].id, username });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    console.error(err);
    res.status(500).json({ error: 'Could not register the faculty member.' });
  }
});

app.put('/api/registrar/faculty/:id', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const id = Number(req.params.id);
  const b = req.body || {};
  const first = String(b.first_name || '').trim().slice(0, 100);
  const middle = String(b.middle_name || '').trim().slice(0, 100);
  const last = String(b.last_name || '').trim().slice(0, 100);
  const temp = String(b.temp_password || '');
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Choose a faculty member.' });
  if (!first || !last) return res.status(400).json({ error: 'First name and last name are required.' });
  if (temp && temp.length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  try {
    const f = await pool.query("SELECT id FROM reg_users WHERE id = $1 AND role = 'faculty' AND college = $2", [id, college]);
    if (!f.rows.length) return res.status(404).json({ error: 'Faculty member not found.' });
    const emailProblem = await facultyEmailProblem(email, id);
    if (emailProblem) return res.status(400).json({ error: emailProblem });
    await pool.query(
      `UPDATE reg_users SET name = $2, first_name = $3, middle_name = $4, last_name = $5, email = $6
         ${temp ? ', password_hash = $7, must_change_password = TRUE' : ''} WHERE id = $1`,
      temp ? [id, facultyName(last, first, middle), first, middle || null, last, email, hashPassword(temp)]
           : [id, facultyName(last, first, middle), first, middle || null, last, email]);
    logAction(req, college + ' registrar', 'faculty updated', String(id));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the faculty profile.' });
  }
});

app.post('/api/registrar/faculty/:id/archive', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const r = await pool.query("UPDATE reg_users SET archived_at = now() WHERE id = $1 AND role = 'faculty' AND college = $2 AND archived_at IS NULL", [Number(req.params.id), college]);
  if (!r.rowCount) return res.status(404).json({ error: 'Faculty member not found or already archived.' });
  logAction(req, college + ' registrar', 'faculty archived', req.params.id);
  res.json({ ok: true });
});

// Subject assignments for the active term: which faculty teaches which subject to which year levels and sections.
app.get('/api/registrar/subject-assignments', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
  const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
  if (!m.grading_semester || !m.grading_ay) return res.json({ term: '', academic_year: '', assignments: [] });
  const r = await pool.query(
    `SELECT sa.id, sa.user_id, u.username, u.name AS faculty, u.first_name, u.last_name, sa.course_code,
            COALESCE(c.descriptive_title, (SELECT rc.descriptive_title FROM reg_courses rc WHERE rc.course_code = sa.course_code LIMIT 1), '') AS descriptive_title,
            sa.years, sa.sections,
            COALESCE(NULLIF(sa.subject_college, ''), sa.college) AS subject_college, sa.program,
            sa.group_label, sa.day_label, sa.time_slot,
            (SELECT rs.room FROM reg_schedules rs WHERE rs.college = sa.college AND rs.course_code = sa.course_code
               AND rs.term = sa.term AND rs.academic_year = sa.academic_year AND rs.group_label = sa.group_label
               AND rs.year_level = ANY(sa.years) AND rs.section = ANY(sa.sections) ORDER BY rs.year_level, rs.section LIMIT 1) AS room
       FROM reg_subject_assignments sa
       JOIN reg_users u ON u.id = sa.user_id
       LEFT JOIN reg_courses c ON c.college = COALESCE(NULLIF(sa.subject_college, ''), sa.college) AND c.course_code = sa.course_code
      WHERE sa.college = $1 AND sa.term = $2 AND sa.academic_year = $3
      ORDER BY sa.course_code, u.name`,
    [college, m.grading_semester, m.grading_ay]);
  res.json({ term: m.grading_semester, academic_year: m.grading_ay, assignments: r.rows.filter((a) => !isHiddenUserRow(a)) });
});

// Next free group label (G1 ... G20) for a subject in the grading term. Used when an assignment names no group.
async function nextSubjectGroup(client, college, term, ay, code) {
  const r = await client.query(
    'SELECT group_label FROM reg_subject_assignments WHERE college=$1 AND term=$2 AND academic_year=$3 AND course_code=$4',
    [college, term, ay, code]);
  const used = new Set(r.rows.map((x) => { const m = /^G(\d+)/.exec(x.group_label || ''); return m ? Number(m[1]) : 0; }));
  for (let g = 1; g <= 20; g++) if (!used.has(g)) return 'G' + g;
  const e = new Error('All 20 groups of ' + code + ' are used.');
  e.clientError = true;
  throw e;
}

// Subject schedule (days, time, room) per subject per year level and section, for the grading term.
const SCHED_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
async function gradingTerm() {
  const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
  const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
  return { term: m.grading_semester || '', ay: m.grading_ay || '' };
}
// Assignment time text ("7:00 AM - 8:30 AM") to 24-hour start and end, or null when it is not a time range.
function schParseSlot(slot) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(String(slot || ''));
  if (!m) return null;
  const to24 = (h, mi, ap) => String((Number(h) % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0') + ':' + mi;
  return { start: to24(m[1], m[2], m[3]), end: to24(m[4], m[5], m[6]) };
}
app.get('/api/registrar/schedules', requireRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const year = [1, 2, 3, 4].includes(Number(req.query.year_level)) ? Number(req.query.year_level) : 0; // 0 = all years
  const section = String(req.query.section || '').trim().toUpperCase(); // '' = all sections
  const course = String(req.query.course || '').trim(); // subjects on the table, separated by |; '' = all
  const t = await gradingTerm();
  if (!t.term || !t.ay) return res.json({ term: t.term, academic_year: t.ay, rows: [] });
  // Every subject of the college (optionally one year level) for the active term.
  const courses = await pool.query(
    `SELECT x.course_code, COALESCE(c.descriptive_title, '') AS descriptive_title, COALESCE(c.units, 0) AS units, COALESCE(c.year_level, 0) AS year_level
       FROM (
         SELECT DISTINCT course_code FROM reg_subject_assignments
          WHERE college = $1 AND term = $3 AND academic_year = $4 AND ($2 = 0 OR $2 = ANY(years))
       ) x
       LEFT JOIN LATERAL (SELECT descriptive_title, units, year_level FROM reg_courses rc WHERE rc.course_code = x.course_code ORDER BY (rc.college = $1) DESC, rc.year_level LIMIT 1) c ON true
      WHERE ($5 = '' OR x.course_code = ANY(string_to_array($5, '|')))
      ORDER BY COALESCE(c.year_level, 0), x.course_code`,
    [college, year, t.term, t.ay, course]);
  const asg = await pool.query(
    `SELECT sa.course_code, sa.group_label, sa.years, sa.sections, u.name
       FROM reg_subject_assignments sa JOIN reg_users u ON u.id = sa.user_id
      WHERE sa.college = $1 AND sa.term = $2 AND sa.academic_year = $3`,
    [college, t.term, t.ay]);
  const sch = await pool.query(
    `SELECT course_code, group_label, year_level, section, days, start_time, end_time, room FROM reg_schedules
      WHERE college = $1 AND term = $2 AND academic_year = $3 ORDER BY section`,
    [college, t.term, t.ay]);
  // One row per saved assignment, year level and section, so every section shows (even with no group yet).
  const titleOf = new Map(courses.rows.map((c) => [c.course_code, c]));
  const schBy = new Map();
  sch.rows.forEach((x) => schBy.set(x.course_code + '|' + x.group_label + '|' + x.year_level + '|' + x.section, x));
  const rows = [];
  asg.rows.forEach((a) => {
    const c = titleOf.get(a.course_code);
    if (!c) return;
    (a.years || []).forEach((y) => {
      if (year && y !== year) return;
      (a.sections || []).forEach((sec) => {
        if (section && sec !== section) return;
        const x = schBy.get(a.course_code + '|' + a.group_label + '|' + y + '|' + sec) || {};
        rows.push({
          course_code: a.course_code, descriptive_title: c.descriptive_title, units: c.units, year_level: y,
          group_label: a.group_label, instructor: a.name, section: sec,
          days: x.days || '', start_time: x.start_time || '', end_time: x.end_time || '', room: x.room || ''
        });
      });
    });
  });
  rows.sort((p, q) => p.course_code.localeCompare(q.course_code)
    || String(p.group_label).localeCompare(String(q.group_label), undefined, { numeric: true })
    || p.year_level - q.year_level || p.section.localeCompare(q.section));
  res.json({ term: t.term, academic_year: t.ay, rows });
});

// Save the schedule. Blank section = every section (A, B, C) of each row's year level.
// 24-hour "13:00" to the assignment list's "1:00 PM" style.
const fmt12Sched = (hhmm) => { const [hh, mi] = String(hhmm).split(':'); const h = Number(hh); return (h % 12 || 12) + ':' + mi + ' ' + (h >= 12 ? 'PM' : 'AM'); };
app.post('/api/registrar/schedules', requireRegistrar, async (req, res) => {
  // Read-only: schedules are saved from Subject Assignment only.
  return res.status(403).json({ error: 'The subject schedule is read-only. Save days, time and room in Subject Assignment.' });
  // eslint-disable-next-line no-unreachable
  const b = req.body || {};
  const college = regCollege(req, b.college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const section = String(b.section || '').trim().toUpperCase().slice(0, 20);
  const t = await gradingTerm();
  if (!t.term || !t.ay) return res.status(400).json({ error: 'The grading term is not set yet.' });
  const items = Array.isArray(b.items) ? b.items : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      const code = String(it.course_code || '').trim().slice(0, 40);
      if (!code) continue;
      const year = Number(it.year_level);
      if (!(year >= 1 && year <= 4)) throw new Error('Year level is missing for ' + code + '.');
      const group = String(it.group_label || '').trim().toUpperCase().slice(0, 30);
      const days = String(it.days || '').trim().toUpperCase().slice(0, 20);
      const st = String(it.start_time || '').trim();
      const et = String(it.end_time || '').trim();
      const room = String(it.room || '').trim().slice(0, 40);
      const label = code + (group ? ' ' + group : '');
      if ((st && !SCHED_TIME_RE.test(st)) || (et && !SCHED_TIME_RE.test(et))) throw new Error('Time must be set for ' + label + '.');
      if (st && et && et <= st) throw new Error('End time must be after start time for ' + label + '.');
      // A row can name its own section; blank means every section of the year level.
      const itSec = String(it.section || '').trim().toUpperCase();
      if (itSec && !['A', 'B', 'C'].includes(itSec)) throw new Error('Section must be A, B or C.');
      const secs = itSec ? [itSec] : (section ? [section] : ['A', 'B', 'C']);
      for (const sec of secs) {
        if (!days && !st && !et && !room) {
          await client.query('DELETE FROM reg_schedules WHERE college=$1 AND course_code=$2 AND term=$3 AND academic_year=$4 AND year_level=$5 AND section=$6 AND group_label=$7',
            [college, code, t.term, t.ay, year, sec, group]);
          continue;
        }
        await client.query(
          `INSERT INTO reg_schedules (college, course_code, term, academic_year, year_level, section, group_label, days, start_time, end_time, room)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (college, course_code, term, academic_year, year_level, section, group_label)
           DO UPDATE SET days = EXCLUDED.days, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, room = EXCLUDED.room`,
          [college, code, t.term, t.ay, year, sec, group, days, st, et, room]);
        // A scheduled group with no assignment yet gets one automatically, with the same instructor as the
        // subject's existing assignment for this year and section. Skipped when no such assignment exists.
        if (group && (days || (st && et))) {
          const hasRow = await client.query(
            'SELECT 1 FROM reg_subject_assignments WHERE college=$1 AND term=$2 AND academic_year=$3 AND course_code=$4 AND group_label=$5 AND $6 = ANY(years) AND $7 = ANY(sections) LIMIT 1',
            [college, t.term, t.ay, code, group, year, sec]);
          if (!hasRow.rows.length) {
            const src = await client.query(
              `SELECT user_id, subject_college, program FROM reg_subject_assignments
                WHERE college=$1 AND term=$2 AND academic_year=$3 AND course_code=$4 AND $5 = ANY(years) AND $6 = ANY(sections)
                ORDER BY id LIMIT 1`,
              [college, t.term, t.ay, code, year, sec]);
            if (src.rows.length) {
              const sv = src.rows[0];
              await client.query(
                `INSERT INTO reg_subject_assignments (user_id, college, course_code, term, academic_year, years, sections, subject_college, program, group_label, day_label, time_slot)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [sv.user_id, college, code, t.term, t.ay, [year], [sec], sv.subject_college, sv.program, group,
                 days || 'TBA', st && et ? fmt12Sched(st) + ' - ' + fmt12Sched(et) : 'TBA']);
            }
          }
        }
        // Keep the Subject Assignments list in step with the schedule.
        await client.query(
          `UPDATE reg_subject_assignments SET day_label = $1, time_slot = $2
            WHERE college = $3 AND term = $4 AND academic_year = $5 AND course_code = $6 AND group_label = $7
              AND $8 = ANY(years) AND $9 = ANY(sections)`,
          [days || 'TBA', st && et ? fmt12Sched(st) + ' - ' + fmt12Sched(et) : 'TBA', college, t.term, t.ay, code, group, year, sec]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: err.message || 'Could not save the schedule.' });
  } finally {
    client.release();
  }
  logAction(req, (req.session && req.session.name) || 'Registrar', 'schedule saved', college + ' · ' + (section || 'all sections') + ' · ' + items.length + ' row(s)');
  res.json({ ok: true });
});

// Live conflict check for the Subject schedule: section overlaps and instructor overlaps.
function schDaySet(str) {
  const t = String(str || '').toUpperCase();
  if (t.indexOf('TBA') !== -1) return new Set();
  const toks = [['MON', 'MON'], ['TUES', 'TUE'], ['TUE', 'TUE'], ['WED', 'WED'], ['THURS', 'THU'], ['THUR', 'THU'], ['THU', 'THU'],
    ['FRI', 'FRI'], ['SAT', 'SAT'], ['SUN', 'SUN'], ['TH', 'THU'], ['SU', 'SUN'], ['M', 'MON'], ['T', 'TUE'], ['W', 'WED'], ['F', 'FRI'], ['S', 'SAT']];
  const out = new Set();
  let i = 0;
  while (i < t.length) {
    let hit = false;
    for (const [tok, day] of toks) {
      if (t.startsWith(tok, i)) { out.add(day); i += tok.length; hit = true; break; }
    }
    if (!hit) i++;
  }
  return out;
}
function schOverlaps(a, b) {
  const da = schDaySet(a.days), db = schDaySet(b.days);
  if (![...da].some((d) => db.has(d))) return false;
  return a.st < b.et && b.st < a.et;
}
// Subject schedule as a PDF file. The page sends the rows it shows; the server lays them out as a table.
app.post('/api/registrar/schedules/pdf', requireRegistrar, (req, res) => {
  const b = req.body || {};
  const college = regCollege(req, b.college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 1000).map((r) => ({
    code: String(r.code || '').slice(0, 40), title: String(r.title || '').slice(0, 120), group: String(r.group || '').slice(0, 30),
    section: String(r.section || '').slice(0, 10), day: String(r.day || '').slice(0, 40), time: String(r.time || '').slice(0, 60),
    instructor: String(r.instructor || '').slice(0, 120), room: String(r.room || '').slice(0, 40)
  }));
  if (!rows.length) return res.status(400).json({ error: 'Nothing to print.' });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Subject-Schedule-' + college + '.pdf"');
  doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(14).text(college + ' | Subject Schedule');
  doc.font('Helvetica').fontSize(9).text('Printed ' + new Date().toLocaleString('en-PH'));
  doc.moveDown(0.8);
  const cols = [
    ['Code', 70, 'code'], ['Descriptive title', 200, 'title'], ['Group', 50, 'group'], ['Section', 50, 'section'],
    ['Day', 80, 'day'], ['Time', 150, 'time'], ['Instructor', 170, 'instructor'], ['Room', 80, 'room']
  ];
  // Shrink the columns proportionally so the whole table fits across one landscape page.
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const scale = pageWidth / cols.reduce((sum, c) => sum + c[1], 0);
  cols.forEach((c) => { c[1] = c[1] * scale; });
  const x0 = doc.page.margins.left, rowH = 20, bottom = doc.page.height - doc.page.margins.bottom;
  let y = doc.y;
  const drawRow = (vals, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    let x = x0;
    cols.forEach(([, w], i) => {
      doc.rect(x, y, w, rowH).stroke();
      doc.text(String(vals[i] || ''), x + 4, y + 6, { width: w - 8, height: rowH - 6, ellipsis: true, lineBreak: false });
      x += w;
    });
    y += rowH;
  };
  const newPageIfNeeded = () => {
    if (y + rowH <= bottom) return;
    doc.addPage();
    y = doc.page.margins.top;
    drawRow(cols.map((c) => c[0]), true);
  };
  drawRow(cols.map((c) => c[0]), true);
  rows.forEach((r) => {
    newPageIfNeeded();
    drawRow(cols.map((c) => r[c[2]]), false);
  });
  doc.end();
});

app.post('/api/registrar/schedules/check', requireRegistrar, async (req, res) => {
  const b = req.body || {};
  const college = regCollege(req, b.college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const year = Number(b.year_level);
  const section = String(b.section || '').trim().toUpperCase().slice(0, 20);
  const t = await gradingTerm();
  // A conflict check needs one section; ALL is not checked.
  if (!t.term || !t.ay || !(year >= 1 && year <= 4) || !section || section === 'ALL') return res.json({ conflicts: {} });
  // Subject+group keys on the grid. The grid holds the live values, so saved rows with these keys are not compared.
  const gridKeys = new Set((Array.isArray(b.items) ? b.items : []).slice(0, 500).map((it) =>
    String(it.course_code || '').trim().slice(0, 40) + '|' + String(it.group_label || '').trim().toUpperCase().slice(0, 30)));
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 500).map((it, i) => ({
    i, code: String(it.course_code || '').trim().slice(0, 40), group: String(it.group_label || '').trim().toUpperCase().slice(0, 30),
    days: String(it.days || '').trim().toUpperCase(), st: String(it.start_time || '').trim(), et: String(it.end_time || '').trim()
  })).filter((x) => x.code && x.days && x.st && x.et && x.st < x.et);
  const conflicts = {};
  const add = (i, msg) => { (conflicts[i] = conflicts[i] || []).push(msg); };
  const label = (x) => x.code + (x.group ? ' ' + x.group : '');
  const when = (x) => x.days + ' ' + x.st + '–' + x.et;
  try {
    for (const x of items) {
      const who = await pool.query(
        `SELECT DISTINCT sa.user_id, u.name FROM reg_subject_assignments sa JOIN reg_users u ON u.id = sa.user_id
          WHERE sa.college=$1 AND sa.term=$2 AND sa.academic_year=$3 AND sa.course_code=$4 AND sa.group_label=$5 AND $6 = ANY(sa.years) AND $7 = ANY(sa.sections)`,
        [college, t.term, t.ay, x.code, x.group, year, section]);
      x.instructors = who.rows;
    }
    // Inside this grid: everything here is the same year and section, so any overlap is a section conflict.
    for (let a = 0; a < items.length; a++) {
      for (let c = a + 1; c < items.length; c++) {
        const p = items[a], q = items[c];
        if (!schOverlaps(p, q)) continue;
        // Groups of the same subject (G1, G2 ...) are alternatives, so they do not clash with each other.
        if (p.code !== q.code) {
          add(p.i, 'Section conflict: ' + label(q) + ' is on ' + when(q) + ' in this section.');
          add(q.i, 'Section conflict: ' + label(p) + ' is on ' + when(p) + ' in this section.');
        }
        for (const ip of p.instructors) {
          if (q.instructors.some((iq) => iq.user_id === ip.user_id)) {
            add(p.i, 'Instructor conflict: ' + ip.name + ' also teaches ' + label(q) + ' at this time.');
            add(q.i, 'Instructor conflict: ' + ip.name + ' also teaches ' + label(p) + ' at this time.');
          }
        }
      }
    }
    // Against saved schedules of this year and section.
    const sec = await pool.query(
      `SELECT course_code, group_label, days, start_time, end_time FROM reg_schedules
        WHERE college=$1 AND term=$2 AND academic_year=$3 AND year_level=$4 AND section=$5 AND days<>'' AND start_time<>'' AND end_time<>''`,
      [college, t.term, t.ay, year, section]);
    for (const x of items) {
      for (const sv of sec.rows) {
        // Groups of the same subject do not clash with each other, saved or on the grid.
        if (sv.course_code === x.code) continue;
        if (gridKeys.has(sv.course_code + '|' + (sv.group_label || ''))) continue;
        const o = { days: sv.days, st: sv.start_time, et: sv.end_time };
        if (schOverlaps(x, o)) add(x.i, 'Section conflict: ' + sv.course_code + (sv.group_label ? ' ' + sv.group_label : '') + ' is saved on ' + sv.days + ' ' + sv.start_time + '–' + sv.end_time + '.');
      }
    }
    // Instructor against their other saved schedules (any year and section).
    for (const x of items) {
      for (const ins of x.instructors) {
        const other = await pool.query(
          `SELECT rs.course_code, rs.group_label, rs.year_level, rs.section, rs.days, rs.start_time, rs.end_time
             FROM reg_schedules rs
             JOIN reg_subject_assignments sa ON sa.college = rs.college AND sa.course_code = rs.course_code AND sa.group_label = rs.group_label
                  AND sa.term = rs.term AND sa.academic_year = rs.academic_year AND rs.year_level = ANY(sa.years) AND rs.section = ANY(sa.sections)
            WHERE sa.user_id = $1 AND rs.college = $2 AND rs.term = $3 AND rs.academic_year = $4
              AND rs.days <> '' AND rs.start_time <> '' AND rs.end_time <> ''
              AND NOT (rs.course_code = $5 AND rs.group_label = $6 AND rs.year_level = $7 AND rs.section = $8)`,
          [ins.user_id, college, t.term, t.ay, x.code, x.group, year, section]);
        for (const o of other.rows) {
          if (schOverlaps(x, { days: o.days, st: o.start_time, et: o.end_time })) {
            add(x.i, 'Instructor conflict: ' + ins.name + ' teaches ' + o.course_code + (o.group_label ? ' ' + o.group_label : '') + ' in ' + o.year_level + '-' + o.section + ' on ' + o.days + ' ' + o.start_time + '–' + o.end_time + '.');
          }
        }
      }
    }
    res.json({ conflicts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check conflicts.' });
  }
});

// Subjects of every college and the programs of each, for Subject Assignments (college and program are chosen per assignment).
app.get('/api/registrar/subject-catalog', requireRegistrar, async (req, res) => {
  const r = await pool.query('SELECT college, course_code, descriptive_title, year_level FROM reg_courses ORDER BY college, course_code');
  res.json({ colleges: REG_COLLEGES, programs: REG_PROGRAM_COLLEGES, courses: r.rows });
});

const cc = (p, ...n) => n.map((x) => p + ' ' + x);
// Major subjects per program (GEC, NSTP, PHE and RIZ are not majors). Used by the Program filter in Subject schedule.
const BSBA_BASE = [...cc('CBM', 101, 302), ...cc('ECO', 101), ...cc('MGT', 101, 201, 301), ...cc('FIN', 101), ...cc('LAW', 201), ...cc('TAX', 201), ...cc('RES', 301), 'GEL 201', 'GEL 202', 'GEL 301', 'FEL 301', 'FEL 401', 'PRC 401'];
const BSED_EDU = cc('EDU', 101, 102, 201, 202, 301, 302, 303, 304, 401, 402, 403, 404);
const CURRICULUM_PROGRAMS = [
  { label: "Bachelor of Arts in Political Science (ABPS)", college: 'CAS', codes: ["GEC 101", "GEC 102", "GEC 104", "POL 101", "NSTP 101", "PHE 101", "GEC 103", "GEC 105", "POL 102", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "POL 201", "GEL 201", "PHE 201", "GEC 108", "RIZ 101", "POL 202", "GEL 202", "PHE 202", "POL 301", "POL 302", "GEL 301", "POE 301", "FEL 301", "POL 303", "POE 302", "POE 303", "FEL 302", "POL 401", "POE 401", "FEL 401", "FEL 402", "POL 402"] },
  { label: "Associate in Computer Technology (ACT)", college: 'COACS', codes: ["GEC 101", "GEC 104", "GEC 105", "ITE 101", "ITE 101L", "ITE 102", "ITE 102L", "NSTP 101", "PHE 101", "GEC 102", "GEC 103", "ITE 103", "ITE 103L", "ITE 104", "ITE 104L", "ITE 105", "ITE 105L", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "ITE 201", "ITE 201L", "ITE 202", "ITE 202L", "ITE 203", "ITE 203L", "ITE 204", "ITE 204L", "PHE 201", "GEC 108", "RIZ 101", "ITE 205", "ITE 205L", "ACT 201", "ACT 201L", "ACT 202", "ACT 202L", "PHE 202", "ACT 203"] },
  { label: "Bachelor in Elementary Education (BEEd)", college: 'COED', codes: ["GEC 101", "GEC 102", "GEC 104", "EDU 101", "NSTP 101", "PHE 101", "GEC 103", "GEC 105", "EDU 102", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "EDU 201", "BED 201", "BED 202", "BED 202L", "PHE 201", "GEC 108", "RIZ 101", "EDU 202", "BED 203", "BED 204", "PHE 202", "EDU 301", "EDU 302", "BED 301", "BED 302", "BED 303", "EDU 303", "EDU 304", "EDU 304L", "BED 304", "BED 304L", "BED 305", "BED 306", "EDU 401", "EDU 402", "EDU 403", "BED 401", "BED 402", "EDU 404"] },
  { label: "Bachelor of Science in Business Administration (BSBA) - Financial Management", college: 'COBM', codes: ["GEC 101", "GEC 102", "GEC 104", "CBM 101", "ECO 101", "NSTP 101", "PHE 101", "GEC 103", "GEC 105", "MGT 101", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "FIN 101", "LAW 201", "GEL 201", "PHE 201", "GEC 108", "RIZ 101", "TAX 201", "MGT 201", "GEL 202", "PHE 202", "MGT 301", "RES 301", "GEL 301", "FMA 301", "FMA 302", "CBM 302", "FEL 301", "FMA 303", "FMA 304", "FMA 305", "FEL 401", "FMA 401", "FMA 402", "PRC 401"] },
  { label: "Bachelor of Science in Business Administration (BSBA) - Human Resource", college: 'COBM', codes: ["GEC 101", "GEC 102", "GEC 104", "CBM 101", "ECO 101", "NSTP 101", "PHE 101", "GEC 103", "GEC 105", "MGT 101", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "FIN 101", "LAW 201", "GEL 201", "PHE 201", "GEC 108", "RIZ 101", "TAX 201", "MGT 201", "GEL 202", "PHE 202", "MGT 301", "RES 301", "GEL 301", "HRM 301", "HRM 302", "CBM 302", "FEL 301", "HRM 303", "HRM 304", "HRM 305", "FEL 401", "HRM 401", "HRM 402", "PRC 401"] },
  { label: "Bachelor of Science in Business Administration (BSBA) - Marketing Management", college: 'COBM', codes: ["GEC 101", "GEC 102", "GEC 104", "CBM 101", "ECO 101", "NSTP 101", "PHE 101", "GEC 103", "GEC 105", "MGT 101", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "FIN 101", "LAW 201", "GEL 201", "PHE 201", "GEC 108", "RIZ 101", "TAX 201", "MGT 201", "GEL 202", "PHE 202", "MGT 301", "RES 301", "GEL 301", "MKT 301", "MKT 302", "CBM 302", "FEL 301", "MKT 303", "MKT 304", "MKT 305", "FEL 401", "MKT 401", "MKT 402", "MKT 403", "PRC 401"] },
  { label: "Bachelor of Science in Business Administration (BSBA) - Operations Management", college: 'COBM', codes: ["GEC 101", "GEC 102", "GEC 104", "CBM 101", "ECO 101", "NSTP 101", "PHE 101", "GEC 103", "GEC 105", "MGT 101", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "FIN 101", "LAW 201", "GEL 201", "PHE 201", "GEC 108", "RIZ 101", "TAX 201", "MGT 201", "GEL 202", "PHE 202", "MGT 301", "RES 301", "GEL 301", "OPM 301", "OPM 302", "CBM 302", "FEL 301", "OPM 303", "OPM 304", "OPM 305", "FEL 401", "OPM 401", "OPM 402", "PRC 401"] },
  { label: "Bachelor in Secondary Education (BSEd) - English", college: 'COED', codes: ["GEC 101", "GEC 102", "GEC 104", "EDU 101", "NSTP 101", "PHE 101", "ENG 101", "GEC 103", "GEC 105", "EDU 102", "NSTP 102", "PHE 102", "ENG 102", "GEC 106", "GEC 107", "EDU 201", "PHE 201", "ENG 201", "ENG 202", "GEC 108", "RIZ 101", "EDU 202", "PHE 202", "ENG 203", "ENG 204", "EDU 301", "EDU 302", "ENG 301", "ENG 302", "ENG 302L", "EDU 303", "EDU 304", "EDU 304L", "ENG 303", "ENG 304", "EDU 401", "EDU 402", "EDU 403", "ENG 401", "EDU 404"] },
  { label: "Bachelor in Secondary Education (BSEd) - Filipino", college: 'COED', codes: ["GEC 101", "GEC 102", "GEC 104", "EDU 101", "NSTP 101", "PHE 101", "FIL 101", "GEC 103", "GEC 105", "EDU 102", "NSTP 102", "PHE 102", "FIL 102", "GEC 106", "GEC 107", "EDU 201", "PHE 201", "FIL 201", "FIL 202", "GEC 108", "RIZ 101", "EDU 202", "PHE 202", "FIL 203", "FIL 204", "EDU 301", "EDU 302", "FIL 301", "FIL 302", "EDU 303", "EDU 304", "EDU 304L", "FIL 303", "FIL 304", "EDU 401", "EDU 402", "EDU 403", "FIL 401", "EDU 404"] },
  { label: "Bachelor in Secondary Education (BSEd) - Mathematics", college: 'COED', codes: ["GEC 101", "GEC 102", "GEC 104", "EDU 101", "NSTP 101", "PHE 101", "MAT 101", "GEC 103", "GEC 105", "EDU 102", "NSTP 102", "PHE 102", "MAT 102", "GEC 106", "GEC 107", "EDU 201", "PHE 201", "MAT 201", "MAT 202", "GEC 108", "RIZ 101", "EDU 202", "PHE 202", "MAT 203", "MAT 204", "EDU 301", "EDU 302", "MAT 301", "MAT 302", "EDU 303", "EDU 304", "EDU 304L", "MAT 303", "MAT 304", "EDU 401", "EDU 402", "EDU 403", "MAT 401", "EDU 404"] },
  { label: "Bachelor in Secondary Education (BSEd) - Science", college: 'COED', codes: ["GEC 101", "GEC 102", "GEC 104", "EDU 101", "NSTP 101", "PHE 101", "SCI 101", "SCI 101L", "GEC 103", "GEC 105", "EDU 102", "NSTP 102", "PHE 102", "SCI 102", "SCI 102L", "GEC 106", "GEC 107", "EDU 201", "PHE 201", "SCI 201", "SCI 201L", "SCI 202", "SCI 202L", "GEC 108", "RIZ 101", "EDU 202", "PHE 202", "SCI 203", "SCI 203L", "SCI 204", "SCI 204L", "EDU 301", "EDU 302", "SCI 301", "SCI 301L", "SCI 302", "SCI 302L", "EDU 303", "EDU 304", "EDU 304L", "SCI 303", "SCI 303L", "SCI 304", "SCI 304L", "EDU 401", "EDU 402", "EDU 403", "SCI 401", "SCI 401L", "EDU 404"] },
  { label: "Bachelor in Secondary Education (BSEd) - Social Studies", college: 'COED', codes: ["GEC 101", "GEC 102", "GEC 104", "EDU 101", "NSTP 101", "PHE 101", "SOC 101", "GEC 103", "GEC 105", "EDU 102", "NSTP 102", "PHE 102", "SOC 102", "GEC 106", "GEC 107", "EDU 201", "PHE 201", "SOC 201", "SOC 202", "GEC 108", "RIZ 101", "EDU 202", "PHE 202", "SOC 203", "SOC 204", "EDU 301", "EDU 302", "SOC 301", "SOC 302", "EDU 303", "EDU 304", "EDU 304L", "SOC 303", "SOC 304", "EDU 401", "EDU 402", "EDU 403", "SOC 401", "EDU 404"] },
  { label: "Bachelor of Science in Office Administration (BSOA)", college: 'COACS', codes: ["GEC 101", "GEC 102", "GEC 104", "OAD 101", "OAD 101L", "OAD 102", "OAD 102L", "NSTP 101", "PHE 101", "GEC 103", "GEC 105", "OAD 103", "OAD 104", "OAD 104L", "NSTP 102", "PHE 102", "GEC 106", "GEC 107", "OAD 201", "OAD 201L", "CBM 201", "GEL 201", "PHE 201", "GEC 108", "RIZ 101", "OAD 202", "OAD 202L", "OAD 203L", "GEL 202", "PHE 202", "OAD 301", "OAD 302", "OAD 303", "GEL 301", "FEL 301", "OAD 304", "OAD 305", "OAD 306", "CBM 301", "FEL 302", "OAD 401", "FEL 401", "OAD 402"] },
  { label: "Juris Doctor (J.D.)", college: 'LAW', codes: ["LAW 101", "LAW 102", "LAW 103", "LAW 104", "LAW 105", "LAW 106", "LAW 107", "LAW 108", "LAW 109", "LAW 110", "LAW 111", "LAW 201", "LAW 202", "LAW 203", "LAW 204", "LAW 205", "LAW 206", "LAW 207", "LAW 208", "LAW 209", "LAW 301", "LAW 302", "LAW 303", "LAW 304", "LAW 305", "LAW 306", "LAW 307", "LAW 308", "LAW 401", "LAW 402", "LAW 403", "LAW 404", "LAW 405", "LAW 406", "LAW 407", "LAW 408", "LAW 409"] },
];
// Programs for a college (labels), for the Program dropdown.
app.get('/api/registrar/curriculum-programs', requireRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  if (!college) return res.json({ programs: [] });
  res.json({ programs: CURRICULUM_PROGRAMS.filter((x) => x.college === college).map((x) => x.label) });
});
// Subject codes of one program (exact label from curriculum-programs).
app.get('/api/registrar/curriculum-codes', requireRegistrar, async (req, res) => {
  const program = String(req.query.program || '').trim();
  const hit = CURRICULUM_PROGRAMS.find((x) => x.label === program);
  res.json({ codes: hit ? [...new Set(hit.codes)] : [], known: [] });
});

// Turns the assignment day text ("MWF", "TTH", "Mon/Wed", "F") into the schedule's codes ("MON WED FRI").
const SCHED_DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
function schDayCodes(text) {
  const src = String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!src || src === 'TBA') return '';
  const found = new Set();
  let i = 0;
  while (i < src.length) {
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (SCHED_DAY_ORDER.includes(three)) { found.add(three); i += 3; continue; }
    if (two === 'TH') { found.add('THU'); i += 2; continue; }
    if (two === 'SU') { found.add('SUN'); i += 2; continue; }
    if (two === 'SA') { found.add('SAT'); i += 2; continue; }
    const one = { M: 'MON', T: 'TUE', W: 'WED', F: 'FRI', S: 'SAT' }[src[i]];
    if (one) found.add(one);
    i += 1;
  }
  return SCHED_DAY_ORDER.filter((d) => found.has(d)).join(' ');
}

app.post('/api/registrar/subject-assignments', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const b = req.body || {};
  const userId = Number(b.faculty_id);
  // One or more subjects; a single course_code is still accepted.
  const codes = [...new Set((Array.isArray(b.course_codes) ? b.course_codes : [b.course_code])
    .map((c) => String(c || '').trim()).filter(Boolean))];
  // Schedule group: any label (G1 ... G12 and beyond), day and time as typed. Not limited in number.
  let groupLabel = String(b.group_label || '').trim().toUpperCase().slice(0, 30);
  if (/^\d{1,2}$/.test(groupLabel)) groupLabel = 'G' + groupLabel; // a bare number means G<number>
  const dayLabel = String(b.day_label || '').trim().slice(0, 40);
  const timeSlot = String(b.time_slot || '').trim().slice(0, 40);
  const roomText = String(b.room || '').trim().slice(0, 40) || 'TBA';
  const years = (Array.isArray(b.years) ? b.years : []).map(Number).filter((y) => [1, 2, 3, 4].includes(y));
  let sections = (Array.isArray(b.sections) ? b.sections : []).map((s) => String(s).trim()).filter((s) => ['A', 'B', 'C'].includes(s));
  if (!codes.length) return res.status(400).json({ error: 'Choose at least one subject.' });
  // Group label: G<number> (for all selected sections), or G<number><section> such as G1A, where that section must be selected.
  if (groupLabel && !(/^G\d{1,2}$/.test(groupLabel) || (/^G\d{1,2}[A-C]$/.test(groupLabel) && sections.includes(groupLabel.slice(-1))))) {
    return res.status(400).json({ error: 'Group must look like G1 (all selected sections) or G1A (section A must be selected).' });
  }
  // G1A applies to Section A only, whatever else is ticked.
  const gsec = /^G\d{1,2}([A-C])$/.exec(groupLabel);
  if (gsec) sections = [gsec[1]];
  if (!years.length || !sections.length) return res.status(400).json({ error: 'Choose at least one year level and one section.' });
  const client = await pool.connect();
  try {
    const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
    const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
    if (!m.grading_semester || !m.grading_ay) return res.status(400).json({ error: 'Set the grading period first.' });
    const f = await pool.query("SELECT id FROM reg_users WHERE id = $1 AND role = 'faculty' AND college = $2 AND archived_at IS NULL", [userId, college]);
    if (!f.rows.length) return res.status(400).json({ error: 'Choose a faculty member from this college.' });
    // Subjects are limited to this college's own curriculum.
    const subjectCollege = college;
    const program = String(b.program || '');
    const isMajorProgram = CURRICULUM_PROGRAMS.some((x) => x.label === program && x.college === subjectCollege);
    if (program && !isMajorProgram && !(REG_PROGRAM_COLLEGES[subjectCollege] || []).includes(program) && !REG_PROGRAMS.includes(program)) {
      return res.status(400).json({ error: 'Choose a valid program.' });
    }
    const c = await pool.query('SELECT course_code FROM reg_courses WHERE college = $1 AND course_code = ANY($2::text[])', [subjectCollege, codes]);
    if (c.rows.length !== codes.length) return res.status(400).json({ error: 'Choose subjects from this college only.' });
    await client.query('BEGIN');
    // No group chosen: each subject takes its next free group (G1, G2 ...). Adding a group for a subject works this way.
    const groupFor = {};
    for (const code of codes) {
      groupFor[code] = groupLabel; // blank = no group yet; the + button gives groups (G1, then G2 ...)
      await client.query(
        'INSERT INTO reg_subject_assignments (user_id, college, course_code, term, academic_year, years, sections, subject_college, program, group_label, day_label, time_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [userId, college, code, m.grading_semester, m.grading_ay, years, sections, subjectCollege, program, groupFor[code], dayLabel, timeSlot]);
    }
    // Subject Assignment is the only place schedules are saved: it writes the days, time and room
    // to the Subject schedule table for each year and section picked. A blank value keeps what is saved.
    const schDays = schDayCodes(dayLabel).slice(0, 20);
    const tm = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeSlot);
    const to24 = (h, mi, ap) => String((Number(h) % 12) + (/PM/i.test(ap) ? 12 : 0)).padStart(2, '0') + ':' + mi;
    const schStart = tm ? to24(tm[1], tm[2], tm[3]) : '';
    const schEnd = tm ? to24(tm[4], tm[5], tm[6]) : '';
    const schTimes = !!(schStart && schEnd); // overnight (end earlier than start) is allowed
    if (schDays || schTimes || roomText) {
      for (const y of years) {
        for (const sec of sections) {
          for (const code of codes) {
            await client.query(
              `INSERT INTO reg_schedules (college, course_code, term, academic_year, year_level, section, group_label, days, start_time, end_time, room)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (college, course_code, term, academic_year, year_level, section, group_label)
               DO UPDATE SET days = CASE WHEN EXCLUDED.days <> '' THEN EXCLUDED.days ELSE reg_schedules.days END,
                             start_time = CASE WHEN EXCLUDED.start_time <> '' THEN EXCLUDED.start_time ELSE reg_schedules.start_time END,
                             end_time = CASE WHEN EXCLUDED.end_time <> '' THEN EXCLUDED.end_time ELSE reg_schedules.end_time END,
                             room = CASE WHEN EXCLUDED.room <> '' THEN EXCLUDED.room ELSE reg_schedules.room END`,
              [college, code, m.grading_semester, m.grading_ay, y, sec, groupFor[code], schDays, schTimes ? schStart : '', schTimes ? schEnd : '', roomText]);
          }
        }
      }
    }
    await client.query('COMMIT');
    logAction(req, college + ' registrar', 'subject assigned', codes.join(', ') + ' to ' + userId);
    res.json({ ok: true, count: codes.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.clientError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Could not save the assignment.' });
  } finally {
    client.release();
  }
});

// Edit the schedule (day, time, room) of one saved assignment. Updates its row and the Subject schedule table.
app.post('/api/registrar/subject-assignments/:id/schedule', requireRegistrar, async (req, res) => {
  const b = req.body || {};
  const college = regCollege(req, b.college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
  const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
  if (!m.grading_semester || !m.grading_ay) return res.status(400).json({ error: 'Set the grading period first.' });
  const row = await pool.query(
    'SELECT id, course_code, group_label, years, sections FROM reg_subject_assignments WHERE id = $1 AND college = $2 AND term = $3 AND academic_year = $4',
    [Number(req.params.id), college, m.grading_semester, m.grading_ay]);
  if (!row.rows.length) return res.status(404).json({ error: 'That assignment was not found.' });
  const a = row.rows[0];
  const dayLabel = String(b.day_label || '').trim().slice(0, 40) || 'TBA';
  const timeSlot = String(b.time_slot || '').trim().slice(0, 40) || 'TBA';
  const roomText = String(b.room || '').trim().slice(0, 40) || 'TBA';
  const tm = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeSlot);
  const to24 = (h, mi, ap) => String((Number(h) % 12) + (/PM/i.test(ap) ? 12 : 0)).padStart(2, '0') + ':' + mi;
  const schStart = tm ? to24(tm[1], tm[2], tm[3]) : '';
  const schEnd = tm ? to24(tm[4], tm[5], tm[6]) : '';
  // An end time earlier than the start time means the duty runs past midnight (e.g. 6:00 PM - 2:00 AM).
  const schDays = dayLabel === 'TBA' ? '' : schDayCodes(dayLabel).slice(0, 20);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE reg_subject_assignments SET day_label = $1, time_slot = $2 WHERE id = $3', [dayLabel, timeSlot, a.id]);
    for (const y of a.years) {
      for (const sec of a.sections) {
        await client.query(
          `INSERT INTO reg_schedules (college, course_code, term, academic_year, year_level, section, group_label, days, start_time, end_time, room)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (college, course_code, term, academic_year, year_level, section, group_label)
           DO UPDATE SET days = EXCLUDED.days, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, room = EXCLUDED.room`,
          [college, a.course_code, m.grading_semester, m.grading_ay, y, sec, a.group_label, schDays, schStart, schEnd, roomText]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    return res.status(500).json({ error: 'Could not update the schedule.' });
  } finally {
    client.release();
  }
  logAction(req, college + ' registrar', 'schedule edited', a.course_code + ' ' + a.group_label);
  res.json({ ok: true });
});

// Edit one saved assignment: faculty, years, sections, group, day, time and room. Rebuilds its Subject schedule rows.
app.post('/api/registrar/subject-assignments/:id/update', requireRegistrar, async (req, res) => {
  const b = req.body || {};
  const college = regCollege(req, b.college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const set = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
  const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
  if (!m.grading_semester || !m.grading_ay) return res.status(400).json({ error: 'Set the grading period first.' });
  const row = await pool.query(
    'SELECT id, course_code, group_label, years, sections FROM reg_subject_assignments WHERE id = $1 AND college = $2 AND term = $3 AND academic_year = $4',
    [Number(req.params.id), college, m.grading_semester, m.grading_ay]);
  if (!row.rows.length) return res.status(404).json({ error: 'That assignment was not found.' });
  const a = row.rows[0];
  const userId = Number(b.faculty_id);
  const f = await pool.query("SELECT id FROM reg_users WHERE id = $1 AND role = 'faculty' AND college = $2 AND archived_at IS NULL", [userId, college]);
  if (!f.rows.length) return res.status(400).json({ error: 'Choose a faculty member from this college.' });
  const years = (Array.isArray(b.years) ? b.years : []).map(Number).filter((y) => [1, 2, 3, 4].includes(y));
  let sections = (Array.isArray(b.sections) ? b.sections : []).map((s) => String(s).trim()).filter((s) => ['A', 'B', 'C'].includes(s));
  let groupLabel = String(b.group_label || '').trim().toUpperCase().slice(0, 30);
  if (/^\d{1,2}$/.test(groupLabel)) groupLabel = 'G' + groupLabel;
  if (!groupLabel) return res.status(400).json({ error: 'Enter a group, for example G1.' });
  if (!(/^G\d{1,2}$/.test(groupLabel) || (/^G\d{1,2}[A-C]$/.test(groupLabel) && sections.includes(groupLabel.slice(-1))))) {
    return res.status(400).json({ error: 'Group must look like G1 (all selected sections) or G1A (section A must be selected).' });
  }
  const gsec = /^G\d{1,2}([A-C])$/.exec(groupLabel);
  if (gsec) sections = [gsec[1]];
  if (!years.length || !sections.length) return res.status(400).json({ error: 'Choose at least one year level and one section.' });
  const dayLabel = String(b.day_label || '').trim().slice(0, 40) || 'TBA';
  const timeSlot = String(b.time_slot || '').trim().slice(0, 40) || 'TBA';
  const roomText = String(b.room || '').trim().slice(0, 40) || 'TBA';
  const tm = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeSlot);
  const to24 = (h, mi, ap) => String((Number(h) % 12) + (/PM/i.test(ap) ? 12 : 0)).padStart(2, '0') + ':' + mi;
  const schStart = tm ? to24(tm[1], tm[2], tm[3]) : '';
  const schEnd = tm ? to24(tm[4], tm[5], tm[6]) : '';
  // An end time earlier than the start time means the duty runs past midnight (e.g. 6:00 PM - 2:00 AM).
  const schDays = dayLabel === 'TBA' ? '' : schDayCodes(dayLabel).slice(0, 20);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      'SELECT 1 FROM reg_subject_assignments WHERE college=$1 AND term=$2 AND academic_year=$3 AND course_code=$4 AND group_label=$5 AND id<>$6 LIMIT 1',
      [college, m.grading_semester, m.grading_ay, a.course_code, groupLabel, a.id]);
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: groupLabel + ' is already used for ' + a.course_code + '.' });
    }
    // Remove the old schedule rows for this subject and group, then write the new ones.
    await client.query(
      'DELETE FROM reg_schedules WHERE college=$1 AND course_code=$2 AND term=$3 AND academic_year=$4 AND group_label=$5',
      [college, a.course_code, m.grading_semester, m.grading_ay, a.group_label]);
    await client.query(
      'UPDATE reg_subject_assignments SET user_id=$1, years=$2, sections=$3, group_label=$4, day_label=$5, time_slot=$6 WHERE id=$7',
      [userId, years, sections, groupLabel, dayLabel, timeSlot, a.id]);
    for (const y of years) {
      for (const sec of sections) {
        await client.query(
          `INSERT INTO reg_schedules (college, course_code, term, academic_year, year_level, section, group_label, days, start_time, end_time, room)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (college, course_code, term, academic_year, year_level, section, group_label)
           DO UPDATE SET days = EXCLUDED.days, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, room = EXCLUDED.room`,
          [college, a.course_code, m.grading_semester, m.grading_ay, y, sec, groupLabel, schDays, schStart, schEnd, roomText]);
      }
    }
    await cleanOrphanSchedules(client, college, m.grading_semester, m.grading_ay);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    return res.status(500).json({ error: 'Could not update the assignment.' });
  } finally {
    client.release();
  }
  logAction(req, college + ' registrar', 'assignment edited', a.course_code + ' ' + groupLabel);
  res.json({ ok: true });
});

// Same cleanup for every college, term and year (used when accounts are deleted).
async function cleanAllOrphanSchedules(db) {
  await db.query(
    `DELETE FROM reg_schedules s
      WHERE NOT EXISTS (
          SELECT 1 FROM reg_subject_assignments a
           WHERE a.college = s.college AND a.term = s.term AND a.academic_year = s.academic_year
             AND a.course_code = s.course_code AND a.group_label = s.group_label
             AND s.year_level = ANY(a.years) AND s.section = ANY(a.sections))`);
}
// Deletes Subject schedule rows that no saved assignment supports (same subject, group, year and section, term and A.Y.).
async function cleanOrphanSchedules(db, college, term, ay) {
  await db.query(
    `DELETE FROM reg_schedules s
      WHERE s.college = $1 AND s.term = $2 AND s.academic_year = $3
        AND NOT EXISTS (
          SELECT 1 FROM reg_subject_assignments a
           WHERE a.college = s.college AND a.term = s.term AND a.academic_year = s.academic_year
             AND a.course_code = s.course_code AND a.group_label = s.group_label
             AND s.year_level = ANY(a.years) AND s.section = ANY(a.sections))`,
    [college, term, ay]);
}

app.post('/api/registrar/subject-assignments/:id/remove', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('DELETE FROM reg_subject_assignments WHERE id = $1 AND college = $2 RETURNING course_code, group_label, term, academic_year', [Number(req.params.id), college]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Assignment not found.' }); }
    const g = r.rows[0];
    await cleanOrphanSchedules(client, college, g.term, g.academic_year);
    await client.query('COMMIT');
    logAction(req, college + ' registrar', 'assignment removed', g.course_code + ' ' + g.group_label);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Could not remove the assignment.' });
  } finally {
    client.release();
  }
});

// Subject slots on a faculty profile: the list of subjects taught this term. A new slot takes the subject's year level and all sections.
app.put('/api/registrar/faculty/:id/subjects', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college || req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  const userId = Number(req.params.id);
  const codes = [...new Set((Array.isArray((req.body || {}).course_codes) ? req.body.course_codes : []).map((c) => String(c).trim()).filter(Boolean))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const set = await client.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay')");
    const m = Object.fromEntries(set.rows.map((r) => [r.key, r.value]));
    if (!m.grading_semester || !m.grading_ay) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Set the grading period first.' }); }
    const f = await client.query("SELECT id FROM reg_users WHERE id = $1 AND role = 'faculty' AND college = $2 AND archived_at IS NULL", [userId, college]);
    if (!f.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Faculty member not found.' }); }
    const cur = await client.query('SELECT course_code FROM reg_subject_assignments WHERE user_id = $1 AND term = $2 AND academic_year = $3', [userId, m.grading_semester, m.grading_ay]);
    const have = new Set(cur.rows.map((r) => r.course_code));
    await client.query('DELETE FROM reg_subject_assignments WHERE user_id = $1 AND term = $2 AND academic_year = $3 AND NOT (course_code = ANY($4::text[]))', [userId, m.grading_semester, m.grading_ay, codes]);
    for (const code of codes) {
      if (have.has(code)) continue;
      const c = await client.query('SELECT year_level FROM reg_courses WHERE course_code = $2 ORDER BY (CASE WHEN college = $1 THEN 0 ELSE 1 END) LIMIT 1', [college, code]);
      if (!c.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Subject ' + code + ' is not in the curriculum.' }); }
      const year = c.rows[0].year_level;
      await client.query(
        'INSERT INTO reg_subject_assignments (user_id, college, course_code, term, academic_year, years, sections) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [userId, college, code, m.grading_semester, m.grading_ay, year ? [year] : [1, 2, 3, 4], ['A', 'B', 'C']]);
    }
    await cleanOrphanSchedules(client, college, m.grading_semester, m.grading_ay);
    await client.query('COMMIT');
    logAction(req, college + ' registrar', 'faculty subjects saved', String(userId));
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Could not save the subjects.' });
  } finally {
    client.release();
  }
});


// Global grading period settings (Academic Year and Semester)
app.get('/api/portal/settings', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('grading_semester','grading_ay','enrollment_open','enrollment_schedule')");
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ grading_semester: m.grading_semester || '', grading_ay: m.grading_ay || '', ...enrollmentStateFrom(m) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

app.post('/api/registrar/settings', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  const sem = String(b.grading_semester || '').trim();
  const ay = String(b.grading_ay || '').trim();
  if (!REG_SEMESTERS.includes(sem)) return res.status(400).json({ error: 'Choose a valid semester (1st Semester, 2nd Semester, or Summer).' });
  if (!/^\d{4}-\d{4}$/.test(ay)) return res.status(400).json({ error: 'Academic year must be in the format YYYY-YYYY.' });
  try {
    await pool.query("INSERT INTO reg_settings (key, value) VALUES ('grading_semester', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [sem]);
    await pool.query("INSERT INTO reg_settings (key, value) VALUES ('grading_ay', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [ay]);
    logAction(req, 'University Registrar', 'settings updated', ay + ' · ' + sem);
    res.json({ ok: true, grading_semester: sem, grading_ay: ay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

// ----- Enrollment schedule (open/close switch and per-college enrollment dates) -----
function enrollmentStateFrom(m) {
  let schedule = {};
  try { schedule = JSON.parse(m.enrollment_schedule || '{}') || {}; } catch (_) { schedule = {}; }
  return { enrollment_open: m.enrollment_open === '1', enrollment_schedule: schedule };
}
async function enrollmentSettings() {
  const { rows } = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('enrollment_open','enrollment_schedule')");
  return enrollmentStateFrom(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}
function manilaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}
// College registrars can enroll only while the master switch is open. The University Registrar is never blocked.
async function blockIfEnrollmentClosed(req, res) {
  if (req.reg && req.reg.role === 'superadmin') return false;
  const st = await enrollmentSettings();
  if (st.enrollment_open) return false;
  res.status(403).json({ error: 'Enrollment is closed. The University Registrar opens it in Settings → Enrollment Section.' });
  return true;
}
// Student Portal: open only when the master switch is on AND today is one of the student's college enrollment dates.
app.get('/api/portal/enrollment-window', requirePortal('student'), async (req, res) => {
  try {
    const st = await enrollmentSettings();
    const dates = st.enrollment_schedule[req.portal.college] || [];
    const today = manilaToday();
    res.json({ open: st.enrollment_open && dates.includes(today), enrollment_open: st.enrollment_open, college_dates: dates, today });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the enrollment window.' });
  }
});
app.get('/api/registrar/enrollment-schedule', requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM reg_settings WHERE key IN ('enrollment_open','enrollment_schedule')");
    res.json({ ...enrollmentStateFrom(Object.fromEntries(rows.map((r) => [r.key, r.value]))), colleges: REG_COLLEGES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the enrollment schedule.' });
  }
});
app.post('/api/registrar/enrollment-schedule', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  if (typeof b.open !== 'boolean') return res.status(400).json({ error: 'Enrollment open/close state is required.' });
  const raw = b.schedule && typeof b.schedule === 'object' ? b.schedule : {};
  const clean = {};
  for (const college of REG_COLLEGES) {
    const dates = Array.isArray(raw[college]) ? raw[college] : [];
    const valid = [...new Set(dates.map((d) => String(d || '').trim()))].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')));
    if (dates.length && valid.length !== new Set(dates.map((d) => String(d || '').trim())).size) return res.status(400).json({ error: `Invalid date for ${college}. Use the date picker.` });
    if (valid.length) clean[college] = valid.sort();
  }
  try {
    await pool.query("INSERT INTO reg_settings (key, value) VALUES ('enrollment_open', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [b.open ? '1' : '0']);
    await pool.query("INSERT INTO reg_settings (key, value) VALUES ('enrollment_schedule', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(clean)]);
    logAction(req, 'University Registrar', 'enrollment schedule updated', (b.open ? 'open' : 'closed') + ' · ' + Object.keys(clean).length + ' college(s)');
    res.json({ ok: true, enrollment_open: !!b.open, enrollment_schedule: clean });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the enrollment schedule.' });
  }
});

// ----- College Registrar and CSC accounts (University Registrar, Accounts section) -----
const cleanNamePart = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Builds a username from first and last name (e.g. bart.santiago) and adds a number if it is taken.
async function autoStaffUsername(first, last) {
  const base = [cleanNamePart(first), cleanNamePart(last)].filter(Boolean).join('.').slice(0, 50) || 'staff';
  let candidate = base, n = 2;
  for (;;) {
    const r = await pool.query(
      'SELECT 1 FROM accounts WHERE username = $1 UNION ALL SELECT 1 FROM csc_accounts WHERE username = $1 UNION ALL SELECT 1 FROM reg_users WHERE username = $1 LIMIT 1', [candidate]);
    if (!r.rowCount) return candidate;
    candidate = base + n++;
  }
}
const STAFF_KINDS = { registrar: 'accounts', university: 'accounts', uniregistrar: 'accounts', nstp: 'accounts', csc: 'csc_accounts' };
const CSC_POSITIONS = ['President', 'Vice President', 'Secretary', 'Assistant Secretary', 'Treasurer', 'Auditor', 'Public Information Officer', 'Business Manager', 'Representative'];
function staffTable(kind) { return STAFF_KINDS[kind] || null; }
function staffRole(kind) { return kind === 'nstp' ? 'nstp' : kind === 'university' ? 'university' : kind === 'uniregistrar' ? 'uniregistrar' : 'registrar'; }
function staffWhere(kind) { return kind === 'university' ? " WHERE role IN ('university','uniregistrar')" : kind === 'registrar' || kind === 'uniregistrar' || kind === 'nstp' ? " WHERE role = '" + staffRole(kind) + "'" : ''; }
function staffAnd(kind) { return kind === 'university' ? " AND role IN ('university','uniregistrar')" : kind === 'registrar' || kind === 'uniregistrar' || kind === 'nstp' ? " AND role = '" + staffRole(kind) + "'" : ''; }
app.get('/api/registrar/staff/:kind', requireSuperAdmin, async (req, res) => {
  const kind = req.params.kind;
  if (!staffTable(kind)) return res.status(404).json({ error: 'Unknown account type.' });
  try {
    const sql = kind === 'registrar' || kind === 'university' || kind === 'nstp'
      ? "SELECT id, COALESCE(username, email) AS username, last_name, first_name, COALESCE(middle_name,'') AS middle_name, COALESCE(name_extension,'') AS extension, email, CASE WHEN role = 'uniregistrar' THEN 'University Registrar' ELSE COALESCE(college,'') END AS college, '' AS position, archived_at FROM accounts WHERE " + (kind === 'university' ? "role IN ('university','uniregistrar')" : "role = '" + staffRole(kind) + "'") + " ORDER BY archived_at IS NOT NULL, last_name, first_name"
      : "SELECT id, username, last_name, first_name, middle_name, extension, email, '' AS college, position, archived_at FROM csc_accounts ORDER BY archived_at IS NOT NULL, last_name, first_name";
    const { rows } = await pool.query(sql);
    res.json({ accounts: rows, positions: CSC_POSITIONS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the accounts.' });
  }
});
app.post('/api/registrar/staff/:kind', requireSuperAdmin, async (req, res) => {
  const kind = req.params.kind;
  if (!staffTable(kind)) return res.status(404).json({ error: 'Unknown account type.' });
  const b = req.body || {};
  const last = String(b.last_name || '').trim().slice(0, 100);
  const first = String(b.first_name || '').trim().slice(0, 100);
  const middle = String(b.middle_name || '').trim().slice(0, 100);
  const ext = String(b.extension || '').trim().slice(0, 20);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  if (!last || !first) return res.status(400).json({ error: 'Last name and first name are required.' });
  if (!STRICT_EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const temp = generateTempPassword();
  try {
    const username = await autoStaffUsername(first, last);
    if (kind === 'university' && String(b.college || '') === 'REGISTRAR') {
      await pool.query(
        "INSERT INTO accounts (category, first_name, middle_name, last_name, name_extension, email, password_hash, role, college, username, must_change_password) VALUES ('REGISTRAR',$1,$2,$3,$4,$5,$6,'uniregistrar','',$7,TRUE)",
        [first, middle, last, ext, email, hashPassword(temp), username]);
      logAction(req, 'University Registrar', 'University Registrar account created', email);
      const emailed = await sendStaffWelcome(req, { kind: 'uniregistrar', to: email, name: first + ' ' + last, username, temp });
      return res.json({ ok: true, username, temp_password: temp, email_sent: emailed });
    }
    if (kind === 'university') {
      const college = String(b.college || '');
      if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
      await pool.query(
        "INSERT INTO accounts (category, first_name, middle_name, last_name, name_extension, email, password_hash, role, college, username, must_change_password) VALUES ('REGISTRAR',$1,$2,$3,$4,$5,$6,'university',$7,$8,TRUE)",
        [first, middle, last, ext, email, hashPassword(temp), college, username]);
      logAction(req, 'University Registrar', 'Records-in-Charge account created', email + ' · ' + college);
      const emailed = await sendStaffWelcome(req, { kind: 'university', to: email, name: first + ' ' + last, username, temp, college });
      return res.json({ ok: true, username, temp_password: temp, email_sent: emailed });
    }
    if (kind === 'registrar') {
      const college = String(b.college || '');
      if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
      await pool.query(
        "INSERT INTO accounts (category, first_name, middle_name, last_name, name_extension, email, password_hash, role, college, username, must_change_password) VALUES ('REGISTRAR',$1,$2,$3,$4,$5,$6,'registrar',$7,$8,TRUE)",
        [first, middle, last, ext, email, hashPassword(temp), college, username]);
      logAction(req, 'University Registrar', 'college registrar account created', email + ' · ' + college);
      const emailed = await sendStaffWelcome(req, { kind: 'registrar', to: email, name: first + ' ' + last, username, temp, college });
      return res.json({ ok: true, username, temp_password: temp, email_sent: emailed });
    }
    if (kind === 'nstp') {
      await pool.query(
        "INSERT INTO accounts (category, first_name, middle_name, last_name, name_extension, email, password_hash, role, college, username, must_change_password) VALUES ('REGISTRAR',$1,$2,$3,$4,$5,$6,'nstp','',$7,TRUE)",
        [first, middle, last, ext, email, hashPassword(temp), username]);
      logAction(req, 'University Registrar', 'NSTP officer account created', email);
      const emailed = await sendStaffWelcome(req, { kind: 'nstp', to: email, name: first + ' ' + last, username, temp });
      return res.json({ ok: true, username, temp_password: temp, email_sent: emailed });
    }
    const position = String(b.position || '');
    if (!CSC_POSITIONS.includes(position)) return res.status(400).json({ error: 'Choose a position.' });
    await pool.query(
      'INSERT INTO csc_accounts (username, password_hash, last_name, first_name, middle_name, extension, email, position, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)',
      [username, hashPassword(temp), last, first, middle, ext, email, position]);
    logAction(req, 'University Registrar', 'CSC account created', username + ' · ' + position);
    const emailed = await sendStaffWelcome(req, { kind: 'csc', to: email, name: first + ' ' + last, username, temp });
    res.json({ ok: true, username, temp_password: temp, email_sent: emailed });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: kind === 'csc' ? 'That CSC username already exists.' : 'That email already has an account of this type.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});
// Staff first login: the emailed Click to Login button opens the change-password page, which posts here.
app.post('/api/staff/first-login', async (req, res) => {
  const b = req.body || {};
  const t = readStaffSetupToken(b.token);
  const table = t ? staffTable(t.k) : null;
  if (!t || !table) return res.status(400).json({ error: 'This link is not valid or has expired. Ask the University Registrar to send your account email again.' });
  const current = String(b.current || ''), next = String(b.new || '');
  if (!current) return res.status(400).json({ error: 'Enter the temporary password from your email.' });
  if (next.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  if (next === current) return res.status(400).json({ error: 'The new password must be different from the temporary password.' });
  try {
    const cols = t.k === 'csc' ? 'id, password_hash, must_change_password' : 'id, password_hash, must_change_password, college';
    const { rows } = await pool.query('SELECT ' + cols + ' FROM ' + table + ' WHERE username = $1 AND archived_at IS NULL' + staffAnd(t.k), [t.u]);
    const row = rows[0];
    if (!row || !verifyPassword(current, row.password_hash)) return res.status(401).json({ error: 'The temporary password is incorrect.' });
    if (!row.must_change_password) return res.status(400).json({ error: 'This password was already changed. Please sign in with your new password.', login: staffLoginPage(t.k, row.college) });
    await pool.query('UPDATE ' + table + ' SET password_hash = $2, must_change_password = FALSE WHERE id = $1', [row.id, hashPassword(next)]);
    logAction(req, t.u, 'password changed at first login', t.k);
    res.json({ ok: true, login: staffLoginPage(t.k, row.college) });
  } catch (err) {
    console.error('first-login:', err.message);
    res.status(500).json({ error: 'Could not change the password. Try again.' });
  }
});
app.post('/api/registrar/staff/:kind/:action', requireSuperAdmin, async (req, res) => {
  const kind = req.params.kind, action = req.params.action;
  const table = staffTable(kind);
  if (!table) return res.status(404).json({ error: 'Unknown account type.' });
  const ids = parseIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one account.' });
  const label = kind === 'registrar' ? 'college registrar' : kind === 'university' ? 'University Registrar staff' : kind === 'nstp' ? 'NSTP' : 'CSC';
  try {
    if (action === 'archive') {
      const r = await pool.query(`UPDATE ${table} SET archived_at = now() WHERE id = ANY($1::int[]) AND archived_at IS NULL${staffAnd(kind)}`, [ids]);
      logAction(req, 'University Registrar', label + ' accounts archived', r.rowCount + ' account(s)');
      return res.json({ ok: true, count: r.rowCount });
    }
    if (action === 'restore') {
      const r = await pool.query(`UPDATE ${table} SET archived_at = NULL WHERE id = ANY($1::int[]) AND archived_at IS NOT NULL${staffAnd(kind)}`, [ids]);
      logAction(req, 'University Registrar', label + ' accounts restored', r.rowCount + ' account(s)');
      return res.json({ ok: true, count: r.rowCount });
    }
    if (action === 'delete') {
      if (String((req.body || {}).confirm || '') !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
      const r = await pool.query(`DELETE FROM ${table} WHERE id = ANY($1::int[]) AND archived_at IS NOT NULL${staffAnd(kind)}`, [ids]);
      logAction(req, 'University Registrar', label + ' accounts deleted', r.rowCount + ' account(s)');
      return res.json({ ok: true, count: r.rowCount });
    }
    if (action === 'reset') {
      const id = ids[0];
      const temp = generateTempPassword();
      const r = await pool.query('UPDATE ' + table + ' SET password_hash = $2, must_change_password = TRUE WHERE id = $1' + staffAnd(kind) + ' RETURNING username, email, first_name, last_name' + (kind === 'csc' ? '' : ', college'), [id, hashPassword(temp)]);
      if (!r.rowCount) return res.status(404).json({ error: 'Account not found.' });
      const acct = r.rows[0];
      logAction(req, 'University Registrar', label + ' password reset', 'account #' + id);
      const emailed = await sendStaffWelcome(req, { kind, to: acct.email, name: acct.first_name + ' ' + acct.last_name, username: acct.username, temp, college: acct.college });
      return res.json({ ok: true, temp_password: temp, email_sent: emailed });
    }
    return res.status(404).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error(action + ':', err.message);
    res.status(500).json({ error: 'Could not complete the action.' });
  }
});

// ----- CSC Portal (CSC fee PAID marking; PAID students move on to Step 6) -----
const CSC_SESSION_MS = 8 * 60 * 60 * 1000;
const cscAttempts = new Map();
function readCscSession(req) {
  const m = /(?:^|;\s*)csc_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = signSession(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (d.role !== 'csc' || !d.exp || d.exp < Date.now()) return null;
    return d;
  } catch { return null; }
}
function requireCsc(req, res, next) {
  if (!readCscSession(req)) return res.status(401).json({ error: 'Not logged in.' });
  next();
}
app.post('/api/csc/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = cscAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  if (rec.count >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const username = String((req.body && req.body.username) || '').trim().slice(0, 200);
  const password = String((req.body && req.body.password) || '').slice(0, 200);
  const cu = process.env.CSC_USERNAME || '';
  const cp = process.env.CSC_PASSWORD || '';
  let ok = !!(cu && cp && username && password && regSafeEqual(username, cu) && regSafeEqual(password, cp));
  if (!ok && username && password) {
    try {
      const r = await pool.query('SELECT password_hash, must_change_password FROM csc_accounts WHERE username = $1 AND archived_at IS NULL', [username.toLowerCase()]);
      if (r.rows.length && r.rows[0].must_change_password && verifyPassword(password, r.rows[0].password_hash)) return res.json({ ok: true, must_change: true, token: staffSetupTokenFor('csc', username.toLowerCase()) });
      ok = !!(r.rows.length && verifyPassword(password, r.rows[0].password_hash));
    } catch (err) { console.error(err); }
  }
  if (ok) {
    cscAttempts.delete(ip);
    const body = Buffer.from(JSON.stringify({ role: 'csc', exp: now + CSC_SESSION_MS })).toString('base64url');
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `csc_session=${body}.${signSession(body)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
    return res.json({ ok: true });
  }
  rec.count += 1;
  cscAttempts.set(ip, rec);
  res.status(401).json({ error: 'Incorrect username or password.' });
});
app.post('/api/csc/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'csc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/csc/me', requireCsc, (req, res) => res.json({ role: 'csc' }));
app.get('/api/csc/students', requireCsc, async (req, res) => {
  const college = String(req.query.college || '');
  if (!REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const { rows } = await pool.query(
      `SELECT student_no, last_name, first_name, middle_name, name_extension, program, year_level, section, csc_paid_at
       FROM reg_students WHERE college = $1 AND status IN ('enrolled','pre-registered') ORDER BY last_name, first_name`, [college]);
    res.json({ students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load students.' });
  }
});
app.post('/api/csc/students/:no/paid', requireCsc, async (req, res) => {
  const no = String(req.params.no || '').trim();
  const paid = !!(req.body && req.body.paid === true);
  try {
    const r = await pool.query(
      `UPDATE reg_students SET csc_paid_at = CASE WHEN $2 THEN COALESCE(csc_paid_at, now()) ELSE NULL END
       WHERE student_no = $1 AND status IN ('enrolled','pre-registered') RETURNING student_no, college, csc_paid_at`, [no, paid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Student not found.' });
    logAction(req, 'CSC Portal', paid ? 'CSC fee marked PAID' : 'CSC fee marked unpaid', no + ' · ' + r.rows[0].college);
    res.json({ ok: true, student_no: no, paid, csc_paid_at: r.rows[0].csc_paid_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update the CSC fee status.' });
  }
});
// Step 6 (Registrar Office): students whose CSC fee is PAID, with their Step 6 task progress
app.get('/api/registrar/step6', requireRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  if (!college || !REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const { rows } = await pool.query(
      `SELECT student_no, last_name, first_name, middle_name, program, year_level, section, status, csc_paid_at,
              advising_slip_at, coe_printed_at, id_validated_at
       FROM reg_students WHERE college = $1 AND csc_paid_at IS NOT NULL ORDER BY csc_paid_at, last_name`, [college]);
    res.json({ students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load Step 6 students.' });
  }
});

// Step 6 task toggles: advising slip, COE printing, ID validation
const STEP6_TASKS = { advising: 'advising_slip_at', coe: 'coe_printed_at', id: 'id_validated_at' };
const STEP6_LABELS = { advising: 'Advising slip submitted', coe: 'COE printed', id: 'ID validated' };
app.post('/api/registrar/step6/:no/:task', requireRegistrar, async (req, res, next) => {
  const col = STEP6_TASKS[req.params.task];
  if (!col) return next();
  const college = regCollege(req, (req.body || {}).college);
  if (!college) return res.status(400).json({ error: 'Invalid Step 6 request.' });
  const no = String(req.params.no || '').trim();
  const done = !!((req.body || {}).done === true);
  try {
    const r = await pool.query(
      `UPDATE reg_students SET ${col} = CASE WHEN $3 THEN COALESCE(${col}, now()) ELSE NULL END
       WHERE student_no = $1 AND college = $2 AND csc_paid_at IS NOT NULL RETURNING student_no, ${col} AS done_at`, [no, college, done]);
    if (!r.rows.length) return res.status(404).json({ error: 'Student not found or CSC fee not yet paid.' });
    // Undoing a required step takes the student back out of Officially Enrolled.
    if (!done && req.params.task === 'advising') {
      await pool.query("UPDATE reg_students SET status = 'pre-registered' WHERE student_no = $1 AND college = $2 AND status = 'enrolled'", [no, college]);
    }
    logAction(req, 'Registrar Office', (done ? 'Step 6 done: ' : 'Step 6 undone: ') + STEP6_LABELS[req.params.task], no + ' · ' + college);
    res.json({ ok: true, student_no: no, done_at: r.rows[0].done_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update Step 6.' });
  }
});

// Steps that must be done before the University Registrar can enroll a student.
const ENROLL_CHECKS = [
  { label: 'Step 1 (Grades verified)', ok: (r) => r.step1_status === 'verified' },
  { label: 'Step 2 · Evaluation', ok: (r) => !!r.step2_evaluated_at },
  { label: 'Step 2 · Advising', ok: (r) => !!r.step2_advised_at },
  { label: 'Step 2 · Section Assignment', ok: (r) => !!r.step2_sectioned_at },
  // NSTP: required for Year 1 and 2, or for anyone who chose an NSTP subject in Step 2. Otherwise Step 3 is automatically done.
  { label: 'Step 3 · NSTP', ok: (r) => !((Number(r.year_level) <= 2) || !!r.nstp_subject) || !!r.nstp_enrolled_at },
  // Step 4 (Official CUP ID): done automatically once the student has a student number.
  { label: 'Step 4 · Official CUP ID', ok: (r) => !!String(r.student_no || '').trim() },
  { label: 'Step 5 · CSC payment', ok: (r) => !!r.csc_paid_at },
  { label: 'Step 6 · Advising slip submitted', ok: (r) => !!r.advising_slip_at },
];
function enrollMissing(r) { return ENROLL_CHECKS.filter((c) => !c.ok(r)).map((c) => c.label); }
const ENROLL_ROW_SQL = `SELECT student_no, status, year_level, COALESCE(nstp_subject, '') AS nstp_subject, nstp_enrolled_at, step1_status, step2_evaluated_at, step2_advised_at, step2_sectioned_at, csc_paid_at, advising_slip_at, coe_printed_at, id_validated_at
  FROM reg_students WHERE student_no = $1 AND college = $2`;
// Readiness for the Submission of Advising Slip page: which steps are still not done.
app.get('/api/registrar/enroll-readiness/:no', requireSuperAdmin, async (req, res) => {
  const college = regCollege(req, req.query.college);
  if (!college) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const r = await pool.query(ENROLL_ROW_SQL, [String(req.params.no || '').trim(), college]);
    if (!r.rows.length) return res.status(404).json({ error: 'Student not found.' });
    const missing = enrollMissing(r.rows[0]);
    const x = r.rows[0];
    res.json({ ready: missing.length === 0 && x.status === 'pre-registered', missing, status: x.status,
      tasks: { csc: !!x.csc_paid_at, advising: !!x.advising_slip_at, coe: !!x.coe_printed_at, id: !!x.id_validated_at } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check the steps.' });
  }
});
// University Registrar: undo Officially Enrolled (back to pre-enrolled).
app.post('/api/registrar/enroll-official/:no/undo', requireSuperAdmin, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college);
  if (!college) return res.status(400).json({ error: 'Choose a college.' });
  const no = String(req.params.no || '').trim();
  try {
    const r = await pool.query("UPDATE reg_students SET status = 'pre-registered' WHERE student_no = $1 AND college = $2 AND status = 'enrolled' RETURNING student_no", [no, college]);
    if (!r.rows.length) return res.status(400).json({ error: 'This student is not officially enrolled.' });
    logAction(req, 'University Registrar', 'Officially Enrolled undone (Submission of Advising Slip)', no + ' · ' + college);
    res.json({ ok: true, student_no: no });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not undo the enrollment.' });
  }
});
// University Registrar: mark a pre-registered student Officially Enrolled, only when every step is done.
app.post('/api/registrar/enroll-official/:no', requireSuperAdmin, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college);
  if (!college) return res.status(400).json({ error: 'Choose a college.' });
  const no = String(req.params.no || '').trim();
  try {
    const cur = await pool.query(ENROLL_ROW_SQL, [no, college]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Student not found.' });
    if (cur.rows[0].status !== 'pre-registered') return res.status(400).json({ error: 'This student is already officially enrolled.' });
    const missing = enrollMissing(cur.rows[0]);
    if (missing.length) return res.status(400).json({ error: 'Not yet done: ' + missing.join(', ') + '.' });
    await pool.query("UPDATE reg_students SET status = 'enrolled' WHERE student_no = $1 AND college = $2 AND status = 'pre-registered'", [no, college]);
    logAction(req, 'University Registrar', 'Officially Enrolled (Submission of Advising Slip)', no + ' · ' + college);
    res.json({ ok: true, student_no: no });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not enroll the student.' });
  }
});

// Registrar tags the student Officially Enrolled, only after all Step 6 tasks are complete
app.post('/api/registrar/step6/:no/official', requireRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college);
  if (!college) return res.status(400).json({ error: 'Choose a college.' });
  const no = String(req.params.no || '').trim();
  try {
    const r = await pool.query(
      `UPDATE reg_students SET status = 'enrolled'
       WHERE student_no = $1 AND college = $2 AND csc_paid_at IS NOT NULL
         AND advising_slip_at IS NOT NULL AND coe_printed_at IS NOT NULL AND id_validated_at IS NOT NULL
       RETURNING student_no`, [no, college]);
    if (!r.rows.length) return res.status(400).json({ error: 'Complete all three Step 6 tasks first.' });
    logAction(req, 'Registrar Office', 'Tagged Officially Enrolled (Step 6 complete)', no + ' · ' + college);
    res.json({ ok: true, student_no: no });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not tag Officially Enrolled.' });
  }
});

// Step 2 (Dean's Office, College Registrar): student evaluation, advising and section assignment
// Marking a step done requires the student's grades to be fully approved (Step 1 verified).
async function step2Blocked(no, college) {
  const r = await pool.query("SELECT step1_status FROM reg_students WHERE student_no = $1 AND college = $2 AND status IN ('enrolled','pre-registered')", [no, college]);
  if (!r.rows.length) return 'Student not found.';
  if (r.rows[0].step1_status !== 'verified') return 'Grades are not yet fully approved for this student, so this step cannot be marked done yet.';
  return null;
}
// Student standing (REGULAR, IRREGULAR, WARNING, PROBATION, PERMANENT DISQUALIFICATION) for the info panels.
app.get('/api/registrar/student-standing/:no', requireCollegeRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  if (!college) return res.status(403).json({ error: 'Choose a college.' });
  try {
    const no = String(req.params.no || '').trim();
    const own = await pool.query('SELECT 1 FROM reg_students WHERE student_no = $1 AND college = $2', [no, college]);
    if (!own.rows.length) return res.status(404).json({ error: 'Student not found.' });
    const r = await studentRetentionStatus(no);
    res.json({ standing: r ? r.status : '' });
  } catch (err) {
    console.error('student standing', err);
    res.status(500).json({ error: 'Could not load the student status.' });
  }
});

app.get('/api/registrar/step2', requireCollegeRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  if (!college || !REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const { rows } = await pool.query(
      `SELECT student_no, last_name, first_name, middle_name, program, year_level, section, status, COALESCE(step1_status, '') AS step1_status,
              step2_evaluated_at, step2_advised_at, step2_sectioned_at, COALESCE(nstp_subject, '') AS nstp_subject
       FROM reg_students WHERE college = $1 AND status IN ('enrolled','pre-registered')
       ORDER BY last_name, first_name`, [college]);
    res.json({ students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load Step 2 students.' });
  }
});

const STEP2_TASKS = { evaluation: 'step2_evaluated_at', advising: 'step2_advised_at', section: 'step2_sectioned_at' };
const STEP2_LABELS = { evaluation: 'Student evaluation', advising: 'Advising', section: 'Section assignment' };
app.post('/api/registrar/step2/:no/:task', requireCollegeRegistrar, async (req, res, next) => {
  const col = STEP2_TASKS[req.params.task];
  if (!col) return next();
  const college = regCollege(req, (req.body || {}).college);
  if (!college) return res.status(400).json({ error: 'Invalid Step 2 request.' });
  const no = String(req.params.no || '').trim();
  const done = (req.body || {}).done === true;
  const blockedT = done ? await step2Blocked(no, college) : null;
  if (blockedT) return res.status(400).json({ error: blockedT });
  try {
    const r = await pool.query(
      `UPDATE reg_students SET ${col} = CASE WHEN $3 THEN COALESCE(${col}, now()) ELSE NULL END
       WHERE student_no = $1 AND college = $2 AND status IN ('enrolled','pre-registered') RETURNING student_no, ${col} AS done_at`, [no, college, done]);
    if (!r.rows.length) return res.status(404).json({ error: 'Student not found.' });
    logAction(req, 'College Registrar', (done ? 'Step 2 done: ' : 'Step 2 undone: ') + STEP2_LABELS[req.params.task], no + ' · ' + college);
    res.json({ ok: true, student_no: no, done_at: r.rows[0].done_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update Step 2.' });
  }
});

// Step 2 advising: the NSTP subject the student is pre-registered for (NSTP 1 = CWTS, ROTC 1 = ROTC).
app.post('/api/registrar/step2/:no/nstp', requireCollegeRegistrar, async (req, res) => {
  const college = regCollege(req, (req.body || {}).college);
  if (!college) return res.status(400).json({ error: 'Invalid Step 2 request.' });
  const subject = String((req.body || {}).subject || '');
  if (subject && !NSTP_CODES.includes(subject)) return res.status(400).json({ error: 'Choose NSTP 1 (CWTS) or ROTC 1.' });
  const no = String(req.params.no || '').trim();
  const blockedN = await step2Blocked(no, college);
  if (blockedN) return res.status(400).json({ error: blockedN });
  try {
    const r = await pool.query(
      `UPDATE reg_students SET nstp_subject = NULLIF($3, '') WHERE student_no = $1 AND college = $2 AND status IN ('enrolled','pre-registered') RETURNING student_no, nstp_subject`,
      [no, college, subject]);
    if (!r.rows.length) return res.status(404).json({ error: 'Student not found.' });
    logAction(req, 'College Registrar', 'NSTP subject set', no + ' · ' + (subject || 'none') + ' · ' + college);
    res.json({ ok: true, student_no: no, nstp_subject: r.rows[0].nstp_subject || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the NSTP choice.' });
  }
});

// Section Assignment: live counts per program code, year level and section
app.get('/api/registrar/step2/section-counts', requireCollegeRegistrar, async (req, res) => {
  const college = regCollege(req, req.query.college);
  const year = String(req.query.year || '').trim();
  if (!college || !REG_COLLEGES.includes(college) || !/^[1-9]$/.test(year)) return res.status(400).json({ error: 'Choose a college and year level.' });
  try {
    const counts = await pool.query(
      `SELECT program, section, COUNT(*)::int AS n
       FROM reg_students WHERE college = $1 AND status IN ('enrolled','pre-registered') AND year_level::text = $2
         AND section IS NOT NULL AND section <> ''
       GROUP BY program, section`, [college, year]);
    // Group by the program code in brackets, e.g. "Bachelor of Science in Nursing (BSN)" -> BSN
    var byKey = {};
    counts.rows.forEach(function (r) {
      var m = String(r.program || '').match(/\(([^)]+)\)\s*$/);
      var code = m ? m[1] : String(r.program || '');
      var key = code + '|' + r.section;
      byKey[key] = { code: code, section: r.section, n: (byKey[key] ? byKey[key].n : 0) + r.n };
    });
    var countRows = Object.keys(byKey).map(function (k) { return byKey[k]; });
    const secs = await pool.query(
      `SELECT DISTINCT section FROM reg_students WHERE college = $1 AND section IS NOT NULL AND section <> ''`, [college]);
    const sections = Array.from(new Set(['A', 'B', 'C', 'D', 'E'].concat(secs.rows.map(function (r) { return String(r.section).trim(); }))))
      .filter(Boolean).sort();
    res.json({ year, sections, counts: countRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load section counts.' });
  }
});

// Section Assignment: save year level and section for the student, and mark the task done
app.post('/api/registrar/step2/:no/assign-section', requireCollegeRegistrar, async (req, res) => {
  const body = req.body || {};
  const college = regCollege(req, body.college);
  const year = String(body.year_level || '').trim();
  const section = String(body.section || '').trim().toUpperCase();
  if (!college || !/^[1-9]$/.test(year) || !/^[A-Z]{1,2}$/.test(section)) return res.status(400).json({ error: 'Choose a year level and section.' });
  const no = String(req.params.no || '').trim();
  const blockedS = await step2Blocked(no, college);
  if (blockedS) return res.status(400).json({ error: blockedS });
  try {
    const r = await pool.query(
      `UPDATE reg_students SET year_level = $3, section = $4, step2_sectioned_at = now()
       WHERE student_no = $1 AND college = $2 AND status IN ('enrolled','pre-registered') RETURNING student_no`, [no, college, year, section]);
    if (!r.rows.length) return res.status(404).json({ error: 'Student not found.' });
    logAction(req, 'College Registrar', 'Step 2 section assigned: ' + year + section, no + ' · ' + college);
    res.json({ ok: true, student_no: no });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the section.' });
  }
});

// Step 1 (Evaluation): a student is verified once every grade on file has been approved by the University Registrar,
// regardless of the grades, and then proceeds to Step 2. Failed, Conditional, Incomplete, Dropped, Absent, No Grade or
// mismatched remarks are listed for review; those are handled through the College Registrar.
// awaiting = some grades not yet approved; no-grades = nothing on file yet.
async function runStep1(studentNos) {
  const nos = Array.from(new Set((studentNos || []).map(String).filter(Boolean)));
  const result = {};
  if (!nos.length) return result;
  const { rows } = await pool.query('SELECT student_no, status FROM reg_grades WHERE student_no = ANY($1)', [nos]);
  const byNo = {};
  rows.forEach((r) => { (byNo[r.student_no] = byNo[r.student_no] || []).push(r); });
  const outNos = [], outStatus = [];
  nos.forEach((no) => {
    const list = byNo[no] || [];
    let st = 'no-grades';
    if (list.length) st = list.every((g) => g.status === 'approved') ? 'verified' : 'awaiting';
    result[no] = st; outNos.push(no); outStatus.push(st);
  });
  await pool.query(
    `UPDATE reg_students s SET step1_status = v.st,
            step1_verified_at = CASE WHEN v.st = 'verified' THEN COALESCE(s.step1_verified_at, now()) ELSE NULL END
     FROM (SELECT unnest($1::text[]) AS no, unnest($2::text[]) AS st) v
     WHERE s.student_no = v.no`, [outNos, outStatus]);
  return result;
}

function step1College(req, given) {
  if (req.reg && (req.reg.role === 'registrar' || req.reg.role === 'records')) return req.reg.college;
  if (req.reg && req.reg.role === 'superadmin') { const c = String(given || ''); return REG_COLLEGES.includes(c) ? c : null; }
  return null;
}

app.get('/api/registrar/step1', requireRegistrar, async (req, res) => {
  const college = step1College(req, req.query.college);
  if (!college || !REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a college.' });
  try {
    const students = await pool.query(
      `SELECT student_no, last_name, first_name, middle_name, program, year_level, section, status
       FROM reg_students WHERE college = $1 AND status IN ('enrolled','pre-registered') ORDER BY last_name, first_name`, [college]);
    const statuses = await runStep1(students.rows.map((r) => r.student_no));
    const grades = await pool.query(
      'SELECT student_no, course_code, final_grade, remarks FROM reg_grades WHERE college = $1', [college]);
    const issues = {};
    grades.rows.forEach((g) => {
      const computed = computeServerRemark(g.final_grade);
      if (computed !== 'PASSED' || (g.remarks && g.remarks !== computed)) {
        (issues[g.student_no] = issues[g.student_no] || []).push({ course_code: g.course_code, final_grade: g.final_grade, remark: computed || g.remarks || '' });
      }
    });
    res.json({
      students: students.rows.map((r) => ({ ...r, step1_status: statuses[r.student_no] || 'no-grades', issues: issues[r.student_no] || [] }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load Step 1.' });
  }
});

function normalizeCsvDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    // Dates like 17/03/2008 are day-first; 03/17/2008 is month-first. Only swap when the first number cannot be a month.
    let mon = Number(m[1]), day = Number(m[2]);
    if (mon > 12 && day <= 12) [mon, day] = [day, mon];
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return `${m[3]}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function normalizeCsvContact(raw) {
  let s = String(raw || '').trim().replace(/[\s\-()]/g, '');
  if (!s) return null;
  if (/^9\d{9}$/.test(s)) s = '0' + s;
  if (/^639\d{9}$/.test(s)) s = '+' + s;
  return STRICT_CONTACT_RE.test(s) ? s : '__invalid__';
}

function normalizeCsvSemester(raw, fallbackSem) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return fallbackSem || '1st Semester';
  if (s === '1' || s === '1st' || s === '1st semester' || s === 'first' || s === 'first semester') return '1st Semester';
  if (s === '2' || s === '2nd' || s === '2nd semester' || s === 'second' || s === 'second semester') return '2nd Semester';
  if (s === '3' || s === 'summer') return 'Summer';
  return null;
}

function normalizeCsvYearLevel(raw) {
  const s = String(raw || '').trim();
  if (!s) return 1;
  const m = s.match(/[1-4]/);
  return m ? Number(m[0]) : null;
}

function normalizeCsvStudentNo(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d-\d{7}-\d{2}$/.test(s)) return s;
  const d = s.replace(/\D/g, '');
  if (d.length === 14) return `${d.slice(0, 4)}-${d.slice(4, 5)}-${d.slice(5, 12)}-${d.slice(12, 14)}`;
  return s;
}

function parseSubjectsCell(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return [...new Set(s.split(/[|;,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
}

// Multi-file Batch Upload Endpoint for Student, Faculty, and Grades (under the 8 college tabs)
// Stop or resume sending the credential emails from batch uploads (University and College Registrar).
app.post('/api/registrar/welcome-emails/:action', requireRegistrar, (req, res) => {
  const action = req.params.action;
  if (action !== 'stop' && action !== 'resume') return res.status(404).json({ error: 'Unknown action.' });
  welcomeEmailsStopped = action === 'stop';
  logAction(req, req.reg.role === 'registrar' ? (req.reg.college || '') + ' registrar' : 'University Registrar', welcomeEmailsStopped ? 'credential emails stopped' : 'credential emails resumed', '');
  res.json({ ok: true, stopped: welcomeEmailsStopped });
});

// Live progress for batch commits. The browser polls the job id while rows are being saved.
const batchJobs = new Map();
function batchJobStart(jobId, total) { if (jobId) batchJobs.set(jobId, { done: 0, total, at: Date.now() }); }
function batchJobTick(jobId) { const j = jobId && batchJobs.get(jobId); if (j) j.done += 1; }
function batchJobEnd(jobId) { if (jobId) setTimeout(() => batchJobs.delete(jobId), 60000); }
app.get('/api/registrar/batch-upload-progress/:jobId', requireRegistrar, (req, res) => {
  const j = batchJobs.get(String(req.params.jobId || ''));
  if (!j) return res.json({ done: 0, total: 0, active: false });
  res.json({ done: j.done, total: j.total, active: true });
});
app.post('/api/registrar/batch-upload/:type', requireRegistrar, async (req, res) => {
  const type = String(req.params.type || '').toLowerCase();
  if (!['student', 'faculty', 'grades'].includes(type)) return res.status(400).json({ error: 'Invalid batch upload type.' });
  const b = req.body || {};
  const college = regCollege(req, b.college || req.query.college);
  if (!college || !REG_COLLEGES.includes(college)) return res.status(400).json({ error: 'Choose a valid college.' });
  const dryRun = !!b.dryRun;
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.length) return res.status(400).json({ error: 'Select at least one CSV file.' });
  // Batch uploads always pre-register students. Only the Registrar Office (Step 6) tags Officially Enrolled.
  const enrollStatus = 'pre-registered';
  if (type === 'student' && await blockIfEnrollmentClosed(req, res)) return;

  const t = await activeTerm();
  const chosenAy = type === 'grades' && /^\d{4}-\d{4}$/.test(String(b.academic_year || '')) ? String(b.academic_year) : '';
  const activeAy = chosenAy || t.ay || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
  const activeSem = t.term || '1st Semester';

  // Load course catalog for subject lookups
  const coursesRes = await pool.query('SELECT college, course_code, descriptive_title, year_level FROM reg_courses');
  const titleByCode = new Map();
  coursesRes.rows.forEach((c) => {
    if (!titleByCode.has(c.course_code) || c.college === college) titleByCode.set(c.course_code, c.descriptive_title);
  });

  const errors = [];
  const parsedFiles = [];

  for (let fIdx = 0; fIdx < files.length; fIdx++) {
    const fObj = files[fIdx] || {};
    const fname = String(fObj.filename || `File_${fIdx + 1}.csv`);
    const rows = parseCsvText(fObj.csv || '');
    if (!rows.length) {
      errors.push(`${fname}: The CSV file is empty or has no data rows.`);
      continue;
    }
    parsedFiles.push({ filename: fname, rows });
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed. Nothing was uploaded.', errors });

  if (type === 'student') {
    const seenStu = new Set();
    const filePlans = [];
    for (const pf of parsedFiles) {
      const planRows = [];
      for (let i = 0; i < pf.rows.length; i++) {
        const r = pf.rows[i];
        const line = i + 2;
        const rawNo = r.student_number || r.student_no || '';
        const studentNo = normalizeCsvStudentNo(rawNo);
        if (!studentNo || !/^\d{4}-\d-\d{7}-\d{2}$/.test(studentNo)) {
          errors.push(`${pf.filename} (Row ${line}): student_number '${rawNo}' must be in the format xxxx-x-xxxxxxx-xx.`);
          continue;
        }
        const key = studentNo.toLowerCase();
        if (seenStu.has(key)) {
          errors.push(`${pf.filename} (Row ${line}): Duplicate student_number '${studentNo}' in the upload batch.`);
          continue;
        }
        seenStu.add(key);

        const lastName = String(r.last_name || '').trim().slice(0, 100);
        const firstName = String(r.first_name || '').trim().slice(0, 100);
        const middleName = String(r.middle_name || '').trim().slice(0, 100) || null;
        const extension = String(r.extension || r.name_extension || '').trim().slice(0, 30) || null;
        if (!lastName || !firstName) {
          errors.push(`${pf.filename} (Row ${line}): last_name and first_name are required.`);
          continue;
        }
        const gRaw = String(r.gender || '').trim().toLowerCase();
        const gender = gRaw === 'male' || gRaw === 'm' ? 'Male' : (gRaw === 'female' || gRaw === 'f' ? 'Female' : null);
        const civilRaw = String(r.status || '').trim();
        const civil = civilRaw ? canonicalCivil(civilRaw) : null;
        if (civilRaw && !civil) {
          errors.push(`${pf.filename} (Row ${line}): status '${civilRaw}' must be Single, Married, Widowed, Separated or Solo Parent.`);
          continue;
        }
        const birthday = normalizeCsvDate(r.birthday || r.birthdate);
        if ((r.birthday || r.birthdate) && !birthday) {
          errors.push(`${pf.filename} (Row ${line}): birthday '${r.birthday || r.birthdate}' must be YYYY-MM-DD.`);
          continue;
        }
        const contact = normalizeCsvContact(r.contact_number || r.contact);
        if (contact === '__invalid__') {
          errors.push(`${pf.filename} (Row ${line}): contact_number '${r.contact_number || r.contact}' must be 09XXXXXXXXX or +639XXXXXXXXX.`);
          continue;
        }
        const email = String(r.email || '').trim().toLowerCase().slice(0, 254) || null;
        if (!email) {
          errors.push(`${pf.filename} (Row ${line}): email is required.`);
          continue;
        }
        if (email && !STRICT_EMAIL_RE.test(email)) {
          errors.push(`${pf.filename} (Row ${line}): email '${r.email}' is not a valid email format.`);
          continue;
        }
        const rawProg = String(r.program || '').trim();
        if (rawProg) {
          const canonProg = canonicalProgram(rawProg) || (resolveProgramChoice(college, rawProg) || {}).program || null;
          if (!canonProg) {
            errors.push(`${pf.filename} (Row ${line}): program '${rawProg}' is not recognized.`);
            continue;
          }
          if (!(REG_PROGRAM_COLLEGES[college] || []).includes(canonProg)) {
            const owner = Object.keys(REG_PROGRAM_COLLEGES).find((c) => REG_PROGRAM_COLLEGES[c].includes(canonProg)) || 'another college';
            errors.push(`${pf.filename} (Row ${line}): ${canonProg} belongs to ${owner}. Upload this file under the ${owner} tab.`);
            continue;
          }
        }
        const program = canonicalProgram(rawProg) || (resolveProgramChoice(college, rawProg) || {}).program || rawProg || (REG_PROGRAM_COLLEGES[college] && REG_PROGRAM_COLLEGES[college][0]) || college;
        const yearLevel = normalizeCsvYearLevel(r.year_level);
        if (!yearLevel) {
          errors.push(`${pf.filename} (Row ${line}): year_level '${r.year_level}' must be 1 to 4.`);
          continue;
        }
        const section = String(r.section || 'A').trim().toUpperCase().slice(0, 10) || 'A';
        const subjCodes = parseSubjectsCell(r.subjects);

        planRows.push({
          student_no: studentNo,
          last_name: lastName,
          first_name: firstName,
          middle_name: middleName,
          extension,
          gender,
          civil_status: civil,
          birthday,
          contact_number: contact,
          email,
          program,
          year_level: yearLevel,
          section,
          subjects: subjCodes
        });
      }
      filePlans.push({ filename: pf.filename, rows: planRows });
    }
    if (errors.length) return res.status(400).json({ error: 'Validation failed. Fix the listed rows and retry.', errors });
    if (dryRun) return res.json({ ok: true, validatedFiles: filePlans.length });

    const jobId = String(b.jobId || '').slice(0, 64);
    batchJobStart(jobId, filePlans.reduce((n, fp) => n + fp.rows.length, 0));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Load default instructor assignments for this college & active term
      const asgRes = await client.query(
        `SELECT sa.course_code, sa.user_id, u.name AS instructor_name, sa.years, sa.sections
         FROM reg_subject_assignments sa JOIN reg_users u ON u.id = sa.user_id
         WHERE sa.college = $1 AND sa.term = $2 AND sa.academic_year = $3`,
        [college, activeSem, activeAy]);

      const fileResults = [];
      const welcomeItems = [];
      let totalSaved = 0;

      for (const fp of filePlans) {
        const created = [];
        for (const p of fp.rows) {
          await client.query(
            `INSERT INTO reg_students (student_no, college, first_name, middle_name, last_name, name_extension, gender, birthday, email, contact_number, program, year_level, section, civil_status, status, enrolled_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
             ON CONFLICT (student_no) DO UPDATE SET
               status = CASE WHEN EXCLUDED.status = 'enrolled' THEN 'enrolled' ELSE reg_students.status END,
               college = EXCLUDED.college, first_name = EXCLUDED.first_name, middle_name = EXCLUDED.middle_name,
               last_name = EXCLUDED.last_name, name_extension = EXCLUDED.name_extension, gender = COALESCE(EXCLUDED.gender, reg_students.gender),
               birthday = COALESCE(EXCLUDED.birthday, reg_students.birthday), email = COALESCE(EXCLUDED.email, reg_students.email),
               contact_number = COALESCE(EXCLUDED.contact_number, reg_students.contact_number), program = EXCLUDED.program,
               year_level = EXCLUDED.year_level, section = EXCLUDED.section, civil_status = COALESCE(EXCLUDED.civil_status, reg_students.civil_status)`,
            [p.student_no, college, p.first_name, p.middle_name, p.last_name, p.extension, p.gender, p.birthday, p.email, p.contact_number, p.program, p.year_level, p.section, p.civil_status, enrollStatus]);

          const temp = generateTempPassword();
          const fullName = `${p.last_name}, ${p.first_name}${p.middle_name ? ' ' + p.middle_name : ''}${p.extension ? ' ' + p.extension : ''}`;
          await client.query(
            `INSERT INTO reg_users (role, username, password_hash, name, first_name, middle_name, last_name, gender, birthdate, email, college, student_no, must_change_password)
             VALUES ('student',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
             ON CONFLICT (username) DO UPDATE SET
               password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, first_name = EXCLUDED.first_name,
               middle_name = EXCLUDED.middle_name, last_name = EXCLUDED.last_name, college = EXCLUDED.college,
               student_no = EXCLUDED.student_no, email = COALESCE(EXCLUDED.email, reg_users.email),
               must_change_password = TRUE, archived_at = NULL`,
            [p.student_no.toLowerCase(), hashPassword(temp), fullName, p.first_name, p.middle_name, p.last_name, p.gender, p.birthday, p.email, college, p.student_no]);

          // Build enrollment subjects (if subjects column provided, use those; otherwise use curriculum subjects for this year_level & activeSem)
          let subjList = p.subjects;
          if (!subjList.length) {
            const curSubj = await client.query(
              'SELECT course_code FROM reg_courses WHERE college = $1 AND year_level = $2 AND (semester = $3 OR semester IS NULL) ORDER BY course_code',
              [college, p.year_level, activeSem]);
            subjList = curSubj.rows.map((x) => x.course_code);
          }
          const enrollSubjects = subjList.map((code) => {
            const matchAsg = asgRes.rows.find((a) => a.course_code === code && (a.years || []).includes(p.year_level) && (a.sections || []).includes(p.section))
              || asgRes.rows.find((a) => a.course_code === code);
            return {
              course_code: code,
              descriptive_title: titleByCode.get(code) || '',
              instructor_id: matchAsg ? matchAsg.user_id : null,
              instructor_name: matchAsg ? matchAsg.instructor_name : ''
            };
          });

          await client.query(
            `INSERT INTO reg_enrollments (student_no, term, academic_year, college, year_level, section, subjects)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (student_no, term, academic_year) DO UPDATE SET
               college = EXCLUDED.college, year_level = EXCLUDED.year_level, section = EXCLUDED.section,
               subjects = EXCLUDED.subjects, enrolled_at = now()`,
            [p.student_no, activeSem, activeAy, college, p.year_level, p.section, JSON.stringify(enrollSubjects)]);

          created.push({
            student_no: p.student_no,
            username: p.student_no.toLowerCase(),
            name: fullName,
            college,
            program: p.program,
            email: p.email || '',
            temp_password: temp
          });
          if (p.email) welcomeItems.push({ to: p.email, student_no: p.student_no, name: fullName, temp });
          totalSaved += 1;
          batchJobTick(jobId);
        }
        fileResults.push({ filename: fp.filename, created });
      }

      await client.query('COMMIT');
      batchJobEnd(jobId);
      sendPortalWelcomeEmails(req, welcomeItems);
      logAction(req, req.reg.role === 'registrar' ? college + ' registrar' : 'University Registrar', 'batch upload students', `${college}: ${totalSaved} student(s) in ${filePlans.length} file(s)`);
      return res.json({ ok: true, totalSaved, fileResults });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('batch-upload student:', err);
      return res.status(500).json({ error: 'Database error during commit. No data was uploaded.', detail: String(err.message || '').slice(0, 300) });
    } finally {
      client.release();
    }
  }

  if (type === 'faculty') {
    const seenFac = new Set();
    const filePlans = [];
    for (const pf of parsedFiles) {
      const planRows = [];
      for (let i = 0; i < pf.rows.length; i++) {
        const r = pf.rows[i];
        const line = i + 2;
        const username = String(r.username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
          errors.push(`${pf.filename} (Row ${line}): username '${r.username || ''}' must be 3 to 60 letters, numbers, dots, dashes or underscores.`);
          continue;
        }
        if (seenFac.has(username)) {
          errors.push(`${pf.filename} (Row ${line}): Duplicate username '${username}' in the upload batch.`);
          continue;
        }
        seenFac.add(username);

        const firstName = String(r.first_name || '').trim().slice(0, 100);
        const middleName = String(r.middle_name || '').trim().slice(0, 100) || null;
        const lastName = String(r.last_name || '').trim().slice(0, 100);
        if (!firstName || !lastName) {
          errors.push(`${pf.filename} (Row ${line}): first_name and last_name are required.`);
          continue;
        }
        const gRaw = String(r.gender || '').trim().toLowerCase();
        const gender = gRaw === 'male' || gRaw === 'm' ? 'Male' : (gRaw === 'female' || gRaw === 'f' ? 'Female' : null);
        const birthdate = normalizeCsvDate(r.birthdate || r.birthday);
        if ((r.birthdate || r.birthday) && !birthdate) {
          errors.push(`${pf.filename} (Row ${line}): birthdate '${r.birthdate || r.birthday}' must be YYYY-MM-DD.`);
          continue;
        }
        const email = String(r.email || '').trim().toLowerCase().slice(0, 254) || null;
        if (!email) {
          errors.push(`${pf.filename} (Row ${line}): email is required.`);
          continue;
        }
        if (email && !STRICT_EMAIL_RE.test(email)) {
          errors.push(`${pf.filename} (Row ${line}): email '${r.email}' is not a valid email format.`);
          continue;
        }
        const subjCodes = parseSubjectsCell(r.subjects);

        planRows.push({
          username,
          first_name: firstName,
          middle_name: middleName,
          last_name: lastName,
          gender,
          birthdate,
          email,
          subjects: subjCodes
        });
      }
      filePlans.push({ filename: pf.filename, rows: planRows });
    }
    if (errors.length) return res.status(400).json({ error: 'Validation failed. Fix the listed rows and retry.', errors });
    if (dryRun) return res.json({ ok: true, validatedFiles: filePlans.length });

    const jobId = String(b.jobId || '').slice(0, 64);
    batchJobStart(jobId, filePlans.reduce((n, fp) => n + fp.rows.length, 0));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fileResults = [];
      let totalSaved = 0;

      for (const fp of filePlans) {
        const created = [];
        for (const p of fp.rows) {
          const temp = generateTempPassword();
          const fullName = facultyName(p.last_name, p.first_name, p.middle_name);
          const uRes = await client.query(
            `INSERT INTO reg_users (role, username, password_hash, name, first_name, middle_name, last_name, gender, birthdate, email, college, must_change_password)
             VALUES ('faculty',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
             ON CONFLICT (username) DO UPDATE SET
               role = 'faculty', password_hash = EXCLUDED.password_hash, name = EXCLUDED.name,
               first_name = EXCLUDED.first_name, middle_name = EXCLUDED.middle_name, last_name = EXCLUDED.last_name,
               gender = COALESCE(EXCLUDED.gender, reg_users.gender), birthdate = COALESCE(EXCLUDED.birthdate, reg_users.birthdate),
               email = COALESCE(EXCLUDED.email, reg_users.email), college = EXCLUDED.college,
               must_change_password = TRUE, archived_at = NULL
             RETURNING id`,
            [p.username, hashPassword(temp), fullName, p.first_name, p.middle_name, p.last_name, p.gender, p.birthdate, p.email, college]);
          const userId = uRes.rows[0].id;

          for (const code of p.subjects) {
            // Do not create subject rows here: the title, units and term come from the curriculum upload (Subjects and Units).
            const ex = await client.query(
              'SELECT id FROM reg_subject_assignments WHERE user_id = $1 AND college = $2 AND course_code = $3 AND term = $4 AND academic_year = $5',
              [userId, college, code, activeSem, activeAy]);
            if (!ex.rows.length) {
              await client.query(
                `INSERT INTO reg_subject_assignments (user_id, college, course_code, term, academic_year, years, sections, subject_college, program)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [userId, college, code, activeSem, activeAy, [1, 2, 3, 4], ['A', 'B', 'C'], college, (REG_PROGRAM_COLLEGES[college] && REG_PROGRAM_COLLEGES[college][0]) || '']);
            }
            await client.query(
              `INSERT INTO reg_assignments (user_id, college, course_code, term, academic_year)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, course_code, term, academic_year) DO NOTHING`,
              [userId, college, code, activeSem, activeAy]);
          }

          created.push({
            username: p.username,
            name: fullName,
            college,
            email: p.email || '',
            temp_password: temp
          });
          totalSaved += 1;
          batchJobTick(jobId);
        }
        fileResults.push({ filename: fp.filename, created });
      }

      await client.query('COMMIT');
      batchJobEnd(jobId);
      logAction(req, req.reg.role === 'registrar' ? college + ' registrar' : 'University Registrar', 'batch upload faculty', `${college}: ${totalSaved} faculty in ${filePlans.length} file(s)`);
      return res.json({ ok: true, totalSaved, fileResults });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('batch-upload faculty:', err);
      return res.status(500).json({ error: 'Database error during commit. No data was uploaded.' });
    } finally {
      client.release();
    }
  }

  if (type === 'grades') {
    // Load existing students and existing grades for uniqueness validation
    const stuRes = await pool.query('SELECT student_no, college, year_level, section FROM reg_students');
    const stuMap = new Map(stuRes.rows.map((s) => [s.student_no.toLowerCase(), s]));
    const existingGradesRes = await pool.query('SELECT student_no, course_code, term, academic_year FROM reg_grades');
    const existingGradeKeys = new Set(existingGradesRes.rows.map((g) => `${g.student_no.toLowerCase()}|${g.course_code.toUpperCase()}|${g.term}|${g.academic_year}`));
    const batchGradeKeys = new Set();

    const filePlans = [];
    for (const pf of parsedFiles) {
      const planRows = [];
      for (let i = 0; i < pf.rows.length; i++) {
        const r = pf.rows[i];
        const line = i + 2;
        const rawNo = r.student_number || r.student_no || '';
        const studentNo = normalizeCsvStudentNo(rawNo);
        if (!studentNo) {
          errors.push(`${pf.filename} (Row ${line}): student_number is required.`);
          continue;
        }
        const stu = stuMap.get(studentNo.toLowerCase());
        if (!stu) {
          errors.push(`${pf.filename} (Row ${line}): Student '${studentNo}' is not found in the enrolled student records.`);
          continue;
        }
        const courseCode = String(r.course_code || '').trim().toUpperCase().slice(0, 50);
        if (!courseCode) {
          errors.push(`${pf.filename} (Row ${line}): course_code is required.`);
          continue;
        }
        const yearLevel = normalizeCsvYearLevel(r.year_level || stu.year_level);
        if (!yearLevel) {
          errors.push(`${pf.filename} (Row ${line}): year_level '${r.year_level}' must be 1 to 4.`);
          continue;
        }
        const sem = normalizeCsvSemester(r.semester, activeSem);
        if (!sem) {
          errors.push(`${pf.filename} (Row ${line}): semester '${r.semester}' must be 1st Semester, 2nd Semester, or Summer.`);
          continue;
        }
                const rowAy = String(r.academic_year || '').trim() || chosenAy;
        if (!rowAy) {
          errors.push(`${pf.filename} (Row ${line}): choose an academic year on the upload form, or add an academic_year column (for example 2025-2026).`);
          continue;
        }
        if (!/^\d{4}-\d{4}$/.test(rowAy)) {
          errors.push(`${pf.filename} (Row ${line}): academic_year '${rowAy}' must look like 2025-2026.`);
          continue;
        }
        let grade = '';
        try {
          grade = normalizeGrade(r.final_grade);
        } catch (e) {
          errors.push(`${pf.filename} (Row ${line}): Invalid final_grade '${r.final_grade}'.`);
          continue;
        }
        if (!grade) {
          errors.push(`${pf.filename} (Row ${line}): final_grade is required.`);
          continue;
        }
        const uniqKey = `${stu.student_no.toLowerCase()}|${courseCode}|${sem}|${rowAy}`;
        if (batchGradeKeys.has(uniqKey)) {
          errors.push(`${pf.filename} (Row ${line}): Student ${stu.student_no} has duplicate subject '${courseCode}' in the same Academic Year (${rowAy}) and Semester (${sem}) within the upload batch.`);
          continue;
        }
        if (existingGradeKeys.has(uniqKey)) {
          errors.push(`${pf.filename} (Row ${line}): Student ${stu.student_no} already has a recorded grade for subject '${courseCode}' in ${rowAy} (${sem}). A student cannot have two of the same subject in the same academic year and semester.`);
          continue;
        }
        batchGradeKeys.add(uniqKey);

        planRows.push({
          student_no: stu.student_no,
          student_college: stu.college || college,
          section: stu.section || 'A',
          course_code: courseCode,
          year_level: yearLevel,
          term: sem,
          academic_year: rowAy,
          final_grade: grade,
          remarks: registrarRemark(grade)
        });
      }
      filePlans.push({ filename: pf.filename, rows: planRows });
    }
    if (errors.length) return res.status(400).json({ error: 'Validation failed. Fix the listed rows and retry.', errors });
    if (dryRun) return res.json({ ok: true, validatedFiles: filePlans.length });

    const jobId = String(b.jobId || '').slice(0, 64);
    batchJobStart(jobId, filePlans.reduce((n, fp) => n + fp.rows.length, 0));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let totalSaved = 0;

      for (const fp of filePlans) {
        for (const p of fp.rows) {
          await client.query(
            `INSERT INTO reg_grades (student_no, college, course_code, final_grade, instructor, term, academic_year, remarks, status)
             VALUES ($1,$2,$3,$4,'',$5,$6,$7,'submitted')`,
            [p.student_no, p.student_college, p.course_code, p.final_grade, p.term, p.academic_year, p.remarks]);

          // Also ensure the subject is aligned in reg_enrollments for this student, term, and academic_year
          const enRes = await client.query(
            'SELECT subjects FROM reg_enrollments WHERE student_no = $1 AND term = $2 AND academic_year = $3 FOR UPDATE',
            [p.student_no, p.term, p.academic_year]);
          const subjObj = { course_code: p.course_code, descriptive_title: titleByCode.get(p.course_code) || '', instructor_id: null, instructor_name: '' };
          if (!enRes.rows.length) {
            await client.query(
              `INSERT INTO reg_enrollments (student_no, term, academic_year, college, year_level, section, subjects)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [p.student_no, p.term, p.academic_year, p.student_college, p.year_level, p.section, JSON.stringify([subjObj])]);
          } else {
            const curSubjs = Array.isArray(enRes.rows[0].subjects) ? enRes.rows[0].subjects : [];
            if (!curSubjs.some((s) => String(s.course_code || '').toUpperCase() === p.course_code)) {
              curSubjs.push(subjObj);
              await client.query(
                'UPDATE reg_enrollments SET subjects = $4 WHERE student_no = $1 AND term = $2 AND academic_year = $3',
                [p.student_no, p.term, p.academic_year, JSON.stringify(curSubjs)]);
            }
          }
          totalSaved += 1;
          batchJobTick(jobId);
        }
      }

      await client.query('COMMIT');
      batchJobEnd(jobId);
      logAction(req, req.reg.role === 'registrar' ? college + ' registrar' : 'University Registrar', 'batch upload grades', `${college}: ${totalSaved} grade(s) in ${filePlans.length} file(s)`);
      return res.json({ ok: true, totalSaved });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A student in the batch already has a grade for that subject in the same academic year and semester. Nothing was uploaded.' });
      }
      console.error('batch-upload grades:', err);
      return res.status(500).json({ error: 'Database error during commit. No data was uploaded.' });
    } finally {
      client.release();
    }
  }
});

app.get('/api/cat/me', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const hasId = await pool.query('SELECT applicant_id FROM accounts WHERE id = $1', [id]);
    if (hasId.rows.length && !hasId.rows[0].applicant_id) {
      const att = await pool.query("SELECT 1 FROM cat_sections WHERE account_id = $1 AND section = 'attachments'", [id]);
      if (att.rowCount > 0) await assignApplicantId(id).catch((err) => console.error('Applicant ID backfill failed:', err.message));
    }
    const { rows } = await pool.query(
      'SELECT category, first_name, middle_name, last_name, name_extension, email, date_of_birth, created_at, applicant_id, dob_changed FROM accounts WHERE id = $1', [id]);
    if (!rows.length) return res.status(401).json({ error: 'Not logged in.' });
    setSessionCookie(req, res, id);
    const r = rows[0];
    res.json({ firstName: r.first_name, middleName: r.middle_name, lastName: r.last_name, nameExtension: r.name_extension, email: r.email, dateOfBirth: r.date_of_birth, createdAt: r.created_at, applicantId: r.applicant_id, category: categoryLabel(r.category), dobLocked: r.dob_changed, ...(await examFields(id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your account.' });
  }
});

// ---- Application sections: each is saved once, then locked ----
const CAT_SECTIONS = ['degree', 'personal', 'photo', 'family', 'education', 'academic', 'attachments'];
// The application form: locked for good once the final Submit goes through.
const FORM_SECTIONS = ['degree', 'personal', 'photo', 'family', 'education'];
async function isSubmitted(accountId) {
  const { rowCount } = await pool.query('SELECT 1 FROM cat_submissions WHERE account_id = $1', [accountId]);
  return rowCount > 0;
}
// Records the first download of the application form and test permit (step 5).
// Returns first: true only the first time, so the congratulations popup shows once.
app.post('/api/cat/download', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO cat_sections (account_id, section, data, submitted_at) VALUES ($1, 'download', '{}', now())
       ON CONFLICT (account_id, section) DO NOTHING RETURNING section`, [id]);
    res.json({ first: rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record the download.' });
  }
});

app.get('/api/cat/sections', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { rows } = await pool.query(
      'SELECT section, data, submitted_at, unlocked FROM cat_sections WHERE account_id = $1', [id]);
    const out = { submitted: await isSubmitted(id) };
    rows.forEach((r) => { out[r.section] = { data: r.data, submittedAt: r.submitted_at, unlocked: r.unlocked }; });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your application.' });
  }
});

// A contact number may belong to only one applicant. Compared in 09XXXXXXXXX form.
function normalizeContact(v) { return String(v || '').replace(/\s+/g, '').replace(/^\+63/, '0'); }
const CONTACT_SQL = "(CASE WHEN data->>'contact' LIKE '+63%' THEN '0' || substr(data->>'contact', 4) ELSE data->>'contact' END)";
async function contactTaken(number, accountId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM cat_sections WHERE section = 'personal' AND account_id <> $2 AND ${CONTACT_SQL} = $1 LIMIT 1`,
    [number, accountId]);
  return rows.length > 0;
}
// Signup check while typing: is this first + last name or this email already registered?
app.get('/api/cat/account-check', async (req, res) => {
  const firstName = String(req.query.firstName || '').trim().slice(0, 100);
  const lastName = String(req.query.lastName || '').trim().slice(0, 100);
  const email = String(req.query.email || '').trim().toLowerCase().slice(0, 200);
  if (!((firstName && lastName) || email)) return res.json({ taken: false });
  try {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM accounts WHERE ($1 <> \'\' AND email = $1) OR ($2 <> \'\' AND $3 <> \'\' AND lower(first_name) = lower($2) AND lower(last_name) = lower($3)) LIMIT 1',
      [email, firstName, lastName]);
    res.json({ taken: rowCount > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check the account.' });
  }
});

app.get('/api/cat/contact-check', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const number = normalizeContact(req.query.number);
  if (!/^09\d{9}$/.test(number)) return res.json({ taken: false });
  try {
    res.json({ taken: await contactTaken(number, id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check the number.' });
  }
});

// Checks the base64 payload really is a PNG, JPEG or WEBP file (by its first bytes), not just a label.
function isImageDataUrl(v) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(v || ''));
  if (!m) return false;
  const head = Buffer.from(m[2].slice(0, 16), 'base64');
  if (m[1] === 'png') return head.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (m[1] === 'jpeg') return head.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  return head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP';
}

// Applicant ID: YYYY-1XXXX, where XXXX is the applicant's number among successful applications.
async function assignApplicantId(accountId) {
  const cur = await pool.query('SELECT applicant_id FROM accounts WHERE id = $1', [accountId]);
  if (!cur.rows.length || cur.rows[0].applicant_id) return;
  // Creates the counter row if it is missing, then increases it.
  const { rows } = await pool.query("INSERT INTO cat_stats (key, value) VALUES ('total_successful_applications', 1) ON CONFLICT (key) DO UPDATE SET value = cat_stats.value + 1 RETURNING value");
  const aid = `${new Date().getFullYear()}-1${String(rows[0].value).padStart(4, '0')}`;
  await pool.query('UPDATE accounts SET applicant_id = $1 WHERE id = $2 AND applicant_id IS NULL', [aid, accountId]);
}

// Copies the applicant's uploaded PDFs and photo to Google Drive through the Apps Script web app.
// Needs APPS_SCRIPT_URL and APPS_SCRIPT_SECRET in the environment; see docs/apps-script/drive-sync.gs.
async function syncDrive(accountId) {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;
  if (!url || !secret) { console.warn('Drive sync skipped: APPS_SCRIPT_URL or APPS_SCRIPT_SECRET is not set.'); return; }
  const acc = await pool.query('SELECT applicant_id, first_name, last_name FROM accounts WHERE id = $1', [accountId]);
  const att = await pool.query("SELECT data FROM cat_sections WHERE account_id = $1 AND section = 'attachments'", [accountId]);
  const pho = await pool.query("SELECT data FROM cat_sections WHERE account_id = $1 AND section = 'photo'", [accountId]);
  if (!acc.rows.length || !att.rows.length) return;
  const a = acc.rows[0];
  const d = att.rows[0].data || {};
  const safe = (v) => String(v || 'file').replace(/[\\/:*?"<>|]/g, '').slice(0, 150);
  const parse = (u) => { const m = /^data:([^;]+);base64,(.*)$/.exec(String(u || '')); return m ? { mime: m[1], data: m[2] } : null; };
  const files = [];
  [['psa', 'PSA-NSO Birth Certificate', d.psaName], ['voter', 'Voter Certificate', d.voterName], ['f137', 'Form 137-A', d.f137Name], ['f138', 'Form 138', d.f138Name]].forEach(([k, label, name]) => {
    const f = parse(d[k]);
    if (f) files.push({ name: `${label} - ${safe(name)}`, mime: f.mime, data: f.data });
  });
  const photo = pho.rows.length ? parse((pho.rows[0].data || {}).photo) : null;
  if (photo) files.push({ name: 'Photo.' + (photo.mime.split('/')[1] || 'png'), mime: photo.mime, data: photo.data });
  const folderName = safe(`${a.applicant_id || 'pending'} - ${a.last_name}, ${a.first_name}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, folderName, files })
  });
  if (!res.ok) throw new Error('Drive sync HTTP ' + res.status);
}

app.post('/api/cat/sections/:section', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const section = req.params.section;
  if (!CAT_SECTIONS.includes(section)) return res.status(404).json({ error: 'Unknown section.' });
  const input = req.body && typeof req.body === 'object' ? req.body : {};
  const data = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') {
      const max = section === 'photo' ? 2800000 : section === 'attachments' ? 2800000 : 300;
      if (v.length > max) {
        return res.status(400).json({ error: section === 'photo' ? 'The photo is too large. Please use an image under 2MB.' : section === 'attachments' ? 'A file is too large. Each PDF must be under 2MB.' : 'One of your entries is too long. Please shorten it.' });
      }
      data[k] = v;
    }
    else if (typeof v === 'boolean') data[k] = v;
  }
  if (section === 'degree') {
    const picks = [data.p1, data.p2, data.p3].filter(Boolean);
    if (new Set(picks).size !== picks.length) {
      return res.status(400).json({ error: 'Each degree program can be chosen only once. Please pick different programs for your first, second and third choice.' });
    }
  }
  if (section === 'personal' && !/^(09\d{9}|\+639\d{9})$/.test(data.contact || '')) {
    return res.status(400).json({ error: 'Enter a valid contact number: 09XXXXXXXXX or +639XXXXXXXXX.' });
  }
  if (section === 'attachments') {
    const files = ['psa', 'voter', 'f137', 'f138'];
    const pdfOk = (v) => /^data:application\/pdf;base64,[A-Za-z0-9+/]+={0,2}$/.test(String(v || '')) &&
      Buffer.from(String(v).split(',')[1].slice(0, 8), 'base64').toString('latin1').startsWith('%PDF');
    if (!files.every((k) => pdfOk(data[k]))) {
      return res.status(400).json({ error: 'Please upload all four documents as PDF files.' });
    }
    const names = files.map((k) => data[k + 'Name']);
    if (new Set(names).size !== names.length) {
      return res.status(400).json({ error: 'Please refrain from uploading the same file.' });
    }
    if (!String(data.principal || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.principalEmail || ''))) {
      return res.status(400).json({ error: 'Please enter the principal name and a valid school email.' });
    }
  }
  if (section === 'photo' && !isImageDataUrl(data.photo)) {
    return res.status(400).json({ error: 'Please upload a valid image.' });
  }
  try {
    if (section === 'personal') {
      data.contact = normalizeContact(data.contact);
      if (await contactTaken(data.contact, id)) {
        return res.status(422).json({ error: 'Contact Number already used.' });
      }
    }
    if (FORM_SECTIONS.includes(section) && await isSubmitted(id)) {
      return res.status(409).json({ error: 'Your application has been submitted and can no longer be changed.' });
    }
    // Saved sections are locked; an unlocked section (after Review Information) can be saved once more.
    const { rows } = await pool.query(
      `INSERT INTO cat_sections (account_id, section, data, submitted_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, section) DO UPDATE SET data = EXCLUDED.data, submitted_at = now(), unlocked = false
         WHERE cat_sections.unlocked
            OR (cat_sections.section = 'attachments' AND NOT (cat_sections.data ?& array['psaName', 'voterName', 'f137Name', 'f138Name']))
       RETURNING section`,
      [id, section, JSON.stringify(data)]);
    if (!rows.length) return res.status(409).json({ error: 'This section is already submitted and cannot be changed.' });
    if (section === 'attachments') {
      await assignApplicantId(id).catch((err) => console.error('Applicant ID failed:', err.message));
      await assignSlotFor(id).catch((err) => console.error('Exam slot assignment failed:', err.message));
      syncDrive(id).catch((err) => console.error('Drive sync failed:', err.message));
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save this section.' });
  }
});

// Review Information: unlocks every saved section so the applicant can edit each one once.
// Update Records: unlocks only the Academic Records section for one more save.
app.post('/api/cat/sections/academic/unlock', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { rows } = await pool.query(
      "UPDATE cat_sections SET unlocked = true WHERE account_id = $1 AND section = 'academic' RETURNING section", [id]);
    if (!rows.length) return res.status(404).json({ error: 'Academic Records have not been submitted yet.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not open your records for editing.' });
  }
});

app.post('/api/cat/review', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  try {
    if (await isSubmitted(id)) return res.status(409).json({ error: 'Your application has already been submitted.' });
    await pool.query('UPDATE cat_sections SET unlocked = true WHERE account_id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not open your sections for review.' });
  }
});

// Final Submit of the application form: every form section must be saved, then the form is locked for good.
app.post('/api/cat/submit', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('submit-lock'))");
    const reg = await getRegistrationState(client);
    if (!reg.open) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: REG_CLOSED_MSG });
    }
    if (reg.quotaReached) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: QUOTA_MSG });
    }
    const done = await client.query('SELECT 1 FROM cat_submissions WHERE account_id = $1', [id]);
    if (done.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Your application has already been submitted.' });
    }
    const { rows } = await client.query(
      'SELECT section FROM cat_sections WHERE account_id = $1 AND section = ANY($2)', [id, FORM_SECTIONS]);
    const have = rows.map((r) => r.section);
    const missing = FORM_SECTIONS.filter((sec) => !have.includes(sec));
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Please complete and save every section before you submit.', missing });
    }
    // The slot is normally given at step 4 (attachments); this only fills it in if it is still missing.
    const hasSlot = await client.query('SELECT 1 FROM cat_exam_slots WHERE account_id = $1', [id]);
    if (hasSlot.rowCount === 0) {
      const slot = await assignExamSlot(client);
      if (!slot) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'No examination slots are available right now. Please contact the CUP Registrar\'s Office.' });
      }
      await client.query(
        'INSERT INTO cat_exam_slots (account_id, exam_date, exam_time, exam_building, exam_room, exam_seat) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, slot.date, slot.time, slot.building, slot.room, slot.seat]);
    }
    await client.query('UPDATE cat_sections SET unlocked = false WHERE account_id = $1 AND section = ANY($2)', [id, FORM_SECTIONS]);
    await client.query('INSERT INTO cat_submissions (account_id) VALUES ($1)', [id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Could not submit your application. Please try again.' });
  } finally {
    client.release();
  }
});

// Emails the applicant a congratulations message with a Click to Login button. Sent once per applicant.
app.post('/api/cat/submission-email', async (req, res) => {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  let claimed = false;
  try {
    const claim = await pool.query(
      'UPDATE cat_submissions SET emailed_at = now() WHERE account_id = $1 AND emailed_at IS NULL RETURNING account_id', [id]);
    if (claim.rowCount === 0) return res.json({ ok: true, already: true });
    claimed = true;
    const { rows } = await pool.query(
      'SELECT email, first_name, middle_name, last_name, applicant_id FROM accounts WHERE id = $1', [id]);
    const acc = rows[0];
    const mi = String(acc.middle_name || '').trim().charAt(0);
    const fullName = acc.last_name + ', ' + acc.first_name + (mi ? ' ' + mi.toUpperCase() + '.' : '');
    const loginUrl = portalBase(req) + '/CUP-CAT/login';
    const subject = 'Congratulations! Your CUP College Admission Test application is complete';
    const text = 'Dear ' + acc.first_name + ',\n\n' +
      'Congratulations! You have successfully completed your application for the CUP College Admission Test.\n\n' +
      'Applicant ID: ' + (acc.applicant_id || '') + '\n' +
      'Applicant name: ' + fullName + '\n' +
      'Username: ' + acc.email + '\n\n' +
      'Log in to download your application form and test permit:\n' + loginUrl + '\n\n' +
      'City University of Pasay\nOffice of Student Affairs, Admissions, and Scholarships';
    const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5">' +
      '<p>Dear ' + escHtml(acc.first_name) + ',</p>' +
      '<p>Congratulations! You have successfully completed your application for the CUP College Admission Test.</p>' +
      '<p style="margin:0 0 4px"><strong>Applicant ID:</strong> ' + escHtml(acc.applicant_id || '') + '</p>' +
      '<p style="margin:0 0 4px"><strong>Applicant name:</strong> ' + escHtml(fullName) + '</p>' +
      '<p style="margin:0 0 16px"><strong>Username:</strong> ' + escHtml(acc.email) + '</p>' +
      '<p><a href="' + escHtml(loginUrl) + '" style="display:inline-block;background:#1f5d1f;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:6px">Click to Login</a></p>' +
      '<p>Log in to download your application form and test permit.</p>' +
      '<p>City University of Pasay<br>Office of Student Affairs, Admissions, and Scholarships</p></div>';
    await sendEmail(acc.email, subject, text, { sender: 'CUP College Admission Test', html });
    res.json({ ok: true });
  } catch (err) {
    if (claimed) await pool.query('UPDATE cat_submissions SET emailed_at = NULL WHERE account_id = $1', [id]).catch(() => {});
    console.error('Submission email failed:', err.message);
    res.status(500).json({ error: 'Could not email the confirmation.' });
  }
});

app.post('/api/cat/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'cat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

pool.query(`CREATE TABLE IF NOT EXISTS cat_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).catch((err) => console.error('cat_settings table:', err.message));
pool.query(`CREATE TABLE IF NOT EXISTS cat_sections (
  account_id INT NOT NULL REFERENCES accounts(id),
  section TEXT NOT NULL,
  data JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unlocked BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, section))`)
  .then(() => pool.query('ALTER TABLE cat_sections ADD COLUMN IF NOT EXISTS unlocked BOOLEAN NOT NULL DEFAULT false'))
  .then(() => pool.query('CREATE TABLE IF NOT EXISTS cat_submissions (account_id INT PRIMARY KEY REFERENCES accounts(id), submitted_at TIMESTAMPTZ NOT NULL DEFAULT now())'))
  .then(() => pool.query('ALTER TABLE cat_submissions ADD COLUMN IF NOT EXISTS exam_date DATE, ADD COLUMN IF NOT EXISTS exam_time TEXT, ADD COLUMN IF NOT EXISTS exam_building TEXT, ADD COLUMN IF NOT EXISTS exam_room INT, ADD COLUMN IF NOT EXISTS exam_seat INT'))
  .then(() => pool.query('ALTER TABLE cat_submissions ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ'))
  .then(() => pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dob_changed BOOLEAN NOT NULL DEFAULT false'))
  .then(() => pool.query("CREATE TABLE IF NOT EXISTS student_profiles (account_id INT PRIMARY KEY REFERENCES accounts(id), student_number TEXT UNIQUE NOT NULL, program TEXT NOT NULL, year_level INT NOT NULL)"))
  .then(() => pool.query("CREATE TABLE IF NOT EXISTS curriculum_subjects (id SERIAL PRIMARY KEY, program TEXT NOT NULL, year_level INT NOT NULL, term_no INT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, units NUMERIC NOT NULL, UNIQUE (program, year_level, term_no, code))"))
  .then(() => pool.query("CREATE TABLE IF NOT EXISTS pre_enrollments (account_id INT NOT NULL REFERENCES accounts(id), term TEXT NOT NULL, subject_id INT NOT NULL REFERENCES curriculum_subjects(id), PRIMARY KEY (account_id, term, subject_id))"))
  .then(() => pool.query("CREATE TABLE IF NOT EXISTS pre_enroll_submissions (account_id INT NOT NULL REFERENCES accounts(id), term TEXT NOT NULL, submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (account_id, term))"))
  .then(() => pool.query('ALTER TABLE cat_submissions ALTER COLUMN exam_room TYPE TEXT USING exam_room::text'))
  .then(() => pool.query('CREATE TABLE IF NOT EXISTS cat_exam_slots (account_id INT PRIMARY KEY REFERENCES accounts(id), exam_date DATE NOT NULL, exam_time TEXT, exam_building TEXT, exam_room TEXT, exam_seat INT, assigned_at TIMESTAMPTZ NOT NULL DEFAULT now())'))
  .then(() => pool.query('INSERT INTO cat_exam_slots (account_id, exam_date, exam_time, exam_building, exam_room, exam_seat) SELECT account_id, exam_date, exam_time, exam_building, exam_room, exam_seat FROM cat_submissions WHERE exam_date IS NOT NULL ON CONFLICT (account_id) DO NOTHING'))
  .then(() => pool.query('CREATE TABLE IF NOT EXISTS password_history (id SERIAL PRIMARY KEY, account_id INT NOT NULL REFERENCES accounts(id), password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())'))
  .then(() => pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS college TEXT"))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_students (student_no TEXT PRIMARY KEY, college TEXT NOT NULL, first_name TEXT NOT NULL, middle_name TEXT, last_name TEXT NOT NULL, name_extension TEXT, gender TEXT, birthday DATE, email TEXT, contact_number TEXT, program TEXT NOT NULL, year_level INT NOT NULL DEFAULT 1, section TEXT NOT NULL DEFAULT 'A', status TEXT NOT NULL DEFAULT 'enrolled', enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now())`))
  .then(() => pool.query('ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS name_extension TEXT'))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_grades (id SERIAL PRIMARY KEY, student_no TEXT NOT NULL REFERENCES reg_students(student_no), college TEXT NOT NULL, course_code TEXT NOT NULL, final_grade TEXT NOT NULL DEFAULT '', instructor TEXT NOT NULL DEFAULT '', term TEXT NOT NULL, academic_year TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (student_no, course_code, term, academic_year))`))
  .then(() => pool.query("ALTER TABLE reg_grades ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'submitted'"))
  .then(() => pool.query('ALTER TABLE reg_grades ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ'))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_users (
    id SERIAL PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('faculty', 'student')),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    college TEXT,
    student_no TEXT REFERENCES reg_students(student_no),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS first_name TEXT'))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS middle_name TEXT'))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS last_name TEXT'))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS gender TEXT'))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS birthdate DATE'))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS email TEXT'))
  .then(() => pool.query('ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS birthday_changed BOOLEAN NOT NULL DEFAULT FALSE'))
  .then(() => pool.query('ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS photo TEXT'))
  .then(() => pool.query('ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS photo_changed_at TIMESTAMPTZ'))
  .then(() => pool.query('ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS civil_status TEXT'))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_subject_assignments (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES reg_users(id), college TEXT NOT NULL, course_code TEXT NOT NULL, term TEXT NOT NULL, academic_year TEXT NOT NULL, years INT[] NOT NULL, sections TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_enrollments (student_no TEXT NOT NULL REFERENCES reg_students(student_no), term TEXT NOT NULL, academic_year TEXT NOT NULL, college TEXT NOT NULL, year_level INT NOT NULL, section TEXT NOT NULL DEFAULT 'A', subjects JSONB NOT NULL DEFAULT '[]', enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (student_no, term, academic_year))`))
  .then(() => pool.query("ALTER TABLE reg_grades ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query("ALTER TABLE reg_subject_assignments ADD COLUMN IF NOT EXISTS subject_college TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query("ALTER TABLE reg_subject_assignments ADD COLUMN IF NOT EXISTS program TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query("ALTER TABLE reg_subject_assignments ADD COLUMN IF NOT EXISTS group_label TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query("ALTER TABLE reg_subject_assignments ADD COLUMN IF NOT EXISTS day_label TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query("ALTER TABLE reg_subject_assignments ADD COLUMN IF NOT EXISTS time_slot TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query("ALTER TABLE reg_schedules ADD COLUMN IF NOT EXISTS group_label TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query('ALTER TABLE reg_schedules DROP CONSTRAINT IF EXISTS reg_schedules_pkey'))
  .then(() => pool.query('ALTER TABLE reg_schedules ADD CONSTRAINT reg_schedules_pkey PRIMARY KEY (college, course_code, term, academic_year, year_level, section, group_label)'))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_schedules (college TEXT NOT NULL, course_code TEXT NOT NULL, term TEXT NOT NULL, academic_year TEXT NOT NULL, year_level INT NOT NULL, section TEXT NOT NULL, days TEXT NOT NULL DEFAULT '', start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '', PRIMARY KEY (college, course_code, term, academic_year, year_level, section))`))
  .then(() => pool.query('CREATE TABLE IF NOT EXISTS reg_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_courses (college TEXT NOT NULL, course_code TEXT NOT NULL, descriptive_title TEXT NOT NULL DEFAULT '', units NUMERIC(4,1) NOT NULL DEFAULT 0, PRIMARY KEY (college, course_code))`))
  .then(() => pool.query('ALTER TABLE reg_courses ADD COLUMN IF NOT EXISTS year_level INT'))
  .then(() => pool.query('ALTER TABLE reg_courses ADD COLUMN IF NOT EXISTS semester TEXT'))
  .then(() => pool.query("ALTER TABLE reg_grades ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_logs (id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ip TEXT)`))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE'))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ'))
  .then(() => pool.query('ALTER TABLE reg_users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ'))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS major TEXT NOT NULL DEFAULT ''"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS csc_paid_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS advising_slip_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS coe_printed_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS id_validated_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS step2_evaluated_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS step2_advised_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS step2_sectioned_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS nstp_subject TEXT"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS nstp_instructor_id INTEGER"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS nstp_enrolled_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS step1_status TEXT"))
  .then(() => pool.query("ALTER TABLE reg_students ADD COLUMN IF NOT EXISTS step1_verified_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ"))
  .then(() => pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS username TEXT UNIQUE'))
  .then(() => pool.query("ALTER TABLE accounts ALTER COLUMN date_of_birth DROP NOT NULL"))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS csc_accounts (
      id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      last_name TEXT NOT NULL, first_name TEXT NOT NULL, middle_name TEXT NOT NULL DEFAULT '',
      extension TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, position TEXT NOT NULL,
      archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`))
  .then(() => pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false'))
  .then(() => pool.query('ALTER TABLE csc_accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false'))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS reg_assignments (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES reg_users(id) ON DELETE CASCADE,
    college TEXT NOT NULL,
    course_code TEXT NOT NULL,
    term TEXT NOT NULL,
    academic_year TEXT NOT NULL,
    UNIQUE (user_id, course_code, term, academic_year))`))
  .then(() => (process.env.RUN_STARTUP_TASKS !== 'false' ? seedTestAccounts() : null))
  .catch((err) => console.error('test accounts:', err.message))
  .catch((err) => console.error('cat_sections table:', err.message));


// ---- Admin: live applicant list and downloads (Excel + ZIP) ----
const ExcelJS = require('exceljs');
const archiver = require('archiver');

async function requireAdmin(req, res, next) {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { rows } = await pool.query('SELECT role FROM accounts WHERE id = $1', [id]);
    if (!rows.length) return res.status(401).json({ error: 'Not logged in.' });
    if (rows[0].role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check access.' });
  }
}

// ---- CUP CAT year: one global setting used across the CUP CAT pages ----
const DEFAULT_CAT_YEAR = 2027;
// Stored category codes -> the wording shown on the form, test permit and admin list.
const CATEGORY_LABELS = {
  grade12: 'Graduating SHS',
  'shs-grad': 'Graduated SHS',
  'hs-grad': 'Graduate of High School (SY 2015-2016 or earlier)'
};
function categoryLabel(code) { return CATEGORY_LABELS[code] || code || ''; }
function catLabels(y) {
  return { catYear: y, catLabel: 'CUP CAT ' + y + '-' + (y + 1), academicYear: y + '-' + (y + 1) };
}
async function getCatYear() {
  const { rows } = await pool.query("SELECT value FROM cat_settings WHERE key = 'cat_year'");
  const y = rows.length ? Number(rows[0].value) : DEFAULT_CAT_YEAR;
  return Number.isInteger(y) ? y : DEFAULT_CAT_YEAR;
}
// ---- Registration and application control (open/close, applicant quota) ----
const REG_CLOSED_MSG = 'Registration is currently closed. Please standby for further announcements at the CUP Website and CUP Official FB Page.';
const QUOTA_MSG = 'Applications have closed because the applicant quota has been reached.';

async function getRegistrationState(client = pool) {
  const { rows } = await client.query("SELECT key, value FROM cat_settings WHERE key IN ('cat_open', 'applicant_quota')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const open = m.cat_open !== 'false';
  let quota = m.applicant_quota ? Number(m.applicant_quota) : null;
  if (!quota) {
    const cfg = await getExamSettings(client);
    quota = cfg.rooms.reduce((sum, r) => sum + (Number(r.seats) || 0), 0) || 600;
  }
  const sub = await client.query('SELECT COUNT(*)::int AS n FROM cat_submissions');
  const reg = await client.query("SELECT COUNT(*)::int AS n FROM accounts WHERE role = 'applicant'");
  const submitted = sub.rows[0].n;
  const quotaReached = submitted >= quota;
  return { open, quota, submitted, registrants: reg.rows[0].n, quotaReached };
}

app.get('/api/admin/registration', requireAdmin, async (req, res) => {
  try {
    res.json(await getRegistrationState());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the registration settings.' });
  }
});

app.post('/api/admin/registration', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    if (typeof b.open === 'boolean') {
      await pool.query("INSERT INTO cat_settings (key, value) VALUES ('cat_open', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [b.open ? 'true' : 'false']);
    }
    if (b.quota !== undefined) {
      const q = Number(b.quota);
      if (!Number.isInteger(q) || q < 1 || q > 100000) return res.status(400).json({ error: 'The quota must be a whole number from 1 to 100000.' });
      await pool.query("INSERT INTO cat_settings (key, value) VALUES ('applicant_quota', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(q)]);
    }
    res.json(await getRegistrationState());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the registration settings.' });
  }
});

app.get('/api/cat/settings', async (req, res) => {
  try {
    const reg = await getRegistrationState();
    res.json({ ...catLabels(await getCatYear()), registrationOpen: reg.open, quotaReached: reg.quotaReached });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});
// ---- Examination schedule (assigned automatically on final submit) ----
const EXAM_TIMES_DEFAULT = ['08:30', '13:30'];
const EXAM_DEFAULTS = { start: '2027-03-01', end: '2027-03-31', days: 'weekends' };

// Until the admin lists rooms, show 20 rooms of 30 seats (building left blank for the admin to fill).
function defaultExamRooms() {
  return Array.from({ length: 20 }, (_, i) => ({ building: '', room: 'Room ' + (i + 1), seats: 30, session: 1 }));
}

async function getExamSettings(client = pool) {
  const { rows } = await client.query("SELECT key, value FROM cat_settings WHERE key LIKE 'exam_%'");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let rooms = defaultExamRooms();
  if (m.exam_room_list) {
    try { rooms = JSON.parse(m.exam_room_list); } catch (e) { /* keep the default list */ }
  }
  return {
    start: m.exam_start || EXAM_DEFAULTS.start,
    end: m.exam_end || EXAM_DEFAULTS.end,
    days: m.exam_days || EXAM_DEFAULTS.days,
    rooms,
    times: parseTimes(m.exam_times),
  };
}

function parseTimes(raw) {
  try {
    const t = JSON.parse(raw);
    if (Array.isArray(t) && t.length === 2 && t.every((x) => /^\d{2}:\d{2}$/.test(x))) return t;
  } catch (e) { /* use the default */ }
  return EXAM_TIMES_DEFAULT.slice();
}

function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
}

function parseExamSettings(b) {
  const start = String(b.start || ''), end = String(b.end || ''), days = String(b.days || '');
  if (!validDate(start) || !validDate(end) || start > end) {
    return { error: 'Enter a valid start and end date. The start date cannot be after the end date.' };
  }
  if (!['all', 'weekdays', 'weekends'].includes(days)) return { error: 'Choose weekdays only, weekends only, or all days.' };
  if (!Array.isArray(b.rooms) || b.rooms.length === 0) return { error: 'Add at least one room.' };
  if (b.rooms.length > 300) return { error: 'Up to 300 rooms can be listed.' };
  const seen = new Set();
  const rooms = [];
  for (const raw of b.rooms) {
    const r = raw || {};
    const building = String(r.building || '').trim().slice(0, 100);
    const room = String(r.room || '').trim().slice(0, 50);
    const seats = Number(r.seats);
    if (!building) return { error: 'Every room needs a building name.' };
    if (!room) return { error: 'Every room needs a room name or number.' };
    if (!Number.isInteger(seats) || seats < 1 || seats > 500) return { error: 'Seats per room must be a whole number from 1 to 500.' };
    const session = Number(r.session);
    if (session !== 1 && session !== 2) return { error: 'Choose 8:30 AM or 1:30 PM for every room.' };
    const key = building.toLowerCase() + '|' + room.toLowerCase();
    if (seen.has(key)) return { error: 'Room "' + room + '" in ' + building + ' is listed more than once.' };
    seen.add(key);
    rooms.push({ building, room, seats, session });
  }
  const times = Array.isArray(b.times) ? b.times : [];
  if (times.length !== 2 || !times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t)))) {
    return { error: 'Enter both session times, for example 08:30 and 13:30.' };
  }
  return { value: { start, end, days, rooms, times: times.map(String) } };
}

// Dates in range (UTC, so no timezone shift) that match the chosen days.
function examDates(start, end, days) {
  const out = [];
  for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    const weekend = wd === 0 || wd === 6;
    if (days === 'all' || (days === 'weekends' && weekend) || (days === 'weekdays' && !weekend)) {
      out.push(d.toISOString().slice(0, 10));
    }
  }
  return out;
}

// First open date, session, room (in list order) with a free seat. Runs inside the submit transaction under a lock.
async function assignExamSlot(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('exam-slots'))");
  const cfg = await getExamSettings(client);
  const dates = examDates(cfg.start, cfg.end, cfg.days);
  if (!dates.length || !cfg.rooms.length) return null;
  const taken = await client.query(
    `SELECT to_char(exam_date, 'YYYY-MM-DD') AS d, exam_time AS t, exam_building AS b, exam_room AS r, COUNT(*)::int AS n
       FROM cat_exam_slots WHERE exam_date BETWEEN $1 AND $2 GROUP BY exam_date, exam_time, exam_building, exam_room`,
    [cfg.start, cfg.end]);
  const used = new Map(taken.rows.map((x) => [x.d + '|' + x.t + '|' + x.b + '|' + x.r, x.n]));
  for (const d of dates) {
    for (let s = 1; s <= 2; s++) {
      const t = cfg.times[s - 1];
      for (const rm of cfg.rooms.filter((x) => Number(x.session || 1) === s)) {
        const n = used.get(d + '|' + t + '|' + rm.building + '|' + rm.room) || 0;
        if (n < rm.seats) return { date: d, time: t, building: rm.building, room: rm.room, seat: n + 1 };
      }
    }
  }
  return null;
}

// Gives the applicant an exam slot right after step 4 (attachments). Keeps an existing slot if there is one.
async function assignSlotFor(accountId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('exam-slots'))");
    const has = await client.query('SELECT 1 FROM cat_exam_slots WHERE account_id = $1', [accountId]);
    if (has.rowCount === 0) {
      const slot = await assignExamSlot(client);
      if (slot) {
        await client.query(
          'INSERT INTO cat_exam_slots (account_id, exam_date, exam_time, exam_building, exam_room, exam_seat) VALUES ($1, $2, $3, $4, $5, $6)',
          [accountId, slot.date, slot.time, slot.building, slot.room, slot.seat]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Gives an exam slot to every applicant with an applicant ID who has none yet. Returns how many were filled.
async function backfillExamSlots() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT a.id AS account_id FROM accounts a LEFT JOIN cat_exam_slots s ON s.account_id = a.id
        WHERE a.role = 'applicant' AND a.applicant_id IS NOT NULL AND s.account_id IS NULL
        ORDER BY a.created_at, a.id`);
    let filled = 0;
    for (const r of rows) {
      const slot = await assignExamSlot(client);
      if (!slot) break;
      await client.query(
        `INSERT INTO cat_exam_slots (account_id, exam_date, exam_time, exam_building, exam_room, exam_seat) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id) DO NOTHING`,
        [r.account_id, slot.date, slot.time, slot.building, slot.room, slot.seat]);
      filled++;
    }
    await client.query('COMMIT');
    return filled;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

app.get('/api/admin/exam-settings', requireAdmin, async (req, res) => {
  try {
    res.json(await getExamSettings());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the examination settings.' });
  }
});

app.post('/api/admin/exam-settings', requireAdmin, async (req, res) => {
  const parsed = parseExamSettings(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const pairs = [['exam_start', v.start], ['exam_end', v.end], ['exam_days', v.days], ['exam_room_list', JSON.stringify(v.rooms)], ['exam_times', JSON.stringify(v.times)]];
    for (const [k, val] of pairs) {
      await pool.query('INSERT INTO cat_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, val]);
    }
    // Applicants who submitted before a schedule existed get their slot now.
    const assigned = await backfillExamSlots();
    res.json({ ...v, assigned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the examination settings.' });
  }
});

// The applicant's assigned slot; all null until step 4 (attachments) gives one.
async function examFields(accountId) {
  const { rows } = await pool.query(
    `SELECT to_char(exam_date, 'YYYY-MM-DD') AS exam_date, exam_time, exam_building, exam_room, exam_seat
       FROM cat_exam_slots WHERE account_id = $1`, [accountId]);
  const r = rows[0] || {};
  return { examDate: r.exam_date || null, examTime: r.exam_time || null, examBuilding: r.exam_building || null, examRoom: r.exam_room || null, examSeat: r.exam_seat || null };
}

// Admin account: change email in steps. Each address must be verified by a one-time code first:
// 1) code to the current email, 2) code to the new email, 3) change saved.
async function sendEmailCode(email, purpose) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pool.query(
    `INSERT INTO otp_codes (email, code_hash, expires_at, attempts)
     VALUES ($1, $2, now() + interval '10 minutes', 0)
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, verified_at = NULL`,
    [email, hashCode(email, code)]);
  await sendEmail(email, 'Your One-time-PIN (OTP)', 'Your code to ' + purpose + ' is ' + code + '. It expires in 10 minutes. If you did not request this, ignore this email.', { sender: 'CUP CAT Online Application System' });
}

async function checkEmailCode(email, otp) {
  const row = await pool.query('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email = $1', [email]);
  if (row.rowCount === 0 || new Date(row.rows[0].expires_at) < new Date()) return 'The code has expired. Please request a new one.';
  if (row.rows[0].attempts >= 5) return 'Too many wrong attempts. Please request a new code.';
  if (row.rows[0].code_hash !== hashCode(email, String(otp || '').trim())) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
    return 'The code is incorrect.';
  }
  await pool.query('UPDATE otp_codes SET verified_at = now() WHERE email = $1', [email]);
  return null;
}

async function currentAdminEmail(id) {
  const r = await pool.query('SELECT email FROM accounts WHERE id = $1', [id]);
  return r.rowCount ? r.rows[0].email : null;
}

async function isVerifiedRecently(email, minutes) {
  const r = await pool.query(
    "SELECT 1 FROM otp_codes WHERE email = $1 AND verified_at IS NOT NULL AND verified_at > now() - ($2 || ' minutes')::interval",
    [email, String(minutes)]);
  return r.rowCount > 0;
}

app.post('/api/admin/account/email/send-old', requireAdmin, async (req, res) => {
  try {
    const email = await currentAdminEmail(readSession(req));
    if (!email) return res.status(404).json({ error: 'Account not found.' });
    await sendEmailCode(email, 'confirm the change from this email');
    res.json({ ok: true, email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send the code to your current email.' });
  }
});

app.post('/api/admin/account/email/verify-old', requireAdmin, async (req, res) => {
  try {
    const email = await currentAdminEmail(readSession(req));
    if (!email) return res.status(404).json({ error: 'Account not found.' });
    const err = await checkEmailCode(email, (req.body || {}).code);
    if (err) return res.status(400).json({ error: err });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not verify the code.' });
  }
});

app.post('/api/admin/account/email/send-new', requireAdmin, async (req, res) => {
  const id = readSession(req);
  const newEmail = String((req.body || {}).newEmail || '').trim().toLowerCase().slice(0, 200);
  try {
    const old = await currentAdminEmail(id);
    if (!old || !(await isVerifiedRecently(old, 15))) return res.status(403).json({ error: 'Verify your current email first.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.status(400).json({ error: 'Enter a valid new email address.' });
    if (newEmail === old) return res.status(400).json({ error: 'The new email must be different from your current email.' });
    const taken = await pool.query('SELECT 1 FROM accounts WHERE email = $1 AND id <> $2', [newEmail, id]);
    if (taken.rowCount) return res.status(409).json({ error: 'That email is already used by another account.' });
    await sendEmailCode(newEmail, 'confirm your new admin email');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send the code to the new email.' });
  }
});

app.post('/api/admin/account/email/verify-new', requireAdmin, async (req, res) => {
  const id = readSession(req);
  const newEmail = String((req.body || {}).newEmail || '').trim().toLowerCase().slice(0, 200);
  try {
    const old = await currentAdminEmail(id);
    if (!old || !(await isVerifiedRecently(old, 15))) return res.status(403).json({ error: 'Verify your current email first.' });
    const err = await checkEmailCode(newEmail, (req.body || {}).code);
    if (err) return res.status(400).json({ error: err });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not verify the code.' });
  }
});

app.post('/api/admin/account/email/confirm', requireAdmin, async (req, res) => {
  const id = readSession(req);
  const newEmail = String((req.body || {}).newEmail || '').trim().toLowerCase().slice(0, 200);
  try {
    const old = await currentAdminEmail(id);
    if (!old || !(await isVerifiedRecently(old, 15)) || !(await isVerifiedRecently(newEmail, 15))) {
      return res.status(403).json({ error: 'Both email addresses must be verified before the change is saved.' });
    }
    const taken = await pool.query('SELECT 1 FROM accounts WHERE email = $1 AND id <> $2', [newEmail, id]);
    if (taken.rowCount) return res.status(409).json({ error: 'That email is already used by another account.' });
    await pool.query('UPDATE accounts SET email = $1 WHERE id = $2', [newEmail, id]);
    await pool.query('DELETE FROM otp_codes WHERE email = ANY($1)', [[old, newEmail]]);
    res.json({ ok: true, email: newEmail });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change the email.' });
  }
});

// Admin account: change password. Step 1 checks the passwords and emails a code; step 2 verifies the code and saves.
async function checkAdminPasswordChange(id, current, next) {
  if (next.length < 8) return { error: 'The new password must be at least 8 characters.', status: 400 };
  const acc = await pool.query('SELECT email, password_hash FROM accounts WHERE id = $1', [id]);
  if (!acc.rowCount || !verifyPassword(current, acc.rows[0].password_hash)) {
    return { error: 'Your current password is incorrect.', status: 401 };
  }
  const past = await pool.query('SELECT password_hash FROM password_history WHERE account_id = $1', [id]);
  const previous = [acc.rows[0].password_hash, ...past.rows.map((r) => r.password_hash)];
  if (previous.some((h) => verifyPassword(next, h))) {
    return { error: 'You cannot reuse a previous password. Please choose a new one.', status: 400 };
  }
  return { acc: acc.rows[0] };
}

app.post('/api/admin/account/password/send', requireAdmin, async (req, res) => {
  const id = readSession(req);
  const b = req.body || {};
  try {
    const check = await checkAdminPasswordChange(id, String(b.currentPassword || ''), String(b.newPassword || ''));
    if (check.error) return res.status(check.status).json({ error: check.error });
    await sendEmailCode(check.acc.email, 'change your admin password');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send the verification code.' });
  }
});

app.post('/api/admin/account/password/confirm', requireAdmin, async (req, res) => {
  const id = readSession(req);
  const b = req.body || {};
  const next = String(b.newPassword || '');
  try {
    const check = await checkAdminPasswordChange(id, String(b.currentPassword || ''), next);
    if (check.error) return res.status(check.status).json({ error: check.error });
    const codeErr = await checkEmailCode(check.acc.email, b.code);
    if (codeErr) return res.status(400).json({ error: codeErr });
    await pool.query('INSERT INTO password_history (account_id, password_hash) VALUES ($1, $2)', [id, check.acc.password_hash]);
    await pool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hashPassword(next), id]);
    await pool.query('DELETE FROM otp_codes WHERE email = $1', [check.acc.email]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change the password.' });
  }
});

// ---- CUP Student Interactive Portal (pre-enrollment for 2nd to 4th year students) ----
const STUDENT_YEARS = [2, 3, 4];

function currentPortalTerm(m) {
  const ay = m.portal_ay || '';
  const semester = Number(m.portal_term_no) === 2 ? 2 : 1;
  return { ay, semester, key: ay + '|' + semester, open: m.pre_enroll_open === 'true' };
}

async function getPortalTerm(client = pool) {
  const { rows } = await client.query("SELECT key, value FROM cat_settings WHERE key IN ('portal_ay', 'portal_term_no', 'pre_enroll_open')");
  return currentPortalTerm(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

async function requireStudent(req, res, next) {
  const id = readSession(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const { rows } = await pool.query('SELECT role FROM accounts WHERE id = $1', [id]);
    if (!rows.length || rows[0].role !== 'student') return res.status(403).json({ error: 'This portal is for enrolled students only.' });
    req.studentId = id;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check your access.' });
  }
}

// Admin: import students (rows parsed from the uploaded CSV).
app.post('/api/admin/import/students', requireAdmin, async (req, res) => {
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 5000) return res.status(400).json({ error: 'Upload between 1 and 5000 student rows.' });
  const result = { created: 0, updated: 0, errors: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const line = i + 2;
    const studentNumber = String(r.student_number || '').trim().slice(0, 50);
    const lastName = String(r.last_name || '').trim().slice(0, 100);
    const firstName = String(r.first_name || '').trim().slice(0, 100);
    const middleName = String(r.middle_name || '').trim().slice(0, 100) || null;
    const nameExt = String(r.name_extension || '').trim().slice(0, 10) || null;
    const email = String(r.email || '').trim().toLowerCase().slice(0, 200);
    const dob = String(r.date_of_birth || '').trim();
    const program = String(r.program || '').trim().slice(0, 100);
    const year = Number(r.year_level);
    if (!studentNumber || !lastName || !firstName || !program || !STUDENT_YEARS.includes(year)) {
      result.errors.push({ line, error: 'Missing student number, name, program, or year level (2, 3 or 4).' });
      continue;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { result.errors.push({ line, error: 'Invalid email.' }); continue; }
    if (!validDate(dob)) { result.errors.push({ line, error: 'Date of birth must be YYYY-MM-DD.' }); continue; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const byNumber = await client.query('SELECT account_id FROM student_profiles WHERE student_number = $1', [studentNumber]);
      let accountId;
      if (byNumber.rowCount) {
        accountId = byNumber.rows[0].account_id;
        await client.query('UPDATE student_profiles SET program = $2, year_level = $3 WHERE account_id = $1', [accountId, program, year]);
        result.updated++;
      } else {
        const byEmail = await client.query('SELECT id, role FROM accounts WHERE email = $1', [email]);
        if (byEmail.rowCount && byEmail.rows[0].role !== 'student') {
          await client.query('ROLLBACK');
          result.errors.push({ line, error: 'That email belongs to another account.' });
          continue;
        }
        if (byEmail.rowCount) {
          accountId = byEmail.rows[0].id;
        } else {
          const ins = await client.query(
            `INSERT INTO accounts (category, first_name, middle_name, last_name, name_extension, date_of_birth, email, password_hash, role)
             VALUES ('STUDENT', $1, $2, $3, $4, $5, $6, $7, 'student') RETURNING id`,
            [firstName, middleName, lastName, nameExt, dob, email, hashPassword(crypto.randomBytes(24).toString('hex'))]);
          accountId = ins.rows[0].id;
        }
        await client.query(
          'INSERT INTO student_profiles (account_id, student_number, program, year_level) VALUES ($1, $2, $3, $4)',
          [accountId, studentNumber, program, year]);
        result.created++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      result.errors.push({ line, error: 'Could not save this row.' });
    } finally {
      client.release();
    }
  }
  res.json(result);
});

// Admin: import the curriculum (subjects per program, year level and semester).
app.post('/api/admin/import/curriculum', requireAdmin, async (req, res) => {
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 5000) return res.status(400).json({ error: 'Upload between 1 and 5000 subject rows.' });
  const result = { saved: 0, errors: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const line = i + 2;
    const program = String(r.program || '').trim().slice(0, 100);
    const year = Number(r.year_level);
    const term = Number(r.term_no);
    const code = String(r.code || '').trim().slice(0, 30);
    const title = String(r.title || '').trim().slice(0, 200);
    const units = Number(r.units);
    if (!program || !STUDENT_YEARS.includes(year) || ![1, 2].includes(term) || !code || !title || !(units > 0 && units <= 10)) {
      result.errors.push({ line, error: 'Needs program, year level (2-4), term (1 or 2), code, title and units.' });
      continue;
    }
    try {
      await pool.query(
        `INSERT INTO curriculum_subjects (program, year_level, term_no, code, title, units) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (program, year_level, term_no, code) DO UPDATE SET title = EXCLUDED.title, units = EXCLUDED.units`,
        [program, year, term, code, title, units]);
      result.saved++;
    } catch (err) {
      result.errors.push({ line, error: 'Could not save this row.' });
    }
  }
  res.json(result);
});

// Admin: portal term and pre-enrollment open/closed.
app.get('/api/admin/portal', requireAdmin, async (req, res) => {
  try {
    const t = await getPortalTerm();
    const counts = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM student_profiles) AS students,
              (SELECT COUNT(*)::int FROM pre_enroll_submissions WHERE term = $1) AS submitted`, [t.key]);
    res.json({ ay: t.ay, semester: t.semester, open: t.open, ...counts.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the portal settings.' });
  }
});

app.post('/api/admin/portal', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    const pairs = [];
    if (b.ay !== undefined) {
      const ay = String(b.ay).trim();
      if (!/^\d{4}-\d{4}$/.test(ay)) return res.status(400).json({ error: 'Academic year must look like 2027-2028.' });
      pairs.push(['portal_ay', ay]);
    }
    if (b.semester !== undefined) {
      if (![1, 2].includes(Number(b.semester))) return res.status(400).json({ error: 'Choose the 1st or 2nd semester.' });
      pairs.push(['portal_term_no', String(Number(b.semester))]);
    }
    if (typeof b.open === 'boolean') pairs.push(['pre_enroll_open', b.open ? 'true' : 'false']);
    for (const [k, v] of pairs) {
      await pool.query('INSERT INTO cat_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
    }
    const t = await getPortalTerm();
    res.json({ ay: t.ay, semester: t.semester, open: t.open });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the portal settings.' });
  }
});

// Student: profile, term, curriculum for the program and year, and current selections.
app.get('/api/student/me', requireStudent, async (req, res) => {
  try {
    const p = await pool.query(
      `SELECT sp.student_number, sp.program, sp.year_level, a.first_name, a.last_name, a.middle_name, a.name_extension, a.email
         FROM student_profiles sp JOIN accounts a ON a.id = sp.account_id WHERE sp.account_id = $1`, [req.studentId]);
    if (!p.rowCount) return res.status(404).json({ error: 'No student record found for this account.' });
    const prof = p.rows[0];
    const t = await getPortalTerm();
    const subjects = await pool.query(
      'SELECT id, code, title, units FROM curriculum_subjects WHERE program = $1 AND year_level = $2 AND term_no = $3 ORDER BY code',
      [prof.program, prof.year_level, t.semester]);
    const sel = await pool.query('SELECT subject_id FROM pre_enrollments WHERE account_id = $1 AND term = $2', [req.studentId, t.key]);
    const sub = await pool.query('SELECT submitted_at FROM pre_enroll_submissions WHERE account_id = $1 AND term = $2', [req.studentId, t.key]);
    res.json({
      student: { number: prof.student_number, program: prof.program, yearLevel: prof.year_level, name: [prof.first_name, prof.middle_name, prof.last_name, prof.name_extension].filter(Boolean).join(' ') },
      term: { ay: t.ay, semester: t.semester, open: t.open },
      subjects: subjects.rows,
      selected: sel.rows.map((r) => r.subject_id),
      submitted: sub.rowCount > 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load your pre-enrollment.' });
  }
});

// Student: save selections (draft) or submit (locks the pre-enrollment for this term).
app.post('/api/student/pre-enroll', requireStudent, async (req, res) => {
  const submit = (req.body || {}).submit === true;
  const ids = Array.isArray((req.body || {}).subjectIds) ? req.body.subjectIds.map(Number) : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await getPortalTerm(client);
    if (!t.open) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Pre-enrollment is currently closed.' }); }
    const done = await client.query('SELECT 1 FROM pre_enroll_submissions WHERE account_id = $1 AND term = $2', [req.studentId, t.key]);
    if (done.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Your pre-enrollment has already been submitted.' }); }
    const prof = await client.query('SELECT program, year_level FROM student_profiles WHERE account_id = $1', [req.studentId]);
    if (!prof.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No student record found.' }); }
    const allowed = await client.query(
      'SELECT id FROM curriculum_subjects WHERE program = $1 AND year_level = $2 AND term_no = $3',
      [prof.rows[0].program, prof.rows[0].year_level, t.semester]);
    const allowedIds = new Set(allowed.rows.map((r) => r.id));
    if (ids.some((id) => !allowedIds.has(id))) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'One of the selected subjects is not in your curriculum for this term.' }); }
    await client.query('DELETE FROM pre_enrollments WHERE account_id = $1 AND term = $2', [req.studentId, t.key]);
    for (const id of new Set(ids)) {
      await client.query('INSERT INTO pre_enrollments (account_id, term, subject_id) VALUES ($1, $2, $3)', [req.studentId, t.key, id]);
    }
    if (submit) {
      if (!ids.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Select at least one subject before you submit.' }); }
      await client.query('INSERT INTO pre_enroll_submissions (account_id, term) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.studentId, t.key]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, submitted: submit });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Could not save your pre-enrollment.' });
  } finally {
    client.release();
  }
});

// Admin: pre-enrollment list for the current term.
app.get('/api/admin/pre-enrollment', requireAdmin, async (req, res) => {
  try {
    const t = await getPortalTerm();
    const { rows } = await pool.query(
      `SELECT sp.student_number, sp.program, sp.year_level, a.last_name, a.first_name, a.email,
              (SELECT COUNT(*)::int FROM pre_enrollments pe WHERE pe.account_id = sp.account_id AND pe.term = $1) AS subjects,
              (SELECT COALESCE(SUM(cs.units), 0)::float FROM pre_enrollments pe JOIN curriculum_subjects cs ON cs.id = pe.subject_id WHERE pe.account_id = sp.account_id AND pe.term = $1) AS units,
              EXISTS (SELECT 1 FROM pre_enroll_submissions ps WHERE ps.account_id = sp.account_id AND ps.term = $1) AS submitted
         FROM student_profiles sp JOIN accounts a ON a.id = sp.account_id
        ORDER BY sp.program, sp.year_level, a.last_name, a.first_name`, [t.key]);
    res.json({ term: t, students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the pre-enrollment list.' });
  }
});

app.post('/api/admin/cat-year', requireAdmin, async (req, res) => {
  const year = String((req.body && req.body.year) || '').trim();
  if (!/^\d{4}$/.test(year) || Number(year) < 2000 || Number(year) > 2100) {
    return res.status(400).json({ error: 'Enter a 4-digit year, for example 2027.' });
  }
  try {
    await pool.query(
      "INSERT INTO cat_settings (key, value) VALUES ('cat_year', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [year]);
    res.json(catLabels(Number(year)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the CUP CAT year.' });
  }
});

const APPLICANT_SECTIONS = ['degree', 'personal', 'photo', 'family', 'education', 'academic', 'attachments'];

app.get('/api/admin/applicants', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.applicant_id, a.category, a.first_name, a.middle_name, a.last_name, a.name_extension, a.email, a.created_at,
             COALESCE(json_object_agg(s.section, s.submitted_at) FILTER (WHERE s.section IS NOT NULL), '{}') AS sections
      FROM accounts a LEFT JOIN cat_sections s ON s.account_id = a.id AND s.unlocked = false
      WHERE a.role = 'applicant'
      GROUP BY a.id ORDER BY a.created_at DESC`);
    res.json(rows.map((r) => {
      const done = APPLICANT_SECTIONS.filter((k) => r.sections[k]).length;
      return {
        id: r.id, applicantId: r.applicant_id, category: categoryLabel(r.category),
        name: [r.last_name, r.first_name, r.middle_name, r.name_extension].filter(Boolean).join(', '),
        email: r.email, registeredAt: r.created_at, sectionsDone: done, sectionsTotal: APPLICANT_SECTIONS.length,
        submittedAt: r.sections.attachments || null, complete: !!r.sections.attachments
      };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load applicants.' });
  }
});

// Loads one applicant's account and all section data.
async function loadApplicant(accountId) {
  const acc = await pool.query('SELECT * FROM accounts WHERE id = $1 AND role = $2', [accountId, 'applicant']);
  if (!acc.rows.length) return null;
  const sec = await pool.query('SELECT section, data FROM cat_sections WHERE account_id = $1', [accountId]);
  const sections = {};
  sec.rows.forEach((r) => { sections[r.section] = r.data || {}; });
  return { account: acc.rows[0], sections };
}

function parseDataUrl(u) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(String(u || ''));
  return m ? { mime: m[1], buffer: Buffer.from(m[2], 'base64') } : null;
}
const safeName = (v) => String(v || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 150);

function applicantFolder(a) {
  const name = [a.account.last_name, a.account.first_name].join(', ');
  return safeName(`${a.account.applicant_id || 'Pending'} - ${name}`);
}

// Adds one applicant's folder (the three uploaded attachments) to a ZIP archive.
async function addApplicantToZip(archive, a) {
  const root = applicantFolder(a) + '/';
  const S = a.sections;
  const att = S.attachments || {};
  [['psa', 'PSA-NSO Birth Certificate', att.psaName], ['voter', 'Voter Certificate', att.voterName], ['f137', 'Form 137-A', att.f137Name], ['f138', 'Form 138', att.f138Name]].forEach(([k, label, orig]) => {
    const f = parseDataUrl(att[k]);
    if (f) archive.append(f.buffer, { name: root + 'Attachments/' + label + ' - ' + safeName(orig || 'document.pdf') });
  });
}

function sendZip(res, filename, build) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => { console.error(err); res.destroy(err); });
  archive.pipe(res);
  build(archive).then(() => archive.finalize()).catch((err) => { console.error(err); archive.abort(); res.destroy(err); });
}

// Same data the applicant's own print page reads, so the admin copy renders identically.
app.get('/api/admin/applicants/:id/print-data', requireAdmin, async (req, res) => {
  const a = await loadApplicant(Number(req.params.id)).catch(() => null);
  if (!a) return res.status(404).json({ error: 'Applicant not found.' });
  const r = a.account;
  const sections = {};
  Object.keys(a.sections).forEach((k) => { sections[k] = { data: a.sections[k] }; });
  res.json({
    me: { firstName: r.first_name, middleName: r.middle_name, lastName: r.last_name, nameExtension: r.name_extension, email: r.email, dateOfBirth: r.date_of_birth, createdAt: r.created_at, applicantId: r.applicant_id, category: categoryLabel(r.category), ...(await examFields(a.account.id)) },
    sections
  });
});

app.get('/api/admin/applicants/:id/zip', requireAdmin, async (req, res) => {
  const a = await loadApplicant(Number(req.params.id)).catch(() => null);
  if (!a) return res.status(404).json({ error: 'Applicant not found.' });
  sendZip(res, `${safeName(applicantFolder(a))}.zip`, (archive) => addApplicantToZip(archive, a));
});

app.get('/api/admin/export.zip', requireAdmin, async (req, res) => {
  const ids = await pool.query("SELECT id FROM accounts WHERE role = 'applicant' ORDER BY created_at");
  sendZip(res, 'CUP-CAT-applicants.zip', async (archive) => {
    for (const r of ids.rows) {
      const a = await loadApplicant(r.id);
      if (a) await addApplicantToZip(archive, a);
    }
  });
});

app.get('/api/admin/export.xlsx', requireAdmin, async (req, res) => {
  try {
    const ids = await pool.query("SELECT id FROM accounts WHERE role = 'applicant' ORDER BY created_at");
    const list = [];
    for (const r of ids.rows) { const a = await loadApplicant(r.id); if (a) list.push(a); }
    const SKIP = { photo: ['photo'], attachments: ['psa', 'voter', 'f137', 'f138'] };
    const cols = [
      { header: 'Applicant ID', key: 'applicant_id', width: 14 }, { header: 'Category', key: 'category', width: 28 },
      { header: 'Last Name', key: 'last_name', width: 18 }, { header: 'First Name', key: 'first_name', width: 18 },
      { header: 'Middle Name', key: 'middle_name', width: 16 }, { header: 'Name Ext.', key: 'name_extension', width: 10 },
      { header: 'Date of Birth', key: 'date_of_birth', width: 14 }, { header: 'Email', key: 'email', width: 30 },
      { header: 'Registered At', key: 'created_at', width: 22 }
    ];
    const sectionKeys = {};
    list.forEach((a) => Object.keys(a.sections).forEach((sec) => {
      sectionKeys[sec] = sectionKeys[sec] || new Set();
      Object.keys(a.sections[sec] || {}).forEach((k) => { if (!(SKIP[sec] || []).includes(k)) sectionKeys[sec].add(k); });
    }));
    Object.keys(sectionKeys).forEach((sec) => [...sectionKeys[sec]].forEach((k) => cols.push({ header: sec + ': ' + k, key: sec + '.' + k, width: 20 })));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Applicants');
    ws.columns = cols;
    ws.getRow(1).font = { bold: true };
    list.forEach((a) => {
      const row = {};
      cols.forEach((c) => {
        if (c.key.includes('.')) { const [sec, k] = c.key.split('.'); row[c.key] = (a.sections[sec] || {})[k] ?? ''; }
        else if (c.key === 'date_of_birth') row[c.key] = a.account.date_of_birth ? new Date(a.account.date_of_birth) : '';
        else if (c.key === 'created_at') row[c.key] = a.account.created_at;
        else if (c.key === 'category') row[c.key] = categoryLabel(a.account.category);
        else row[c.key] = a.account[c.key] ?? '';
      });
      ws.addRow(row);
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="CUP-CAT-applicants.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build the Excel file.' });
  }
});

// Test logins from Render environment variables. Each one is a normal account, created or updated at startup,
// so the password in the environment is always the one that works.
//   TEST_FACULTY_USERNAME / TEST_FACULTY_PASSWORD / TEST_FACULTY_COLLEGE
//   TEST_STUDENT_NO / TEST_STUDENT_PASSWORD / TEST_STUDENT_COLLEGE / TEST_STUDENT_PROGRAM   (username = student number)
//   TEST_REGISTRAR_USERNAME / TEST_REGISTRAR_PASSWORD / TEST_REGISTRAR_COLLEGE
//   <COLLEGE>_USERNAME / <COLLEGE>_PASSWORD   (one per college; <COLLEGE> is COACS, CAS, CONM, COED, COBM, LAW, GS, TESDA_TVI)
async function seedTestAccounts() {
  const env = process.env;
  const collegeOf = (v, d) => (REG_COLLEGES.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : d);
  const fu = String(env.TEST_FACULTY_USERNAME || '').trim().toLowerCase();
  const fp = env.TEST_FACULTY_PASSWORD || '';
  if (fu && fp) {
    await pool.query(
      `INSERT INTO reg_users (role, username, password_hash, name, first_name, last_name, college, must_change_password)
       VALUES ('faculty',$1,$2,'Test Faculty','Test','Faculty',$3,FALSE)
       ON CONFLICT (username) DO UPDATE SET role = 'faculty', password_hash = EXCLUDED.password_hash, college = EXCLUDED.college, archived_at = NULL, must_change_password = FALSE`,
      [fu, hashPassword(fp), collegeOf(env.TEST_FACULTY_COLLEGE, 'CONM')]);
  }
  const su = String(env.TEST_STUDENT_NO || '').trim();
  const sp = env.TEST_STUDENT_PASSWORD || '';
  if (su && sp) {
    if (!/^\d{4}-\d-\d{7}-\d{2}$/.test(su)) { console.error('TEST_STUDENT_NO must be in the format xxxx-x-xxxxxxx-xx.'); }
    else {
      const sc = collegeOf(env.TEST_STUDENT_COLLEGE, 'CONM');
      await pool.query(
        `INSERT INTO reg_students (student_no, college, first_name, last_name, program, year_level, section, status, enrolled_at)
         VALUES ($1,$2,'Test','Student',$3,1,'A','enrolled',now())
         ON CONFLICT (student_no) DO UPDATE SET college = EXCLUDED.college, status = 'enrolled'`,
        [su, sc, env.TEST_STUDENT_PROGRAM || 'Test Program']);
      await pool.query(
        `INSERT INTO reg_users (role, username, password_hash, name, college, student_no, must_change_password)
         VALUES ('student',$1,$2,'Test Student',$3,$4,FALSE)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, college = EXCLUDED.college, archived_at = NULL, must_change_password = FALSE`,
        [su.toLowerCase(), hashPassword(sp), sc, su]);
    }
  }
  const ru = String(env.TEST_REGISTRAR_USERNAME || '').trim().toLowerCase();
  const rp = env.TEST_REGISTRAR_PASSWORD || '';
  if (ru && rp) {
    const rc = collegeOf(env.TEST_REGISTRAR_COLLEGE, 'CONM');
    const up = await pool.query("UPDATE accounts SET password_hash = $2, college = $3 WHERE role = 'registrar' AND email = $1", [ru, hashPassword(rp), rc]);
    if (!up.rowCount) {
      await pool.query("INSERT INTO accounts (category, first_name, last_name, date_of_birth, email, password_hash, role, college) VALUES ('REGISTRAR','Test','Registrar','2000-01-01',$1,$2,'registrar',$3)", [ru, hashPassword(rp), rc]);
    }
  }
  // One test registrar per college, so every college portal can be checked.
  for (const college of REG_COLLEGES) {
    const base = collegeTestEnvBase(college);
    const cu = String(env[base + '_USERNAME'] || '').trim().toLowerCase();
    const cp = env[base + '_PASSWORD'] || '';
    if (!cu || !cp) continue;
    const up = await pool.query("UPDATE accounts SET password_hash = $2, college = $3 WHERE role = 'registrar' AND email = $1", [cu, hashPassword(cp), college]);
    if (!up.rowCount) {
      await pool.query("INSERT INTO accounts (category, first_name, last_name, date_of_birth, email, password_hash, role, college) VALUES ('REGISTRAR','Test','Registrar','2000-01-01',$1,$2,'registrar',$3)", [cu, hashPassword(cp), college]);
    }
  }
}

// Gives an applicant ID to every existing account that finished attachments but has none (oldest first).
async function backfillApplicantIds() {
  const { rows } = await pool.query(`SELECT s.account_id FROM cat_sections s JOIN accounts a ON a.id = s.account_id
    WHERE s.section = 'attachments' AND a.applicant_id IS NULL ORDER BY s.submitted_at, s.account_id`);
  for (const r of rows) await assignApplicantId(r.account_id);
  return rows.length;
}
(process.env.RUN_STARTUP_TASKS !== 'false' ? backfillApplicantIds() : Promise.resolve(0))
  .then((n) => console.log('Applicant IDs assigned to existing accounts:', n))
  .catch((err) => console.error('Applicant ID backfill failed:', err.message));

app.listen(port, () => {
  console.log(`City University Pasay site running on port ${port}`);
});
