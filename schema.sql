-- Run once in the Neon SQL editor.
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  program TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CUP-CAT statistics shown on the CUP-CAT page
CREATE TABLE IF NOT EXISTS cat_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cat_stats (key, value) VALUES
  ('total_registrations', 0),
  ('total_successful_applications', 0)
ON CONFLICT (key) DO NOTHING;

-- CUP CAT accounts (one account per email)
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  first_name TEXT NOT NULL,
  middle_name TEXT,
  last_name TEXT NOT NULL,
  name_extension TEXT,
  date_of_birth DATE NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time codes sent to the applicant's email (kept for 10 minutes)
CREATE TABLE IF NOT EXISTS otp_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Marks when the applicant entered the correct OTP
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

ALTER TABLE cat_sections ADD COLUMN IF NOT EXISTS unlocked BOOLEAN NOT NULL DEFAULT false;

-- Applicant ID (YYYY-1XXXX), given once the attachments are submitted
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS applicant_id TEXT UNIQUE;

-- Account role: 'applicant' (default) or 'admin' (College Admission / Staff). Set admins with an UPDATE in Neon.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'applicant';
