/*
  # Create editing_jobs_cache table

  ## Purpose
  Offline cache for Google Sheets editing workflow data. When the Google Sheets
  API is unavailable, the app reads from this table instead of failing silently.

  ## New Tables
  - `editing_jobs_cache`
    - `id` (text, primary key) — matches Google Sheets row identifier (row number as string)
    - `sheet_row` (integer) — actual row number in the Google Sheet (1-indexed, header is row 1)
    - `data` (jsonb) — full job object as serialized from the sheet
    - `synced_at` (timestamptz) — when this row was last synced from the sheet
    - `dirty` (boolean) — true if local changes haven't been pushed to the sheet yet
    - `created_at` (timestamptz)
    - `updated_at` (timestamptz)

  ## Security
  - RLS enabled; public anon key read/write allowed because this is a single-user
    app with no user accounts. Policies are scoped to anon role only.

  ## Notes
  1. `data` stores the raw sheet row values mapped to EditingJob shape
  2. `dirty = true` marks rows pending upload to Sheets when connectivity returns
  3. `sheet_row` is used to construct the A1 range for Sheets API updates
*/

CREATE TABLE IF NOT EXISTS editing_jobs_cache (
  id          text PRIMARY KEY,
  sheet_row   integer NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  synced_at   timestamptz DEFAULT now(),
  dirty       boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE editing_jobs_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon users can read editing jobs cache"
  ON editing_jobs_cache FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Anon users can insert editing jobs cache"
  ON editing_jobs_cache FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Anon users can update editing jobs cache"
  ON editing_jobs_cache FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon users can delete editing jobs cache"
  ON editing_jobs_cache FOR DELETE
  TO anon
  USING (true);
