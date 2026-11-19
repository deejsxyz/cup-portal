-- Run once on Neon BEFORE deploying the pre-registration change.
-- Records a student's pre-registration for one term. Rows are never deleted or edited.
CREATE TABLE IF NOT EXISTS reg_preregistrations (
  student_no    TEXT NOT NULL REFERENCES reg_students(student_no),
  college       TEXT NOT NULL,
  term          TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  info          JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_no, term, academic_year)
);
