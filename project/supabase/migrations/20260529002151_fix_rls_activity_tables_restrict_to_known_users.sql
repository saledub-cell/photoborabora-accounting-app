/*
  # Fix RLS policies for card_activity_log and user_activity

  ## Problem
  Both tables had INSERT/UPDATE policies with `WITH CHECK (true)` or `USING (true)`,
  meaning any anonymous client could write any arbitrary data — a real security gap.

  ## Fix
  Replace always-true write policies with policies that verify the actor/user_id
  references an actual user in the user_roles table. Since this app does not use
  Supabase Auth (no auth.uid()), we validate by checking that the written value
  exists as a known user ID or display name in user_roles.

  ### card_activity_log
  - INSERT: actor must match a display_name in user_roles
  - SELECT: unchanged (anon can read)

  ### user_activity
  - INSERT: user_id must exist in user_roles
  - UPDATE: user_id must exist in user_roles (both USING and WITH CHECK)
  - SELECT: unchanged (anon can read)

  ## Security improvement
  Random anonymous clients can no longer inject arbitrary rows.
  Only sessions that know a valid user_id / display_name from user_roles can write.
*/

-- ── card_activity_log ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can insert activity log" ON card_activity_log;

CREATE POLICY "Known users can insert activity log"
  ON card_activity_log
  FOR INSERT
  TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.display_name = actor
    )
  );

-- ── user_activity ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can upsert user activity"  ON user_activity;
DROP POLICY IF EXISTS "Anyone can update user activity"  ON user_activity;

CREATE POLICY "Known users can insert own activity"
  ON user_activity
  FOR INSERT
  TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.id = user_id
    )
  );

CREATE POLICY "Known users can update own activity"
  ON user_activity
  FOR UPDATE
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.id = user_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.id = user_id
    )
  );
