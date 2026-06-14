/*
  # Add block_end_row column to editing_jobs_cache

  ## Summary
  Adds a `block_end_row` integer column to track the last sheet row belonging
  to a multi-row job block. Herman's sheet sometimes uses 2+ consecutive rows
  for a single job (main row + email/notes continuation row). When dragging a
  card, the app needs to repaint ALL rows in the block, not just the first.

  ## Changes
  - `editing_jobs_cache`: new column `block_end_row` (integer, default = sheet_row)
    - Equals `sheet_row` for single-row jobs
    - Greater than `sheet_row` for multi-row jobs
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'block_end_row'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN block_end_row integer;
    -- Default to sheet_row for existing rows
    UPDATE editing_jobs_cache SET block_end_row = sheet_row WHERE block_end_row IS NULL;
  END IF;
END $$;
