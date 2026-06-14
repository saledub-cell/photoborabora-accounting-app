// Google Sheets sync for the Editing Pipeline.
//
// SAFETY CONTRACT:
//   READ  — calls /sheets-sync/read  (edge function reads columns A–T via service account)
//   WRITE — calls /sheets-sync/write-sasha (edge function writes ONLY columns O–T)
//           Herman's workflow data (A–N) is NEVER modified.
//
// All sheet access goes through the Supabase edge function, which holds the
// GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID secrets server-side.
// No OAuth token or Sheet ID is needed in the browser.

import { createClient } from "@supabase/supabase-js";

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
);

function edgeUrl(path: string): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sheets-sync${path}`;
}

function edgeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };
}

// ─── Data shapes ──────────────────────────────────────────────────────────────

export interface HermanData {
  rowId: string;
  galleryName: string;
  resort: string;
  date: string;
  package: string;
  status: string;
  emails: string;        // column G (index 6) — fixed position, always emails
  // Actual row background color from Herman's Google Sheet
  // Classified as: "none"|"yellow"|"red"|"purple"|"blue"|"green"|"orange"
  sheetColor: string;
  // Raw hex color from the sheet (e.g. "#b4a7d6") — used for debug display
  sheetColorRaw: string;
  // Workflow checkboxes (Herman's columns — read-only)
  saved: boolean;
  selectedAndPreedited: boolean;
  imported: boolean;
  beginSelectionMailSent: boolean;
  selectionReceived: boolean;
  edited: boolean;
  editionUploaded: boolean;
  delivered: boolean;
  // Other fields
  photosToEdit: number | null;
  remarks: string;
  lastUpdated: string;
  occasion: string;
}

export type SashaPriority    = "urgent" | "important" | "normal" | "ready" | "";
export type SashaColor       = "orange" | "blue" | "green" | "gray";
export type SashaRequest     = "urgent" | "edit_first" | "wait" | "client_asked" | "vip" | "send_today" | "";
export type SashaStage       = CardGroup | "";
export type SashaReviewStatus = "waiting_german" | "waiting_sasha" | "reviewed" | "";
export type SashaActionReason = "new_comment" | "photos_added" | "" ;

export interface SashaData {
  priority:      SashaPriority;
  color:         SashaColor;
  comment:       string;
  request:       SashaRequest;
  duePriority:   string;
  updatedAt:     string;
  stage:         SashaStage;
  reviewStatus:  SashaReviewStatus;
  actionReason:  SashaActionReason;
  syncStatus:    "synced" | "pending" | "failed" | "";
  movedToReadyAt?:  string;
  editingAddedAt?:  string;
  deliveredDate?:   string;
  lastUpdated?:     string;
  revisionCount?:   number;
  statusHistory?:   { stage: SashaStage; at: string; by: string }[];
}

export const DEFAULT_SASHA: SashaData = {
  priority: "", color: "gray", comment: "", request: "", duePriority: "", updatedAt: "",
  stage: "", reviewStatus: "", actionReason: "", syncStatus: "", movedToReadyAt: "", editingAddedAt: "",
};

export interface ActivityInfo {
  lastUpdatedBy: string; // "Sasha" | "Herman"
  lastUpdatedAt: string; // ISO timestamp
  lastAction:    string; // e.g. "moved to Delivered", "added comment"
}

export interface SheetJob {
  id:          string;
  sheetRow:    number;
  blockEndRow: number; // last sheet row belonging to this job block (>= sheetRow)
  rowKey:      string;
  herman:      HermanData;
  sasha:       SashaData;
  activity:    ActivityInfo;
}

export const DEFAULT_ACTIVITY: ActivityInfo = {
  lastUpdatedBy: "",
  lastUpdatedAt: "",
  lastAction:    "",
};

// ─── Card groups ──────────────────────────────────────────────────────────────
// Colors mirror Herman's Google Sheet row background colors EXACTLY.
// The edge function returns the classified color name for each row.
//
//   none/white → Not Started
//   yellow     → Waiting for Selection
//   purple     → In Progress / Editing
//   blue       → Ready to Send
//   green      → Delivered

export type CardGroup =
  | "not_started"
  | "waiting_selection"
  | "in_progress"
  | "ready_to_send"
  | "delivered";

export interface CardGroupDef {
  id:          CardGroup;
  label:       string;
  // Display color — matches Herman's actual sheet row color
  sheetColor:  string;
  bgColor:     string;
  statusLabel: string;
}

export const CARD_GROUPS: CardGroupDef[] = [
  {
    id:          "not_started",
    label:       "Not Started",
    sheetColor:  "#9ca3af",
    bgColor:     "#f9fafb",
    statusLabel: "Not started",
  },
  {
    id:          "waiting_selection",
    label:       "Waiting for Selection",
    sheetColor:  "#d97706",
    bgColor:     "#fffbeb",
    statusLabel: "Waiting for selection",
  },
  {
    id:          "in_progress",
    label:       "In Progress / Editing",
    sheetColor:  "#7c3aed",
    bgColor:     "#faf5ff",
    statusLabel: "Editing",
  },
  {
    id:          "ready_to_send",
    label:       "Ready to Send",
    sheetColor:  "#2563eb",
    bgColor:     "#eff6ff",
    statusLabel: "Ready to send",
  },
  {
    id:          "delivered",
    label:       "Delivered",
    sheetColor:  "#16a34a",
    bgColor:     "#f0fdf4",
    statusLabel: "Delivered",
  },
];

// Map the classified sheet color name → CardGroup.
// ONLY sheet color determines stage. No checkbox fallback.
const SHEET_COLOR_TO_GROUP: Record<string, CardGroup> = {
  yellow: "waiting_selection",
  purple: "in_progress",
  blue:   "ready_to_send",
  green:  "delivered",
  // red/orange/any other color → not_started (no red column)
};

// Stage priority: Sasha override → sheet background color → not_started.
// Checkboxes are NEVER used to determine stage — only sheet color matters.
export function groupForJob(job: SheetJob): CardGroup {
  if (!job) return "not_started";

  // 1. Sasha's explicit stage override (writes only to Sasha columns)
  const stage = job.sasha?.stage;
  if (stage) {
    const valid: CardGroup[] = ["not_started","waiting_selection","in_progress","ready_to_send","delivered"];
    if (valid.includes(stage as CardGroup)) return stage as CardGroup;
  }

  // 2. Herman's actual row background color from Google Sheets — sole source of truth
  const color = job.herman?.sheetColor;
  if (color && color !== "none" && color !== "") {
    return SHEET_COLOR_TO_GROUP[color] ?? "not_started";
  }

  return "not_started";
}

// ─── Priority color map ───────────────────────────────────────────────────────

export const COLOR_MAP: Record<SashaColor, { bg: string; border: string; dot: string; label: string }> = {
  orange: { bg: "#fff7ed", border: "#fed7aa", dot: "#f97316", label: "Important" },
  blue:   { bg: "#eff6ff", border: "#bfdbfe", dot: "#3b82f6", label: "Normal" },
  green:  { bg: "#f0fdf4", border: "#bbf7d0", dot: "#22c55e", label: "Ready" },
  gray:   { bg: "#f9fafb", border: "#e5e7eb", dot: "#9ca3af", label: "No priority" },
};

// ─── Sync state ───────────────────────────────────────────────────────────────

export type SyncStatus = "idle" | "syncing" | "ok" | "offline" | "error";

export interface SyncState {
  status:     SyncStatus;
  lastSynced: Date | null;
  error:      string | null;
  fromCache:  boolean;
  rowCount:   number;
  sheetId?:   string;
  sheetName?: string;
  gid?:       number;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toUpperCase();
    if (s === "" || s === "FALSE" || s === "NO" || s === "0") return false;
    if (s === "TRUE" || s === "YES" || s === "1" || s === "✓" || s === "X" || s === "✔") return true;
    // Treat any non-empty string as truthy (Herman uses dates like "26/2" in checkbox columns)
    return s.length > 0;
  }
  return false;
}

// Returns string value; returns "" for null/undefined and for boolean strings
// that leaked from Google Sheets checkbox columns (TRUE/FALSE).
function str(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  const up = s.toUpperCase();
  if (up === "TRUE" || up === "FALSE") return "";
  return s;
}



function normalizeKey(galleryName: string, date: string, resort: string): string {
  return [galleryName, date, resort].map(s => s.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
}

// ─── Header index ─────────────────────────────────────────────────────────────
// Stores both the original lowercase header AND a "slug" version (letters/digits
// only, spaces collapsed) so "Selected & Preedited" → "selected preedited".

type ColIndex = Record<string, number>;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function buildColIndex(headers: unknown[]): ColIndex {
  const idx: ColIndex = {};
  headers.forEach((h, i) => {
    if (h == null || h === "") return;
    const raw  = String(h).trim();
    const low  = raw.toLowerCase();
    const slug = slugify(raw);
    idx[low]  = i;
    if (slug !== low) idx[slug] = i;
  });
  console.log("[sheetsSync] detected headers:", Object.entries(idx).map(([k, v]) => `${v}:"${k}"`).join(", "));
  return idx;
}

function colOf(idx: ColIndex, ...names: string[]): number {
  for (const n of names) {
    const low  = n.toLowerCase();
    const slug = slugify(n);
    // Exact match first
    if (idx[low]  !== undefined) return idx[low];
    if (idx[slug] !== undefined) return idx[slug];
  }
  // Prefix match as fallback (only used when no exact match found for ANY name)
  for (const n of names) {
    const low = n.toLowerCase();
    for (const [key, col] of Object.entries(idx)) {
      if (key.startsWith(low) && key.length <= low.length + 3) return col;
    }
  }
  return -1;
}

// ─── Row → SheetJob ───────────────────────────────────────────────────────────

function parseRow(
  row: unknown[],
  colIdx: ColIndex,
  rowNum: number,
  blockEndRow: number,
  sheetColor: string,
  sheetColorRaw: string,
  existingSasha?: SashaData,
  existingActivity?: ActivityInfo,
  cacheDirty?: boolean
): SheetJob | null {
  try {
    const safeRow = Array.isArray(row) ? row : [];
    const g = (i: number) => (i >= 0 && i < safeRow.length ? safeRow[i] : undefined);

    const clientCol    = colOf(colIdx, "gallery name", "client name", "client", "gallery", "name");
    const resortCol    = colOf(colIdx, "resort", "hotel", "venue");
    const dateCol      = colOf(colIdx, "date", "shoot date", "booking date");
    const pkgCol       = colOf(colIdx, "package", "photo package", "photos package");
    const statusCol    = colOf(colIdx, "status");
    const emailsCol    = 6; // Column G (0-based) — fixed position, always emails
    const savedCol     = colOf(colIdx, "saved");
    const selPreCol    = colOf(colIdx, "selected preedited", "selected and preedited", "selected & preedited", "preedited");
    const importedCol  = colOf(colIdx, "imported");
    const beginSelCol  = colOf(colIdx, "begin selection mail sent", "begin selection", "selection mail");
    const selCol       = colOf(colIdx, "selection received");
    const editCol      = colOf(colIdx, "edited");
    const uploadCol    = colOf(colIdx, "uploaded", "edition uploaded", "back up", "backup");
    const delivCol     = colOf(colIdx, "delivered", "sent to client", "delivery");
    const photosCol    = colOf(colIdx, "photos to edit", "photos to", "nb photos", "number of photos");
    const remCol       = colOf(colIdx, "remarks", "notes", "note");
    const updCol       = colOf(colIdx, "last updated", "updated");
    const occCol       = colOf(colIdx, "ocasion", "occasion", "event type", "event");
    // U = column index 20 (0-based). If the header row is missing or mis-named,
    // fall back to the absolute position so Sasha columns still parse correctly.
    const sashaStartFromHeader = colOf(colIdx, "sasha priority");
    const sashaStart = sashaStartFromHeader >= 0 ? sashaStartFromHeader : 20;

    const galleryName = str(g(clientCol));
    const resort      = str(g(resortCol));
    const date        = str(g(dateCol));

    // Always use row number as the stable unique ID to avoid collisions
    // when col0 is empty or repeated across rows.
    const rowId = `sheet-row-${rowNum}`;

    const safeColor    = (typeof sheetColor    === "string" && sheetColor)    ? sheetColor    : "none";
    const safeColorRaw = (typeof sheetColorRaw === "string" && sheetColorRaw) ? sheetColorRaw : "";

    const herman: HermanData = {
      rowId,
      galleryName,
      resort,
      date,
      package:                str(g(pkgCol)),
      status:                 str(g(statusCol)),
      emails:                 str(g(emailsCol)),
      sheetColor:             safeColor,
      sheetColorRaw:          safeColorRaw,
      saved:                  parseBool(g(savedCol)),
      selectedAndPreedited:   parseBool(g(selPreCol)),
      imported:               parseBool(g(importedCol)),
      beginSelectionMailSent: parseBool(g(beginSelCol)),
      selectionReceived:      parseBool(g(selCol)),
      edited:                 parseBool(g(editCol)),
      editionUploaded:        parseBool(g(uploadCol)),
      delivered:              parseBool(g(delivCol)),
      photosToEdit:           g(photosCol) != null && g(photosCol) !== "" ? Number(g(photosCol)) || null : null,
      remarks:                str(g(remCol)),
      lastUpdated:            str(g(updCol)),
      occasion:               str(g(occCol)),
    };

    const fromSheet: Partial<SashaData> = {};
    if (sashaStart >= 0) {
      fromSheet.priority    = (str(g(sashaStart))     || "") as SashaPriority;
      fromSheet.color       = (str(g(sashaStart + 1)) || "gray") as SashaColor;
      fromSheet.comment     =  str(g(sashaStart + 2));
      fromSheet.request     = (str(g(sashaStart + 3)) || "") as SashaRequest;
      fromSheet.duePriority =  str(g(sashaStart + 4));
      fromSheet.updatedAt   =  str(g(sashaStart + 5));
      fromSheet.stage       = (str(g(sashaStart + 6)) || "") as SashaStage;
      // column AE (sashaStart + 10) — "Editing Added At" — written once at job creation
      fromSheet.editingAddedAt = str(g(sashaStart + 10)) || "";
    }

    // When cacheDirty=true the user has a pending write not yet confirmed by the sheet —
    // keep the local cache values so they aren't overwritten by a stale sheet read.
    // When cacheDirty=false (or undefined) the sheet is the source of truth; use sheet
    // values for fields the sheet actually has, and cache only for app-only fields.
    const useCache = cacheDirty === true && existingSasha != null;

    const sasha: SashaData = {
      priority:     useCache ? (existingSasha!.priority    || fromSheet.priority    || DEFAULT_SASHA.priority)    : (fromSheet.priority    || existingSasha?.priority    || DEFAULT_SASHA.priority)    as SashaPriority,
      color:        useCache ? (existingSasha!.color       || fromSheet.color       || DEFAULT_SASHA.color)       : (fromSheet.color       || existingSasha?.color       || DEFAULT_SASHA.color)       as SashaColor,
      comment:      useCache ? (existingSasha!.comment     !== undefined ? existingSasha!.comment : (fromSheet.comment     ?? DEFAULT_SASHA.comment))    : (fromSheet.comment     ?? existingSasha?.comment     ?? DEFAULT_SASHA.comment),
      request:      useCache ? (existingSasha!.request     || fromSheet.request     || DEFAULT_SASHA.request)     : (fromSheet.request     || existingSasha?.request     || DEFAULT_SASHA.request)     as SashaRequest,
      duePriority:  useCache ? (existingSasha!.duePriority !== undefined ? existingSasha!.duePriority : (fromSheet.duePriority ?? DEFAULT_SASHA.duePriority)) : (fromSheet.duePriority ?? existingSasha?.duePriority ?? DEFAULT_SASHA.duePriority),
      updatedAt:    useCache ? (existingSasha!.updatedAt   || fromSheet.updatedAt   || DEFAULT_SASHA.updatedAt)   : (fromSheet.updatedAt   || existingSasha?.updatedAt   || DEFAULT_SASHA.updatedAt),
      stage:        useCache ? (existingSasha!.stage       || fromSheet.stage       || DEFAULT_SASHA.stage)       : (fromSheet.stage       || existingSasha?.stage       || DEFAULT_SASHA.stage)       as SashaStage,
      reviewStatus: (existingSasha?.reviewStatus ?? "") as SashaReviewStatus,
      actionReason:  (existingSasha?.actionReason  ?? "") as SashaActionReason,
      syncStatus:   cacheDirty ? "pending" : "synced",
      editingAddedAt: fromSheet.editingAddedAt || existingSasha?.editingAddedAt || "",
    };

    return {
      id:          rowId,
      sheetRow:    rowNum,
      blockEndRow: blockEndRow,
      rowKey:      normalizeKey(galleryName, date, resort),
      herman,
      sasha,
      activity:    existingActivity ?? DEFAULT_ACTIVITY,
    };
  } catch (err) {
    console.error(`[sheetsSync] parseRow failed for row ${rowNum}:`, err);
    return null;
  }
}

// ─── READ: fetch all rows via edge function ───────────────────────────────────

export async function fetchSheetJobs(): Promise<{ jobs: SheetJob[]; fromCache: boolean; sheetId?: string; sheetName?: string; gid?: number }> {
  console.log("[SYNC_START] fetchSheetJobs — reading from sheet and Supabase cache");

  // Load Sasha cache for merging
  const { data: cacheRows } = await supabase.from("editing_jobs_cache").select("*");
  const sashaByKey    = new Map<string, SashaData>();
  const sashaById     = new Map<string, SashaData>();
  const dirtyIds      = new Set<string>();
  const dirtyKeys     = new Set<string>();
  const activityById  = new Map<string, ActivityInfo>();
  const activityByKey = new Map<string, ActivityInfo>();
  for (const row of cacheRows ?? []) {
    const s: SashaData = {
      priority:      row.sasha_priority as SashaPriority,
      color:         row.sasha_color    as SashaColor,
      comment:       str(row.sasha_comment ?? ""),
      request:       row.sasha_request  as SashaRequest,
      duePriority:   row.sasha_due_priority ?? "",
      updatedAt:     row.sasha_updated_at   ?? "",
      stage:         (row.sasha_stage    ?? "") as SashaStage,
      reviewStatus:  (row.review_status  ?? "") as SashaReviewStatus,
      actionReason:  (row.action_reason  ?? "") as SashaActionReason,
      syncStatus:    row.dirty ? "pending" : "synced",
      editingAddedAt: row.editing_added_at ? new Date(row.editing_added_at as string).toISOString() : "",
    };
    sashaByKey.set(row.row_key, s);
    sashaById.set(row.id, s);
    if (row.dirty) {
      dirtyIds.add(row.id);
      dirtyKeys.add(row.row_key);
    }
    if (row.last_updated_by || row.last_updated_at || row.last_action) {
      const a: ActivityInfo = {
        lastUpdatedBy: row.last_updated_by ?? "",
        lastUpdatedAt: row.last_updated_at ?? "",
        lastAction:    row.last_action     ?? "",
      };
      activityById.set(row.id, a);
      activityByKey.set(row.row_key, a);
    }
  }

  let rows: unknown[][];
  let rowColors: string[]    = [];
  let rowRawColors: string[] = [];
  let sheetIdFromServer:   string | undefined;
  let sheetNameFromServer: string | undefined;
  let gidFromServer:       number | undefined;
  try {
    const res = await fetch(edgeUrl("/read"), { headers: edgeHeaders() });
    console.log("[sheetsSync] edge /read status:", res.status);

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = body.error ?? `HTTP ${res.status}`;
      console.error("[SYNC_ERROR] edge /read error:", msg);
      return loadFromCache(sashaById, sashaByKey);
    }

    const json = await res.json() as { rows?: unknown[][]; rowColors?: string[]; rowRawColors?: string[]; sheetId?: string; sheetName?: string; gid?: number };
    rows         = json.rows         ?? [];
    rowColors    = json.rowColors    ?? [];
    rowRawColors = json.rowRawColors ?? [];
    sheetIdFromServer   = json.sheetId;
    sheetNameFromServer = json.sheetName;
    gidFromServer       = json.gid;
    console.log("[sheetsSync] edge /read returned", rows.length, "rows");

  } catch (err) {
    console.error("[SYNC_ERROR] edge /read network error:", err);
    return loadFromCache(sashaById, sashaByKey);
  }

  if (rows.length === 0) {
    console.warn("[sheetsSync] Sheet returned 0 rows — showing empty board");
    return { jobs: [], fromCache: false };
  }

  const colIdx   = buildColIndex(rows[0]);
  const dataRows = rows.slice(1);

  if (dataRows.length === 0) {
    console.warn("[sheetsSync] Sheet has header but no data rows");
    return { jobs: [], fromCache: false };
  }

  // ── Detect job block boundaries ──────────────────────────────────────────────
  // A job may span multiple consecutive sheet rows (e.g. main row + email/notes row).
  // Rules for "belongs to same block":
  //   - The main row has a non-empty gallery name.
  //   - The immediately following row(s) belong to the same block if ALL of:
  //       (a) their gallery name is empty OR matches the main row's gallery name
  //       (b) their date is empty (continuation row, not a new job)
  //       (c) they have at least one non-empty cell (not a true blank spacer)
  // As soon as a row has a non-empty date it starts a new job — stop extending.

  const clientColIdx = colOf(colIdx, "gallery name", "client name", "client", "gallery", "name");
  const dateColIdx   = colOf(colIdx, "date", "shoot date", "booking date");

  function rowGallery(row: unknown[]): string {
    return clientColIdx >= 0 ? str(row[clientColIdx]) : "";
  }
  function rowDate(row: unknown[]): string {
    return dateColIdx >= 0 ? str(row[dateColIdx]) : "";
  }
  function rowHasContent(row: unknown[]): boolean {
    return Array.isArray(row) && row.some(c => c != null && String(c).trim() !== "");
  }

  // blockEndRow[i] = last sheet row (1-based) of the block starting at dataRows[i]
  const blockEndRows: number[] = new Array(dataRows.length);
  for (let i = 0; i < dataRows.length; i++) {
    const mainRow = Array.isArray(dataRows[i]) ? dataRows[i] as unknown[] : [];
    const mainGallery = rowGallery(mainRow);
    if (!mainGallery) {
      // Not a primary job row — its block is just itself
      blockEndRows[i] = i + 2; // sheet row = i+2 (1-based, offset by header)
      continue;
    }
    let end = i; // last data-row index (inclusive) for this block
    for (let j = i + 1; j < dataRows.length; j++) {
      const nextRow = Array.isArray(dataRows[j]) ? dataRows[j] as unknown[] : [];
      const nextGallery = rowGallery(nextRow);
      const nextDate    = rowDate(nextRow);
      // Stop if the next row has a non-empty date (it's a new job) or is a blank spacer
      if (nextDate !== "") break;
      if (!rowHasContent(nextRow)) break;
      // Accept if gallery is empty (continuation) or matches main gallery
      if (nextGallery === "" || nextGallery.toLowerCase() === mainGallery.toLowerCase()) {
        end = j;
      } else {
        break; // different gallery name = new job
      }
    }
    blockEndRows[i] = end + 2; // convert to 1-based sheet row
    if (end > i) {
      console.log(`[sheetsSync] job block: rows ${i+2}–${end+2} gallery="${mainGallery}"`);
    }
  }

  // ── Identify which rows are PRIMARY (start a block) vs CONTINUATION ─────────
  // A primary row MUST have both a non-empty gallery name AND a non-empty date.
  // Continuation rows (same block, no date) are absorbed into the primary row's
  // blockEndRow but must NOT produce their own card.
  const isPrimaryRow = new Array(dataRows.length).fill(false);
  for (let i = 0; i < dataRows.length; i++) {
    const row     = Array.isArray(dataRows[i]) ? dataRows[i] as unknown[] : [];
    const gallery = rowGallery(row);
    const date    = rowDate(row);
    if (gallery && date) isPrimaryRow[i] = true;
  }

  let skippedNoGallery   = 0;
  let skippedNoDate      = 0;
  let skippedContinuation = 0;
  let skippedParseError  = 0;
  let duplicateIds       = 0;
  let duplicateKeys      = 0;

  const seenIds  = new Set<string>();
  const seenKeys = new Set<string>();

  const jobs: SheetJob[] = dataRows
    .map((row, i) => {
      // Only emit a card for PRIMARY rows
      if (!isPrimaryRow[i]) {
        skippedContinuation++;
        return null;
      }
      const rowNum      = i + 2; // 1-based sheet row (row 1 is the header)
      const blockEndRow = blockEndRows[i] ?? rowNum;
      const resortColIdx = colOf(colIdx, "resort", "hotel", "venue");
      const rKey = normalizeKey(
        str(Array.isArray(row) ? row[clientColIdx] ?? "" : ""),
        str(Array.isArray(row) ? row[dateColIdx]   ?? "" : ""),
        str(Array.isArray(row) ? row[resortColIdx] ?? "" : "")
      );
      const stableId    = `sheet-row-${rowNum}`;
      const existing    = sashaById.get(stableId)    ?? sashaByKey.get(rKey);
      const existingAct = activityById.get(stableId) ?? activityByKey.get(rKey);
      const isDirty     = dirtyIds.has(stableId) || dirtyKeys.has(rKey);
      const sheetColor    = rowColors[i + 1]    ?? "none";
      const sheetColorRaw = rowRawColors[i + 1] ?? "";
      return parseRow(row, colIdx, rowNum, blockEndRow, sheetColor, sheetColorRaw, existing, existingAct, isDirty);
    })
    .filter((j): j is SheetJob => {
      if (j === null) return false;
      if (!j.herman.galleryName) { skippedNoGallery++; return false; }
      if (!j.herman.date)        { skippedNoDate++;    return false; }

      // Deduplicate by stable ID (sheet row number)
      if (seenIds.has(j.id)) {
        duplicateIds++;
        console.warn(`[sheetsSync] DUPLICATE id=${j.id} gallery="${j.herman.galleryName}" — skipping`);
        return false;
      }
      seenIds.add(j.id);

      // Deduplicate by composite rowKey (gallery|date|resort)
      if (j.rowKey && seenKeys.has(j.rowKey)) {
        duplicateKeys++;
        console.warn(`[sheetsSync] DUPLICATE rowKey="${j.rowKey}" (row ${j.sheetRow}) — skipping`);
        return false;
      }
      if (j.rowKey) seenKeys.add(j.rowKey);

      return true;
    });

  // ── Status breakdown for debug ────────────────────────────────────────────────
  const statusCounts: Record<string, number> = {};
  for (const job of jobs) {
    const g = groupForJob(job);
    statusCounts[g] = (statusCounts[g] ?? 0) + 1;
  }

  console.log(
    `[sheetsSync] SYNC COMPLETE: ${jobs.length} unique cards from ${dataRows.length} data rows\n` +
    `  skipped: ${skippedContinuation} continuation, ${skippedNoGallery} no-gallery, ${skippedNoDate} no-date, ${skippedParseError} parse-errors\n` +
    `  duplicates removed: ${duplicateIds} by ID, ${duplicateKeys} by rowKey\n` +
    `  status counts: ${JSON.stringify(statusCounts)}`
  );
  if (jobs.length > 0) {
    console.log("[SYNC_SUCCESS] first 5 jobs:", jobs.slice(0, 5).map(j =>
      `row=${j.sheetRow} "${j.herman.galleryName}" ${j.herman.date} stage=${groupForJob(j)}`
    ));
  }

  await upsertHermanCache(jobs);

  // ── Remove orphan cache rows (rows that no longer exist in the sheet) ─────────
  const currentIds = new Set(jobs.map(j => j.id));
  await purgeOrphanCacheRows(currentIds);

  console.log(`[SYNC_SUCCESS] fetchSheetJobs complete: ${jobs.length} jobs from sheet`);
  return { jobs, fromCache: false, sheetId: sheetIdFromServer, sheetName: sheetNameFromServer, gid: gidFromServer };
}

// ─── WRITE: push Sasha columns via edge function ──────────────────────────────

export async function writeSashaColumns(
  job: SheetJob,
  actor = "Sasha",
  action = "added comment"
): Promise<{ ok: boolean; cached: boolean }> {
  const now     = new Date().toISOString();
  const updated = { ...job.sasha, updatedAt: now };

  // editingAddedAt: preserve existing value — never overwrite once set
  const editingAddedAt = job.sasha.editingAddedAt || "";

  // Always write to Supabase cache first (local persistence even if sheet write fails)
  await supabase.from("editing_jobs_cache").upsert({
    id:                 job.id,
    sheet_row:          job.sheetRow,
    row_key:            job.rowKey,
    herman_data:        job.herman,
    sasha_priority:     updated.priority,
    sasha_color:        updated.color,
    sasha_comment:      updated.comment,
    sasha_request:      updated.request,
    sasha_due_priority: updated.duePriority,
    sasha_updated_at:   now,
    sasha_stage:        updated.stage ?? "",
    review_status:      updated.reviewStatus ?? "",
    action_reason:      updated.actionReason ?? "",
    last_updated_by:    actor,
    last_updated_at:    now,
    last_action:        action,
    dirty:              true,
    updated_at:         now,
    ...(editingAddedAt ? { editing_added_at: editingAddedAt } : {}),
  });

  try {
    const res = await fetch(edgeUrl("/write-sasha"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify({
        sheetRow: job.sheetRow,
        // 11 values: U–AE
        // Position 0–9: Priority, Color, Comment, Request, DuePriority, UpdatedAt, Stage,
        //               LastUpdatedBy, LastUpdatedAt, LastAction
        // Position 10 (AE): Editing Added At — pass existing value; edge fn preserves it if cell occupied
        values: [
          updated.priority,
          updated.color,
          updated.comment,
          updated.request,
          updated.duePriority,
          now,
          updated.stage ?? "",
          actor,
          now,
          action,
          editingAddedAt,  // AE — edge fn will not overwrite if cell already has a value
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      console.error("[sheetsSync] write-sasha error:", body.error);
      return { ok: false, cached: true };
    }

    await supabase.from("editing_jobs_cache").update({ dirty: false }).eq("id", job.id);
    return { ok: true, cached: false };
  } catch (err) {
    console.error("[sheetsSync] write-sasha network error:", err);
    return { ok: false, cached: true };
  }
}

// ─── MOVE: drag-drop — update row background color in Google Sheets ──────────
// Writes ONLY the row background color (batchUpdate) so stage changes are
// visible in Herman's sheet. Never touches cell text/checkboxes.
// blockEndRow covers multi-row job blocks (e.g. main row + email continuation row).

export async function moveJobStage(
  job: SheetJob,
  toGroup: CardGroup,
  actor = "Sasha"
): Promise<{ ok: boolean; blockEndRow: number }> {
  const blockEndRow = job.blockEndRow ?? job.sheetRow;
  const stageLabels: Record<CardGroup, string> = {
    not_started:       "Not Started",
    waiting_selection: "Waiting for Selection",
    in_progress:       "In Progress / Editing",
    ready_to_send:     "Ready to Send",
    delivered:         "Delivered Archive",
  };
  const oldStage = groupForJob(job);
  const action = `moved to ${stageLabels[toGroup] ?? toGroup}`;

  console.log(`[MOVE_STAGE_START] id=${job.id} row=${job.sheetRow} oldStage=${oldStage} newStage=${toGroup} actor=${actor}`);

  const now = new Date().toISOString();

  // 1. Persist new stage in Supabase cache immediately (dirty=true so fetchSheetJobs
  //    uses cache values while sheet writes are in-flight)
  await supabase.from("editing_jobs_cache").upsert({
    id:              job.id,
    sheet_row:       job.sheetRow,
    block_end_row:   blockEndRow,
    row_key:         job.rowKey,
    herman_data:     job.herman,
    sasha_stage:     toGroup,
    last_updated_by: actor,
    last_updated_at: now,
    last_action:     action,
    dirty:           true,
    updated_at:      now,
  });

  try {
    // 2. Write background color (Herman's visual view)
    console.log(`[MOVE_STAGE_SHEET_WRITE] writing color row=${job.sheetRow} stage=${toGroup}`);
    const colorRes = await fetch(edgeUrl("/write-color"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify({
        sheetRow:    job.sheetRow,
        blockEndRow: job.sheetRow,
        stage:       toGroup,
      }),
    });
    if (!colorRes.ok) {
      const body = await colorRes.json().catch(() => ({ error: `HTTP ${colorRes.status}` })) as { error?: string };
      console.error("[MOVE_STAGE_SHEET_WRITE] color write failed:", body.error, "row:", job.sheetRow);
      return { ok: false, blockEndRow };
    }

    // 3. Write stage text to Sasha column AA so other users see correct stage on sync
    console.log(`[MOVE_STAGE_SHEET_WRITE] writing sasha column AA row=${job.sheetRow} stage=${toGroup}`);
    const updatedSasha = { ...job.sasha, stage: toGroup as SashaStage, updatedAt: now };
    const editingAddedAt = job.sasha.editingAddedAt || "";
    const sashaRes = await fetch(edgeUrl("/write-sasha"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify({
        sheetRow: job.sheetRow,
        values: [
          updatedSasha.priority    ?? "",
          updatedSasha.color       ?? "gray",
          updatedSasha.comment     ?? "",
          updatedSasha.request     ?? "",
          updatedSasha.duePriority ?? "",
          now,
          toGroup,          // column AA — stage text (CardGroup value)
          actor,
          now,
          action,
          editingAddedAt,   // AE — preserved
        ],
      }),
    });
    if (!sashaRes.ok) {
      const body = await sashaRes.json().catch(() => ({ error: `HTTP ${sashaRes.status}` })) as { error?: string };
      console.warn("[MOVE_STAGE_SHEET_WRITE] sasha text write failed (color ok):", body.error, "row:", job.sheetRow);
      return { ok: true, blockEndRow };
    }

    // 4. Mark cache clean — sheet is now the source of truth
    await supabase.from("editing_jobs_cache").update({ dirty: false }).eq("id", job.id);
    console.log(`[MOVE_STAGE_SHEET_WRITE] complete ok=true row=${job.sheetRow} newStage=${toGroup}`);
    return { ok: true, blockEndRow };
  } catch (err) {
    console.error("[MOVE_STAGE_SHEET_WRITE] network error row:", job.sheetRow, err);
    return { ok: false, blockEndRow };
  }
}

// ─── Flush dirty cache rows ───────────────────────────────────────────────────

export async function flushDirtyCache(): Promise<{ flushed: number; failed: number }> {
  const { data } = await supabase.from("editing_jobs_cache").select("*").eq("dirty", true);
  if (!data?.length) return { flushed: 0, failed: 0 };

  let flushed = 0;
  let failed  = 0;
  for (const row of data) {
    const sasha: SashaData = {
      priority:       row.sasha_priority    as SashaPriority,
      color:          row.sasha_color       as SashaColor,
      comment:        row.sasha_comment     ?? "",
      request:        row.sasha_request     as SashaRequest,
      duePriority:    row.sasha_due_priority ?? "",
      updatedAt:      row.sasha_updated_at   ?? "",
      stage:          (row.sasha_stage      ?? "") as SashaStage,
      syncStatus:     row.dirty ? "pending" : "synced",
      reviewStatus:   (row.review_status ?? "") as SashaReviewStatus,
      actionReason:   (row.action_reason ?? "") as SashaActionReason,
      editingAddedAt: row.editing_added_at ? new Date(row.editing_added_at as string).toISOString() : "",
    };
    const job: SheetJob = {
      id:          row.id,
      sheetRow:    row.sheet_row,
      blockEndRow: row.block_end_row ?? row.sheet_row,
      rowKey:      row.row_key,
      herman:      row.herman_data as HermanData,
      sasha,
      activity: {
        lastUpdatedBy: row.last_updated_by ?? "",
        lastUpdatedAt: row.last_updated_at ?? "",
        lastAction:    row.last_action     ?? "",
      },
    };
    const { ok } = await writeSashaColumns(job, row.last_updated_by ?? "Sasha", row.last_action ?? "synced");
    if (ok) flushed++; else failed++;
  }
  return { flushed, failed };
}

// ─── REVIEW STATUS: update review status in Supabase cache only ──────────────
// reviewStatus is app-level state stored in Supabase. It is NOT written to the
// Google Sheet (no extra columns needed). Both users read it via Supabase.

export async function writeReviewStatus(
  job: SheetJob,
  reviewStatus: SashaReviewStatus,
  actor: string,
  actionReason: SashaActionReason = ""
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("editing_jobs_cache").upsert({
    id:              job.id,
    sheet_row:       job.sheetRow,
    row_key:         job.rowKey,
    review_status:   reviewStatus,
    action_reason:   reviewStatus === "reviewed" ? "" : actionReason,
    last_updated_by: actor,
    last_updated_at: now,
    last_action:     reviewStatus === "reviewed" ? "marked reviewed" : `review: ${reviewStatus}`,
    updated_at:      now,
  });
  if (error) {
    console.error("[sheetsSync] writeReviewStatus error:", error.message);
    return { ok: false };
  }
  return { ok: true };
}

// ─── ADD: append a new editing job row via edge function ─────────────────────
// Writes only non-accounting fields to the sheet. Never touches pricing/invoice.

export interface NewEditingJob {
  date:           string;
  galleryName:    string;
  resort:         string;
  photoPackage:   string;
  occasion:       string;
  notes:          string;
  actor:          string;
  // ISO timestamp set once at creation — never overwritten
  editingAddedAt: string;
}

export async function addJobToSheet(data: NewEditingJob): Promise<{ ok: boolean; sheetRow?: number; blockEndRow?: number; error?: string; alreadyExists?: boolean }> {
  try {
    // ── Duplicate guard: check the live sheet before writing ───────────────────
    // Fetch current rows and see if this gallery+date+resort already exists.
    const checkRes = await fetch(edgeUrl("/read"), { headers: edgeHeaders() });
    if (checkRes.ok) {
      const checkJson = await checkRes.json() as { rows?: unknown[][] };
      const checkRows = checkJson.rows ?? [];
      if (checkRows.length > 1) {
        const hdr    = buildColIndex(checkRows[0]);
        const clientC = colOf(hdr, "gallery name", "client name", "client", "gallery", "name");
        const dateC   = colOf(hdr, "date", "shoot date", "booking date");
        const targetName = normalizeKey(data.galleryName, "", "");
        const targetDate = data.date.trim().toLowerCase();
        for (let i = 1; i < checkRows.length; i++) {
          const r = checkRows[i] as unknown[];
          const existingName = String(r[clientC] ?? "").trim().toLowerCase();
          const existingDate = String(r[dateC]   ?? "").trim().toLowerCase();
          if (!existingName || !existingDate) continue;
          const nameMatch = normalizeKey(String(r[clientC] ?? ""), "", "").toLowerCase() === targetName.toLowerCase();
          const dateMatch = existingDate === targetDate;
          if (nameMatch && dateMatch) {
            console.warn(`[addJobToSheet] DUPLICATE — "${data.galleryName}" ${data.date} already at sheet row ${i + 1}. Skipping write.`);
            return { ok: true, sheetRow: i + 1, blockEndRow: i + 1, alreadyExists: true };
          }
        }
      }
    }

    const res = await fetch(edgeUrl("/add-job"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok?: boolean; sheetRow?: number; blockEndRow?: number };
    return { ok: true, sheetRow: json.sheetRow, blockEndRow: json.blockEndRow ?? json.sheetRow };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ─── Test the edge function connection ───────────────────────────────────────

// ─── Activity log helpers ─────────────────────────────────────────────────────

export async function logCardActivity(params: {
  jobId:    string;
  sheetRow: number;
  actor:    string;
  action:   string;
  oldStage?: string;
  newStage?: string;
}): Promise<void> {
  await supabase.from("card_activity_log").insert({
    job_id:    params.jobId,
    sheet_row: params.sheetRow,
    actor:     params.actor,
    action:    params.action,
    old_stage: params.oldStage ?? null,
    new_stage: params.newStage ?? null,
  });
}

export async function pingUserActivity(userId: string, displayName: string, lastTab: string, lastAction: string): Promise<void> {
  await supabase.from("user_activity").upsert({
    user_id:      userId,
    display_name: displayName,
    last_seen_at: new Date().toISOString(),
    last_action:  lastAction,
    last_tab:     lastTab,
  }, { onConflict: "user_id" });
}

export async function fetchOtherUserActivity(myUserId: string): Promise<{ userId: string; displayName: string; lastSeenAt: string; lastAction: string; lastTab: string } | null> {
  const { data } = await supabase
    .from("user_activity")
    .select("user_id, display_name, last_seen_at, last_action, last_tab")
    .neq("user_id", myUserId)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    userId:      data.user_id,
    displayName: data.display_name,
    lastSeenAt:  data.last_seen_at,
    lastAction:  data.last_action,
    lastTab:     data.last_tab,
  };
}

export async function testSheetConnection(): Promise<{ ok: boolean; message: string; rowCount?: number }> {
  console.log("[sheetsSync] testSheetConnection — calling edge function /read");
  try {
    const res = await fetch(edgeUrl("/read"), { headers: edgeHeaders() });
    console.log("[sheetsSync] test /read status:", res.status);

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = body.error ?? `HTTP ${res.status}`;
      if (msg.includes("GOOGLE_SERVICE_ACCOUNT_JSON")) {
        return { ok: false, message: "GOOGLE_SERVICE_ACCOUNT_JSON secret not configured in Supabase Edge Function secrets." };
      }
      if (msg.includes("GOOGLE_SHEET_ID")) {
        return { ok: false, message: "GOOGLE_SHEET_ID secret not configured in Supabase Edge Function secrets." };
      }
      return { ok: false, message: msg };
    }

    const json     = await res.json() as { rows?: unknown[][]; sheetId?: string; gid?: number; sheetName?: string };
    const rowCount = Math.max(0, (json.rows?.length ?? 1) - 1);
    const debugInfo = json.sheetId ? ` [sheetId: ${json.sheetId}, gid: ${json.gid}, tab: "${json.sheetName}"]` : "";
    return { ok: true, message: `Connected — ${rowCount} job${rowCount !== 1 ? "s" : ""} found${debugInfo}`, rowCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Connection failed";
    return { ok: false, message: msg };
  }
}

export async function testSheetWrite(): Promise<{ ok: boolean; message: string; row?: number; sheetId?: string; gid?: number; tabName?: string }> {
  console.log("[sheetsSync] testSheetWrite — calling edge function /test-write");
  try {
    const res = await fetch(edgeUrl("/test-write"), { method: "POST", headers: edgeHeaders() });
    console.log("[sheetsSync] test-write status:", res.status);
    const body = await res.json().catch(() => ({})) as {
      ok?: boolean; message?: string; row?: number;
      sheetId?: string; gid?: number; tabName?: string; error?: string;
    };
    if (!res.ok || !body.ok) {
      return { ok: false, message: body.error ?? body.message ?? `HTTP ${res.status}` };
    }
    return {
      ok:      true,
      message: body.message ?? `Test write SUCCESS — row ${body.row} on tab "${body.tabName}"`,
      row:     body.row,
      sheetId: body.sheetId,
      gid:     body.gid,
      tabName: body.tabName,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Test write failed";
    return { ok: false, message: msg };
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadFromCache(
  sashaById:  Map<string, SashaData>,
  sashaByKey: Map<string, SashaData>
): Promise<{ jobs: SheetJob[]; fromCache: boolean }> {
  const { data: rows } = await supabase.from("editing_jobs_cache").select("*");
  if (!rows?.length) {
    console.warn("[sheetsSync] No cache available — returning empty jobs");
    return { jobs: [], fromCache: true };
  }

  // Deduplicate by sheet_row — keep only the most recently updated row per sheet row number.
  // This guards against any lingering duplicate rows in the DB.
  const bySheetRow = new Map<number, typeof rows[0]>();
  for (const row of rows) {
    const n = row.sheet_row as number;
    if (!n) continue;
    const existing = bySheetRow.get(n);
    if (!existing) {
      bySheetRow.set(n, row);
    } else {
      // Keep whichever has the more recent updated_at
      const eTime = existing.updated_at ? new Date(existing.updated_at as string).getTime() : 0;
      const rTime = row.updated_at      ? new Date(row.updated_at      as string).getTime() : 0;
      if (rTime > eTime) bySheetRow.set(n, row);
    }
  }

  const deduped = [...bySheetRow.values()];
  let skipped = 0;

  const seenKeys = new Set<string>();
  const jobs: SheetJob[] = deduped
    .map(row => {
      try {
        const herman: HermanData = {
          rowId:                  "",
          galleryName:            "",
          resort:                 "",
          date:                   "",
          package:                "",
          status:                 "",
          emails:                 "",
          sheetColor:             "none",
          sheetColorRaw:          "",
          saved:                  false,
          selectedAndPreedited:   false,
          imported:               false,
          beginSelectionMailSent: false,
          selectionReceived:      false,
          edited:                 false,
          editionUploaded:        false,
          delivered:              false,
          photosToEdit:           null,
          remarks:                "",
          lastUpdated:            "",
          occasion:               "",
          ...(row.herman_data && typeof row.herman_data === "object" ? row.herman_data as HermanData : {}),
        };
        if (!herman.sheetColor)    herman.sheetColor    = "none";
        if (!herman.sheetColorRaw) herman.sheetColorRaw = "";

        // Only include rows that were primary rows in the sheet (have both name and date)
        if (!herman.galleryName || !herman.date) { skipped++; return null; }

        // Deduplicate by rowKey
        const rk = (row.row_key as string) ?? "";
        if (rk && seenKeys.has(rk)) { skipped++; return null; }
        if (rk) seenKeys.add(rk);

        const baseSasha = sashaById.get(row.id as string) ?? sashaByKey.get(row.row_key as string) ?? DEFAULT_SASHA;
        const sasha: SashaData = {
          ...DEFAULT_SASHA,
          ...baseSasha,
          priority:      (row.sasha_priority    || baseSasha.priority    || "") as SashaPriority,
          color:         (row.sasha_color       || baseSasha.color       || "gray") as SashaColor,
          comment:       row.sasha_comment      ?? baseSasha.comment     ?? "",
          request:       (row.sasha_request     || baseSasha.request     || "") as SashaRequest,
          duePriority:   row.sasha_due_priority ?? baseSasha.duePriority ?? "",
          updatedAt:     row.sasha_updated_at   ?? baseSasha.updatedAt   ?? "",
          stage:         (row.sasha_stage       || baseSasha.stage       || "") as SashaStage,
          reviewStatus:  (row.review_status     || baseSasha.reviewStatus || "") as SashaReviewStatus,
          actionReason:  (row.action_reason     || baseSasha.actionReason || "") as SashaActionReason,
          syncStatus:    row.dirty ? "pending" : "synced",
          editingAddedAt: (row.editing_added_at ? new Date(row.editing_added_at as string).toISOString() : "")
                          || baseSasha.editingAddedAt || "",
        };
        const sheetRow = row.sheet_row as number ?? 0;
        const activity: ActivityInfo = {
          lastUpdatedBy: row.last_updated_by ?? "",
          lastUpdatedAt: row.last_updated_at ?? "",
          lastAction:    row.last_action     ?? "",
        };
        return {
          id:          row.id as string ?? `cache-${Math.random()}`,
          sheetRow,
          blockEndRow: row.block_end_row as number ?? sheetRow,
          rowKey:      rk,
          herman,
          sasha,
          activity,
        };
      } catch (err) {
        console.error("[sheetsSync] loadFromCache: skipping malformed cache row:", err);
        skipped++;
        return null;
      }
    })
    .filter((j): j is SheetJob => j !== null);

  console.log(`[sheetsSync] loadFromCache: ${rows.length} DB rows → ${deduped.length} deduped → ${jobs.length} valid jobs (${skipped} skipped)`);
  return { jobs, fromCache: true };
}

async function upsertHermanCache(jobs: SheetJob[]): Promise<void> {
  if (!jobs.length) return;
  const now = new Date().toISOString();
  await supabase.from("editing_jobs_cache").upsert(
    jobs.map(job => ({
      id:            job.id,
      sheet_row:     job.sheetRow,
      block_end_row: job.blockEndRow,
      row_key:       job.rowKey,
      herman_data:   job.herman,
      synced_at:     now,
      updated_at:    now,
    })),
    { onConflict: "id", ignoreDuplicates: false }
  );
}

// Deletes cache rows whose IDs are NOT in the current sheet sync.
// This removes ghost cards from old sheets, renamed rows, or deleted shoots.
async function purgeOrphanCacheRows(currentIds: Set<string>): Promise<void> {
  const { data: allRows } = await supabase.from("editing_jobs_cache").select("id");
  if (!allRows?.length) return;
  const orphanIds = allRows.map(r => r.id as string).filter(id => !currentIds.has(id));
  if (!orphanIds.length) return;
  console.log(`[sheetsSync] purging ${orphanIds.length} orphan cache rows:`, orphanIds);
  await supabase.from("editing_jobs_cache").delete().in("id", orphanIds);
}

// Maps HermanData field names → sheet header text used by the edge function.
// The edge function slugifies and prefix-matches these strings against row 1.
const HERMAN_FIELD_TO_HEADER: Record<string, string> = {
  saved:                  "saved",
  selectedAndPreedited:   "selected preedited",
  imported:               "imported",
  beginSelectionMailSent: "begin selection mail sent",
  selectionReceived:      "selection received",
  edited:                 "edited",
  editionUploaded:        "uploaded",
  delivered:              "delivered",
};

export async function writeHermanCheckbox(
  job: SheetJob,
  field: string,
  value: boolean
): Promise<{ ok: boolean; error?: string }> {
  const header = HERMAN_FIELD_TO_HEADER[field] ?? field;
  try {
    const res = await fetch(edgeUrl("/write-herman-checkbox"), {
      method: "POST",
      headers: edgeHeaders(),
      body: JSON.stringify({ sheetRow: job.sheetRow, field: header, value }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function clearSheetRow(job: SheetJob): Promise<{ ok: boolean; error?: string }> {
  console.log(`deleting row ${job.sheetRow} (id=${job.id} gallery="${job.herman.galleryName}")`);
  try {
    const res = await fetch(edgeUrl("/clear-row"), {
      method: "POST",
      headers: { ...edgeHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ sheetRow: job.sheetRow }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = body.error ?? `HTTP ${res.status}`;
      console.error(`delete failure row ${job.sheetRow}: ${msg}`);
      return { ok: false, error: msg };
    }
    console.log(`delete success row ${job.sheetRow}`);
    // Remove from Supabase cache — match by sheet_row for reliability
    await supabase.from("editing_jobs_cache").delete().eq("sheet_row", job.sheetRow);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`delete failure row ${job.sheetRow}: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ─── Shoots tab helpers ───────────────────────────────────────────────────────

export interface ShootSheetRow {
  id: number;
  date: string;
  hotel: string;
  client: string;
  eventType: string;
  photoPackage: string;
  department: string;
  source: string;
  ht: number;
  tax: number;
  finalAmount: number;
  status: string;
  country?: string;
  originalSource?: string;
}

export async function initAccountingHeaders(): Promise<{ ok: boolean; results?: Record<string, string>; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/shoots-init"), {
      method: "POST",
      headers: edgeHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; results?: Record<string, string> };
    return { ok: true, results: json.results };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function writeShootToSheet(
  shoot: ShootSheetRow
): Promise<{ ok: boolean; alreadyExists?: boolean; sheetRow?: number; error?: string }> {
  console.log('[writeShootToSheet] START — id:', shoot.id, 'client:', shoot.client);
  try {
    const res = await fetch(edgeUrl("/shoots-write"), {
      method: "POST",
      headers: edgeHeaders(),
      body: JSON.stringify(shoot),
    });
    console.log('[writeShootToSheet] response status:', res.status);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      console.log('[writeShootToSheet] response body:', JSON.stringify(body));
      const msg = body.error ?? `HTTP ${res.status}`;
      const result = { ok: false, error: msg };
      console.log('[writeShootToSheet] returning:', JSON.stringify(result));
      return result;
    }
    const json = await res.json() as { ok: boolean; alreadyExists?: boolean; sheetRow?: number };
    console.log('[writeShootToSheet] response body:', JSON.stringify(json));
    const result = { ok: true, alreadyExists: json.alreadyExists, sheetRow: json.sheetRow };
    console.log('[writeShootToSheet] returning:', JSON.stringify(result));
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    const result = { ok: false, error: msg };
    console.log('[writeShootToSheet] returning:', JSON.stringify(result));
    return result;
  }
}

export async function readShootFromSheet(
  id: number
): Promise<{ ok: boolean; found?: boolean; row?: unknown[]; sheetRow?: number; error?: string }> {
  try {
    const res = await fetch(edgeUrl(`/shoots-read?id=${id}`), { headers: edgeHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; found?: boolean; row?: unknown[]; sheetRow?: number };
    return { ok: true, found: json.found, row: json.row, sheetRow: json.sheetRow };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}


export async function testAccountingSheet(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(edgeUrl("/acct-test"), { headers: edgeHeaders() });
    const json = await res.json() as { ok: boolean; detail?: string; error?: string };
    return { ok: json.ok, detail: json.detail ?? json.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Network error" };
  }
}

export interface DebugTabResult {
  tab: string;
  error?: string;
  rawCount: number;
  parsedCount: number;
  rejectedCount: number;
  headerRow: unknown[] | null;
  first3Raw: unknown[][];
  first3Parsed: unknown[];
  rejected: { rowIndex: number; reason: string; raw: unknown[] }[];
}

export interface DebugReadResult {
  ok: boolean;
  sheetId?: string;
  shoots?: DebugTabResult;
  direct?: DebugTabResult;
  price?: DebugTabResult;
  error?: string;
}

export async function debugSheetRead(): Promise<DebugReadResult> {
  try {
    const res = await fetch(edgeUrl("/debug-read"), { headers: edgeHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return await res.json() as DebugReadResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export interface ShootAllRow {
  id:             number;
  date:           string;
  hotel:          string;
  client:         string;
  eventType:      string;
  photoPackage:   string;
  department:     string;
  source:         string;
  ht:             number;
  tax:            number;
  finalAmount:    number;
  status:         string;
  country:        string;
  originalSource: string;
  sheetRow:       number;
}

export async function fetchAllShoots(): Promise<{ ok: boolean; shoots?: ShootAllRow[]; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/shoots-read-all"), { headers: edgeHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; shoots?: ShootAllRow[] };
    return { ok: true, shoots: json.shoots ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function deleteShootFromSheet(
  shoot: { id: number; date: string; hotel: string; client: string; photoPackage: string }
): Promise<{ ok: boolean; found?: boolean; sheetRow?: number; matchMethod?: string; error?: string }> {
  console.log(`[DELETE SHOOT] id=${shoot.id} | date=${shoot.date} | hotel=${shoot.hotel}`);
  try {
    const res = await fetch(edgeUrl("/shoots-delete"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify({
        id:           shoot.id,
        date:         shoot.date,
        hotel:        shoot.hotel,
        client:       shoot.client,
        photoPackage: shoot.photoPackage,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = body.error ?? `HTTP ${res.status}`;
      console.error(`[DELETE SHOOT] FAILED | id=${shoot.id} | ${msg}`);
      return { ok: false, error: msg };
    }
    const json = await res.json() as { ok: boolean; found?: boolean; sheetRow?: number; matchMethod?: string };
    console.log(`[DELETE SHOOT] result | id=${shoot.id} | found=${json.found} | sheetRow=${json.sheetRow} | matchMethod=${json.matchMethod}`);
    if (!json.found) {
      return { ok: false, error: "Row not found in Google Sheet — shoot may have already been deleted or has no matching ID/date+hotel" };
    }
    return { ok: true, found: true, sheetRow: json.sheetRow, matchMethod: json.matchMethod };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    console.error(`[DELETE SHOOT] ERROR | id=${shoot.id} | ${msg}`);
    return { ok: false, error: msg };
  }
}

// ─── WRITE: photos to edit column Q ──────────────────────────────────────────
// Writes ONLY column Q for one row. Never touches any other column.

export async function writePhotosToEdit(
  job: SheetJob,
  photosToEdit: number | null
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/write-photos"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify({ sheetRow: job.sheetRow, photosToEdit }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      console.error("[sheetsSync] write-photos error:", body.error);
      return { ok: false, error: body.error };
    }
    // Update local cache so UI reflects the write immediately (no need to wait for next sync)
    const updatedHerman: HermanData = { ...job.herman, photosToEdit };
    await supabase.from("editing_jobs_cache").update({
      herman_data: updatedHerman,
      updated_at:  new Date().toISOString(),
    }).eq("id", job.id);
    return { ok: true };
  } catch (err) {
    console.error("[sheetsSync] write-photos network error:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function writeEmailColumn(
  job: SheetJob,
  emails: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/write-email"), {
      method: "POST",
      headers: edgeHeaders(),
      body: JSON.stringify({ sheetRow: job.sheetRow, emails }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      console.error("[sheetsSync] write-email error:", body.error);
      return { ok: false, error: body.error };
    }
    // Update local cache so UI reflects the write immediately (no need to wait for next sync)
    const updatedHerman: HermanData = { ...job.herman, emails };
    await supabase.from("editing_jobs_cache").update({
      herman_data: updatedHerman,
      updated_at:  new Date().toISOString(),
    }).eq("id", job.id);
    return { ok: true };
  } catch (err) {
    console.error("[sheetsSync] write-email network error:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ─── PRICES: read/write/delete against the Price tab ─────────────────────────

export interface SheetPriceRow {
  id:           string;
  hotel:        string;
  photoPackage: string;
  department:   string;
  ht:           number;
  sheetRow:     number;
}

export async function fetchPrices(): Promise<{ ok: boolean; prices?: SheetPriceRow[]; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/prices-read"), { headers: edgeHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; prices?: SheetPriceRow[] };
    return { ok: true, prices: json.prices ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function writePriceRow(
  row: { id: number | string; hotel: string; photoPackage: string; department: string; ht: number }
): Promise<{ ok: boolean; isUpdate?: boolean; sheetRow?: number; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/prices-write"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify(row),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; isUpdate?: boolean; sheetRow?: number };
    return { ok: true, isUpdate: json.isUpdate, sheetRow: json.sheetRow };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function deletePriceRow(
  row: { hotel: string; photoPackage: string; department: string }
): Promise<{ ok: boolean; found?: boolean; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/prices-delete"), {
      method:  "POST",
      headers: edgeHeaders(),
      body:    JSON.stringify(row),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; found?: boolean };
    return { ok: true, found: json.found };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

// ─── Direct tab helpers ───────────────────────────────────────────────────────

export interface DirectSheetRow {
  id: number;
  date: string;
  client: string;
  income: string;
  amount: number;
}

export interface DirectAllRow {
  id:       number;
  date:     string;
  client:   string;
  income:   string;
  amount:   number;
  sheetRow: number;
}

export async function fetchAllDirect(): Promise<{ ok: boolean; direct?: DirectAllRow[]; error?: string }> {
  try {
    const res = await fetch(edgeUrl("/direct-read-all"), { headers: edgeHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const json = await res.json() as { ok: boolean; direct?: DirectAllRow[] };
    return { ok: true, direct: json.direct ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function writeDirectToSheet(
  row: DirectSheetRow
): Promise<{ ok: boolean; sheetRow?: number; error?: string }> {
  console.log(`[direct] write | id=${row.id} | payload:`, JSON.stringify(row));
  try {
    const res = await fetch(edgeUrl("/direct-write"), {
      method: "POST",
      headers: edgeHeaders(),
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = body.error ?? `HTTP ${res.status}`;
      console.error(`[direct] write failed | id=${row.id} | ${msg}`);
      return { ok: false, error: msg };
    }
    const json = await res.json() as { ok: boolean; sheetRow?: number };
    console.log(`[direct] write success | id=${row.id} | sheetRow=${json.sheetRow}`);
    return { ok: true, sheetRow: json.sheetRow };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    console.error(`[direct] write error | id=${row.id} | ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function updateDirectInSheet(
  row: DirectSheetRow
): Promise<{ ok: boolean; error?: string }> {
  console.log(`[direct] update | id=${row.id} | payload:`, JSON.stringify(row));
  try {
    const res = await fetch(edgeUrl("/direct-update"), {
      method: "POST",
      headers: edgeHeaders(),
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = body.error ?? `HTTP ${res.status}`;
      console.error(`[direct] update failed | id=${row.id} | ${msg}`);
      return { ok: false, error: msg };
    }
    const json = await res.json() as { ok: boolean };
    console.log(`[direct] update success | id=${row.id} | result:`, JSON.stringify(json));
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    console.error(`[direct] update error | id=${row.id} | ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function deleteDirectFromSheet(
  row: { id: number; date?: string; client?: string; income?: string; amount?: number }
): Promise<{ ok: boolean; found?: boolean; error?: string }> {
  console.log(`[direct] delete | id=${row.id}`);
  try {
    const res = await fetch(edgeUrl("/direct-delete"), {
      method: "POST",
      headers: edgeHeaders(),
      body: JSON.stringify({ id: row.id, date: row.date, client: row.client, income: row.income, amount: row.amount }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = body.error ?? `HTTP ${res.status}`;
      console.error(`[direct] delete failed | id=${row.id} | ${msg}`);
      return { ok: false, error: msg };
    }
    const json = await res.json() as { ok: boolean; found?: boolean };
    console.log(`[direct] delete result | id=${row.id} | result:`, JSON.stringify(json));
    return { ok: true, found: json.found };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    console.error(`[direct] delete error | id=${row.id} | ${msg}`);
    return { ok: false, error: msg };
  }
}
