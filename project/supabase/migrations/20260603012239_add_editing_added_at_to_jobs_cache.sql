/*
  # Add editing_added_at to editing_jobs_cache

  ## Purpose
  Stores the ISO timestamp of when a job was first added to the Editing Pipeline.
  This value is written once (at creation) and never overwritten by stage moves,
  comment edits, or workflow checkbox changes.

  ## Changes
  - editing_jobs_cache: add `editing_added_at` (timestamptz, nullable)

  ## Notes
  - Nullable so existing rows don't break; old cards show a fallback date in the UI.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'editing_added_at'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN editing_added_at timestamptz;
  END IF;
END $$;
