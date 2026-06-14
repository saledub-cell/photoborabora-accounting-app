/*
  # Fix user_roles RLS — admin-only writes via edge function

  ## Summary
  The previous policy only allowed anon SELECT. All writes were blocked by RLS
  because the app uses the anon key (no Supabase Auth). Write operations are now
  routed through the user-admin edge function which uses the service role key
  (bypasses RLS). This migration cleans up and documents the final policy set.

  ## Changes
  1. Keep anon SELECT so the login screen can load user profiles
  2. Allow service_role full access (used by the user-admin edge function)
  3. No direct write access for anon — all mutations go through the edge function

  ## Security
  - Anon users can only READ the user list (needed for login screen)
  - Only the service role (edge function) can INSERT / UPDATE / DELETE
  - The edge function itself verifies the caller is an admin before mutating
*/

-- Drop any existing policies to start clean
DROP POLICY IF EXISTS "Anyone can read user roles for login"        ON user_roles;
DROP POLICY IF EXISTS "Anon can read user profiles for login"       ON user_roles;
DROP POLICY IF EXISTS "Service role full access"                    ON user_roles;
DROP POLICY IF EXISTS "Admins can manage users"                     ON user_roles;
DROP POLICY IF EXISTS "Editors can read own profile"                ON user_roles;

-- 1. Anon SELECT — login screen needs to list users and verify PINs
CREATE POLICY "Anon can read user profiles for login"
  ON user_roles
  FOR SELECT
  TO anon
  USING (true);

-- 2. Service role full access — used exclusively by the user-admin edge function
--    which performs its own admin verification before any write
CREATE POLICY "Service role full access"
  ON user_roles
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
