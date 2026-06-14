ALTER TABLE editing_jobs_cache
  ADD COLUMN IF NOT EXISTS action_reason TEXT NOT NULL DEFAULT '';
