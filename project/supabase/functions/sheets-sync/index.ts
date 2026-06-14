// Google Sheets sync for Sasha's Editing Pipeline.
//
// SHEET CONFIG:
//   Editing Pipeline sheet : GOOGLE_SHEET_ID secret (tab: GOOGLE_SHEET_NAME, gid: GOOGLE_SHEET_GID)
//   Accounting sheet       : GOOGLE_ACCOUNTING_SHEET_ID secret (tabs: Shoots, Direct, Price)
//
// SAFETY CONTRACT:
//   /read        — returns ALL rows with cell values, classified colors, AND raw hex colors
//   /write-sasha — writes ONLY columns U–AD (Sasha's columns); never touches A–T
//   /write-color — updates background color for EXACTLY ONE row (startRowIndex = row-1, endRowIndex = row)
//   /add-job     — writes a new photoshoot row into the first clean empty row
//   /test-write  — writes a single test row then immediately deletes it; returns debug info

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { JWT } from "npm:google-auth-library@9";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const encoder = new TextEncoder();

function jsonResp(data: unknown, status = 200) {
  const body = encoder.encode(JSON.stringify(data));
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Content-Length": String(body.byteLength) },
  });
}

function errResp(message: string, status = 500) {
  const body = encoder.encode(JSON.stringify({ error: message }));
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Content-Length": String(body.byteLength) },
  });
}

async function getSheetsToken(): Promise<string> {
  const credsJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!credsJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret not configured");
  const creds = JSON.parse(credsJson);
  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const token = await jwt.getAccessToken();
  if (!token.token) throw new Error("Failed to obtain Google access token");
  return token.token;
}

// ── SHEET CONFIG — single source of truth ─────────────────────────────────────
// Sasha's "Acounting" spreadsheet on Google Drive.
// These are the ONLY values used. The edge function ignores any stale secrets
// that may still point to old sheets.
const CANONICAL_SHEET_ID  = "1mTI1YYkENbYHEQ4xZiBa-Hc9H84W4YaZSnKhSmTz1n4";
const CANONICAL_TAB_NAME  = "Editing Pipline";   // exact name — note intentional typo in actual sheet
const CANONICAL_TAB_GID   = 531734729;

function getSheetId(): string {
  return CANONICAL_SHEET_ID;
}

function getTargetGid(): number {
  return CANONICAL_TAB_GID;
}

function getTargetTabName(): string {
  return CANONICAL_TAB_NAME;
}

// Sasha columns: U–AE (11 columns, start at col index 20)
const SASHA_COL_START = "U";
const SASHA_COL_END   = "AE";

const SASHA_HEADERS = [
  "Sasha Priority",     // U
  "Sasha Color",        // V
  "Sasha Comment",      // W
  "Sasha Request",      // X
  "Sasha Due Priority", // Y
  "Sasha Updated At",   // Z
  "Sasha Stage",        // AA
  "Last Updated By",    // AB
  "Last Updated At",    // AC
  "Last Action",        // AD
  "Editing Added At",   // AE — written once at job creation, never overwritten
];

interface SheetProperties { title?: string; sheetId?: number; }
interface SpreadsheetMeta { properties?: { title?: string }; sheets?: { properties?: SheetProperties }[] }

// Resolve tab name + GID from the spreadsheet metadata.
// Strategy:
//   1. Try matching by GID (from GOOGLE_SHEET_GID env, default 531734729)
//   2. If not found, fall back to matching by tab name (GOOGLE_SHEET_NAME env, default "Editing Pipeline")
// Always logs the spreadsheet title and all available tabs for debugging.
async function resolveSheetMeta(
  baseUrl: string,
  authHeader: Record<string, string>,
  sheetId: string
): Promise<{ name: string; gid: number }> {
  const res = await fetch(
    `${baseUrl}?fields=properties.title,sheets.properties`,
    { headers: authHeader }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch spreadsheet metadata: ${res.status} ${text}`);
  }
  const json = await res.json() as SpreadsheetMeta;
  const spreadsheetTitle = json.properties?.title ?? "(unknown)";
  const sheets = json.sheets ?? [];

  const targetGid     = getTargetGid();
  const targetTabName = getTargetTabName();
  const available     = sheets.map(s => `"${s.properties?.title}" (gid=${s.properties?.sheetId})`).join(", ");

  console.log(`[resolveSheetMeta] spreadsheetId=${sheetId} spreadsheetTitle="${spreadsheetTitle}"`);
  console.log(`[resolveSheetMeta] targetGid=${targetGid} targetTabName="${targetTabName}"`);
  console.log(`[resolveSheetMeta] available tabs: ${available}`);

  // 1. Match by GID
  let match = sheets.find(s => s.properties?.sheetId === targetGid);

  // 2. Fallback: match by tab name (case-insensitive)
  if (!match?.properties?.title) {
    match = sheets.find(
      s => s.properties?.title?.toLowerCase() === targetTabName.toLowerCase()
    );
    if (match) {
      console.log(`[resolveSheetMeta] GID ${targetGid} not found — matched by name "${match.properties?.title}" (gid=${match.properties?.sheetId})`);
    }
  }

  if (!match?.properties?.title || match.properties.sheetId == null) {
    throw new Error(
      `Tab not found in spreadsheet "${spreadsheetTitle}" (id=${sheetId}). ` +
      `Tried GID=${targetGid} and name="${targetTabName}". ` +
      `Available: ${available}`
    );
  }

  console.log(`[resolveSheetMeta] selected tab="${match.properties.title}" gid=${match.properties.sheetId} spreadsheet="${spreadsheetTitle}"`);
  return { name: match.properties.title, gid: match.properties.sheetId };
}

async function resolveSheetName(
  baseUrl: string,
  authHeader: Record<string, string>,
  sheetId: string
): Promise<string> {
  const { name } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
  return name;
}

async function ensureSashaHeaders(
  baseUrl: string,
  authHeader: Record<string, string>,
  sheetName: string
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/values/${encodeURIComponent(`${sheetName}!U1:AA1`)}`,
    { headers: authHeader }
  );
  if (!res.ok) return;
  const json = await res.json() as { values?: string[][] };
  const headers: string[] = (json.values?.[0] ?? []);
  if (headers[0] === "Sasha Priority") return;

  const range = `${sheetName}!${SASHA_COL_START}1:${SASHA_COL_END}1`;
  await fetch(
    `${baseUrl}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [SASHA_HEADERS] }),
    }
  );
  console.log(`[ensureSashaHeaders] wrote Sasha headers to ${range}`);
}

// Classify an RGB color into a named stage.
// Calibrated for Herman's actual pastel palette.
function classifyColor(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2 / 255;

  if (lightness > 0.965 && delta < 20) return "none";
  if (lightness < 0.10) return "none";
  if (delta < 12) return "none";

  const saturation = max === 0 ? 0 : delta / max;
  if (saturation < 0.07) return "none";

  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = hue * 60;
  if (hue < 0) hue += 360;

  console.log(`classifyColor rgb(${r},${g},${b}) #${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}: hue=${hue.toFixed(1)} sat=${saturation.toFixed(3)} light=${lightness.toFixed(3)}`);

  if (hue >= 220 && hue <= 310 && b >= r && b > g) return "purple";
  if (hue >= 170 && hue < 220 && b >= r && b >= g) return "blue";
  if (hue >= 75  && hue < 170) return "green";
  if (hue >= 30  && hue < 75 && r >= g && g > b) return "yellow";
  if (hue >= 15  && hue < 30) return "orange";
  if (hue < 15   || hue >= 330) return "red";

  return "none";
}

async function fetchRowColors(
  baseUrl: string,
  authHeader: Record<string, string>,
  sheetName: string,
  rowCount: number
): Promise<{ classified: string[]; raw: string[] }> {
  try {
    const range  = encodeURIComponent(`${sheetName}!A1:D${rowCount}`);
    const fields = encodeURIComponent("sheets.data.rowData.values.userEnteredFormat.backgroundColor");
    const res = await fetch(
      `${baseUrl}?ranges=${range}&fields=${fields}&includeGridData=true`,
      { headers: authHeader }
    );
    if (!res.ok) {
      console.warn("[sheets-sync] color fetch failed:", res.status, await res.text());
      return { classified: [], raw: [] };
    }

    const json = await res.json() as {
      sheets?: {
        data?: {
          rowData?: {
            values?: {
              userEnteredFormat?: {
                backgroundColor?: { red?: number; green?: number; blue?: number };
              };
            }[];
          }[];
        }[];
      }[];
    };

    const rowData = json.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const classified: string[] = [];
    const raw: string[] = [];

    for (let rowIdx = 0; rowIdx < rowData.length; rowIdx++) {
      const cells = rowData[rowIdx]?.values ?? [];
      let bestClassified = "none";
      let bestRaw = "";

      for (const cell of cells) {
        const bg = cell?.userEnteredFormat?.backgroundColor;
        if (!bg) continue;
        const rv = Math.round((bg.red   ?? 1) * 255);
        const gv = Math.round((bg.green ?? 1) * 255);
        const bv = Math.round((bg.blue  ?? 1) * 255);
        if (rv >= 245 && gv >= 245 && bv >= 245) continue;
        if (rv <= 10  && gv <= 10  && bv <= 10)  continue;

        const hex = `#${rv.toString(16).padStart(2,"0")}${gv.toString(16).padStart(2,"0")}${bv.toString(16).padStart(2,"0")}`;
        if (!bestRaw) bestRaw = hex;

        const c = classifyColor(rv, gv, bv);
        if (c !== "none") {
          if (rowIdx < 10) console.log(`[color] row ${rowIdx+1}: ${hex} → ${c}`);
          bestClassified = c;
          bestRaw = hex;
          break;
        }
      }

      classified.push(bestClassified);
      raw.push(bestRaw);
    }

    const dist: Record<string, number> = {};
    for (const c of classified.slice(1)) dist[c] = (dist[c] ?? 0) + 1;
    console.log("[sheets-sync] color distribution:", JSON.stringify(dist));

    return { classified, raw };
  } catch (e) {
    console.warn("[sheets-sync] color fetch exception:", e);
    return { classified: [], raw: [] };
  }
}

// ── Accounting sheet constants ─────────────────────────────────────────────────
const ACCT_TAB_HEADERS: Record<string, string[]> = {
  Shoots: ["ID","Date","Hotel","Client","Event Type","Package","Department","Source","HT","Tax","Final Amount","Status"],
  Direct: ["ID","Date","Client","Income","Amount"],
  Price:  ["ID","Hotel","Package","Department","HT"],
};

// Returns the accounting spreadsheet ID.
// Prefers GOOGLE_ACCOUNTING_SHEET_ID; falls back to GOOGLE_SHEET_ID.
// Hard-fails if neither is configured.
function getAcctSheetId(): string {
  const id = Deno.env.get("GOOGLE_ACCOUNTING_SHEET_ID") ?? Deno.env.get("GOOGLE_SHEET_ID");
  if (!id) throw new Error("Neither GOOGLE_ACCOUNTING_SHEET_ID nor GOOGLE_SHEET_ID is configured in Supabase Edge Function secrets");
  const src = Deno.env.get("GOOGLE_ACCOUNTING_SHEET_ID") ? "GOOGLE_ACCOUNTING_SHEET_ID" : "GOOGLE_SHEET_ID";
  console.log(`[Accounting Sync] sheetId=${id} (source: ${src})`);
  return id;
}

// Ensures row 1 of a tab has headers. Returns "written" or "already_present".
async function ensureTabHeaders(
  base: string,
  tab: string,
  headers: string[],
  auth: Record<string, string>,
): Promise<"written" | "already_present"> {
  const lastCol = String.fromCharCode(64 + headers.length);
  const range   = `${tab}!A1:${lastCol}1`;
  const chk = await fetch(`${base}/values/${encodeURIComponent(range)}`, { headers: auth });
  if (chk.ok) {
    const j = await chk.json() as { values?: string[][] };
    if ((j.values?.[0]?.[0] ?? "") === headers[0]) return "already_present";
  }
  const w = await fetch(
    `${base}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [headers] }),
    }
  );
  if (!w.ok) throw new Error(`Header write to ${tab} failed: HTTP ${w.status} ${await w.text()}`);
  return "written";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url    = new URL(req.url);
  const action = url.pathname.split("/").pop();

  try {
    const token   = await getSheetsToken();
    const sheetId = getSheetId();
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
    const authHeader = { Authorization: `Bearer ${token}` };

    console.log(`[sheets-sync] action=${action} sheetId=${sheetId} targetGid=${getTargetGid()}`);

    // ── GET /read ─────────────────────────────────────────────────────────────
    if (req.method === "GET" && action === "read") {
      const { name: sheetName, gid } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
      const readRange = `${sheetName}!A:AE`;
      console.log(`[read] tab="${sheetName}" gid=${gid} range=${readRange}`);

      const [valuesRes, colorResult] = await Promise.all([
        fetch(`${baseUrl}/values/${encodeURIComponent(readRange)}`, { headers: authHeader }),
        fetchRowColors(baseUrl, authHeader, sheetName, 1000),
      ]);

      if (!valuesRes.ok) {
        const text = await valuesRes.text();
        return errResp(`Sheets read error: ${valuesRes.status} ${text}`, valuesRes.status);
      }

      const valuesText = await valuesRes.text();
      let rawJson: { values?: unknown[][] };
      try {
        rawJson = JSON.parse(valuesText);
      } catch (parseErr) {
        console.error("[read] failed to parse Sheets API response:", parseErr);
        return errResp(`Failed to parse Sheets API response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`, 500);
      }

      function sanitizeCell(v: unknown): unknown {
        if (typeof v !== "string") return v;
        return v.replace(/[\x00-\x1F\x7F]/g, " ").trim();
      }

      const rows = (rawJson.values ?? []).map(row =>
        Array.isArray(row) ? row.map(sanitizeCell) : row
      );

      const rowColors    = rows.map((_, i) => colorResult.classified[i] ?? "none");
      const rowRawColors = rows.map((_, i) => colorResult.raw[i] ?? "");

      console.log(`[read] returning ${rows.length} rows tab="${sheetName}"`);
      return jsonResp({ rows, rowColors, rowRawColors, sheetName, sheetId, gid });
    }

    // ── POST /write-sasha ─────────────────────────────────────────────────────
    if (req.method === "POST" && action === "write-sasha") {
      const body = await req.json() as { sheetRow: number; values: string[] };

      if (!body.sheetRow || !Array.isArray(body.values) || body.values.length < 6) {
        return errResp("Invalid payload: need sheetRow and values (6–7 element array)", 400);
      }

      const { name: sheetName } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
      await ensureSashaHeaders(baseUrl, authHeader, sheetName);

      const values = [...body.values];
      while (values.length < 11) values.push("");

      // AE (index 10) = "Editing Added At" — preserve existing value if cell already has one.
      // Read the current AE cell first; only write if it is blank.
      const aeRange = `${sheetName}!AE${body.sheetRow}`;
      const aeReadRes = await fetch(`${baseUrl}/values/${encodeURIComponent(aeRange)}`, { headers: authHeader });
      if (aeReadRes.ok) {
        const aeJson = await aeReadRes.json() as { values?: unknown[][] };
        const existing = String(aeJson.values?.[0]?.[0] ?? "").trim();
        if (existing) {
          // Cell already has a value — keep it; don't overwrite with whatever the client sent
          values[10] = existing;
        }
        // If blank and client sent a non-empty value, values[10] already holds it
      }

      const range = `${sheetName}!${SASHA_COL_START}${body.sheetRow}:${SASHA_COL_END}${body.sheetRow}`;
      console.log(`[write-sasha] row=${body.sheetRow} range=${range} sheetId=${sheetId}`);

      const res = await fetch(
        `${baseUrl}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ range, majorDimension: "ROWS", values: [values] }),
        }
      );

      if (!res.ok) {
        const text = await res.text();
        return errResp(`Sheets write error: ${res.status} ${text}`, res.status);
      }

      const writeJson = await res.json();
      console.log(`[write-sasha] SUCCESS updatedRange=${writeJson.updatedRange}`);
      return jsonResp({ ok: true, updatedRange: writeJson.updatedRange, sheetId, gid: getTargetGid() });
    }

    // ── POST /write-color ─────────────────────────────────────────────────────
    // Updates background color for the EXACT job row(s) A–AD only.
    // Never colors empty rows or ranges beyond the specified rows.
    if (req.method === "POST" && action === "write-color") {
      const body = await req.json() as { sheetRow: number; blockEndRow?: number; stage: string };
      if (!body.sheetRow || !body.stage) {
        return errResp("Invalid payload: need sheetRow and stage", 400);
      }

      const startRow = body.sheetRow;
      // ALWAYS color exactly ONE row. blockEndRow is intentionally ignored for formatting.
      // Height MUST equal 1 — never spread color to rows below the target row.
      const endRow = startRow;

      const stageColors: Record<string, { red: number; green: number; blue: number }> = {
        not_started:       { red: 1,     green: 1,     blue: 1     },
        waiting_selection: { red: 1,     green: 0.898, blue: 0.6   },
        in_progress:       { red: 0.706, green: 0.655, blue: 0.839 },
        ready_to_send:     { red: 0.643, green: 0.761, blue: 0.957 },
        delivered:         { red: 0.714, green: 0.843, blue: 0.659 },
      };

      const bgColor = stageColors[body.stage] ?? { red: 1, green: 1, blue: 1 };
      const { gid }  = await resolveSheetMeta(baseUrl, authHeader, sheetId);

      // Debug: always log the exact row/range/height being colored.
      const rangeHeight = endRow - startRow + 1; // must always equal 1
      console.log(
        `[write-color] rowNumber=${startRow} rangeRowStart=${startRow} rangeHeight=${rangeHeight}` +
        ` rangeColumnCount=30 stage=${body.stage} gid=${gid}` +
        ` color=rgb(${bgColor.red},${bgColor.green},${bgColor.blue})`
      );
      if (rangeHeight !== 1) {
        console.error(`[write-color] BUG: rangeHeight=${rangeHeight} — should always be 1`);
      }

      // One repeatCell request per row. Each request covers EXACTLY that row (A–AD).
      // Column A = index 0, column AD = index 29. endColumnIndex is exclusive → 30.
      // startRowIndex and endRowIndex are 0-based; row N → startRow=N-1, endRow=N.
      const requests = [];
      for (let row = startRow; row <= endRow; row++) {
        const appliedRange = `A${row}:AD${row}`;
        console.log(`[write-color] applying color to row ${row} range ${appliedRange} stage=${body.stage}`);
        requests.push({
          repeatCell: {
            range: {
              sheetId:          gid,
              startRowIndex:    row - 1, // 0-based inclusive
              endRowIndex:      row,     // 0-based exclusive (covers only this one row)
              startColumnIndex: 0,       // column A (inclusive)
              endColumnIndex:   30,      // column AD index 29, exclusive end = 30
            },
            cell: { userEnteredFormat: { backgroundColor: bgColor } },
            fields: "userEnteredFormat.backgroundColor",
          },
        });
      }

      const batchBody = { requests };

      const res = await fetch(`${baseUrl}:batchUpdate`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify(batchBody),
      });

      if (!res.ok) {
        const text = await res.text();
        if (text.includes("PERMISSION_DENIED") || res.status === 403) {
          return errResp(
            `Permission denied updating row color. sheetId=${sheetId} gid=${gid}. ` +
            "Share the sheet with the service account and grant Editor role.",
            403
          );
        }
        return errResp(`Sheets batchUpdate error: ${res.status} ${text}`, res.status);
      }

      console.log(`[write-color] SUCCESS rows=${startRow}–${endRow} stage=${body.stage}`);
      return jsonResp({ ok: true, sheetRow: startRow, blockEndRow: endRow, stage: body.stage, sheetId, gid });
    }

    // ── POST /write-email ─────────────────────────────────────────────────────
    // Writes ONLY column G (Emails) for one row. Never touches any other column.
    if (req.method === "POST" && action === "write-email") {
      const body = await req.json() as { sheetRow?: number; emails?: string };
      if (!body.sheetRow || body.sheetRow < 2) return errResp("Invalid sheetRow: must be >= 2", 400);

      const { name: sheetName } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
      const cellRange = `${sheetName}!G${body.sheetRow}`;
      const emails = String(body.emails ?? "").trim();

      console.log(`[write-email] row=${body.sheetRow} range=${cellRange} emails="${emails.slice(0, 80)}"`);

      const writeRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ range: cellRange, majorDimension: "ROWS", values: [[emails]] }),
        }
      );
      if (!writeRes.ok) {
        const text = await writeRes.text();
        return errResp(`write-email failed: ${writeRes.status} ${text}`, writeRes.status);
      }
      console.log(`[write-email] SUCCESS row=${body.sheetRow}`);
      return jsonResp({ ok: true, sheetRow: body.sheetRow });
    }

    // ── POST /write-photos ────────────────────────────────────────────────────
    // Writes ONLY column Q (Photos to edit) for one row. Never touches any other column.
    if (req.method === "POST" && action === "write-photos") {
      const body = await req.json() as { sheetRow?: number; photosToEdit?: number | string | null };
      if (!body.sheetRow || body.sheetRow < 2) return errResp("Invalid sheetRow: must be >= 2", 400);

      const { name: sheetName } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
      const cellRange = `${sheetName}!Q${body.sheetRow}`;
      const value = body.photosToEdit != null && body.photosToEdit !== "" ? String(body.photosToEdit) : "";

      console.log(`[write-photos] row=${body.sheetRow} range=${cellRange} value="${value}"`);

      const writeRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ range: cellRange, majorDimension: "ROWS", values: [[value]] }),
        }
      );
      if (!writeRes.ok) {
        const text = await writeRes.text();
        return errResp(`write-photos failed: ${writeRes.status} ${text}`, writeRes.status);
      }
      console.log(`[write-photos] SUCCESS row=${body.sheetRow}`);
      return jsonResp({ ok: true, sheetRow: body.sheetRow });
    }

    // ── POST /setup-headers ───────────────────────────────────────────────────
    if (req.method === "POST" && action === "setup-headers") {
      const { name: sheetName, gid } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
      await ensureSashaHeaders(baseUrl, authHeader, sheetName);
      return jsonResp({ ok: true, sheetName, sheetId, gid });
    }

    // ── POST /test-write ──────────────────────────────────────────────────────
    // Writes a clearly-labelled test row to the first clean empty row, then
    // immediately clears it. Returns full debug info: sheetId, gid, tab name, row.
    if (req.method === "POST" && action === "test-write") {
      const { name: sheetName, gid } = await resolveSheetMeta(baseUrl, authHeader, sheetId);

      // Find the last populated row + first clean empty row (same logic as add-job)
      const dataRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(`${sheetName}!B:F`)}`,
        { headers: authHeader }
      );
      const dataJson = dataRes.ok
        ? await dataRes.json() as { values?: unknown[][] }
        : { values: [] as unknown[][] };
      const bfRows = dataJson.values ?? [];

      let lastFullRow = 1;
      for (let i = bfRows.length - 1; i >= 1; i--) {
        const r = bfRows[i] as unknown[];
        if (String(r[0] ?? "").trim() && String(r[1] ?? "").trim()) {
          lastFullRow = i + 1;
          break;
        }
      }

      let targetRow = lastFullRow + 1;
      for (let r = lastFullRow + 1; r <= lastFullRow + 20; r++) {
        const row = (bfRows[r - 1] as unknown[] | undefined) ?? [];
        const allEmpty = [0,1,2,3,4].every(c => !String(row[c] ?? "").trim());
        if (allEmpty) { targetRow = r; break; }
      }

      const now       = new Date().toISOString();
      const testRange = `${sheetName}!B${targetRow}:F${targetRow}`;
      const testVals  = [["TEST WRITE", "DO NOT SAVE", now, "auto-clear", "test"]];

      console.log(`[test-write] sheetId=${sheetId} gid=${gid} tab="${sheetName}" targetRow=${targetRow}`);

      const writeRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(testRange)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ range: testRange, majorDimension: "ROWS", values: testVals }),
        }
      );

      const writeText = await writeRes.text();
      if (!writeRes.ok) {
        return errResp(
          `Test write FAILED: ${writeRes.status} ${writeText.slice(0, 300)} | sheetId=${sheetId} gid=${gid} tab="${sheetName}" row=${targetRow}`,
          writeRes.status
        );
      }

      // Immediately clear the test row
      const clearRange = `${sheetName}!B${targetRow}:F${targetRow}`;
      await fetch(
        `${baseUrl}/values/${encodeURIComponent(clearRange)}:clear`,
        { method: "POST", headers: authHeader }
      ).catch(e => console.warn("[test-write] clear non-fatal:", e));

      console.log(`[test-write] SUCCESS — wrote and cleared row ${targetRow} on tab "${sheetName}"`);
      return jsonResp({
        ok:       true,
        sheetId,
        gid,
        tabName:  sheetName,
        row:      targetRow,
        message:  `Test write SUCCESS — wrote to row ${targetRow} on tab "${sheetName}" (sheetId: ${sheetId}, gid: ${gid}) then cleared.`,
      });
    }

    // ── POST /add-job ─────────────────────────────────────────────────────────
    if (req.method === "POST" && action === "add-job") {
      const body = await req.json() as {
        date?: string; galleryName?: string; resort?: string;
        photoPackage?: string; occasion?: string; notes?: string; actor?: string;
        editingAddedAt?: string;
      };

      console.log(`[add-job] START sheetId=${sheetId} body:`, JSON.stringify(body));

      if (!body.galleryName?.trim()) return errResp("galleryName is required", 400);
      if (!body.date?.trim())        return errResp("date is required", 400);

      const { name: sheetName, gid } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
      console.log(`[add-job] tab="${sheetName}" gid=${gid} sheetId=${sheetId}`);

      // ── 1. Read B and C columns to find the first empty row ─────────────────
      // Read B:C only — a row is "available" when BOTH B and C are empty.
      const bcRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(`${sheetName}!B:C`)}`,
        { headers: authHeader }
      );
      if (!bcRes.ok) {
        const t = await bcRes.text();
        return errResp(`Failed to read sheet B:C: ${bcRes.status} ${t.slice(0, 200)}`, bcRes.status);
      }
      const bcJson = await bcRes.json() as { values?: unknown[][] };
      // bcRows is 0-based; index 0 = sheet row 1 (header)
      const bcRows: unknown[][] = bcJson.values ?? [];
      console.log(`[add-job] B:C row count: ${bcRows.length}`);

      // Find last row that has data in B (date) AND C (gallery name)
      let lastDataRow = 1; // minimum = header row
      for (let i = bcRows.length - 1; i >= 1; i--) {
        const b = String(bcRows[i]?.[0] ?? "").trim();
        const c = String(bcRows[i]?.[1] ?? "").trim();
        if (b || c) {
          lastDataRow = i + 1; // convert 0-based index to 1-based sheet row
          console.log(`[add-job] last data row: ${lastDataRow} B="${b}" C="${c}"`);
          break;
        }
      }

      // Target row = first row after lastDataRow where both B and C are empty
      let targetRow = lastDataRow + 1;
      for (let r = lastDataRow + 1; r <= lastDataRow + 30; r++) {
        const idx = r - 1; // 0-based index
        const b = String(bcRows[idx]?.[0] ?? "").trim();
        const c = String(bcRows[idx]?.[1] ?? "").trim();
        if (!b && !c) {
          targetRow = r;
          console.log(`[add-job] first clean empty row: ${targetRow}`);
          break;
        }
        console.log(`[add-job] row ${r} not empty — B="${b}" C="${c}"`);
      }

      console.log(`[add-job] targetRow=${targetRow} lastDataRow=${lastDataRow} sheetId=${sheetId} tab="${sheetName}"`);

      // ── 2. Expand sheet if targetRow exceeds current grid size ───────────────
      const metaRes = await fetch(
        `${baseUrl}?fields=properties.title,sheets(properties(sheetId,title,gridProperties))`,
        { headers: authHeader }
      );
      if (metaRes.ok) {
        const metaJson = await metaRes.json() as {
          sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } } }[]
        };
        const targetSheet = metaJson.sheets?.find(s => s.properties?.title === sheetName);
        const currentRows = targetSheet?.properties?.gridProperties?.rowCount ?? 0;
        const sheetNumericId = targetSheet?.properties?.sheetId ?? gid;
        console.log(`[add-job] grid check: currentRows=${currentRows} targetRow=${targetRow} sheetNumericId=${sheetNumericId}`);
        if (currentRows > 0 && targetRow > currentRows) {
          const needed = targetRow - currentRows + 100;
          console.log(`[add-job] EXPANDING sheet: adding ${needed} rows (currentRows=${currentRows})`);
          const expandRes = await fetch(`${baseUrl}:batchUpdate`, {
            method: "POST",
            headers: { ...authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: [{ appendDimension: { sheetId: sheetNumericId, dimension: "ROWS", length: needed } }]
            }),
          });
          if (expandRes.ok) {
            console.log(`[add-job] EXPAND success — sheet now has at least ${currentRows + needed} rows`);
          } else {
            const expandText = await expandRes.text();
            console.warn(`[add-job] EXPAND failed (non-fatal): ${expandRes.status} ${expandText.slice(0, 200)}`);
          }
        } else {
          console.log(`[add-job] grid OK — no expansion needed`);
        }
      } else {
        console.warn(`[add-job] could not fetch sheet metadata: ${metaRes.status}`);
      }

      // ── 3. Write main row data B–G in a single call ──────────────────────────
      // B = Date, C = Gallery Name, D = Resort, E = Package, F = Occasion, G = Notes
      const pkgVal  = String(body.photoPackage ?? "").replace(/\s*photos?$/i, "").trim();
      const notes   = String(body.notes ?? "").trim();
      // Build values array for B:G (6 columns); always 6 values so the range is exact
      const rowValues = [
        String(body.date        ?? "").trim(),  // B
        String(body.galleryName ?? "").trim(),  // C
        String(body.resort      ?? "").trim(),  // D
        pkgVal,                                 // E
        String(body.occasion    ?? "").trim(),  // F
        notes,                                  // G
      ];

      const mainRange  = `${sheetName}!B${targetRow}:G${targetRow}`;
      console.log(`[add-job] WRITE range=${mainRange} values:`, JSON.stringify(rowValues));

      const mainWriteRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(mainRange)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ range: mainRange, majorDimension: "ROWS", values: [rowValues] }),
        }
      );
      const mainWriteText = await mainWriteRes.text();
      console.log(`[add-job] WRITE status=${mainWriteRes.status} response:`, mainWriteText.slice(0, 400));

      if (!mainWriteRes.ok) {
        if (mainWriteRes.status === 403 || mainWriteText.includes("PERMISSION_DENIED")) {
          return errResp(`Permission denied writing to "${sheetName}". sheetId=${sheetId} gid=${gid}. Check Editor access.`, 403);
        }
        return errResp(`Main data write failed: ${mainWriteRes.status} ${mainWriteText.slice(0, 300)}`, mainWriteRes.status);
      }

      // ── 4. Verify the write landed on B+C ───────────────────────────────────
      const verifyRange = `${sheetName}!B${targetRow}:C${targetRow}`;
      const verifyRes   = await fetch(`${baseUrl}/values/${encodeURIComponent(verifyRange)}`, { headers: authHeader });
      const verifyJson  = verifyRes.ok ? await verifyRes.json() as { values?: unknown[][] } : { values: [] as unknown[][] };
      const vr    = verifyJson.values?.[0] ?? [];
      const vDate = String(vr[0] ?? "").trim();
      const vGal  = String(vr[1] ?? "").trim();
      console.log(`[add-job] VERIFY row=${targetRow} B="${vDate}" C="${vGal}"`);

      if (!vDate && !vGal) {
        // Write landed somewhere else — the sheet may have merged cells pushing the write.
        // Fall back to one row down and try once more.
        const fallbackRow   = targetRow + 1;
        const fallbackRange = `${sheetName}!B${fallbackRow}:G${fallbackRow}`;
        console.warn(`[add-job] verify failed at row ${targetRow} — retrying at row ${fallbackRow}`);
        const fb = await fetch(
          `${baseUrl}/values/${encodeURIComponent(fallbackRange)}?valueInputOption=USER_ENTERED`,
          {
            method: "PUT",
            headers: { ...authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ range: fallbackRange, majorDimension: "ROWS", values: [rowValues] }),
          }
        );
        if (!fb.ok) {
          const fbText = await fb.text();
          return errResp(`Fallback write also failed: ${fb.status} ${fbText.slice(0, 200)}`, fb.status);
        }
        const vr2Res  = await fetch(`${baseUrl}/values/${encodeURIComponent(`${sheetName}!B${fallbackRow}:C${fallbackRow}`)}`, { headers: authHeader });
        const vr2Json = vr2Res.ok ? await vr2Res.json() as { values?: unknown[][] } : { values: [] as unknown[][] };
        const vr2     = vr2Json.values?.[0] ?? [];
        if (!String(vr2[0] ?? "").trim() && !String(vr2[1] ?? "").trim()) {
          return errResp(
            `Wrote B:G at rows ${targetRow} and ${fallbackRow} but both verify empty. ` +
            `sheetId=${sheetId} gid=${gid} tab="${sheetName}". Possible merged-cell block.`,
            500
          );
        }
        // fallback succeeded
        console.log(`[add-job] fallback VERIFY PASSED at row ${fallbackRow}`);
        const newRow = fallbackRow;
        const now2   = new Date().toISOString();
        const addedAt2 = String(body.editingAddedAt ?? now2);
        await fetch(
          `${baseUrl}/values/${encodeURIComponent(`${sheetName}!AB${newRow}:AE${newRow}`)}?valueInputOption=USER_ENTERED`,
          {
            method: "PUT", headers: { ...authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ range: `${sheetName}!AB${newRow}:AE${newRow}`, majorDimension: "ROWS",
              values: [[body.actor ?? "Sasha", now2, "added from calendar", addedAt2]] }),
          }
        ).catch(e => console.warn("[add-job] activity write non-fatal:", e));
        return jsonResp({ ok: true, sheetRow: newRow, blockEndRow: newRow, tabName: sheetName, sheetId, gid,
          galleryName: body.galleryName, date: body.date, resort: body.resort,
          debug: `Wrote row ${newRow} (fallback) on tab "${sheetName}".` });
      }

      // ── 5. Write activity audit (AB:AD) + Editing Added At (AE) ─────────────
      const now      = new Date().toISOString();
      const addedAt  = String(body.editingAddedAt ?? now);
      const actRange = `${sheetName}!AB${targetRow}:AE${targetRow}`;
      await fetch(
        `${baseUrl}/values/${encodeURIComponent(actRange)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({
            range: actRange, majorDimension: "ROWS",
            values: [[body.actor ?? "Sasha", now, "added from calendar", addedAt]],
          }),
        }
      ).catch(e => console.warn("[add-job] activity write non-fatal:", e));

      console.log(`[add-job] SUCCESS — row=${targetRow} gallery="${body.galleryName}" B:G written sheetId=${sheetId} gid=${gid} tab="${sheetName}"`);
      return jsonResp({
        ok:          true,
        sheetRow:    targetRow,
        blockEndRow: targetRow,
        tabName:     sheetName,
        sheetId,
        gid,
        galleryName: body.galleryName,
        date:        body.date,
        resort:      body.resort,
        debug:       `Wrote row ${targetRow} on tab "${sheetName}" (sheetId=${sheetId}, gid=${gid}). lastDataRow was ${lastDataRow}.`,
      });
    }

    // ── POST /write-herman-checkbox ───────────────────────────────────────────
    // Writes a single TRUE/FALSE checkbox cell in Herman's columns (A–T).
    // Body: { sheetRow: number, field: string, value: boolean }
    // `field` must match one of the known header names (case-insensitive).
    if (req.method === "POST" && action === "write-herman-checkbox") {
      const body = await req.json() as { sheetRow?: number; field?: string; value?: boolean };
      if (!body.sheetRow || body.sheetRow < 2) return errResp("Invalid sheetRow: must be >= 2", 400);
      if (!body.field) return errResp("field is required", 400);
      if (body.value === undefined) return errResp("value is required", 400);

      const { name: sheetName } = await resolveSheetMeta(baseUrl, authHeader, sheetId);

      // Read row 1 headers (A–T) to find the column index
      const headersRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(`${sheetName}!A1:T1`)}`,
        { headers: authHeader }
      );
      if (!headersRes.ok) return errResp(`Failed to read headers: ${headersRes.status}`, headersRes.status);
      const headersJson = await headersRes.json() as { values?: string[][] };
      const headers: string[] = headersJson.values?.[0] ?? [];

      const fieldLower = body.field.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      let colIndex = -1;
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (h === fieldLower || h.startsWith(fieldLower)) { colIndex = i; break; }
      }
      if (colIndex < 0) return errResp(`Column not found for field: "${body.field}"`, 400);

      // Convert 0-based index to A1 column letter (A=0, B=1, …, T=19)
      const colLetter = String.fromCharCode(65 + colIndex);
      const cellRange = `${sheetName}!${colLetter}${body.sheetRow}`;
      const cellValue = body.value ? "TRUE" : "FALSE";

      console.log(`[write-herman-checkbox] field="${body.field}" col=${colLetter}(${colIndex}) row=${body.sheetRow} value=${cellValue}`);

      const writeRes = await fetch(
        `${baseUrl}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ range: cellRange, majorDimension: "ROWS", values: [[cellValue]] }),
        }
      );
      if (!writeRes.ok) {
        const text = await writeRes.text();
        return errResp(`write-herman-checkbox failed: ${writeRes.status} ${text}`, writeRes.status);
      }
      return jsonResp({ ok: true, sheetRow: body.sheetRow, field: body.field, col: colLetter, value: body.value });
    }

    // ── POST /clear-row ───────────────────────────────────────────────────────
    // Physically deletes the entire row from the sheet using deleteDimension.
    // This removes the row structure entirely — no empty gaps remain.
    if (req.method === "POST" && action === "clear-row") {
      const body = await req.json() as { sheetRow?: number };
      if (!body.sheetRow || body.sheetRow < 2) return errResp("Invalid sheetRow: must be >= 2", 400);

      const { gid } = await resolveSheetMeta(baseUrl, authHeader, sheetId);
      const rowIndex = body.sheetRow - 1; // 0-based

      console.log(`[clear-row] deleting row ${body.sheetRow} (0-based index ${rowIndex}) gid=${gid}`);

      // deleteDimension removes the row entirely — rows below shift up, no empty gap.
      const deleteRes = await fetch(`${baseUrl}:batchUpdate`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            deleteDimension: {
              range: {
                sheetId:    gid,
                dimension:  "ROWS",
                startIndex: rowIndex,     // 0-based inclusive
                endIndex:   rowIndex + 1, // 0-based exclusive
              },
            },
          }],
        }),
      });

      if (!deleteRes.ok) {
        const text = await deleteRes.text();
        console.error(`[clear-row] delete failure row ${body.sheetRow}: HTTP ${deleteRes.status} ${text.slice(0, 200)}`);
        return errResp(`clear-row failed: ${deleteRes.status} ${text}`, deleteRes.status);
      }

      console.log(`[clear-row] delete success row ${body.sheetRow} (shifted up)`);
      return jsonResp({ ok: true, sheetRow: body.sheetRow });
    }

    // ── GET /sheets ───────────────────────────────────────────────────────────
    if (req.method === "GET" && action === "sheets") {
      const res = await fetch(`${baseUrl}?fields=sheets.properties`, { headers: authHeader });
      if (!res.ok) {
        const text = await res.text();
        return errResp(`Failed to fetch sheet list: ${res.status} ${text}`, res.status);
      }
      const sheetJson = await res.json() as { sheets?: { properties?: SheetProperties }[] };
      const sheets = sheetJson.sheets?.map(s => ({
        title: s.properties?.title ?? "",
        gid:   s.properties?.sheetId ?? 0,
      })) ?? [];
      return jsonResp({ sheets, sheetId });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCOUNTING SHEET HELPERS
    // All accounting endpoints use GOOGLE_ACCOUNTING_SHEET_ID exclusively.
    // They never fall back to CANONICAL_SHEET_ID (which is the Editing Pipeline).
    // ═══════════════════════════════════════════════════════════════════════════

    // ── POST /shoots-init ─────────────────────────────────────────────────────
    // Writes headers to Shoots, Direct, Price tabs. Creates tabs if missing.
    if (req.method === "POST" && action === "shoots-init") {
      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      console.log(`[Accounting Sync] shoots-init | sheetId=${sid}`);

      // Fetch tab list
      const metaRes = await fetch(`${base}?fields=sheets.properties`, { headers: authHeader });
      if (!metaRes.ok) {
        const t = await metaRes.text();
        const msg = metaRes.status === 403
          ? `Permission denied on spreadsheet ${sid}. Share the spreadsheet with the service account (Editor role).`
          : `Cannot access spreadsheet ${sid}: HTTP ${metaRes.status} — ${t}`;
        return errResp(msg, metaRes.status);
      }
      const meta = await metaRes.json() as { sheets?: { properties?: { title?: string } }[] };
      const existingTabs = new Set((meta.sheets ?? []).map(s => s.properties?.title ?? ""));
      console.log(`[shoots-init] tabs in spreadsheet: [${[...existingTabs].join(", ")}]`);

      const results: Record<string, string> = {};
      for (const [tab, headers] of Object.entries(ACCT_TAB_HEADERS)) {
        // Create tab if missing
        if (!existingTabs.has(tab)) {
          const cr = await fetch(`${base}:batchUpdate`, {
            method: "POST",
            headers: { ...authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
          });
          if (!cr.ok) {
            results[tab] = `create tab failed: HTTP ${cr.status} ${await cr.text()}`;
            console.error(`[shoots-init] ${results[tab]}`);
            continue;
          }
          existingTabs.add(tab);
          console.log(`[shoots-init] created tab: ${tab}`);
        }
        try {
          const outcome = await ensureTabHeaders(base, tab, headers, authHeader);
          results[tab] = outcome;
          console.log(`[shoots-init] ${tab}: ${outcome}`);
        } catch (e) {
          results[tab] = e instanceof Error ? e.message : String(e);
          console.error(`[shoots-init] ${tab}: ${results[tab]}`);
        }
      }
      return jsonResp({ ok: true, acctSheetId: sid, results });
    }

    // ── POST /shoots-write ────────────────────────────────────────────────────
    // Upserts one row in the Shoots tab by ID.
    // Updates existing row if ID found; appends after last non-empty row otherwise.
    if (req.method === "POST" && action === "shoots-write") {
      const shoot = await req.json() as {
        id: number; date: string; hotel: string; client: string;
        eventType: string; photoPackage: string; department: string; source: string;
        ht: number; tax: number; finalAmount: number; status: string;
        country?: string; originalSource?: string;
      };
      if (!shoot.id || !shoot.date || !shoot.client) {
        return errResp("Invalid payload: requires id, date, client", 400);
      }

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Shoots";
      console.log(`[Accounting Sync] tab Shoots | action write | sheetId=${sid} | payload: id=${shoot.id} client="${shoot.client}" date=${shoot.date}`);

      // Verify spreadsheet access and tab existence
      const metaRes = await fetch(`${base}?fields=sheets.properties`, { headers: authHeader });
      if (!metaRes.ok) {
        const t = await metaRes.text();
        const msg = metaRes.status === 403
          ? `Permission denied on spreadsheet ${sid}. Share with service account (Editor).`
          : `Cannot access spreadsheet ${sid}: HTTP ${metaRes.status} — ${t}`;
        return errResp(msg, metaRes.status);
      }
      const meta = await metaRes.json() as { sheets?: { properties?: { title?: string } }[] };
      const tabNames = (meta.sheets ?? []).map(s => s.properties?.title ?? "");
      console.log(`[shoots-write] tabs: [${tabNames.join(", ")}]`);

      if (!tabNames.includes(tab)) {
        // Create tab
        const cr = await fetch(`${base}:batchUpdate`, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
        });
        if (!cr.ok) return errResp(`Failed to create Shoots tab: HTTP ${cr.status} ${await cr.text()}`, cr.status);
        console.log(`[shoots-write] Shoots tab created`);
      } else {
        console.log(`[shoots-write] Shoots tab found`);
      }

      // Write headers if missing
      try {
        const h = await ensureTabHeaders(base, tab, ACCT_TAB_HEADERS.Shoots, authHeader);
        console.log(`[shoots-write] headers: ${h}`);
      } catch (e) {
        return errResp(e instanceof Error ? e.message : String(e), 500);
      }

      // Read column A to find existing ID or last row
      const colARes = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:A`)}`, { headers: authHeader });
      if (!colARes.ok) return errResp(`Cannot read Shoots column A: HTTP ${colARes.status} ${await colARes.text()}`, colARes.status);
      const colAJson = await colARes.json() as { values?: unknown[][] };
      const colA = colAJson.values ?? []; // colA[0] = header row

      // Find existing row by ID
      let targetRow = -1;
      for (let i = 1; i < colA.length; i++) {
        if (String(colA[i]?.[0] ?? "").trim() === String(shoot.id)) {
          targetRow = i + 1; // 1-based
          break;
        }
      }

      const isUpdate = targetRow > 0;
      if (!isUpdate) {
        // Find last non-empty row, append after it
        let lastNonEmpty = 1; // header
        for (let i = 1; i < colA.length; i++) {
          if (String(colA[i]?.[0] ?? "").trim() !== "") lastNonEmpty = i + 1;
        }
        targetRow = lastNonEmpty + 1;
        console.log(`Appending new row id=${shoot.id} at row ${targetRow}`);
      } else {
        console.log(`Updating existing row id=${shoot.id} at row ${targetRow}`);
      }

      const values = [
        String(shoot.id),
        String(shoot.date),
        String(shoot.hotel ?? ""),
        String(shoot.client ?? ""),
        String(shoot.eventType ?? ""),
        String(shoot.photoPackage ?? ""),
        String(shoot.department ?? ""),
        String(shoot.source ?? ""),
        String(shoot.ht ?? 0),
        String(shoot.tax ?? 0),
        String(shoot.finalAmount ?? 0),
        String(shoot.status ?? ""),
      ];
      const range = `${tab}!A${targetRow}:L${targetRow}`;
      console.log(isUpdate ? `Shoot updated row: ${targetRow} (id=${shoot.id})` : `Shoot saved row: ${targetRow} (id=${shoot.id})`);

      const wRes = await fetch(
        `${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
        {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ range, majorDimension: "ROWS", values: [values] }),
        }
      );
      if (!wRes.ok) {
        const t = await wRes.text();
        console.error(`[shoots-write] write failed: HTTP ${wRes.status} ${t}`);
        return errResp(`Shoots write failed: HTTP ${wRes.status} — ${t}`, wRes.status);
      }
      const wJson = await wRes.json() as { updatedRange?: string };
      console.log(`[Accounting Sync] tab Shoots | row written | id=${shoot.id} | sheetRow=${targetRow} | isUpdate=${isUpdate} | updatedRange=${wJson.updatedRange}`);
      return jsonResp({ ok: true, isUpdate, sheetRow: targetRow, updatedRange: wJson.updatedRange });
    }

    // ── GET /shoots-read ──────────────────────────────────────────────────────
    // Reads a row from Shoots by ID. Returns { ok, found, sheetRow, row }.
    if (req.method === "GET" && action === "shoots-read") {
      const id = url.searchParams.get("id");
      if (!id) return errResp("id query param required", 400);

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Shoots";

      const res = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:N`)}`, { headers: authHeader });
      if (!res.ok) {
        const t = await res.text();
        console.error(`Read back failed for id=${id}: HTTP ${res.status} ${t}`);
        return errResp(`Shoots read failed: HTTP ${res.status} — ${t}`, res.status);
      }
      const json = await res.json() as { values?: unknown[][] };
      const rows = json.values ?? [];
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i]?.[0] ?? "").trim() === String(id)) {
          console.log(`Read back success id=${id} sheetRow=${i + 1}`);
          return jsonResp({ ok: true, found: true, sheetRow: i + 1, row: rows[i] });
        }
      }
      console.log(`Read back failed — id=${id} not found in ${rows.length} rows`);
      return jsonResp({ ok: true, found: false });
    }

    // ── GET /shoots-raw ───────────────────────────────────────────────────────
    // Returns the raw cell values from Shoots!A:N with NO filtering or parsing.
    // Used as a recovery/debug fallback when /shoots-read-all returns 0 rows.
    if (req.method === "GET" && action === "shoots-raw") {
      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Shoots";
      console.log(`[RECOVERY] /shoots-raw | sheetId=${sid}`);
      const res = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:N`)}?valueRenderOption=UNFORMATTED_VALUE`, { headers: authHeader });
      if (!res.ok) {
        const t = await res.text();
        return errResp(`shoots-raw failed: HTTP ${res.status} — ${t}`, res.status);
      }
      const json = await res.json() as { values?: unknown[][] };
      const rawRows = json.values ?? [];
      console.log(`[RECOVERY] /shoots-raw | total rows including header: ${rawRows.length}`);
      return jsonResp({ ok: true, rawRows });
    }

    // ── GET /shoots-read-all ──────────────────────────────────────────────────
    // Column map: A(0)=ID B(1)=Date C(2)=Hotel D(3)=Client E(4)=EventType
    //             F(5)=Package G(6)=Department H(7)=Source I(8)=HT J(9)=Tax
    //             K(10)=FinalAmount L(11)=Status
    // Skip only: completely blank rows, status exactly "Deleted".
    if (req.method === "GET" && action === "shoots-read-all") {
      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Shoots";

      const res = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:L`)}?valueRenderOption=UNFORMATTED_VALUE`, { headers: authHeader });
      if (!res.ok) {
        const t = await res.text();
        return errResp(`Shoots read-all failed: HTTP ${res.status} — ${t}`, res.status);
      }
      const json = await res.json() as { values?: unknown[][] };
      const rows = json.values ?? [];
      console.log(`[shoots-read-all] raw rows (incl header): ${rows.length}`);
      console.log(`[shoots-read-all] header row: ${JSON.stringify(rows[0] ?? [])}`);

      // Accepts: plain number 47124, thousands-dot "47.124" (3 digits after last dot → integer),
      // or regular decimal "47.12".
      const parseNum = (v: unknown): number => {
        if (typeof v === "number") return v;
        const s = String(v ?? "").trim().replace(/\s/g, "");
        if (!s) return 0;
        const dotIdx = s.lastIndexOf(".");
        if (dotIdx !== -1 && s.length - dotIdx - 1 === 3 && !s.includes(",")) {
          const asInt = parseInt(s.replace(/\./g, ""), 10);
          if (!isNaN(asInt)) return asInt;
        }
        return parseFloat(s.replace(/,/g, ".")) || 0;
      };

      // Convert Google Sheets serial date (days since Dec 30, 1899) to YYYY-MM-DD.
      const serialToDate = (serial: number): string => {
        const ms = (serial - 25569) * 86400 * 1000;
        const d = new Date(ms);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, "0");
        const day = String(d.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      };

      const parseDate = (v: unknown): string => {
        if (typeof v === "number") return serialToDate(v);
        const s = String(v ?? "").trim();
        if (!s) return "";
        // Already YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        // "May 31, 2026" style
        const parsed = new Date(s);
        if (!isNaN(parsed.getTime())) {
          const y = parsed.getFullYear();
          const m = String(parsed.getMonth() + 1).padStart(2, "0");
          const day = String(parsed.getDate()).padStart(2, "0");
          return `${y}-${m}-${day}`;
        }
        return s;
      };

      const shoots = [];
      const rejected: { row: number; reason: string }[] = [];
      let skippedDeleted = 0;

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];

        // Skip completely blank rows
        if (!r.some(cell => String(cell ?? "").trim() !== "")) {
          rejected.push({ row: i + 1, reason: "blank" });
          continue;
        }

        // Skip duplicate header rows (col A = "id")
        if (String(r[0] ?? "").trim().toLowerCase() === "id") {
          rejected.push({ row: i + 1, reason: "duplicate header" });
          continue;
        }

        const status = String(r[11] ?? "").trim();
        if (status === "Deleted") { skippedDeleted++; continue; }

        const rawId = String(r[0] ?? "").trim();
        const id = rawId ? (Number(rawId) || i + 1) : i + 1;

        const shoot = {
          id,
          date:         parseDate(r[1]),
          hotel:        String(r[2]  ?? "").trim(),
          client:       String(r[3]  ?? "").trim(),
          eventType:    String(r[4]  ?? "").trim(),
          photoPackage: String(r[5]  ?? "").trim(),
          department:   String(r[6]  ?? "").trim(),
          source:       String(r[7]  ?? "").trim(),
          ht:           parseNum(r[8]),
          tax:          parseNum(r[9]),
          finalAmount:  parseNum(r[10]),
          status,
          sheetRow:     i + 1,
        };
        console.log("Parsed Shoot Row", JSON.stringify(shoot));
        shoots.push(shoot);
      }

      const totalRaw = rows.length - 1;
      console.log(`[shoots-read-all] raw=${totalRaw} parsed=${shoots.length} deleted=${skippedDeleted} rejected=${rejected.length}`);
      if (rejected.length > 0) console.log(`[shoots-read-all] rejected: ${JSON.stringify(rejected)}`);

      return jsonResp({ ok: true, shoots });
    }

    // ── POST /shoots-delete ───────────────────────────────────────────────────
    // Physically deletes a Shoots row using deleteDimension (row shifts up, no gap).
    // Match priority:
    //   1. Column A (ID) exact string match
    //   2. Fallback: date (B) + hotel (C) + client (D) + package (F)
    // Returns { ok, found, sheetRow, matchMethod }
    if (req.method === "POST" && action === "shoots-delete") {
      const body = await req.json() as {
        id: number | string;
        date?: string;
        hotel?: string;
        client?: string;
        photoPackage?: string;
      };
      if (!body.id) return errResp("id required", 400);

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Shoots";

      console.log("DELETE REQUEST", body);

      // Read columns A–F (A=ID, B=Date, C=Hotel, D=Client, E=EventType, F=Package)
      const res = await fetch(
        `${base}/values/${encodeURIComponent(`${tab}!A:F`)}?valueRenderOption=UNFORMATTED_VALUE`,
        { headers: authHeader }
      );
      if (!res.ok) {
        const t = await res.text();
        return errResp(`Shoots read failed: HTTP ${res.status} — ${t}`, res.status);
      }
      const json = await res.json() as { values?: unknown[][] };
      const rows = json.values ?? [];

      const idStr      = String(body.id).trim();
      const dateStr    = String(body.date         ?? "").trim().toLowerCase();
      const hotelStr   = String(body.hotel        ?? "").trim().toLowerCase();
      const clientStr  = String(body.client       ?? "").trim().toLowerCase();
      const pkgStr     = String(body.photoPackage ?? "").trim().toLowerCase();

      let targetRow = -1;
      let matchMethod = "";

      // Pass 1: exact column A (ID) match
      for (let i = 1; i < rows.length; i++) {
        const cellId = String(rows[i]?.[0] ?? "").trim();
        if (cellId !== "" && cellId === idStr) {
          targetRow = i + 1; // 1-based sheet row
          matchMethod = "id";
          console.log("MATCHED ROW", { method: "id", colA: cellId, sheetRow: targetRow });
          break;
        }
      }

      // Pass 2: fallback — date (B) + hotel (C) + client (D) + package (F)
      if (targetRow < 0 && (dateStr || hotelStr)) {
        for (let i = 1; i < rows.length; i++) {
          const rowDate   = String(rows[i]?.[1] ?? "").trim().toLowerCase();
          const rowHotel  = String(rows[i]?.[2] ?? "").trim().toLowerCase();
          const rowClient = String(rows[i]?.[3] ?? "").trim().toLowerCase();
          const rowPkg    = String(rows[i]?.[5] ?? "").trim().toLowerCase();
          const dateMatch   = !dateStr   || rowDate.includes(dateStr)   || dateStr.includes(rowDate);
          const hotelMatch  = !hotelStr  || rowHotel.includes(hotelStr) || hotelStr.includes(rowHotel);
          const clientMatch = !clientStr || rowClient.includes(clientStr) || clientStr.includes(rowClient);
          const pkgMatch    = !pkgStr    || rowPkg.includes(pkgStr)     || pkgStr.includes(rowPkg);
          if (dateMatch && hotelMatch && clientMatch && pkgMatch) {
            targetRow = i + 1;
            matchMethod = "fallback:date+hotel+client+package";
            console.log("MATCHED ROW", { method: matchMethod, sheetRow: targetRow, rowDate, rowHotel, rowClient, rowPkg });
            break;
          }
        }
      }

      if (targetRow < 0) {
        const result = { ok: false, found: false, error: "Shoot row not found in Google Sheet" };
        console.log("DELETE RESULT", result);
        return jsonResp(result);
      }

      // Resolve numeric sheetId for the Shoots tab
      const metaRes = await fetch(`${base}?fields=sheets.properties`, { headers: authHeader });
      if (!metaRes.ok) return errResp(`Cannot fetch sheet metadata: HTTP ${metaRes.status}`, metaRes.status);
      const metaJson = await metaRes.json() as { sheets?: { properties?: { title?: string; sheetId?: number } }[] };
      const shootsSheet = (metaJson.sheets ?? []).find(s => s.properties?.title === tab);
      if (!shootsSheet) return errResp(`Tab "${tab}" not found in spreadsheet`, 404);
      const tabGid = shootsSheet.properties?.sheetId ?? 0;

      // Physically delete the row — rows below shift up
      const rowIndex = targetRow - 1; // 0-based
      console.log(`[shoots-delete] deleteDimension row ${targetRow} (0-based ${rowIndex}) gid=${tabGid}`);

      const deleteRes = await fetch(`${base}:batchUpdate`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            deleteDimension: {
              range: {
                sheetId:    tabGid,
                dimension:  "ROWS",
                startIndex: rowIndex,
                endIndex:   rowIndex + 1,
              },
            },
          }],
        }),
      });

      if (!deleteRes.ok) {
        const text = await deleteRes.text();
        const result = { ok: false, found: true, error: `Shoots delete failed: HTTP ${deleteRes.status} — ${text.slice(0, 200)}` };
        console.log("DELETE RESULT", result);
        return errResp(result.error, deleteRes.status);
      }

      const result = { ok: true, found: true, sheetRow: targetRow, matchMethod };
      console.log("DELETE RESULT", result);
      return jsonResp(result);
    }


    // ── POST /direct-write ────────────────────────────────────────────────────
    // Appends a new row to the Direct tab.
    // Columns: A=ID  B=Date  C=Client  D=Income  E=Amount
    if (req.method === "POST" && action === "direct-write") {
      const body = await req.json() as { id: number; date: string; client: string; income: string; amount: number };
      if (!body.id || !body.date || !body.client) return errResp("Invalid payload: requires id, date, client", 400);

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Direct";
      console.log(`[direct-write] sheetId=${sid} | payload:`, JSON.stringify(body));

      // Ensure tab and headers exist
      const metaRes = await fetch(`${base}?fields=sheets.properties`, { headers: authHeader });
      if (!metaRes.ok) return errResp(`Cannot access spreadsheet: HTTP ${metaRes.status}`, metaRes.status);
      const meta = await metaRes.json() as { sheets?: { properties?: { title?: string } }[] };
      const tabNames = (meta.sheets ?? []).map(s => s.properties?.title ?? "");
      if (!tabNames.includes(tab)) {
        const cr = await fetch(`${base}:batchUpdate`, {
          method: "POST", headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
        });
        if (!cr.ok) return errResp(`Failed to create Direct tab: HTTP ${cr.status} ${await cr.text()}`, cr.status);
        console.log(`[direct-write] Direct tab created`);
      }
      try { await ensureTabHeaders(base, tab, ACCT_TAB_HEADERS.Direct, authHeader); } catch (e) {
        return errResp(e instanceof Error ? e.message : String(e), 500);
      }

      // Find last non-empty row in column A (ID), append after it
      const colARes = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:A`)}`, { headers: authHeader });
      if (!colARes.ok) return errResp(`Cannot read Direct column A: HTTP ${colARes.status}`, colARes.status);
      const colA = ((await colARes.json() as { values?: unknown[][] }).values) ?? [];
      let lastNonEmpty = 1;
      for (let i = 1; i < colA.length; i++) {
        if (String(colA[i]?.[0] ?? "").trim() !== "") lastNonEmpty = i + 1;
      }
      const targetRow = lastNonEmpty + 1;

      // A=ID  B=Date  C=Client  D=Income  E=Amount
      const values = [String(body.id), String(body.date), String(body.client), String(body.income ?? ""), String(body.amount ?? 0)];
      const range  = `${tab}!A${targetRow}:E${targetRow}`;
      console.log(`[direct-write] appending at row ${targetRow} range=${range} values=${JSON.stringify(values)}`);

      const wRes = await fetch(`${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: "PUT", headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ range, majorDimension: "ROWS", values: [values] }),
      });
      if (!wRes.ok) {
        const t = await wRes.text();
        console.error(`[direct-write] write failed: HTTP ${wRes.status} ${t.slice(0, 200)}`);
        return errResp(`Direct write failed: HTTP ${wRes.status} — ${t}`, wRes.status);
      }
      console.log(`[direct-write] row written | id=${body.id} | sheetRow=${targetRow}`);
      return jsonResp({ ok: true, sheetRow: targetRow });
    }

    // ── POST /direct-update ───────────────────────────────────────────────────
    // Overwrites an existing Direct row. Columns: A=ID  B=Date  C=Client  D=Income  E=Amount
    // Matches by ID in column A.
    if (req.method === "POST" && action === "direct-update") {
      const body = await req.json() as { id: number; date: string; client: string; income: string; amount: number };
      if (!body.id) return errResp("id required", 400);

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Direct";
      console.log(`[direct-update] sheetId=${sid} | id=${body.id} date=${body.date} client=${body.client}`);

      // Read A:E to find matching row by ID
      const allRes = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:E`)}`, { headers: authHeader });
      if (!allRes.ok) return errResp(`Cannot read Direct tab: HTTP ${allRes.status}`, allRes.status);
      const rows = ((await allRes.json() as { values?: unknown[][] }).values) ?? [];

      let targetRow = -1;
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i]?.[0] ?? "").trim() === String(body.id)) { targetRow = i + 1; break; }
      }
      if (targetRow < 0) {
        console.log(`[direct-update] id=${body.id} not found`);
        return errResp(`Direct row id=${body.id} not found`, 404);
      }

      // A=ID  B=Date  C=Client  D=Income  E=Amount
      const values = [String(body.id), String(body.date), String(body.client), String(body.income ?? ""), String(body.amount ?? 0)];
      const range  = `${tab}!A${targetRow}:E${targetRow}`;
      console.log(`[direct-update] overwriting row ${targetRow} values=${JSON.stringify(values)}`);

      const wRes = await fetch(`${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: "PUT", headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ range, majorDimension: "ROWS", values: [values] }),
      });
      if (!wRes.ok) {
        const t = await wRes.text();
        console.error(`[direct-update] write failed: HTTP ${wRes.status} ${t.slice(0, 200)}`);
        return errResp(`Direct update failed: HTTP ${wRes.status} — ${t}`, wRes.status);
      }
      console.log(`[direct-update] row updated | id=${body.id} | sheetRow=${targetRow}`);
      return jsonResp({ ok: true, sheetRow: targetRow });
    }

    // ── POST /direct-delete ───────────────────────────────────────────────────
    // Physically deletes a Direct row using deleteDimension (row shifts up, no gap).
    // Match priority:
    //   1. Column A (ID) exact string match
    //   2. Fallback: date (B) + client (C) + income (D) + amount (E)
    if (req.method === "POST" && action === "direct-delete") {
      const body = await req.json() as {
        id: number | string;
        date?: string;
        client?: string;
        income?: string;
        amount?: number | string;
      };
      if (!body.id) return errResp("id required", 400);

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Direct";
      console.log(`[direct-delete] id=${body.id}`, body);

      // Read columns A–E for matching
      const colRes = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:E`)}?valueRenderOption=UNFORMATTED_VALUE`, { headers: authHeader });
      if (!colRes.ok) return errResp(`Cannot read Direct columns: HTTP ${colRes.status}`, colRes.status);
      const rows = ((await colRes.json() as { values?: unknown[][] }).values) ?? [];

      const idStr     = String(body.id).trim();
      const dateStr   = String(body.date   ?? "").trim().toLowerCase();
      const clientStr = String(body.client ?? "").trim().toLowerCase();
      const incomeStr = String(body.income ?? "").trim().toLowerCase();
      const amtStr    = body.amount != null ? String(body.amount).trim() : "";

      let targetRow = -1;
      let matchMethod = "";

      // Pass 1: exact column A (ID) match
      for (let i = 1; i < rows.length; i++) {
        const cellId = String(rows[i]?.[0] ?? "").trim();
        if (cellId !== "" && cellId === idStr) {
          targetRow = i + 1;
          matchMethod = "id";
          console.log(`[direct-delete] MATCHED id row=${targetRow}`);
          break;
        }
      }

      // Pass 2: fallback — date (B) + client (C) + income (D)
      if (targetRow < 0 && (dateStr || clientStr)) {
        for (let i = 1; i < rows.length; i++) {
          const rowDate   = String(rows[i]?.[1] ?? "").trim().toLowerCase();
          const rowClient = String(rows[i]?.[2] ?? "").trim().toLowerCase();
          const rowIncome = String(rows[i]?.[3] ?? "").trim().toLowerCase();
          const rowAmt    = String(rows[i]?.[4] ?? "").trim();
          const dateMatch   = !dateStr   || rowDate.includes(dateStr)   || dateStr.includes(rowDate);
          const clientMatch = !clientStr || rowClient.includes(clientStr) || clientStr.includes(rowClient);
          const incomeMatch = !incomeStr || rowIncome.includes(incomeStr) || incomeStr.includes(rowIncome);
          const amtMatch    = !amtStr    || rowAmt === amtStr;
          if (dateMatch && clientMatch && incomeMatch && amtMatch) {
            targetRow = i + 1;
            matchMethod = "fallback:date+client+income+amount";
            console.log(`[direct-delete] MATCHED fallback row=${targetRow} rowDate=${rowDate} rowClient=${rowClient}`);
            break;
          }
        }
      }

      if (targetRow < 0) {
        console.log(`[direct-delete] id=${body.id} not found`);
        return jsonResp({ ok: false, found: false, error: "Direct row not found in Google Sheet" });
      }

      // Resolve numeric sheetId for the Direct tab
      const metaRes = await fetch(`${base}?fields=sheets.properties`, { headers: authHeader });
      if (!metaRes.ok) return errResp(`Cannot fetch sheet metadata: HTTP ${metaRes.status}`, metaRes.status);
      const metaJson = await metaRes.json() as { sheets?: { properties?: { title?: string; sheetId?: number } }[] };
      const directSheet = (metaJson.sheets ?? []).find(s => s.properties?.title === tab);
      if (!directSheet) return errResp(`Tab "${tab}" not found in spreadsheet`, 404);
      const tabGid = directSheet.properties?.sheetId ?? 0;

      // Physically delete the row — rows below shift up
      const rowIndex = targetRow - 1; // 0-based
      console.log(`[direct-delete] deleteDimension row ${targetRow} (0-based ${rowIndex}) gid=${tabGid} matchMethod=${matchMethod}`);

      const deleteRes = await fetch(`${base}:batchUpdate`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            deleteDimension: {
              range: {
                sheetId:    tabGid,
                dimension:  "ROWS",
                startIndex: rowIndex,
                endIndex:   rowIndex + 1,
              },
            },
          }],
        }),
      });

      if (!deleteRes.ok) {
        const text = await deleteRes.text();
        console.error(`[direct-delete] delete failed: HTTP ${deleteRes.status} ${text.slice(0, 200)}`);
        return errResp(`Direct delete failed: HTTP ${deleteRes.status} — ${text}`, deleteRes.status);
      }

      console.log(`[direct-delete] delete success | id=${body.id} | sheetRow=${targetRow}`);
      return jsonResp({ ok: true, found: true, sheetRow: targetRow });
    }

    // ── GET /direct-read-all ──────────────────────────────────────────────────
    // Returns all non-deleted rows from the Direct tab.
    // Column map: A(0)=ID  B(1)=Date  C(2)=Client  D(3)=Income  E(4)=Amount
    // Skip only: blank rows, duplicate header rows, income="Deleted".
    if (req.method === "GET" && action === "direct-read-all") {
      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Direct";

      const res = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:E`)}?valueRenderOption=UNFORMATTED_VALUE`, { headers: authHeader });
      if (!res.ok) {
        const t = await res.text();
        return errResp(`Direct read-all failed: HTTP ${res.status} — ${t}`, res.status);
      }
      const json = await res.json() as { values?: unknown[][] };
      const rows = json.values ?? [];
      console.log(`[direct-read-all] raw rows (incl header): ${rows.length}`);
      console.log(`[direct-read-all] header row: ${JSON.stringify(rows[0] ?? [])}`);

      const parseNum = (v: unknown): number => {
        if (typeof v === "number") return v;
        // Strip $, spaces, commas to handle: "$100.00", "1,155.00", "$1,155.00"
        return parseFloat(String(v ?? "0").replace(/[$\s]/g, "").replace(/,/g, "")) || 0;
      };

      const serialToDate = (serial: number): string => {
        const ms = (serial - 25569) * 86400 * 1000;
        const d = new Date(ms);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      };

      const MONTHS: Record<string, string> = {
        jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
        jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
      };

      const parseDate = (v: unknown): string => {
        if (typeof v === "number") return serialToDate(v);
        const s = String(v ?? "").trim();
        if (!s) return "";
        // YYYY-MM-DD already normalized
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        // "Jan 26, 2022" / "January 26 2022" / "Jan. 26, 2022" (Month Day Year)
        const mdy = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
        if (mdy) {
          const mm = MONTHS[mdy[1].toLowerCase().slice(0, 3)];
          if (mm) return `${mdy[3]}-${mm}-${String(mdy[2]).padStart(2, "0")}`;
        }
        // "26 Jan 2022" / "26 January 2022" (Day Month Year)
        const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
        if (dmy) {
          const mm = MONTHS[dmy[2].toLowerCase().slice(0, 3)];
          if (mm) return `${dmy[3]}-${mm}-${String(dmy[1]).padStart(2, "0")}`;
        }
        // D/M/YYYY or DD/MM/YYYY or M/D/YYYY — if first part > 12, treat as day
        const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (slashMatch) {
          const [, a, b, yyyy] = slashMatch.map(Number);
          const [mm, dd] = a > 12 ? [b, a] : [a, b];
          return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        }
        // Last resort: let V8 try (handles many locale-formatted strings)
        const parsed = new Date(s);
        if (!isNaN(parsed.getTime())) {
          return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
        }
        return s;
      };

      const direct = [];
      const rejected: { row: number; reason: string }[] = [];
      let skippedDeleted = 0;

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];

        // Skip completely blank rows
        if (!r.some(c => String(c ?? "").trim() !== "")) {
          rejected.push({ row: i + 1, reason: "blank" });
          continue;
        }

        // Skip duplicate header rows (col A = "id")
        if (String(r[0] ?? "").trim().toLowerCase() === "id") {
          rejected.push({ row: i + 1, reason: "duplicate header" });
          continue;
        }

        // A(0)=ID  B(1)=Date  C(2)=Client  D(3)=Income  E(4)=Amount
        const rawId  = String(r[0] ?? "").trim();
        const date   = parseDate(r[1]);
        const client = String(r[2] ?? "").trim();
        const income = String(r[3] ?? "").trim();
        const amount = parseNum(r[4]);

        // Skip soft-deleted rows
        if (income === "Deleted") { skippedDeleted++; continue; }

        const id = rawId ? (Number(rawId) || i + 1) : i + 1;

        const row = { id, date, client, income, amount, sheetRow: i + 1 };
        console.log("Parsed Direct Row", JSON.stringify(row));
        direct.push(row);
      }

      console.log(`[direct-read-all] raw=${rows.length - 1} parsed=${direct.length} deleted=${skippedDeleted} rejected=${rejected.length}`);
      if (rejected.length > 0) console.log(`[direct-read-all] rejected: ${JSON.stringify(rejected)}`);
      return jsonResp({ ok: true, direct });
    }

    // Full end-to-end test: init headers, write test row, read it back, delete it.
    // Returns a detailed result string safe to display on screen.
    if (req.method === "GET" && action === "acct-test") {
      const lines: string[] = [];
      try {
        const sid  = getAcctSheetId();
        const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
        lines.push(`Sheet ID in use: ${sid}`);

        // 1. Verify access
        const metaRes = await fetch(`${base}?fields=sheets.properties`, { headers: authHeader });
        if (!metaRes.ok) {
          const t = await metaRes.text();
          const msg = metaRes.status === 403
            ? `FAIL: Permission denied on ${sid}. Share with service account (Editor).`
            : `FAIL: Cannot access spreadsheet: HTTP ${metaRes.status} — ${t}`;
          lines.push(msg);
          return jsonResp({ ok: false, detail: lines.join("\n") });
        }
        const meta = await metaRes.json() as { sheets?: { properties?: { title?: string } }[] };
        const tabList = (meta.sheets ?? []).map(s => s.properties?.title ?? "");
        lines.push(`Tabs in spreadsheet: [${tabList.join(", ")}]`);

        // 2. Init headers on all three tabs
        for (const [tab, headers] of Object.entries(ACCT_TAB_HEADERS)) {
          if (!tabList.includes(tab)) {
            const cr = await fetch(`${base}:batchUpdate`, {
              method: "POST",
              headers: { ...authHeader, "Content-Type": "application/json" },
              body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
            });
            if (!cr.ok) { lines.push(`FAIL: create ${tab} tab: ${cr.status} ${await cr.text()}`); continue; }
            lines.push(`Created tab: ${tab}`);
          }
          try {
            const h = await ensureTabHeaders(base, tab, headers, authHeader);
            lines.push(`${tab} headers: ${h}`);
          } catch (e) { lines.push(`FAIL headers ${tab}: ${e instanceof Error ? e.message : String(e)}`); }
        }

        // 3. Write a test row to Shoots
        const testId = 9999999999;
        const testRow = [String(testId),"TEST-DATE","TEST-HOTEL","TEST-CLIENT","","","","","0","0","0","test","",""];
        const colARes = await fetch(`${base}/values/${encodeURIComponent("Shoots!A:A")}`, { headers: authHeader });
        const colA = colARes.ok ? ((await colARes.json() as { values?: unknown[][] }).values ?? []) : [];
        let testTargetRow = -1;
        for (let i = 1; i < colA.length; i++) {
          if (String(colA[i]?.[0] ?? "").trim() === String(testId)) { testTargetRow = i + 1; break; }
        }
        if (testTargetRow < 0) {
          let last = 1;
          for (let i = 1; i < colA.length; i++) { if (String(colA[i]?.[0] ?? "").trim() !== "") last = i + 1; }
          testTargetRow = last + 1;
        }
        const writeRange = `Shoots!A${testTargetRow}:N${testTargetRow}`;
        const wRes = await fetch(
          `${base}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`,
          { method: "PUT", headers: { ...authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ range: writeRange, majorDimension: "ROWS", values: [testRow] }) }
        );
        if (!wRes.ok) {
          lines.push(`FAIL write test row: HTTP ${wRes.status} ${await wRes.text()}`);
          return jsonResp({ ok: false, detail: lines.join("\n") });
        }
        lines.push(`Test row written to Shoots row ${testTargetRow}`);

        // 4. Read back the test row
        const readRes = await fetch(`${base}/values/${encodeURIComponent("Shoots!A:A")}`, { headers: authHeader });
        const readRows = readRes.ok ? ((await readRes.json() as { values?: unknown[][] }).values ?? []) : [];
        let found = false;
        for (let i = 1; i < readRows.length; i++) {
          if (String(readRows[i]?.[0] ?? "").trim() === String(testId)) { found = true; break; }
        }
        if (found) {
          lines.push(`Read back: SUCCESS — test row confirmed in Shoots`);
        } else {
          lines.push(`Read back: FAIL — test row not found after write`);
          return jsonResp({ ok: false, detail: lines.join("\n") });
        }

        // 5. Clean up: clear the test row
        const clearRange = `Shoots!A${testTargetRow}:N${testTargetRow}`;
        await fetch(
          `${base}/values/${encodeURIComponent(clearRange)}:clear`,
          { method: "POST", headers: { ...authHeader, "Content-Type": "application/json" } }
        );
        lines.push(`Test row cleaned up`);
        lines.push(`ALL TESTS PASSED`);
        return jsonResp({ ok: true, detail: lines.join("\n") });
      } catch (e) {
        lines.push(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
        return jsonResp({ ok: false, detail: lines.join("\n") });
      }
    }

    // ── GET /shoots-test (kept for backwards compat) ──────────────────────────
    if (req.method === "GET" && action === "shoots-test") {
      const sid  = Deno.env.get("GOOGLE_ACCOUNTING_SHEET_ID") ?? sheetId;
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const result: Record<string, unknown> = { sid, googleAccountingSheetIdSecretSet: !!Deno.env.get("GOOGLE_ACCOUNTING_SHEET_ID") };
      const mr = await fetch(`${base}?fields=sheets.properties`, { headers: authHeader });
      if (!mr.ok) return jsonResp({ ...result, error: `${mr.status} ${await mr.text()}` });
      const mj = await mr.json() as { sheets?: { properties?: { title?: string; sheetId?: number } }[] };
      result.tabs = (mj.sheets ?? []).map(s => ({ title: s.properties?.title, gid: s.properties?.sheetId }));
      for (const tab of ["Shoots","Direct","Price"]) {
        const r = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A1:N3`)}`, { headers: authHeader });
        result[`${tab}_rows`] = r.ok ? ((await r.json() as { values?: unknown[][] }).values ?? []) : `error ${r.status}`;
      }
      return jsonResp(result);
    }

    // ── GET /debug-read ───────────────────────────────────────────────────────
    // Returns raw rows + full parse trace for Shoots, Direct, Price tabs.
    // Shows exactly what the parser sees, what it accepts, and what it rejects.
    if (req.method === "GET" && action === "debug-read") {
      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      console.log(`[debug-read] sheetId=${sid}`);

      const debugTab = async (tab: string) => {
        const res = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:Z`)}?valueRenderOption=UNFORMATTED_VALUE`, { headers: authHeader });
        if (!res.ok) {
          const t = await res.text();
          return { tab, error: `HTTP ${res.status} — ${t}`, rawCount: 0, parsedCount: 0, rejectedCount: 0, headerRow: null, first3Raw: [], first3Parsed: [], rejected: [] };
        }
        const json = await res.json() as { values?: unknown[][] };
        const rows = json.values ?? [];
        const headerRow = rows[0] ?? null;
        const first3Raw = rows.slice(1, 4);
        const parsed: unknown[] = [];
        const rejected: { rowIndex: number; reason: string; raw: unknown[] }[] = [];

        for (let i = 1; i < rows.length; i++) {
          const r = rows[i] as unknown[];
          const id = String(r?.[0] ?? "").trim();
          if (!id) { rejected.push({ rowIndex: i + 1, reason: "empty column A (no ID)", raw: r.slice(0, 6) }); continue; }
          if (id.toLowerCase() === "id") { rejected.push({ rowIndex: i + 1, reason: "column A contains header text 'ID' (duplicate header row)", raw: r.slice(0, 6) }); continue; }

          if (tab === "Shoots") {
            const status = String(r?.[11] ?? "").trim();
            if (status === "Deleted") { rejected.push({ rowIndex: i + 1, reason: "status=Deleted (soft-deleted)", raw: r.slice(0, 14) }); continue; }
            const parseNum = (v: unknown) => typeof v === "number" ? v : (parseInt(String(v ?? "0").replace(/\D/g, ""), 10) || 0);
            parsed.push({ id: Number(id) || i, date: String(r?.[1] ?? ""), hotel: String(r?.[2] ?? ""), client: String(r?.[3] ?? ""), status, sheetRow: i + 1 });
          } else if (tab === "Direct") {
            const income = String(r?.[3] ?? "").trim();
            if (income === "Deleted") { rejected.push({ rowIndex: i + 1, reason: "income=Deleted (soft-deleted)", raw: r.slice(0, 5) }); continue; }
            const parseNum = (v: unknown) => typeof v === "number" ? v : (parseFloat(String(v ?? "0").replace(/[^\d.]/g, "")) || 0);
            parsed.push({ id: Number(id) || i, date: String(r?.[1] ?? ""), client: String(r?.[2] ?? ""), income, amount: parseNum(r?.[4]), sheetRow: i + 1 });
          } else if (tab === "Price") {
            parsed.push({ id: Number(id) || i, hotel: String(r?.[1] ?? ""), photoPackage: String(r?.[2] ?? ""), department: String(r?.[3] ?? ""), ht: String(r?.[4] ?? ""), sheetRow: i + 1 });
          }
        }

        console.log(`[debug-read] tab=${tab} rawRows=${rows.length - 1} parsed=${parsed.length} rejected=${rejected.length}`);
        return {
          tab,
          rawCount: rows.length - 1,
          parsedCount: parsed.length,
          rejectedCount: rejected.length,
          headerRow,
          first3Raw,
          first3Parsed: parsed.slice(0, 3),
          rejected: rejected.slice(0, 10),
        };
      };

      const [shoots, direct, price] = await Promise.all([
        debugTab("Shoots"),
        debugTab("Direct"),
        debugTab("Price"),
      ]);

      return jsonResp({ ok: true, sheetId: sid, shoots, direct, price });
    }

    // ── GET /prices-read ──────────────────────────────────────────────────────
    // Returns all rows from the Price tab as structured pricing objects.
    // Column structure: A=ID  B=Hotel  C=Package  D=Department  E=HT
    // Supports merged hotel cells: carries forward last-seen hotel when cell is blank.
    // NEVER writes to the sheet.
    if (req.method === "GET" && action === "prices-read") {
      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Price";

      const res = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:E`)}?valueRenderOption=UNFORMATTED_VALUE`, { headers: authHeader });
      if (!res.ok) {
        const t = await res.text();
        return errResp(`Price tab read failed: HTTP ${res.status} — ${t}`, res.status);
      }
      const json = await res.json() as { values?: unknown[][] };
      const rows = json.values ?? [];
      console.log(`[prices-read] raw row count (including header): ${rows.length}`);

      if (rows.length === 0) {
        console.warn("[prices-read] sheet returned 0 rows — tab may be empty or missing");
        return jsonResp({ ok: true, prices: [], warning: "Price tab appears empty" });
      }

      // Log header row for diagnostics
      console.log(`[prices-read] header row: ${JSON.stringify(rows[0])}`);

      const prices = [];
      const rejected: { row: number; reason: string; raw: unknown[] }[] = [];

      // HT parser: treats dot as thousands separator (47.124 → 47124, 109.513 → 109513)
      // Raw numbers from UNFORMATTED_VALUE are kept as-is.
      const parseHt = (v: unknown): number => {
        if (typeof v === "number") return v;
        const s = String(v ?? "").trim();
        if (!s || s === "0") return 0;
        // If string has a dot and no comma, treat dot as thousands separator
        // e.g. "47.124" → strip dots → 47124
        // e.g. "109.513" → strip dots → 109513
        // But "1500.50" with a decimal should NOT be stripped — detect by checking
        // if the part after the last dot has exactly 3 digits (thousands sep pattern)
        const dotIdx = s.lastIndexOf(".");
        if (dotIdx !== -1 && s.length - dotIdx - 1 === 3 && !s.includes(",")) {
          // Treat all dots as thousands separators
          return parseInt(s.replace(/\./g, ""), 10) || 0;
        }
        return parseFloat(s.replace(/,/g, ".")) || 0;
      };

      let lastHotel = "";

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];

        // Columns: A=0(id), B=1(hotel), C=2(pkg), D=3(dept), E=4(ht)
        const rawId   = String(r?.[0] ?? "").trim();
        const rawHotel = String(r?.[1] ?? "").trim();
        const pkg      = String(r?.[2] ?? "").trim();
        const dept     = String(r?.[3] ?? "").trim();
        const rawHt    = r?.[4];

        // Skip duplicate header rows
        if (rawId.toLowerCase() === "id" || rawHotel.toLowerCase() === "hotel") {
          rejected.push({ row: i + 1, reason: "duplicate header row", raw: Array.from(r).slice(0, 5) });
          continue;
        }

        // Carry forward hotel for merged cells (API returns blank for non-first merged cells)
        const hotel = rawHotel || lastHotel;
        if (rawHotel) lastHotel = rawHotel;

        // Accept row if hotel + package + department present; HT can be 0
        if (!hotel || !pkg || !dept) {
          rejected.push({ row: i + 1, reason: `missing required field(s): hotel="${hotel}" pkg="${pkg}" dept="${dept}"`, raw: Array.from(r).slice(0, 5) });
          continue;
        }

        const ht  = parseHt(rawHt);
        const id  = rawId || String(i + 1);

        prices.push({ id, hotel, photoPackage: pkg, department: dept, ht, sheetRow: i + 1 });
      }

      console.log(`[prices-read] parsed=${prices.length} rejected=${rejected.length}`);
      if (rejected.length > 0) console.log(`[prices-read] rejected rows: ${JSON.stringify(rejected)}`);
      if (prices.length > 0) console.log(`[prices-read] first 5: ${JSON.stringify(prices.slice(0, 5))}`);

      return jsonResp({ ok: true, prices, debug: { rawCount: rows.length - 1, parsedCount: prices.length, rejectedCount: rejected.length } });
    }

    // ── POST /prices-write ────────────────────────────────────────────────────
    // Upserts one price row. Matches on hotel+photoPackage+department.
    // Updates existing row if composite key found; appends otherwise.
    if (req.method === "POST" && action === "prices-write") {
      const body = await req.json() as {
        id: number | string; hotel: string; photoPackage: string; department: string; ht: number;
      };
      if (!body.hotel || !body.photoPackage || !body.department) {
        return errResp("Invalid payload: requires hotel, photoPackage, department, ht", 400);
      }

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Price";

      await ensureTabHeaders(base, tab, ACCT_TAB_HEADERS.Price, authHeader).catch(() => {});

      // Read existing rows to find duplicate
      const readRes = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:E`)}`, { headers: authHeader });
      if (!readRes.ok) {
        const t = await readRes.text();
        return errResp(`Price tab read failed: HTTP ${readRes.status} — ${t}`, readRes.status);
      }
      const readJson = await readRes.json() as { values?: unknown[][] };
      const allRows = readJson.values ?? [];

      // Match by hotel + photoPackage + department (case-insensitive)
      const keyOf = (h: string, p: string, d: string) =>
        `${h.toLowerCase()}|${p.toLowerCase()}|${d.toLowerCase()}`;
      const targetKey = keyOf(body.hotel, body.photoPackage, body.department);

      let targetRow = -1;
      for (let i = 1; i < allRows.length; i++) {
        const r = allRows[i] as unknown[];
        const k = keyOf(String(r[1]??''), String(r[2]??''), String(r[3]??''));
        if (k === targetKey) { targetRow = i + 1; break; }
      }

      const isUpdate = targetRow > 0;
      if (!isUpdate) {
        // Append after last non-empty row
        let lastNonEmpty = 1;
        for (let i = 1; i < allRows.length; i++) {
          if (String(allRows[i]?.[0] ?? '').trim() !== '' ||
              String(allRows[i]?.[1] ?? '').trim() !== '') {
            lastNonEmpty = i + 1;
          }
        }
        targetRow = lastNonEmpty + 1;
      }

      const rowId = isUpdate
        ? String((allRows[targetRow - 1] as unknown[])?.[0] ?? body.id ?? targetRow)
        : String(body.id ?? targetRow);

      const values = [rowId, body.hotel, body.photoPackage, body.department, body.ht];
      const range  = `${tab}!A${targetRow}:E${targetRow}`;
      console.log(`[prices-write] ${isUpdate ? "updating row" : "adding row"} at ${range}: ${body.hotel} | ${body.photoPackage} | ${body.department} | ht=${body.ht}`);

      const putRes = await fetch(
        `${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
        {
          method:  "PUT",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body:    JSON.stringify({ range, majorDimension: "ROWS", values: [values] }),
        }
      );
      if (!putRes.ok) {
        const t = await putRes.text();
        return errResp(`Price write failed: HTTP ${putRes.status} — ${t}`, putRes.status);
      }
      console.log(`[prices-write] ${isUpdate ? "updated" : "added"} price row at ${range}`);
      return jsonResp({ ok: true, isUpdate, sheetRow: targetRow });
    }

    // ── POST /prices-delete ───────────────────────────────────────────────────
    // Clears a price row by matching hotel+photoPackage+department.
    if (req.method === "POST" && action === "prices-delete") {
      const body = await req.json() as { hotel: string; photoPackage: string; department: string };
      if (!body.hotel || !body.photoPackage) {
        return errResp("Invalid payload: requires hotel, photoPackage, department", 400);
      }

      const sid  = getAcctSheetId();
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
      const tab  = "Price";

      const readRes = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A:E`)}`, { headers: authHeader });
      if (!readRes.ok) {
        const t = await readRes.text();
        return errResp(`Price tab read failed: HTTP ${readRes.status} — ${t}`, readRes.status);
      }
      const readJson = await readRes.json() as { values?: unknown[][] };
      const allRows = readJson.values ?? [];

      const keyOf = (h: string, p: string, d: string) =>
        `${h.toLowerCase()}|${p.toLowerCase()}|${d.toLowerCase()}`;
      const targetKey = keyOf(body.hotel, body.photoPackage, body.department);

      let targetRow = -1;
      for (let i = 1; i < allRows.length; i++) {
        const r = allRows[i] as unknown[];
        const k = keyOf(String(r[1]??''), String(r[2]??''), String(r[3]??''));
        if (k === targetKey) { targetRow = i + 1; break; }
      }

      if (targetRow < 0) {
        console.log(`[prices-delete] row not found for key="${targetKey}"`);
        return jsonResp({ ok: true, found: false });
      }

      const clearRange = `${tab}!A${targetRow}:E${targetRow}`;
      const clearRes = await fetch(
        `${base}/values/${encodeURIComponent(clearRange)}:clear`,
        { method: "POST", headers: { ...authHeader, "Content-Type": "application/json" } }
      );
      if (!clearRes.ok) {
        const t = await clearRes.text();
        return errResp(`Price delete failed: HTTP ${clearRes.status} — ${t}`, clearRes.status);
      }
      console.log(`[prices-delete] cleared row ${targetRow} for key="${targetKey}"`);
      return jsonResp({ ok: true, found: true, sheetRow: targetRow });
    }

    return errResp(`Unknown action: ${action}`, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sheets-sync] UNHANDLED ERROR action=${action}:`, message);
    return errResp(message, 500);
  }
});

