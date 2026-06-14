/*
  # Add sasha_stage column to editing_jobs_cache

  Adds a new column to store Sasha's stage override for each job.
  This allows Sasha to mark a card's pipeline stage without touching Herman's columns.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'sasha_stage'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN sasha_stage text DEFAULT '';
  END IF;
END $$;
