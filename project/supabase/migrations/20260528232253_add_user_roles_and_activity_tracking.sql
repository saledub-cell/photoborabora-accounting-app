/*
  # User roles and activity tracking

  ## Summary
  Adds a `user_roles` table for simple PIN-based access control (no Supabase Auth
  required). Also adds `last_updated_by`, `last_updated_at`, and `last_action`
  columns to `editing_jobs_cache` for per-card activity tracking.

  ## New Tables
  - `user_roles`
    - `id` (text, PK) — username slug: "sasha" | "herman"
    - `display_name` (text) — shown on activity badges
    - `role` (text) — "admin" | "editor_guest"
    - `pin_hash` (text) — bcrypt-compatible hash; we store a sha-256 hex for simplicity
    - `created_at` (timestamptz)

  ## Modified Tables
  - `editing_jobs_cache`
    - `last_updated_by` (text) — "Sasha" | "Herman"
    - `last_updated_at` (timestamptz)
    - `last_action` (text) — e.g. "moved to Delivered", "checked Edited"

  ## Security
  - `user_roles` has RLS enabled; read allowed for anon (login needs to read roles)
  - No write access from client (roles are managed server-side only)
  - `editing_jobs_cache` policies unchanged (already has RLS)

  ## Notes
  - PIN is stored as SHA-256 hex (verified client-side with SubtleCrypto)
  - Sasha PIN: 1234  (change via direct DB update)
  - Herman PIN: 5678 (change via direct DB update)
*/

-- ── user_roles ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_roles (
  id           text PRIMARY KEY,
  display_name text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin', 'editor_guest')),
  pin_hash     text NOT NULL,
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read user roles for login"
  ON user_roles FOR SELECT
  TO anon
  USING (true);

-- Seed Sasha (admin) and Herman (editor_guest)
-- PIN hashes are SHA-256 of the PIN string
-- Sasha PIN = "1234"  → sha256("1234")
-- Herman PIN = "5678" → sha256("5678")
INSERT INTO user_roles (id, display_name, role, pin_hash) VALUES
  ('sasha',  'Sasha',  'admin',        '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'),
  ('herman', 'Herman', 'editor_guest', 'ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f')
ON CONFLICT (id) DO NOTHING;

-- ── activity tracking columns ─────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'last_updated_by'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN last_updated_by text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'last_updated_at'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN last_updated_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'editing_jobs_cache' AND column_name = 'last_action'
  ) THEN
    ALTER TABLE editing_jobs_cache ADD COLUMN last_action text;
  END IF;
END $$;
