ALTER TABLE editing_jobs_cache
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT '';
