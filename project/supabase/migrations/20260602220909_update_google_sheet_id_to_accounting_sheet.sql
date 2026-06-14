/*
  # Update GOOGLE_SHEET_ID to correct accounting sheet

  Sets GOOGLE_SHEET_ID edge function secret to the correct accounting
  Google Sheet: 1mTI1YYkENbYHEQ4xZiBa-Hc9H84W4YaZSnKhSmTz1n4

  This replaces the previously set German workflow sheet ID.
*/

DO $$
BEGIN
  -- Update GOOGLE_SHEET_ID secret if it exists
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'GOOGLE_SHEET_ID') THEN
    UPDATE vault.secrets
    SET secret = '1mTI1YYkENbYHEQ4xZiBa-Hc9H84W4YaZSnKhSmTz1n4'
    WHERE name = 'GOOGLE_SHEET_ID';
  ELSE
    -- Insert if not present (should already exist but guard just in case)
    PERFORM vault.create_secret(
      '1mTI1YYkENbYHEQ4xZiBa-Hc9H84W4YaZSnKhSmTz1n4',
      'GOOGLE_SHEET_ID'
    );
  END IF;

  -- Also update GOOGLE_ACCOUNTING_SHEET_ID to the same value as a backup
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'GOOGLE_ACCOUNTING_SHEET_ID') THEN
    UPDATE vault.secrets
    SET secret = '1mTI1YYkENbYHEQ4xZiBa-Hc9H84W4YaZSnKhSmTz1n4'
    WHERE name = 'GOOGLE_ACCOUNTING_SHEET_ID';
  END IF;
END $$;
