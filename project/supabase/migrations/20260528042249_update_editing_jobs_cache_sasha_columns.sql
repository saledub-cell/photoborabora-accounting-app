/*
  # Update editing_jobs_cache for safe hybrid sync

  ## Purpose
  Redesign the cache table to separate Herman's read-only workflow data from
  Sasha's writable helper columns. This prevents any accidental overwrite of
  Herman's data.

  ## Changes
  - Drop and recreate editing_jobs_cache with proper column separation
  - `herman_data` (jsonb) — read-only copy of Herman's workflow columns
  - `sasha_priority` (text) — priority tag set by Sasha (urgent/important/normal/ready/none)
  - `sasha_color` (text) — priority color (red/orange/blue/green/gray)
  - `sasha_comment` (text) — short comment from Sasha
  - `sasha_request` (text) — request tag (urgent/edit_first/wait/client_asked/vip/send_today)
  - `sasha_due_priority` (text) — optional due/deadline note
  - `sasha_updated_at` (timestamptz) — when Sasha last updated
  - `sheet_row` (integer) — row number in Google Sheet (1-indexed, row 1 = header)
  - `row_key` (text) — stable match key: galleryName|date|resort (normalized)
  - `synced_at` (timestamptz) — when Herman data was last pulled from sheet
  - `dirty` (boolean) — true if Sasha columns need to be pushed to sheet

  ## Security
  - RLS enabled; anon role read/write for single-user app
*/

DROP TABLE IF EXISTS editing_jobs_cache;

CREATE TABLE editing_jobs_cache (
  id              text PRIMARY KEY,          -- sheet row number as string
  sheet_row       integer NOT NULL,
  row_key         text NOT NULL DEFAULT '',  -- normalized match key
  herman_data     jsonb NOT NULL DEFAULT '{}',
  sasha_priority  text NOT NULL DEFAULT '',
  sasha_color     text NOT NULL DEFAULT 'gray',
  sasha_comment   text NOT NULL DEFAULT '',
  sasha_request   text NOT NULL DEFAULT '',
  sasha_due_priority text NOT NULL DEFAULT '',
  sasha_updated_at timestamptz,
  synced_at       timestamptz DEFAULT now(),
  dirty           boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_editing_jobs_cache_row_key ON editing_jobs_cache (row_key);
CREATE INDEX IF NOT EXISTS idx_editing_jobs_cache_dirty ON editing_jobs_cache (dirty) WHERE dirty = true;

ALTER TABLE editing_jobs_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can read editing jobs cache"
  ON editing_jobs_cache FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Anon can insert editing jobs cache"
  ON editing_jobs_cache FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Anon can update editing jobs cache"
  ON editing_jobs_cache FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can delete editing jobs cache"
  ON editing_jobs_cache FOR DELETE
  TO anon
  USING (true);
