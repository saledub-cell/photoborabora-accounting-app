/*
  # Add allowed_tabs to user_roles

  ## Summary
  Adds a `allowed_tabs` column to `user_roles` so each user's accessible tabs
  are stored in the database and can be managed from Admin Settings.

  ## Changes
  - New column `allowed_tabs` (text[]) on `user_roles` — array of tab names the user can access
  - Default for admin: all tabs
  - Default for editor_guest: Calendar + Editing only
  - Backfills existing rows based on current role
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_roles' AND column_name = 'allowed_tabs'
  ) THEN
    ALTER TABLE user_roles ADD COLUMN allowed_tabs text[] DEFAULT '{}';
  END IF;
END $$;

-- Backfill: admin gets all tabs
UPDATE user_roles
SET allowed_tabs = ARRAY['Dashboard','Shoots','Direct','Invoices','Prices','Calendar','Editing']
WHERE role = 'admin' AND (allowed_tabs IS NULL OR allowed_tabs = '{}');

-- Backfill: editor_guest gets Calendar + Editing
UPDATE user_roles
SET allowed_tabs = ARRAY['Calendar','Editing']
WHERE role = 'editor_guest' AND (allowed_tabs IS NULL OR allowed_tabs = '{}');

-- Add accent_color column for per-user avatar accent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_roles' AND column_name = 'accent_color'
  ) THEN
    ALTER TABLE user_roles ADD COLUMN accent_color text DEFAULT '#c2a96e';
  END IF;
END $$;

UPDATE user_roles SET accent_color = '#c2a96e' WHERE id = 'sasha' AND (accent_color IS NULL OR accent_color = '#c2a96e');
UPDATE user_roles SET accent_color = '#7aabb8' WHERE id = 'herman' AND (accent_color IS NULL OR accent_color = '#7aabb8');
