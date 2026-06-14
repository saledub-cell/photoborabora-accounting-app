/*
  # Update GOOGLE_SHEET_NAME to correct tab name

  The actual tab name in Sasha's "Acounting" spreadsheet is "Editing Pipline"
  (with the typo — missing the second 'e' in Pipeline).

  Edge function secret GOOGLE_SHEET_NAME must be set to: Editing Pipline
  Edge function secret GOOGLE_SHEET_ID must be set to: 1mTI1YYkENbYHEQ4xZiBa-Hc9H84W4YaZSnKhSmTz1n4
  Edge function secret GOOGLE_SHEET_GID must be set to: 531734729

  The edge function resolveSheetMeta() looks up tab by GID first,
  then falls back to exact tab name match (case-insensitive).

  This migration is a no-op marker — secrets are managed via Supabase Edge Function secrets.
*/
SELECT 1;
