/*
  # Card movement history and cross-device activity sync

  ## Summary
  Adds a `card_activity_log` table to record every card change (stage moves,
  comment updates, checkbox changes) from any device/user. Also adds a
  `user_activity` table to track last-seen timestamps per user for cross-device
  presence awareness.

  ## New Tables

  ### card_activity_log
  Append-only log of every editing card change.
  - `id` (uuid, PK)
  - `job_id` (text) — matches editing_jobs_cache.id ("sheet-row-N")
  - `sheet_row` (integer) — sheet row number for direct lookup
  - `actor` (text) — "Sasha" | "Herman"
  - `action` (text) — "moved to Delivered", "added comment", etc.
  - `old_stage` (text) — previous stage (nullable)
  - `new_stage` (text) — new stage (nullable)
  - `created_at` (timestamptz)

  ### user_activity
  One row per user, updated on every action — used for cross-device sync.
  - `user_id` (text, PK) — "sasha" | "herman"
  - `display_name` (text)
  - `last_seen_at` (timestamptz)
  - `last_action` (text)
  - `last_tab` (text) — which tab they are on

  ## Security
  - Both tables have RLS enabled
  - anon role can read and insert (needed for PIN-only auth)
*/

-- ── card_activity_log ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_activity_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     text NOT NULL,
  sheet_row  integer,
  actor      text NOT NULL,
  action     text NOT NULL,
  old_stage  text,
  new_stage  text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE card_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert activity log"
  ON card_activity_log FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Anyone can read activity log"
  ON card_activity_log FOR SELECT
  TO anon
  USING (true);

-- ── user_activity ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_activity (
  user_id      text PRIMARY KEY,
  display_name text NOT NULL,
  last_seen_at timestamptz DEFAULT now(),
  last_action  text DEFAULT '',
  last_tab     text DEFAULT ''
);

ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read user activity"
  ON user_activity FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Anyone can upsert user activity"
  ON user_activity FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Anyone can update user activity"
  ON user_activity FOR UPDATE
  TO anon
  USING (true);
