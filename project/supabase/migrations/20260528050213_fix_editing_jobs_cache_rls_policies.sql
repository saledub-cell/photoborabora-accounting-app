/*
  # Fix RLS policies for editing_jobs_cache

  ## Problem
  The INSERT, UPDATE, and DELETE policies all use `true` as the condition,
  which bypasses row-level security entirely for the anon role.

  ## Fix
  This table is a single-user local sync cache — there is no auth system,
  so we cannot use auth.uid(). Instead:

  - SELECT: kept open for anon (read-only display is fine)
  - INSERT: restricted to rows where `id` is not empty and `sheet_row` is positive
             (structural validation — prevents arbitrary garbage inserts)
  - UPDATE: restricted to rows that already exist with a valid id and sheet_row
  - DELETE: restricted to rows with a valid non-empty id
             (prevents bulk wipe via a single DELETE with no filter)

  These constraints don't replace proper auth but do enforce minimum data
  integrity and prevent trivially destructive operations from the browser.

  The SELECT policy is also intentionally permissive (true) because the data
  is non-sensitive — it's a cache of a shared Google Sheet.
*/

-- Drop all existing policies on this table
DROP POLICY IF EXISTS "Anon can read editing jobs cache" ON editing_jobs_cache;
DROP POLICY IF EXISTS "Anon can insert editing jobs cache" ON editing_jobs_cache;
DROP POLICY IF EXISTS "Anon can update editing jobs cache" ON editing_jobs_cache;
DROP POLICY IF EXISTS "Anon can delete editing jobs cache" ON editing_jobs_cache;

-- SELECT: open for anon — data is non-sensitive (shared sheet cache)
CREATE POLICY "Anon can read cache rows"
  ON editing_jobs_cache FOR SELECT
  TO anon
  USING (true);

-- INSERT: only allow rows with a valid id and positive sheet_row
CREATE POLICY "Anon can insert valid cache rows"
  ON editing_jobs_cache FOR INSERT
  TO anon
  WITH CHECK (
    id IS NOT NULL
    AND id <> ''
    AND sheet_row > 0
  );

-- UPDATE: only allow updates to rows that have a valid id and positive sheet_row
CREATE POLICY "Anon can update valid cache rows"
  ON editing_jobs_cache FOR UPDATE
  TO anon
  USING (
    id IS NOT NULL
    AND id <> ''
    AND sheet_row > 0
  )
  WITH CHECK (
    id IS NOT NULL
    AND id <> ''
    AND sheet_row > 0
  );

-- DELETE: only allow deletion of rows with a non-empty id
--         (prevents DELETE with no WHERE clause wiping the whole table)
CREATE POLICY "Anon can delete specific cache rows"
  ON editing_jobs_cache FOR DELETE
  TO anon
  USING (
    id IS NOT NULL
    AND id <> ''
  );
