/*
# Fix unrestricted anon write policies

## Problem
Five tables had INSERT, UPDATE, and DELETE policies granted to the `anon` role with
USING (true) / WITH CHECK (true), meaning ANY unauthenticated visitor could freely
write, modify, or delete production data — shoots records, invoices, pricing, income.

## Changes
For each of the 5 affected tables:
  - DROP the 3 anon write policies (INSERT, UPDATE, DELETE)
  - CREATE equivalent policies restricted to `authenticated` role only

## What stays the same
  - SELECT (read) policies for `anon` are intentionally left in place — the app
    loads data before the login screen, and reads are not a security risk.
  - The service-role key used by edge functions (sheets-sync) bypasses RLS entirely,
    so sync operations are completely unaffected.

## Affected tables
  1. public.shoots
  2. public.direct_income
  3. public.pricing
  4. public.saved_invoices
  5. public.invoice_sequences

## Security outcome
Only signed-in users can create, modify, or delete records.
Unauthenticated (anon) access is now read-only on all five tables.
*/

-- ─── shoots ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anon can insert shoots" ON public.shoots;
DROP POLICY IF EXISTS "Anon can update shoots" ON public.shoots;
DROP POLICY IF EXISTS "Anon can delete shoots" ON public.shoots;

CREATE POLICY "Authenticated can insert shoots"
ON public.shoots FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated can update shoots"
ON public.shoots FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated can delete shoots"
ON public.shoots FOR DELETE
TO authenticated
USING (true);

-- ─── direct_income ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anon can insert direct_income" ON public.direct_income;
DROP POLICY IF EXISTS "Anon can update direct_income" ON public.direct_income;
DROP POLICY IF EXISTS "Anon can delete direct_income" ON public.direct_income;

CREATE POLICY "Authenticated can insert direct_income"
ON public.direct_income FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated can update direct_income"
ON public.direct_income FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated can delete direct_income"
ON public.direct_income FOR DELETE
TO authenticated
USING (true);

-- ─── pricing ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anon can insert pricing" ON public.pricing;
DROP POLICY IF EXISTS "Anon can update pricing" ON public.pricing;
DROP POLICY IF EXISTS "Anon can delete pricing" ON public.pricing;

CREATE POLICY "Authenticated can insert pricing"
ON public.pricing FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated can update pricing"
ON public.pricing FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated can delete pricing"
ON public.pricing FOR DELETE
TO authenticated
USING (true);

-- ─── saved_invoices ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anon can insert saved_invoices" ON public.saved_invoices;
DROP POLICY IF EXISTS "Anon can update saved_invoices" ON public.saved_invoices;
DROP POLICY IF EXISTS "Anon can delete saved_invoices" ON public.saved_invoices;

CREATE POLICY "Authenticated can insert saved_invoices"
ON public.saved_invoices FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated can update saved_invoices"
ON public.saved_invoices FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated can delete saved_invoices"
ON public.saved_invoices FOR DELETE
TO authenticated
USING (true);

-- ─── invoice_sequences ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anon can insert invoice_sequences" ON public.invoice_sequences;
DROP POLICY IF EXISTS "Anon can update invoice_sequences" ON public.invoice_sequences;
DROP POLICY IF EXISTS "Anon can delete invoice_sequences" ON public.invoice_sequences;

CREATE POLICY "Authenticated can insert invoice_sequences"
ON public.invoice_sequences FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated can update invoice_sequences"
ON public.invoice_sequences FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated can delete invoice_sequences"
ON public.invoice_sequences FOR DELETE
TO authenticated
USING (true);
