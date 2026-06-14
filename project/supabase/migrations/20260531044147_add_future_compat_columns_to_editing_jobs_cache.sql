/*
  # Add future-compatibility columns to editing_jobs_cache

  1. Changes to editing_jobs_cache
    - `moved_to_ready_at`  (timestamptz, nullable) — when the card was last moved into "Ready to Send"; drives sort order in that column
    - `delivered_date`     (timestamptz, nullable) — when the card was marked Delivered
    - `revision_count`     (integer, default 0)    — how many times the card has been sent back for revision
    - `status_history`     (jsonb, default [])     — ordered log of stage transitions: [{stage, at, by}]

  2. Notes
    - All columns are nullable or have safe defaults so existing rows are unaffected
    - No UI required yet — structure only
    - RLS policies already cover all rows on this table; no new policies needed
*/

DO $$
BEGIN
  -- moved_to_ready_at: ISO timestamp when card last entered ready_to_send
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'moved_to_ready_at'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN moved_to_ready_at timestamptz;
  END IF;

  -- delivered_date: ISO timestamp when card was delivered
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'delivered_date'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN delivered_date timestamptz;
  END IF;

  -- revision_count: number of revisions requested
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'revision_count'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN revision_count integer DEFAULT 0;
  END IF;

  -- status_history: ordered array of {stage, at, by} objects
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'status_history'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN status_history jsonb DEFAULT '[]'::jsonb;
  END IF;
END $$;
