import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TrendingUp, TrendingDown, Receipt, Coins, Users, Camera, Building2, BarChart2, SlidersHorizontal, CalendarDays, History, ChevronDown } from "lucide-react";
import DocumentsPanel, { saveFileToDocsFolder, getStoredDocsHandle } from "./DocumentsPanel";
import EditingPipelinePanel, { EditingJob, initialEditingJobs } from "./EditingPipeline";
import { fetchSheetJobs, writeSashaColumns, writeReviewStatus, moveJobStage, flushDirtyCache, testSheetConnection, testSheetWrite, addJobToSheet, clearSheetRow, logCardActivity, pingUserActivity, fetchOtherUserActivity, writeShootToSheet, readShootFromSheet, initAccountingHeaders, testAccountingSheet, debugSheetRead, writeEmailColumn, fetchPrices, writePriceRow, deletePriceRow, fetchAllShoots, deleteShootFromSheet, writeDirectToSheet, updateDirectInSheet, deleteDirectFromSheet, fetchAllDirect, groupForJob, type ShootSheetRow, type DirectSheetRow, type SyncState, type SheetJob, type SashaData, type SashaReviewStatus, type SashaActionReason, type CardGroup, type NewEditingJob, type DebugReadResult } from "./sheetsSync";
import { createClient as _createClientForLogin } from "@supabase/supabase-js";
import DashboardV2 from "./DashboardV2";

const STORAGE_KEY = "sasha-photography-accounting-v11";
const GCAL_TOKEN_KEY = "gcal_access_token";
const GCAL_TOKEN_EXPIRY_KEY = "gcal_token_expiry";
const GCAL_CONNECTED_KEY = "gcal_connected";         // "1" if user explicitly connected
const GCAL_WRITE_SCOPE_KEY = "gcal_write_scope";     // "1" if write scope was granted
const GCAL_ACCOUNT_KEY = "gcal_account_email";       // last connected account email
const TAX_RATE = 0.13;

interface HotelInfo { name: string; address: string; code: string; }
interface Shoot { id: number; date: string; hotel: string; client: string; eventType: string; photoPackage: string; department: string; source: string; ht: number; tax: number; finalAmount: number; status: string; }
interface DirectRow { id: number; date: string; client: string; income: string; amount: number; }
interface PricingRow { id: number; hotel: string; photoPackage: string; department: string; ht: number; }
interface GeneratedInvoice { invoiceNumber: string; invoiceDate: string; hotel: HotelInfo; department: string; month: string; rows: Shoot[]; totalHT: number; totalTax: number; totalTTC: number; }
interface SavedInvoice { id: string; invoiceNumber: string; invoiceDate: string; dateModified?: string; hotel: HotelInfo; hotelKey: string; department: string; monthKey: string; year: string; month: string; rows: Shoot[]; totalHT: number; totalTax: number; totalTTC: number; status: "Original" | "Regenerated"; }
interface GroupRow { label: string; value: number; }
interface ShootForm { date: string; hotel: string; client: string; eventType: string; photoPackage: string; department: string; source: string; ht: string; tax: string; finalAmount: string; status: string; }
interface DirectForm { date: string; client: string; income: string; amount: string; }
interface PriceForm { hotel: string; photoPackage: string; department: string; ht: string; }
interface CalendarEvent { id: number; date: string; time?: string; endTime?: string; title: string; description: string; location: string; imported: boolean; googleEventId?: string; gcalCalendarId?: string; }
interface SavedData { activeTab?: string; shoots?: Shoot[]; directIncome?: DirectRow[]; pricing?: PricingRow[]; query?: string; dashboardYear?: string; dashboardHotel?: string; dashboardMonth?: string; invoiceHotel?: string; invoiceYear?: string; invoiceMonth?: string; invoiceDepartment?: string; generatedInvoice?: GeneratedInvoice | null; calendarEvents?: CalendarEvent[]; invoiceSequences?: Record<string, number>; savedInvoices?: SavedInvoice[]; autoBackupEnabled?: boolean; keepBackupHistory?: boolean; lastBackupAt?: string; editingJobs?: EditingJob[]; gcalSelectedIds?: string[]; gcalHasWriteScope?: boolean; }
interface UndoSnapshot { shoots: Shoot[]; directIncome: DirectRow[]; pricing: PricingRow[]; generatedInvoice: GeneratedInvoice | null; savedInvoices: SavedInvoice[]; invoiceSequences: Record<string, number>; editingJobs: EditingJob[]; }

const HOTEL_INFO: Record<string, HotelInfo> = {
  "Four Seasons": { name: "Four Seasons Resort Bora Bora", address: "Motu Tehotu, Bora Bora, French Polynesia", code: "FSBB" },
  Westin: { name: "The Westin Bora Bora Resort & Spa", address: "Motu Tape, Bora Bora, French Polynesia", code: "WEST" },
  "Le Bora Bora": { name: "Le Bora Bora by Pearl Resorts", address: "Motu Tevairoa, Bora Bora, French Polynesia", code: "LBB" },
  "Le Moana": { name: "InterContinental Bora Bora Le Moana Resort", address: "Matira Point, Bora Bora, French Polynesia", code: "LM" },
  Thalasso: { name: "InterContinental Bora Bora Resort & Thalasso Spa", address: "Motu Piti Aau, Bora Bora, French Polynesia", code: "THAL" },
  "St. Regis": { name: "The St. Regis Bora Bora Resort", address: "Motu Omee, Bora Bora, French Polynesia", code: "SRBB" },
  Conrad: { name: "Conrad Bora Bora Nui", address: "Motu Toopua, Bora Bora, French Polynesia", code: "CON" },
  Mainland: { name: "Mainland / Matira", address: "Bora Bora, French Polynesia", code: "MAIN" },
};

const HOTELS = Object.keys(HOTEL_INFO);
const DASHBOARD_HOTELS = ["St. Regis", "Conrad", "Mainland", "Le Moana"];
const PHOTO_PACKAGES = ["50 photos", "100 photos", "150 photos", "200 photos", "Event / Custom"];
const EVENT_TYPES = ["Honeymoon", "Wedding", "Anniversary", "Proposal", "Engagement", "Family", "Portrait", "Event"];
const SOURCES = ["Resort", "Direct"];
const DEPARTMENTS = ["Concierge", "Event"];
const INVOICE_DEPARTMENTS = ["All Departments", ...DEPARTMENTS];
const STATUS_OPTIONS = ["Paid", "To invoice", "Invoice sent", "Unpaid"];
const DEBUG_MODE = false; // set true to show Debug tab
const TABS = ["Dashboard", "Dashboard V2", "Shoots", "Direct", "Invoices", "Prices", "Calendar", "Editing", ...(DEBUG_MODE ? ["Debug"] : [])];
const MONTH_OPTIONS: [string, string][] = [["01","January"],["02","February"],["03","March"],["04","April"],["05","May"],["06","June"],["07","July"],["08","August"],["09","September"],["10","October"],["11","November"],["12","December"]];
const MONTH_CODES: Record<string, string> = { "01":"JAN","02":"FEB","03":"MAR","04":"APR","05":"MAY","06":"JUN","07":"JUL","08":"AUG","09":"SEP","10":"OCT","11":"NOV","12":"DEC" };

const initialPricing: PricingRow[] = [
  { id: 1, hotel: "Four Seasons", photoPackage: "50 photos", department: "Concierge", ht: 47124 },
  { id: 2, hotel: "Four Seasons", photoPackage: "50 photos", department: "Event", ht: 49115 },
  { id: 3, hotel: "Four Seasons", photoPackage: "100 photos", department: "Concierge", ht: 79646 },
  { id: 4, hotel: "Four Seasons", photoPackage: "100 photos", department: "Event", ht: 79646 },
  { id: 5, hotel: "Four Seasons", photoPackage: "150 photos", department: "Concierge", ht: 109513 },
  { id: 6, hotel: "Four Seasons", photoPackage: "150 photos", department: "Event", ht: 122788 },
  { id: 7, hotel: "Four Seasons", photoPackage: "200 photos", department: "Concierge", ht: 139381 },
  { id: 8, hotel: "Four Seasons", photoPackage: "200 photos", department: "Event", ht: 139381 },
  { id: 9, hotel: "Westin", photoPackage: "50 photos", department: "Concierge", ht: 47124 },
  { id: 10, hotel: "Le Moana", photoPackage: "100 photos", department: "Concierge", ht: 79646 },
  { id: 11, hotel: "St. Regis", photoPackage: "50 photos", department: "Concierge", ht: 47124 },
  { id: 12, hotel: "Conrad", photoPackage: "50 photos", department: "Concierge", ht: 47124 },
  { id: 13, hotel: "Mainland", photoPackage: "50 photos", department: "Concierge", ht: 62832 },
];

const initialShoots: Shoot[] = [
  { id: 1, date: "2026-05-02", hotel: "St. Regis", client: "Yu & Shi", eventType: "Wedding", photoPackage: "100 photos", department: "Event", source: "Resort", ht: 90000, tax: 11700, finalAmount: 101700, status: "To invoice" },
  { id: 2, date: "2026-05-09", hotel: "Conrad", client: "Amanda & Randy", eventType: "Proposal", photoPackage: "50 photos", department: "Concierge", source: "Direct", ht: 71000, tax: 9230, finalAmount: 80230, status: "Paid" },
  { id: 3, date: "2026-05-14", hotel: "Four Seasons", client: "Employee Event", eventType: "Event", photoPackage: "Event / Custom", department: "Event", source: "Resort", ht: 120000, tax: 15600, finalAmount: 135600, status: "To invoice" },
  { id: 4, date: "2026-05-18", hotel: "Le Moana", client: "Cheryl", eventType: "Honeymoon", photoPackage: "100 photos", department: "Concierge", source: "Resort", ht: 110000, tax: 14300, finalAmount: 124300, status: "Paid" },
];

const initialDirectIncome: DirectRow[] = [
  { id: 1, date: "2026-05-10", client: "Amber", income: "Extra Photos", amount: 300 },
  { id: 2, date: "2026-05-15", client: "Cheryl", income: "Extra Photos", amount: 150 },
];

function makeEmptyShoot(pricing: PricingRow[]): ShootForm {
  const hotel = "Four Seasons";
  const photoPackage = "50 photos";
  const department = "Concierge";
  const price = findPrice(pricing, hotel, photoPackage, department);
  const ht = price?.ht || 74000;
  return { date: new Date().toISOString().slice(0, 10), hotel, client: "", eventType: "Honeymoon", photoPackage, department, source: "Resort", ht: String(ht), tax: String(calculateTax(ht)), finalAmount: String(calculateFinalAmount(ht)), status: "To invoice" };
}
const emptyDirect: DirectForm = { date: "2026-05-21", client: "", income: "Extra Photos", amount: "150" };
const DIRECT_INCOME_OPTIONS = ["St. Regis", "Conrad", "Le Moana", "Tips", "Extra Photos", "Prints"];
const emptyPrice: PriceForm = { hotel: "Four Seasons", photoPackage: "50 photos", department: "Concierge", ht: "47124" };

function toNumber(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }
// Parses amounts that may come from Google Sheets as strings: "$100", "1,155.00", "$1,155.00", "1155"
function parseAmount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const s = String(value ?? "").trim().replace(/[$\s]/g, "").replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function numberOnly(value: unknown): string { return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(toNumber(value)); }
function money(value: unknown): string { return numberOnly(value) + " XPF"; }
function usd(value: unknown): string { return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(toNumber(value)); }
function compactMoney(value: unknown): string { const n = toNumber(value); if (Math.abs(n) >= 1000000) return `${(n/1000000).toFixed(1)}M`; if (Math.abs(n) >= 1000) return `${Math.round(n/1000)}K`; return numberOnly(n); }
function calculateTax(ht: unknown): number { return Math.round(toNumber(ht) * TAX_RATE); }
function calculateFinalAmount(ht: unknown): number { return toNumber(ht) + calculateTax(ht); }
function formatDate(date: Date): string { const mon = date.toLocaleString("en-US", { month: "short" }); const day = String(date.getDate()).padStart(2, "0"); return `${mon} ${day}, ${date.getFullYear()}`; }
// Month name → zero-padded number
const MONTH_NAMES: Record<string, string> = {
  jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
  jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
  january:"01",february:"02",march:"03",april:"04",june:"06",
  july:"07",august:"08",september:"09",october:"10",november:"11",december:"12",
};
function parseDateString(date: string): Date | null {
  if (typeof date !== "string") return null;
  const v = date.trim();
  if (!v) return null;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const d = new Date(v + "T00:00:00"); return Number.isNaN(d.getTime()) ? null : d; }
  // "Jan 26, 2022" / "Jan 26 2022" / "January 26, 2022" / "Apr. 03, 2026" — Month Day Year
  const mdy = v.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdy) {
    const mm = MONTH_NAMES[mdy[1].toLowerCase()];
    if (mm) { const d = new Date(`${mdy[3]}-${mm}-${String(mdy[2]).padStart(2,"0")}T00:00:00`); return Number.isNaN(d.getTime()) ? null : d; }
  }
  // "26 Jan 2022" / "26 January 2022" — Day Month Year
  const dmy = v.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (dmy) {
    const mm = MONTH_NAMES[dmy[2].toLowerCase()];
    if (mm) { const d = new Date(`${dmy[3]}-${mm}-${String(dmy[1]).padStart(2,"0")}T00:00:00`); return Number.isNaN(d.getTime()) ? null : d; }
  }
  // DD/MM/YYYY or D/M/YYYY or M/D/YYYY (slash/dot separated) — if first > 12 it must be day
  const slash = v.match(/^(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{4})$/);
  if (slash) {
    const [, a, b, yyyy] = slash.map(Number);
    const [mm, dd] = a > 12 ? [b, a] : [a, b];
    const d = new Date(`${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Last resort: browser parse (handles many locale variants)
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}
function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function normalizeDirect(row: DirectRow): DirectRow {
  const rawDate = String(row.date ?? "").trim();
  const parsed = parseDateString(rawDate);
  return {
    ...row,
    date:   parsed ? dateToIso(parsed) : rawDate,
    client: String(row.client ?? "").trim(),
    income: String(row.income ?? "").trim(),
    amount: parseAmount(row.amount),
  };
}
function displayDate(date: string): string { const d = parseDateString(date); return d ? formatDate(d) : (date || ""); }
function invoiceDateText(value: Date | string): string { const date = value instanceof Date ? value : new Date(value); return formatDate(date); }
function invoiceRowDate(date: string): string { const d = parseDateString(date); return d ? formatDate(d) : (date || ""); }
function monthKey(date: string): string {
  if (typeof date !== "string") return "";
  const v = date.trim();
  if (v.includes("-")) {
    const p = v.split("-");
    if (p.length >= 2) return `${p[0]}-${p[1].padStart(2, "0")}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) {
    const [a, b, yyyy] = v.split("/").map(Number);
    const [mm] = a > 12 ? [b] : [a];
    return `${yyyy}-${String(mm).padStart(2, "0")}`;
  }
  const parsed = parseDateString(v);
  if (parsed) return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
  return "";
}
function yearFromMonth(month: string): string { return typeof month === "string" && month.length >= 4 ? month.slice(0, 4) : ""; }
function monthName(value: string): string { return MONTH_OPTIONS.find(([key]) => key === value)?.[1] || value; }
function shortMonth(month: string): string { return monthName(String(month).split("-")[1]).slice(0, 3); }
const HOTEL_CODES: Record<string, string> = {
  "Four Seasons": "FOU", "Westin": "WES", "Le Bora Bora": "LBB",
  "Le Moana": "LMO", "Thalasso": "THA", "St. Regis": "STR",
  "Conrad": "CNR", "Mainland": "MNL",
};
function makeInvoiceNumber(hotel: string, _month: string, sequence = 1): string {
  const code = HOTEL_CODES[hotel] || "INV";
  return `${code}-${String(sequence).padStart(3, "0")}`;
}
function hotelCode(hotel: string): string {
  return HOTEL_CODES[hotel] || "INV";
}
function findPrice(pricing: PricingRow[], hotel: string, photoPackage: string, department: string): PricingRow | null { return (Array.isArray(pricing) ? pricing : []).find(row => row.hotel === hotel && row.photoPackage === photoPackage && row.department === department) || null; }
function calculateTotals(shoots: Shoot[], directIncome: DirectRow[]): { ht: number; tax: number; finalAmount: number; direct: number; net: number } {
  const s = Array.isArray(shoots) ? shoots : [];
  const d = Array.isArray(directIncome) ? directIncome : [];
  const ht = s.reduce((sum, row) => sum + toNumber(row.ht), 0);
  const tax = s.reduce((sum, row) => sum + toNumber(row.tax), 0);
  const finalAmount = s.reduce((sum, row) => sum + toNumber(row.finalAmount), 0);
  const direct = d.reduce((sum, row) => sum + parseAmount(row.amount), 0);
  return { ht, tax, finalAmount, direct, net: finalAmount + direct };
}
function buildMonthlyData(shoots: Shoot[], directIncome: DirectRow[]): { month: string; revenue: number }[] {
  const map = new Map<string, number>();
  (shoots || []).forEach(row => { const key = monthKey(row.date); if (key) map.set(key, (map.get(key) || 0) + toNumber(row.ht)); });
  (directIncome || []).forEach(row => { const key = monthKey(row.date); if (key) map.set(key, (map.get(key) || 0) + parseAmount(row.amount)); });
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([month, revenue]) => ({ month, revenue }));
}
// Derives years directly from dates in both arrays — never silently drops a year because revenue is 0
function getYears(shoots: Shoot[], directIncome: DirectRow[]): string[] {
  const years = new Set<string>();
  const addYear = (date: string) => {
    const y = yearFromMonth(monthKey(date));
    if (y) years.add(y);
  };
  (shoots || []).forEach(row => addYear(row.date));
  (directIncome || []).forEach(row => addYear(row.date));
  return Array.from(years).sort();
}
function filterDashboard(shoots: Shoot[], directIncome: DirectRow[], year: string, hotel: string, selectedMonth: string): {
  filteredShoots: Shoot[];
  filteredDirectAll: DirectRow[];   // year+month only — used for Direct totals & analytics
  filteredDirectHotel: DirectRow[]; // year+month+hotel — used for per-hotel header breakdown
} {
  const inYear  = (date: string) => year  === "All" || yearFromMonth(monthKey(date)) === year;
  const inMonth = (date: string) => selectedMonth === "All" || monthKey(date).endsWith(`-${selectedMonth}`);

  const filteredShoots = shoots.filter(row =>
    inYear(row.date) && inMonth(row.date) &&
    (hotel === "All Hotels" || row.hotel === hotel)
  );

  // Direct is never filtered by hotel — year + month only
  const filteredDirectAll = directIncome.filter(row => inYear(row.date) && inMonth(row.date));

  // For per-hotel direct breakdown (header cards): income must match the selected hotel
  const filteredDirectHotel = hotel === "All Hotels"
    ? filteredDirectAll
    : filteredDirectAll.filter(row =>
        row.income === hotel ||
        row.income.toLowerCase().includes(hotel.toLowerCase())
      );

  return { filteredShoots, filteredDirectAll, filteredDirectHotel };
}
function getInvoiceRows(shoots: Shoot[], hotel: string, month: string, department: string): Shoot[] { return shoots.filter(row => { const departmentMatch = department === "All Departments" || row.department === department; return row.hotel === hotel && row.source === "Resort" && monthKey(row.date) === month && departmentMatch; }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()); }
function groupRowsByDepartment(rows: Shoot[]): Record<string, Shoot[]> { const groups: Record<string, Shoot[]> = {}; rows.forEach(row => { const key = row.department || "Other"; if (!groups[key]) groups[key] = []; groups[key].push(row); }); return groups; }
function groupSum(rows: (Shoot | DirectRow)[], key: string, valueKey: string): GroupRow[] { const map = new Map<string, number>(); (Array.isArray(rows) ? rows : []).forEach(row => { const record = row as unknown as Record<string, unknown>; const label = (record[key] as string) || "Other"; const value = valueKey === "count" ? 1 : valueKey === "amount" ? parseAmount(record[valueKey]) : toNumber(record[valueKey]); map.set(label, (map.get(label) || 0) + value); }); return Array.from(map.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); }
function uniqueShoots(rows: Shoot[]): Shoot[] { const seen = new Set<string>(); return rows.filter(row => { const key = [row.date, row.hotel, row.client, row.photoPackage, row.ht].join("|").toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); }
function uniqueDirectIncome(rows: DirectRow[]): DirectRow[] { const seen = new Set<string>(); return rows.filter(row => { const key = [row.date, row.client, row.income, row.amount].join("|").toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); }
function dedupePricing(rows: PricingRow[]): PricingRow[] { const map = new Map<string, PricingRow>(); rows.forEach(row => { const key = `${row.hotel}|${row.photoPackage}|${row.department}`; map.set(key, row); }); return Array.from(map.values()); }
function loadSavedData(): SavedData | null { if (typeof window === "undefined") return null; try { const raw = window.localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) as SavedData : null; } catch { return null; } }
function saveData(data: SavedData): void { if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function downloadJson(filename: string, data: unknown): void { const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); }

// File System Access API types
declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: string; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
  }
}

const BACKUP_FOLDER_KEY = "sasha-backup-folder-handle";

function hasFileSystemAccess(): boolean { return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"; }

async function getStoredFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get(BACKUP_FOLDER_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

async function storeFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, BACKUP_FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* silently ignore — fallback download will still work */ }
}

async function clearStoredFolderHandle(): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").delete(BACKUP_FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("sasha-fs-handles", 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("handles")) req.result.createObjectStore("handles"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function verifyPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    // @ts-expect-error queryPermission is not in all TS lib versions yet
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") return true;
    // @ts-expect-error requestPermission is not in all TS lib versions yet
    const req = await handle.requestPermission({ mode: "readwrite" });
    return req === "granted";
  } catch { return false; }
}

const BACKUP_MAIN_FILE = "sasha-accounting-backup.json";
const BACKUP_TEMP_FILE = "sasha-accounting-backup.tmp.json";

function backupTimestampedFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `sasha-accounting-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
}

async function writeToFolderAtomic(dir: FileSystemDirectoryHandle, filename: string, content: string): Promise<void> {
  // Write to temp file first, then rename — guards against corruption if interrupted.
  // The File System Access API doesn't expose rename, so we write temp then overwrite main.
  // Writing directly with { keepExistingData: false } (the default) is already safe in FSAPI,
  // but we do a double-write pass: temp first, then main, so the previous main is intact until
  // the new write is complete.
  const tmp = await dir.getFileHandle(BACKUP_TEMP_FILE, { create: true });
  const tw = await tmp.createWritable({ keepExistingData: false });
  await tw.write(content);
  await tw.close();
  // Now overwrite the real file
  const main = await dir.getFileHandle(filename, { create: true });
  const mw = await main.createWritable({ keepExistingData: false });
  await mw.write(content);
  await mw.close();
  // Clean up temp
  try { await dir.removeEntry(BACKUP_TEMP_FILE); } catch { /* ignore */ }
}

interface Toast { id: number; message: string; type: "success" | "error"; }

// ─── Google Calendar types ────────────────────────────────────────────────────
interface GCalendarListEntry { id: string; summary: string; backgroundColor?: string; selected?: boolean; primary?: boolean; }
interface GCalendarEventItem {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  status?: string;
}
declare global {
  interface Window {
    gapi?: {
      load: (lib: string, cb: () => void) => void;
      client: {
        init: (cfg: { discoveryDocs: string[] }) => Promise<void>;
        setToken: (token: { access_token: string } | null) => void;
        calendar: {
          calendarList: { list: (p: Record<string, unknown>) => Promise<{ result: { items?: GCalendarListEntry[] } }> };
          events: {
            list:   (p: Record<string, unknown>) => Promise<{ result: { items?: GCalendarEventItem[]; nextPageToken?: string } }>;
            insert: (p: { calendarId: string; resource: Record<string, unknown> }) => Promise<{ result: GCalendarEventItem }>;
            update: (p: { calendarId: string; eventId: string; resource: Record<string, unknown> }) => Promise<{ result: GCalendarEventItem }>;
            delete: (p: { calendarId: string; eventId: string }) => Promise<void>;
          };
        };
      };
    };
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (resp: { access_token?: string; error?: string }) => void;
          }) => { requestAccessToken: () => void };
          revoke: (token: string, cb: () => void) => void;
        };
      };
    };
  }
}

const GOOGLE_SCOPES_READ  = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SCOPES_WRITE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SCOPES = GOOGLE_SCOPES_READ;
const GCAL_DISCOVERY = "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";

async function gapiLoadClient(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!window.gapi) return reject(new Error("gapi not loaded"));
    window.gapi.load("client", async () => {
      try {
        await window.gapi!.client.init({ discoveryDocs: [GCAL_DISCOVERY] });
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

async function fetchGoogleCalendars(accessToken: string): Promise<GCalendarListEntry[]> {
  window.gapi!.client.setToken({ access_token: accessToken });
  const res = await window.gapi!.client.calendar.calendarList.list({ minAccessRole: "reader" });
  return res.result.items || [];
}

async function fetchGoogleEvents(accessToken: string, calendarId: string, maxResults = 2500): Promise<GCalendarEventItem[]> {
  window.gapi!.client.setToken({ access_token: accessToken });
  // Fetch from 2022 so Calendar Analytics can compare multi-year history
  const historyStart  = new Date("2022-01-01T00:00:00Z").toISOString();
  const twoYearsAhead = new Date(new Date().getFullYear() + 2, 11, 31).toISOString();
  const items: GCalendarEventItem[] = [];
  let pageToken: string | undefined;
  do {
    const res = await window.gapi!.client.calendar.events.list({
      calendarId,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: historyStart,
      timeMax: twoYearsAhead,
      ...(pageToken ? { pageToken } : {}),
    });
    items.push(...(res.result.items || []));
    pageToken = res.result.nextPageToken;
  } while (pageToken);
  return items;
}

// ─── Google Calendar write helpers ───────────────────────────────────────────

function buildGCalResource(event: { date: string; time?: string; endTime?: string; title: string; description?: string; location?: string }) {
  const start = event.time
    ? { dateTime: `${event.date}T${event.time}:00-10:00`, timeZone: "Pacific/Tahiti" }
    : { date: event.date };
  const end = event.endTime
    ? { dateTime: `${event.date}T${event.endTime}:00-10:00`, timeZone: "Pacific/Tahiti" }
    : event.time
    ? { dateTime: `${event.date}T${event.time}:00-10:00`, timeZone: "Pacific/Tahiti" }
    : { date: event.date };
  return {
    summary:     event.title,
    description: event.description || "",
    location:    event.location    || "",
    start,
    end,
  };
}

async function createGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: { date: string; time?: string; endTime?: string; title: string; description?: string; location?: string },
): Promise<string> {
  console.log("creating Google event", { calendarId, title: event.title, date: event.date });
  window.gapi!.client.setToken({ access_token: accessToken });
  const resource = buildGCalResource(event);
  const res = await window.gapi!.client.calendar.events.insert({ calendarId, resource });
  const googleEventId = res.result.id;
  console.log("created googleEventId", googleEventId);
  return googleEventId;
}

async function updateGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  event: { date: string; time?: string; endTime?: string; title: string; description?: string; location?: string },
): Promise<void> {
  console.log("updating Google event", { calendarId, googleEventId, title: event.title });
  window.gapi!.client.setToken({ access_token: accessToken });
  const resource = buildGCalResource(event);
  await window.gapi!.client.calendar.events.update({ calendarId, eventId: googleEventId, resource });
}

async function deleteGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<void> {
  console.log("deleting Google event", { calendarId, googleEventId });
  window.gapi!.client.setToken({ access_token: accessToken });
  await window.gapi!.client.calendar.events.delete({ calendarId, eventId: googleEventId });
}

// Expands a Google Calendar event item into one CalendarEvent per day it spans.
// Single-day events produce exactly one entry (preserving original googleEventId).
// Multi-day events produce N entries — each gets a stable synthetic id like
// "{googleId}_d{YYYY-MM-DD}" so re-syncs match correctly without churn.
function gCalEventToCalendarEvents(item: GCalendarEventItem, baseIndex: number, calendarId?: string): CalendarEvent[] {
  const title = (item.summary || "").trim();
  if (!title || item.status === "cancelled") return [];

  const rawDesc = item.description || "";
  const description = stripHtml(cleanIcsText(rawDesc))
    .replace(/\s*[-–]\s*event reminder[^\n]*/gi, "")
    .replace(/\s*reminders?:[^\n]*/gi, "")
    .trim();
  const location = (item.location || "").trim();
  const googleEventId = item.id || undefined;

  // ── Determine if all-day (date-only) or timed ────────────────────────────
  const isAllDay = !!(item.start?.date && !item.start?.dateTime);

  let startDate = "";
  let endDate   = "";
  let time: string | undefined;
  let endTime: string | undefined;

  if (isAllDay) {
    startDate = item.start!.date!;
    // Google all-day end.date is exclusive (July 1–4 means July 1, 2, 3)
    const rawEnd = item.end?.date ?? startDate;
    // Subtract one day from exclusive end to get inclusive end
    const endMs = new Date(rawEnd + "T00:00:00Z").getTime() - 86400000;
    endDate = new Date(endMs).toISOString().slice(0, 10);
  } else if (item.start?.dateTime) {
    const s = utcIsoToTahiti(item.start.dateTime);
    startDate = s.date;
    time = s.time || undefined;
    if (item.end?.dateTime) {
      const e = utcIsoToTahiti(item.end.dateTime);
      endDate  = e.date;
      endTime  = e.time || undefined;
    } else {
      endDate = startDate;
    }
  }

  if (!startDate) return [];

  // Clamp endDate to startDate if end somehow precedes start
  if (endDate < startDate) endDate = startDate;

  // Collect all calendar dates between startDate and endDate (inclusive)
  const renderedDates: string[] = [];
  {
    const cur = new Date(startDate + "T00:00:00Z");
    const end = new Date(endDate   + "T00:00:00Z");
    while (cur <= end) {
      renderedDates.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  // Build a temporary CalendarEvent to run classification helpers on
  const tempEvent = { id: 0, date: startDate, title, description, location, imported: false };
  const detectedHotel   = guessHotelFromCalendarEvent(tempEvent);
  const isShoot         = isPhotographyEvent(tempEvent);
  const isPersonal      = isPersonalEvent(tempEvent);

  console.log("[GCal] event classified", {
    calendarId,
    summary:           title,
    description:       description.slice(0, 120),
    start:             item.start,
    end:               item.end,
    isAllDay,
    renderedDates,
    detectedHotel,
    isPhotoshoot:      isShoot,
    isPersonal,
  });

  // Single-day — return one event with the original googleEventId
  if (renderedDates.length === 1) {
    return [{
      id:             Date.now() + baseIndex,
      date:           renderedDates[0],
      time,
      endTime:        endDate === startDate ? endTime : undefined,
      title,
      description,
      location,
      imported:       false,
      googleEventId,
      gcalCalendarId: calendarId,
    }];
  }

  // Multi-day — one entry per day, each with a stable synthetic googleEventId
  return renderedDates.map((date, dayIdx) => ({
    id:             Date.now() + baseIndex * 1000 + dayIdx,
    date,
    time:           dayIdx === 0 ? time : undefined,
    endTime:        dayIdx === renderedDates.length - 1 ? endTime : undefined,
    title,
    description,
    location,
    imported:       false,
    // Stable per-day key so re-syncs match without churn
    googleEventId:  googleEventId ? `${googleEventId}_d${date}` : undefined,
    gcalCalendarId: calendarId,
  }));
}

// Kept for backward compat — single-event wrapper used nowhere else.
function gCalEventToCalendarEvent(item: GCalendarEventItem, index: number, calendarId?: string): CalendarEvent | null {
  const results = gCalEventToCalendarEvents(item, index, calendarId);
  return results.length > 0 ? results[0] : null;
}

// ─── End Google Calendar ──────────────────────────────────────────────────────

// ─── Pacific/Tahiti timezone helpers (UTC-10, no DST) ────────────────────────
const TAHITI_TZ = "Pacific/Tahiti";
const TAHITI_OFFSET_MS = -10 * 60 * 60 * 1000; // kept for tahitiNow/tahitiDateStr
function tahitiNow(): Date { return new Date(Date.now() + TAHITI_OFFSET_MS); }
function tahitiDateStr(d?: Date): string {
  const t = d ?? tahitiNow();
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const day = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Convert any ISO dateTime string (from Google/ICS, any offset) to Tahiti local date+time
// Uses Intl.DateTimeFormat so the browser handles the tz conversion correctly regardless
// of what offset Google embedded in the string.
function utcIsoToTahiti(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: "", time: "" };
  const fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAHITI_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const fmtTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: TAHITI_TZ,
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const date = fmtDate.format(d); // "YYYY-MM-DD" from en-CA locale
  const time = fmtTime.format(d).replace(":", ":").slice(0, 5); // "HH:MM"
  return { date, time };
}
function daysUntilTahiti(dateStr: string): number {
  const today = tahitiDateStr();
  const [ty, tm, td] = today.split("-").map(Number);
  const [ey, em, ed] = dateStr.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const eventMs = Date.UTC(ey, em - 1, ed);
  return Math.round((eventMs - todayMs) / 86400000);
}
function getDateBucketTahiti(dateStr: string): "today" | "tomorrow" | "week" | "upcoming" | "past" {
  const d = daysUntilTahiti(dateStr);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d > 1 && d <= 7) return "week";
  if (d > 7) return "upcoming";
  return "past";
}

function parseIcsDateRaw(value: unknown): { date: string; time?: string } {
  const raw = String(value || "").trim();
  const isAllDay = !raw.includes("T");
  const clean = raw.replace("Z", "");
  const y = clean.slice(0, 4); const mo = clean.slice(4, 6); const d = clean.slice(6, 8);
  if (!y || !mo || !d) return { date: "" };
  if (isAllDay) return { date: `${y}-${mo}-${d}` };
  // Has time component — build ISO and convert to Tahiti
  const h = clean.slice(9, 11) || "00"; const mi = clean.slice(11, 13) || "00";
  const isoUtc = `${y}-${mo}-${d}T${h}:${mi}:00Z`;
  if (raw.endsWith("Z")) return utcIsoToTahiti(isoUtc);
  // Local/floating time — treat as Tahiti local already
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/[ \t]{2,}/g, " ").replace(/(\n\s*){3,}/g, "\n\n").trim();
}
function cleanIcsText(value: unknown): string {
  return String(value || "")
    .replace(/\\,/g, ",").replace(/\\n/g, "\n").replace(/\\;/g, ";")
    .replace(/\\:/g, ":").replace(/\\\\/g, "\\").trim();
}
function cleanIcsDescription(raw: string): string {
  const unescaped = cleanIcsText(raw);
  const stripped = stripHtml(unescaped);
  // Remove generic "event reminder" boilerplate
  return stripped.replace(/\s*[-–]\s*event reminder[^\n]*/gi, "").replace(/\s*reminders?:[^\n]*/gi, "").trim() || "";
}
function parseIcsEvents(text: string): CalendarEvent[] {
  return String(text || "").split("BEGIN:VEVENT").slice(1).map((block, index) => {
    const getRaw = (name: string) => {
      const match = block.match(new RegExp(`${name}(?:;[^:\\r\\n]*)?:([^\\r\\n]*)`, "i"));
      return match ? match[1] : "";
    };
    const title = cleanIcsText(getRaw("SUMMARY"));
    const description = cleanIcsDescription(getRaw("DESCRIPTION"));
    const location = cleanIcsText(getRaw("LOCATION"));
    const { date, time } = parseIcsDateRaw(cleanIcsText(getRaw("DTSTART")));
    const { time: endTime } = parseIcsDateRaw(cleanIcsText(getRaw("DTEND")));
    if (!date || !title) return null;
    return { id: Date.now() + index, date, time, endTime, title, description, location, imported: false };
  }).filter((e): e is NonNullable<typeof e> => e !== null) as CalendarEvent[];
}

// ─── Parse Google Calendar / ICS title: "Hotel / Package - Client" ────────────
interface ParsedTitle {
  hotel: string;
  client: string;
  pkg: string;
  eventType: string;
  parsedFrom: "title" | "location" | "description" | "default";
}
// Order matters: more specific patterns first (e.g. "le bora bora" before "le moana")
const HOTEL_PATTERNS: [RegExp, string][] = [
  // Four Seasons — all typo variants + FSBB
  [/f(?:our|orr|our)\s*sea?s(?:o|0)n[s]?|four\s*sea[so]+n|fsbb/i, "Four Seasons"],
  // St. Regis — fuzzy: "st regis", "stregis", "st regsi", "regis", "str"
  [/st\.?\s*re?g[ei]s[i]?|stregis|\bregis\b|\bstr\b/i, "St. Regis"],
  // Le Bora Bora — before generic "le" patterns
  [/le\s*bora\s*bora|pearl\s*resort/i, "Le Bora Bora"],
  // Le Moana
  [/le\s*moana|intercontinental\s*(?:bora\s*bora\s*)?moana|ic\s*moana/i, "Le Moana"],
  // Thalasso — typo variants
  [/thala?s{1,3}o{1,2}|ic\s*thalasso/i, "Thalasso"],
  // Conrad — typo variants
  [/\bconrad\b|conr?a?d|cnr\b|conrad\s*bora/i, "Conrad"],
  // Westin — typo variants
  [/w[es]{1,2}tin/i, "Westin"],
  // Intercontinental fallback → Le Moana
  [/intercontinental/i, "Le Moana"],
  // Mainland
  [/matira/i, "Mainland"],
];
const EVENT_TYPE_PATTERNS: [RegExp, string][] = [
  [/wedding|mariage/i, "Wedding"],
  [/honeymoon|lune\s*de\s*miel/i, "Honeymoon"],
  [/proposal|demande/i, "Proposal"],
  [/engagement/i, "Engagement"],
  [/anniversary|anniversaire(?!\s+de)/i, "Anniversary"],
  [/family|famille/i, "Family"],
  [/portrait/i, "Portrait"],
];

function extractHotelFromText(text: string): string {
  for (const [re, name] of HOTEL_PATTERNS) {
    if (re.test(text)) return name;
  }
  return "";
}
function extractEventTypeFromText(text: string): string {
  for (const [re, name] of EVENT_TYPE_PATTERNS) {
    if (re.test(text)) return name;
  }
  return "";
}
function extractPackageFromText(text: string): string {
  // Hour-based: 1h/1 hour → 50, 2h/2 hours → 100, 3h → 150, 4h → 200
  const hourMatch = text.match(/\b([1-4])\s*h(?:(?:ou)?r)?s?\b/i);
  if (hourMatch) {
    const h = parseInt(hourMatch[1]);
    if (h === 1) return "50 photos";
    if (h === 2) return "100 photos";
    if (h === 3) return "150 photos";
    if (h === 4) return "200 photos";
  }
  // Photo count: allow typos like "phtos", "potos"
  const photoMatch = text.match(/(\d{2,3})\s*ph?[o0]t(?:o|0)?s?/i);
  if (photoMatch) {
    const n = parseInt(photoMatch[1]);
    if (n <= 60) return "50 photos";
    if (n <= 110) return "100 photos";
    if (n <= 160) return "150 photos";
    return "200 photos";
  }
  return "";
}

function parseCalendarTitle(event: CalendarEvent): ParsedTitle {
  const raw = event.title.trim();
  // Split on " / " first (primary separator)
  const slashParts = raw.split(/\s*\/\s*/);
  // Find dash in the full raw title for client splitting
  const dashIdx = raw.indexOf(" - ");
  const afterDash = dashIdx !== -1 ? raw.slice(dashIdx + 3).trim() : "";
  // Build search text: everything before the dash (which includes hotel + package segments)
  const beforeDash = dashIdx !== -1 ? raw.slice(0, dashIdx).trim() : raw;

  // 1. Hotel: title is always primary source — search full title (minus client part after dash)
  let hotel = extractHotelFromText(beforeDash);
  let parsedFrom: ParsedTitle["parsedFrom"] = "title";

  if (!hotel) {
    // Fallback: try after the dash too (in case title is just "Package - Hotel / Client")
    hotel = extractHotelFromText(raw);
    if (hotel) parsedFrom = "title";
  }
  if (!hotel) {
    hotel = extractHotelFromText(event.location || "");
    if (hotel) parsedFrom = "location";
  }
  if (!hotel) {
    hotel = extractHotelFromText(event.description || "");
    if (hotel) parsedFrom = "description";
  }
  if (!hotel) {
    hotel = "Unknown";
    parsedFrom = "default";
  }

  // 2. Package: look across full title + description
  const pkg = extractPackageFromText(raw) || extractPackageFromText(event.description || "") || "50 photos";

  // 3. Event type
  const eventType = extractEventTypeFromText(raw) || extractEventTypeFromText(event.description || "") || "Honeymoon";

  // 4. Client: prefer text after " - " in title; otherwise strip hotel/package/keywords
  let client = afterDash;
  if (!client && slashParts.length > 1) {
    // Last slash segment might be the client when format is "Hotel / Client"
    const lastSeg = slashParts[slashParts.length - 1].trim();
    // Only use it as client if it doesn't itself contain a hotel keyword
    if (!extractHotelFromText(lastSeg)) {
      client = lastSeg
        .replace(extractPackageFromText(lastSeg) ? /\d{1,3}\s*ph?[o0]t(?:o|0)?s?|\bh(?:(?:ou)?r)?s?\b/gi : /(?:)/, "")
        .trim();
    }
  }
  if (!client) {
    client = raw
      .replace(new RegExp(hotel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
      .replace(/\d{2,3}\s*ph?[o0]t(?:o|0)?s?/gi, "")
      .replace(/\b[1-4]\s*h(?:(?:ou)?r)?s?\b/gi, "")
      .replace(/wedding|mariage|honeymoon|lune de miel|proposal|engagement|anniversary|anniversaire|family|famille|portrait/gi, "")
      .replace(/[-–—|/]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  return { hotel, client, pkg, eventType, parsedFrom };
}

function guessHotelFromCalendarEvent(event: CalendarEvent): string {
  return parseCalendarTitle(event).hotel;
}
function guessEventTypeFromCalendarEvent(event: CalendarEvent): string {
  return parseCalendarTitle(event).eventType;
}
function guessPackageFromCalendarEvent(event: CalendarEvent): string {
  return parseCalendarTitle(event).pkg;
}
function guessClientNameFromCalendarEvent(event: CalendarEvent): string {
  return parseCalendarTitle(event).client;
}

function normalizeStr(s: string): string {
  return (s ?? "").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,]/g, "");
}

function isCalendarEventAdded(event: CalendarEvent, shoots: Shoot[], sheetJobs: SheetJob[] = []): boolean {
  const { hotel, client } = parseCalendarTitle(event);
  const normClient = normalizeStr(client);
  const normHotel  = normalizeStr(hotel);
  // Check resort shoots tab
  if (shoots.some(s =>
    s.date === event.date
    && normalizeStr(s.hotel) === normHotel
    && normalizeStr(s.client) === normClient
  )) return true;
  // Check editing pipeline (catches direct client adds too)
  if (sheetJobs.some(j =>
    j.herman.date === event.date
    && normalizeStr(j.herman.galleryName) === normClient
  )) return true;
  return false;
}

function calendarEventToShoot(event: CalendarEvent, pricing: PricingRow[]): Shoot {
  const { hotel, client, pkg: photoPackage, eventType } = parseCalendarTitle(event);
  const price = findPrice(pricing, hotel, photoPackage, "Concierge");
  const ht = price?.ht || 71000;
  return { id: Date.now(), date: event.date, hotel, client, eventType, photoPackage, department: "Concierge", source: "Resort", ht, tax: calculateTax(ht), finalAmount: calculateFinalAmount(ht), status: "To invoice" };
}

function invoiceHtml(invoice: GeneratedInvoice | null): string {
  const rows = Array.isArray(invoice?.rows) ? invoice!.rows : [];
  const rowHtml = rows.length ? rows.map(row => `<tr><td>${invoiceRowDate(row.date)}</td><td><strong>${row.client || ""}</strong></td><td>${row.photoPackage || ""}</td><td class="right">${numberOnly(row.ht)}</td><td class="right">${numberOnly(row.tax)}</td><td class="right"><strong>${numberOnly(row.finalAmount)}</strong></td></tr>`).join("") : `<tr><td colspan="6" class="empty">No invoice rows for this hotel and month.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${invoice?.invoiceNumber || "Invoice"}</title><style>@page{size:A4;margin:12mm 10mm}*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6efe4;color:#292524}.page{padding:18px;background:#fbf7ef;border:1px solid #e7dfd2;border-radius:28px}.top{display:flex;justify-content:space-between;gap:32px;border-bottom:1px solid #d6cabb;padding-bottom:28px;margin-bottom:32px}.label{font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:#78716c}h1{margin:6px 0 10px;font-weight:300;font-size:30px;letter-spacing:-.04em}p{margin:4px 0;color:#57534e;font-size:13px}.rightText{text-align:right;max-width:320px}.hotel{margin-top:12px;font-size:18px;color:#292524;font-weight:500}table{width:100%;border-collapse:collapse;background:rgba(255,255,255,.65);border-radius:22px;overflow:hidden}th{text-align:left;padding:6px 8px;color:#78716c;font-size:10px;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid #e7dfd2}td{padding:5px 8px;border-bottom:1px solid #eee8df;font-size:10px;color:#44403c}.right{text-align:right}.empty{text-align:center;padding:40px;color:#78716c}.bottom{display:grid;grid-template-columns:1fr 260px;gap:16px;margin-top:18px}.info{background:rgba(255,255,255,.55);border-radius:24px;padding:20px;font-size:11px;line-height:1.7;color:#57534e}.totals{background:#e7e0d5;color:#292524;border-radius:24px;padding:20px}.totalRow{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.08);color:#57534e;font-size:12px}.grand{display:flex;justify-content:space-between;align-items:baseline;padding-top:14px;color:#292524;font-size:18px;font-weight:700}.grand-amount{display:flex;align-items:baseline;gap:4px}.grand-xpf{font-size:11px;font-weight:400;color:#78716c}@media print{body{background:white}.page{border:none;border-radius:0;padding:12mm 8mm}}</style></head><body><main class="page"><section class="top"><div><div class="label">Sasha Popovic Photography</div><h1>Invoice</h1><p>Invoice number: <strong>${invoice?.invoiceNumber || ""}</strong></p><p>Date: ${invoice?.invoiceDate || ""}</p><p>Period: ${invoice?.month || ""}</p></div><div class="rightText"><div class="label">Billed to</div><div class="hotel">${invoice?.hotel?.name || ""}</div><p>${invoice?.hotel?.address || ""}</p></div></section><table><thead><tr><th>Date</th><th>Client</th><th>Package</th><th class="right">HT</th><th class="right">TVA 13%</th><th class="right">TTC</th></tr></thead><tbody>${rowHtml}</tbody></table><section class="bottom"><div class="info"><strong>SASHA POPOVIC / PHOTOGRAPHY</strong><br/>N° TAHITI D78486 · RCS: 20 1332 A<br/>BP 581 Vaitape, 98730 Bora Bora<br/>Mobile: +689 89 25 09 15<br/>Email: INFO@SASHAPOPOVIC.COM · Web: WWW.SASHAPOPOVIC.COM<br/><br/><strong>Banque de Tahiti</strong><br/>Banque: 12239 · Code guichet: 00004 · Compte: 47941801000 · Clé RIB: 037</div><div class="totals"><div class="totalRow"><span>Total HT</span><span>${money(invoice?.totalHT)}</span></div><div class="totalRow"><span>TVA 13%</span><span>${money(invoice?.totalTax)}</span></div><div class="grand"><span>Total TTC</span><div class="grand-amount"><span>${numberOnly(invoice?.totalTTC)}</span><span class="grand-xpf">XPF</span></div></div></div></section></main></body></html>`;
}
function printInvoice(invoice: GeneratedInvoice | null): void { if (!invoice) return; const w = window.open("", "_blank", "width=900,height=1200"); if (!w) { alert("Popup blocked. Please allow popups for this app, then try again."); return; } w.document.open(); w.document.write(invoiceHtml(invoice)); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }

// Generates a lightweight vector PDF using jsPDF primitives only.
// No html2canvas, no canvas rasterization — pure text + lines = tiny file.
async function generateInvoicePdfBlob(invoice: GeneratedInvoice): Promise<Blob | null> {
  try {
    const { default: jsPDF } = await import("jspdf");

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

    // ── Palette ──────────────────────────────────────────────────────────────
    const BLACK  = [18, 18, 18]   as [number, number, number];
    const DARK   = [41, 37, 36]   as [number, number, number];
    const MID    = [87, 83, 78]   as [number, number, number];
    const SUBTLE = [168, 162, 158] as [number, number, number];
    const GOLD   = [180, 152, 96] as [number, number, number];
    const BG     = [252, 250, 247] as [number, number, number];
    const CELL   = [248, 245, 240] as [number, number, number];
    const TOTBG  = [235, 229, 218] as [number, number, number];

    const W = 210; // A4 width mm
    const H = 297; // A4 height mm
    const ML = 16; // margin left
    const MR = W - 16; // margin right
    const CW = MR - ML; // content width

    // ── Background ───────────────────────────────────────────────────────────
    doc.setFillColor(...BG);
    doc.rect(0, 0, W, H, "F");

    // ── Gold accent bar (top) ────────────────────────────────────────────────
    doc.setFillColor(...GOLD);
    doc.rect(0, 0, W, 1.2, "F");

    let y = 18;

    // ── Header: left block ───────────────────────────────────────────────────
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...SUBTLE);
    doc.text("SASHA POPOVIC PHOTOGRAPHY", ML, y);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(28);
    doc.setTextColor(...DARK);
    doc.text("Invoice", ML, y + 9);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MID);
    doc.text(`Invoice number: ${invoice.invoiceNumber}`, ML, y + 16);
    doc.text(`Date: ${invoice.invoiceDate}`, ML, y + 21);
    doc.text(`Period: ${invoice.month}`, ML, y + 26);

    // ── Header: right block (Billed to) ──────────────────────────────────────
    const RX = ML + CW * 0.56;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...SUBTLE);
    doc.text("BILLED TO", RX, y);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...DARK);
    const hotelLines = doc.splitTextToSize(invoice.hotel?.name || "", CW * 0.42);
    doc.text(hotelLines, RX, y + 6);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MID);
    const addrLines = doc.splitTextToSize(invoice.hotel?.address || "", CW * 0.42);
    doc.text(addrLines, RX, y + 6 + hotelLines.length * 5);

    y += 35;

    // ── Divider ───────────────────────────────────────────────────────────────
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.4);
    doc.line(ML, y, MR, y);
    y += 7;

    // ── Table header ─────────────────────────────────────────────────────────
    const COL = {
      date:    { x: ML,          w: 26 },
      client:  { x: ML + 26,     w: 40 },
      pkg:     { x: ML + 66,     w: 46 },
      ht:      { x: ML + 112,    w: 26 },
      tax:     { x: ML + 138,    w: 26 },
      ttc:     { x: ML + 164,    w: MR - ML - 164 },
    };

    doc.setFillColor(...CELL);
    doc.rect(ML, y - 4, CW, 7, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(...SUBTLE);
    doc.text("DATE",     COL.date.x + 1,   y);
    doc.text("CLIENT",   COL.client.x + 1, y);
    doc.text("PACKAGE",  COL.pkg.x + 1,    y);
    doc.text("HT",       COL.ht.x + COL.ht.w,  y, { align: "right" });
    doc.text("TVA 13%",  COL.tax.x + COL.tax.w, y, { align: "right" });
    doc.text("TTC",      COL.ttc.x + COL.ttc.w, y, { align: "right" });

    y += 5;

    // ── Table rows ────────────────────────────────────────────────────────────
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    const rows = Array.isArray(invoice.rows) ? invoice.rows : [];

    if (rows.length === 0) {
      doc.setTextColor(...SUBTLE);
      doc.text("No invoice rows for this hotel and month.", W / 2, y + 6, { align: "center" });
      y += 14;
    } else {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rowBg = i % 2 === 0;
        const rowH = 7;

        if (rowBg) {
          doc.setFillColor(255, 255, 255);
          doc.rect(ML, y - 4, CW, rowH, "F");
        }

        doc.setTextColor(...DARK);
        doc.setFont("helvetica", "normal");

        const dateStr = invoiceRowDate(r.date);
        doc.text(doc.splitTextToSize(dateStr, COL.date.w - 2)[0], COL.date.x + 1, y);

        doc.setFont("helvetica", "bold");
        doc.text(doc.splitTextToSize(r.client || "", COL.client.w - 2)[0], COL.client.x + 1, y);

        doc.setFont("helvetica", "normal");
        doc.setTextColor(...MID);
        doc.text(doc.splitTextToSize(r.photoPackage || "", COL.pkg.w - 2)[0], COL.pkg.x + 1, y);

        doc.setTextColor(...DARK);
        doc.text(numberOnly(r.ht),          COL.ht.x + COL.ht.w,   y, { align: "right" });
        doc.text(numberOnly(r.tax),         COL.tax.x + COL.tax.w, y, { align: "right" });
        doc.setFont("helvetica", "bold");
        doc.text(numberOnly(r.finalAmount), COL.ttc.x + COL.ttc.w, y, { align: "right" });

        doc.setDrawColor(...[230, 226, 220] as [number, number, number]);
        doc.setLineWidth(0.2);
        doc.line(ML, y + 3, MR, y + 3);

        y += rowH;
      }
    }

    y += 6;

    // ── Divider ───────────────────────────────────────────────────────────────
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.4);
    doc.line(ML, y, MR, y);
    y += 8;

    // ── Bottom: info block (left) + totals block (right) ─────────────────────
    const INFO_W = CW * 0.54;
    const TOT_W  = CW * 0.42;
    const TOT_X  = MR - TOT_W;
    const BOT_Y  = y;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...DARK);
    doc.text("SASHA POPOVIC / PHOTOGRAPHY", ML, y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MID);
    const infoLines = [
      "N° TAHITI D78486 · RCS: 20 1332 A",
      "BP 581 Vaitape, 98730 Bora Bora",
      "Mobile: +689 89 25 09 15",
      "Email: INFO@SASHAPOPOVIC.COM",
      "Web: WWW.SASHAPOPOVIC.COM",
      "",
      "Banque de Tahiti",
      "Banque: 12239 · Code guichet: 00004",
      "Compte: 47941801000 · Clé RIB: 037",
    ];
    infoLines.forEach((line, i) => {
      if (line === "") return;
      if (line.startsWith("Banque de Tahiti")) {
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...DARK);
      } else {
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...MID);
      }
      doc.text(line, ML, y + 6 + i * 4.8, { maxWidth: INFO_W });
    });

    // Totals box
    const totBoxH = 32;
    doc.setFillColor(...TOTBG);
    doc.roundedRect(TOT_X, BOT_Y - 3, TOT_W, totBoxH, 3, 3, "F");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MID);
    doc.text("Total HT",  TOT_X + 5, BOT_Y + 5);
    doc.text("TVA 13%",   TOT_X + 5, BOT_Y + 12);

    doc.setTextColor(...DARK);
    doc.text(money(invoice.totalHT),  TOT_X + TOT_W - 4, BOT_Y + 5,  { align: "right" });
    doc.text(money(invoice.totalTax), TOT_X + TOT_W - 4, BOT_Y + 12, { align: "right" });

    doc.setDrawColor(...MID);
    doc.setLineWidth(0.3);
    doc.line(TOT_X + 4, BOT_Y + 16, TOT_X + TOT_W - 4, BOT_Y + 16);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...BLACK);
    doc.text("Total TTC", TOT_X + 5, BOT_Y + 24);

    doc.setFontSize(14);
    doc.text(numberOnly(invoice.totalTTC), TOT_X + TOT_W - 4, BOT_Y + 24, { align: "right" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...SUBTLE);
    doc.text("XPF", TOT_X + TOT_W - 4, BOT_Y + 28.5, { align: "right" });

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.3);
    doc.line(ML, H - 10, MR, H - 10);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...SUBTLE);
    doc.text("Sasha Popovic Photography — info@sashapopovic.com — www.sashapopovic.com", W / 2, H - 6, { align: "center" });

    return doc.output("blob");
  } catch (e) {
    console.error("PDF generation failed:", e);
    return null;
  }
}

// Build the canonical PDF filename for an invoice.
function invoicePdfFilename(invoice: GeneratedInvoice): string {
  const hotelSlug = (invoice.hotel?.name || "Invoice").replace(/\s+/g, "-");
  const monthSlug = (invoice.month || "").replace(/\s+/g, "-");
  return `${invoice.invoiceNumber}_${hotelSlug}_${monthSlug}.pdf`;
}

// Save PDF into the Documents folder only. Returns true on success.
// Does NOT download to browser — caller shows appropriate feedback.
async function saveInvoiceToDocuments(invoice: GeneratedInvoice): Promise<boolean> {
  const filename = invoicePdfFilename(invoice);
  const parts = (invoice.month || "").split(" ");
  const year = parts.length >= 2 ? parts[parts.length - 1] : String(new Date().getFullYear());
  const monthName_ = parts.length >= 1 ? parts[0] : "";

  const pdfBlob = await generateInvoicePdfBlob(invoice);
  if (!pdfBlob) return false;

  const subPath = ["Invoices", year, ...(monthName_ ? [monthName_] : [])];
  return saveFileToDocsFolder(filename, pdfBlob, subPath);
}

// Download PDF to the browser's Downloads folder. Does NOT save to Documents.
async function downloadInvoicePdf(invoice: GeneratedInvoice): Promise<boolean> {
  const pdfBlob = await generateInvoicePdfBlob(invoice);
  if (!pdfBlob) return false;
  const url = URL.createObjectURL(pdfBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = invoicePdfFilename(invoice);
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// Walk a directory tree to find and delete a PDF whose name starts with the invoice number.
async function findAndDeleteInvoicePdf(dir: FileSystemDirectoryHandle, invoiceNumber: string): Promise<boolean> {
  try {
    // @ts-expect-error values() not in all TS lib versions
    for await (const entry of dir.values()) {
      if (entry.name.startsWith(".")) continue;
      if (entry.kind === "file" && entry.name.startsWith(invoiceNumber) && entry.name.endsWith(".pdf")) {
        await (dir as FileSystemDirectoryHandle & { removeEntry(name: string): Promise<void> }).removeEntry(entry.name);
        return true;
      }
      if (entry.kind === "directory") {
        const found = await findAndDeleteInvoicePdf(entry as FileSystemDirectoryHandle, invoiceNumber);
        if (found) return true;
      }
    }
  } catch { /* permission denied on sub-dir */ }
  return false;
}

function runCalculationTests(): void {
  const sampleShoots = [{ date: "2026-05-01", hotel: "Four Seasons", department: "Concierge", source: "Resort", ht: 100, tax: 13, finalAmount: 113 }] as unknown as Shoot[];
  const totals = calculateTotals(sampleShoots, [{ date: "2026-05-03", amount: 30 }] as unknown as DirectRow[]);
  console.assert(totals.ht === 100, "HT total should be 100");
  console.assert(totals.net === 143, "Net should equal TTC plus direct income");
  console.assert(displayDate("2026-05-21") === "May 21, 2026", "Display date should be Mon DD, YYYY");
  console.assert(invoiceDateText(new Date("2026-05-20T12:00:00")) === "May 20, 2026", "Invoice date format failed");
  console.assert(makeInvoiceNumber("Four Seasons", "2026-05") === "FOU-001", "Invoice number failed");
  console.assert(numberOnly(1000000) === "1.000.000", "Number format should use dots");
  console.assert(getInvoiceRows(sampleShoots, "Four Seasons", "2026-05", "Concierge").length === 1, "Invoice rows failed");
  console.assert(monthKey("2026-04-03") === "2026-04", "YYYY-MM-DD April failed");
  console.assert(monthKey("03/04/2026") === "2026-04", "DD/MM/YYYY April failed");
  console.assert(monthKey("Apr 03, 2026") === "2026-04", "Apr date failed");
}
runCalculationTests();

function canonicalHotel(value: string): string {
  const v = String(value || "").toLowerCase().trim();
  if (v.includes("four") || v.includes("fsbb")) return "Four Seasons";
  if (v.includes("westin")) return "Westin";
  if (v.includes("le bora") || v.includes("pearl")) return "Le Bora Bora";
  if (v.includes("moana")) return "Le Moana";
  if (v.includes("thalasso")) return "Thalasso";
  if (v.includes("regis")) return "St. Regis";
  if (v.includes("conrad")) return "Conrad";
  if (v.includes("mainland") || v.includes("matira")) return "Mainland";
  return value;
}
function normalizeShoot(row: Shoot): Shoot {
  const hotel = canonicalHotel(row.hotel);
  const shouldBeResort = hotel && hotel !== "Mainland" && (!row.source || row.source === "Direct");
  return { ...row, hotel, source: shouldBeResort ? "Resort" : row.source };
}

// ─── Import Preview Modal ─────────────────────────────────────────────────────

interface ImportPreview {
  data: SavedData;
  mode: "merge" | "replace";
  emptyShoots: boolean;
  emptyDirect: boolean;
  isEmpty: boolean;
}

function ImportPreviewModal({
  preview, onConfirm, onCancel,
}: {
  preview: ImportPreview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { data, mode, emptyShoots, emptyDirect, isEmpty } = preview;
  const [confirmedEmpty, setConfirmedEmpty] = React.useState(false);

  const shootCount = Array.isArray(data.shoots) ? data.shoots.length : 0;
  const directCount = Array.isArray(data.directIncome) ? data.directIncome.length : 0;
  const pricingCount = Array.isArray(data.pricing) ? data.pricing.length : 0;
  const calendarCount = Array.isArray(data.calendarEvents) ? data.calendarEvents.length : 0;
  const invoiceCount = Array.isArray(data.savedInvoices) ? data.savedInvoices.length : 0;

  const needsDoubleConfirm = mode === "replace" && isEmpty;
  const canProceed = !needsDoubleConfirm || confirmedEmpty;

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-[2px]" />
      <div
        className="relative w-full sm:max-w-sm rounded-t-[22px] sm:rounded-[24px] border border-stone-200/60 bg-white shadow-[0_24px_80px_rgba(0,0,0,0.20)] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="sm:hidden flex justify-center pt-2 pb-0">
          <div className="h-1 w-8 rounded-full bg-stone-200" />
        </div>

        {/* Header */}
        <div className="px-4 pt-3 pb-2.5 sm:px-5 sm:pt-4 sm:pb-3 border-b border-stone-100 flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-stone-900">
              {mode === "merge" ? "Merge Backup" : "Replace All Data"}
            </p>
            <p className="text-[10px] text-stone-400 mt-0.5">
              {mode === "merge" ? "New records will be added to existing data." : "Current data will be overwritten. Can be undone."}
            </p>
          </div>
          <button onClick={onCancel} className="rounded-full p-1.5 text-stone-300 hover:bg-stone-100 hover:text-stone-600 transition flex-shrink-0 mt-0.5">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Backup summary */}
        <div className="px-4 py-2.5 sm:px-5 sm:py-3.5">
          <p className="text-[9px] uppercase tracking-[0.15em] text-stone-400 font-medium mb-1.5">Backup contents</p>
          <div className="rounded-xl bg-stone-50 divide-y divide-stone-100 overflow-hidden">
            {[
              { label: "Shoots", count: shootCount, warn: emptyShoots },
              { label: "Direct income", count: directCount, warn: emptyDirect },
              { label: "Pricing rows", count: pricingCount, warn: false },
              { label: "Calendar events", count: calendarCount, warn: false },
              { label: "Saved invoices", count: invoiceCount, warn: false },
            ].map(row => (
              <div key={row.label} className="flex items-center justify-between px-3 py-1.5">
                <span className={`text-[11px] ${row.warn ? "text-amber-700 font-medium" : "text-stone-600"}`}>{row.label}</span>
                <span className={`text-[11px] font-semibold tabular-nums ${row.warn ? "text-amber-600" : "text-stone-800"}`}>
                  {row.count}
                  {row.warn && row.count === 0 && <span className="ml-1 text-[9px] font-normal text-amber-500">empty</span>}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Warning: empty shoots + direct */}
        {isEmpty && (
          <div className="mx-4 mb-2.5 sm:mx-5 rounded-xl bg-amber-50 border border-amber-200/70 px-3 py-2.5 space-y-0.5">
            <p className="text-[11px] font-semibold text-amber-800">This backup has no shoots or direct income</p>
            <p className="text-[10px] text-amber-700 leading-snug">Importing it will not restore any client records.</p>
          </div>
        )}
        {!isEmpty && (emptyShoots || emptyDirect) && (
          <div className="mx-4 mb-2.5 sm:mx-5 rounded-xl bg-amber-50 border border-amber-200/70 px-3 py-2.5">
            <p className="text-[11px] font-semibold text-amber-800">Incomplete backup</p>
            <p className="text-[10px] text-amber-700 mt-0.5 leading-snug">
              {emptyShoots && emptyDirect ? "No shoots or direct income found. " : emptyShoots ? "No shoots found. " : "No direct income found. "}
              This backup does not contain shoots or direct income. Importing it will not restore clients.
            </p>
          </div>
        )}

        {/* Double-confirm checkbox for replace + empty */}
        {needsDoubleConfirm && (
          <label className="mx-4 mb-3 sm:mx-5 flex cursor-pointer items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
            <input
              type="checkbox"
              checked={confirmedEmpty}
              onChange={e => setConfirmedEmpty(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded accent-amber-600 flex-shrink-0"
            />
            <span className="text-[10px] text-amber-800 leading-snug font-medium">
              I understand this backup is empty. Replace anyway and overwrite current data.
            </span>
          </label>
        )}

        {/* Actions */}
        <div className="px-4 pb-4 sm:px-5 sm:pb-5 flex items-center gap-2" style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}>
          <button
            onClick={onConfirm}
            disabled={!canProceed}
            className={`flex-1 rounded-xl py-2.5 text-[12px] font-semibold transition active:scale-[0.98]
              ${mode === "replace"
                ? "bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed"
                : "bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
              }`}
          >
            {mode === "merge" ? "Merge" : "Replace all data"}
          </button>
          <button onClick={onCancel} className="rounded-xl border border-stone-200 px-4 py-2.5 text-[12px] font-medium text-stone-500 hover:border-stone-300 hover:text-stone-700 transition">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const TEST_SAVE_KEY = "sasha-localstorage-test";

function useTestSave() {
  const [testResult, setTestResult] = React.useState<"idle" | "ok" | "fail">("idle");
  function runTestSave() {
    try {
      const testVal = String(Date.now());
      localStorage.setItem(TEST_SAVE_KEY, testVal);
      const readBack = localStorage.getItem(TEST_SAVE_KEY);
      localStorage.removeItem(TEST_SAVE_KEY);
      setTestResult(readBack === testVal ? "ok" : "fail");
    } catch { setTestResult("fail"); }
    setTimeout(() => setTestResult("idle"), 3500);
  }
  return { testResult, runTestSave };
}

// ─── Settings accordion row ───────────────────────────────────────────────────

function SettingsAccordion({
  id, open, onToggle, icon, title, meta, danger, children,
}: {
  id: string;
  open: boolean;
  onToggle: (id: string) => void;
  icon: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`border-b last:border-b-0 ${danger ? "border-red-100/60" : "border-stone-100/80"}`}>
      <button
        onClick={() => onToggle(id)}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${open ? "bg-stone-50/60" : "hover:bg-stone-50/40"}`}
      >
        <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg ${danger ? "bg-red-50 text-red-400" : "bg-stone-100 text-stone-400"}`}>
          {icon}
        </span>
        <span className={`flex-1 text-[12px] font-semibold ${danger ? "text-red-700" : "text-stone-800"}`}>{title}</span>
        {meta && <span className="flex-shrink-0">{meta}</span>}
        <svg
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""} ${danger ? "text-red-300" : "text-stone-300"}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Animated body */}
      <div
        className="overflow-hidden transition-all duration-200 ease-in-out"
        style={{ maxHeight: open ? "600px" : "0px", opacity: open ? 1 : 0 }}
      >
        <div className="px-4 pb-3 pt-1 space-y-0.5">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Settings row helpers ─────────────────────────────────────────────────────

function SRow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 ${className}`}>{children}</div>;
}
function SLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-stone-600 font-medium flex-1 min-w-0">{children}</span>;
}
function SValue({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`text-[10px] text-stone-500 font-medium tabular-nums flex-shrink-0 ${className ?? ""}`}>{children}</span>;
}
function SBtn({ onClick, children, variant = "default" }: { onClick: () => void; children: React.ReactNode; variant?: "default" | "amber" | "red" }) {
  const cls = {
    default: "text-stone-700 hover:bg-stone-100",
    amber: "text-amber-700 hover:bg-amber-50",
    red: "text-red-700 hover:bg-red-50",
  }[variant];
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[11px] font-medium transition active:scale-[0.98] ${cls}`}>
      {children}
    </button>
  );
}

// ─── Settings panel ───────────────────────────────────────────────────────────

interface AppHealthStats {
  shootCount: number;
  calendarEventCount: number;
  invoiceCount: number;
  localStorageKb: number;
  docsConnected: boolean;
  backupFolderConnected: boolean;
}

// ─── Editing Sync Wizard ──────────────────────────────────────────────────────
// The edge function (sheets-sync) holds GOOGLE_SERVICE_ACCOUNT_JSON and
// GOOGLE_SHEET_ID as server-side secrets. No OAuth token or Sheet ID needed here.

interface EditingSyncWizardProps {
  onTestConnection: () => void;
  onTestWrite: () => void;
  onSyncNow: () => void;
  syncStatus: string | null;
  syncLoading: boolean;
  testWriteResult: { ok: boolean; message: string } | null;
}

function EditingSyncWizard({ onTestConnection, onTestWrite, onSyncNow, syncStatus, syncLoading, testWriteResult }: EditingSyncWizardProps) {
  const isOk = !!syncStatus && (syncStatus.startsWith("Connected") || syncStatus.includes("job"));

  return (
    <div className="space-y-3 pb-1">
      {/* How it works */}
      <div className="mx-1 rounded-xl bg-stone-50 border border-stone-200 px-3 py-2.5">
        <p className="text-[10.5px] font-semibold text-stone-700 mb-1.5">How it works</p>
        <p className="text-[10px] text-stone-500 leading-relaxed">
          The sync uses a Google service account configured in Supabase. No sign-in or Sheet ID needed here — just click Test Connection to verify everything is working.
        </p>
      </div>

      {/* Test Connection */}
      <div className="mx-1 space-y-2">
        <button
          onClick={onTestConnection}
          disabled={syncLoading}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-[11px] font-medium text-stone-700 hover:border-stone-300 hover:bg-stone-50 transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
        >
          {syncLoading
            ? <svg className="h-3.5 w-3.5 text-stone-400 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            : <svg className="h-3.5 w-3.5 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          }
          {syncLoading ? "Testing…" : "Test Connection"}
        </button>

        {syncStatus && (
          <div className={`rounded-xl border px-3 py-2 ${isOk ? "bg-emerald-50 border-emerald-100" : "bg-red-50 border-red-100"}`}>
            <p className={`text-[10px] leading-relaxed font-mono break-all ${isOk ? "text-emerald-700" : "text-red-700"}`}>{syncStatus}</p>
          </div>
        )}

        {/* Test Google Write */}
        <button
          onClick={onTestWrite}
          disabled={syncLoading}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800 hover:bg-amber-100 transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
        >
          {syncLoading
            ? <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            : <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          }
          Test Google Write
        </button>

        {testWriteResult && (
          <div className={`rounded-xl border px-3 py-2 ${testWriteResult.ok ? "bg-emerald-50 border-emerald-100" : "bg-red-50 border-red-100"}`}>
            <p className={`text-[10px] leading-relaxed font-mono break-all ${testWriteResult.ok ? "text-emerald-700" : "text-red-700"}`}>
              {testWriteResult.message}
            </p>
          </div>
        )}

        <button
          onClick={onSyncNow}
          disabled={syncLoading}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-stone-900 px-3 py-2 text-[11px] font-medium text-white hover:bg-stone-700 transition active:scale-[0.98] disabled:opacity-40"
        >
          {syncLoading
            ? <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            : <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>
          }
          {syncLoading ? "Syncing…" : "Sync Now"}
        </button>
      </div>
    </div>
  );
}

interface SettingsPanelProps {
  lastSavedAt: Date | null;
  lastBackupAt: Date | null;
  autoBackupEnabled: boolean;
  setAutoBackupEnabled: (v: boolean) => void;
  keepBackupHistory: boolean;
  setKeepBackupHistory: (v: boolean) => void;
  backupFolderName: string;
  backupFolderHandle: FileSystemDirectoryHandle | null;
  saveBackup: () => void;
  chooseBackupFolder: () => void;
  clearStoredFolderHandle: () => Promise<void>;
  setBackupFolderHandle: (h: FileSystemDirectoryHandle | null) => void;
  setBackupFolderName: (n: string) => void;
  canUndo: boolean;
  undo: () => void;
  importDataMerge: (e: React.ChangeEvent<HTMLInputElement>) => void;
  importDataReplace: (e: React.ChangeEvent<HTMLInputElement>) => void;
  clearShootsAndDirect: () => void;
  clearCalendarEvents: () => void;
  protectedReset: () => void;
  onClose: () => void;
  // Google Calendar
  gcalAccessToken: string | null;
  gcalConnectedEmail: string;
  gcalCalendars: GCalendarListEntry[];
  gcalSelectedIds: Set<string>;
  setGcalSelectedIds: (ids: Set<string>) => void;
  gcalLoading: boolean;
  gcalError: string | null;
  gapiReady: boolean;
  connectGoogle: (writeScope?: boolean) => void;
  disconnectGoogle: () => void;
  syncGoogleCalendar: () => void;
  importCalendarFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  rebuildCalendarCache: () => void;
  hasCalendarEvents: boolean;
  gcalSyncStats: { added: number; updated: number; removed: number; fetched: number; lastSyncAt: Date | null };
  showDebugStats: boolean;
  setShowDebugStats: (v: boolean) => void;
  appHealth: AppHealthStats;
  // Editing Sync
  onEditingSyncNow: () => void;
  onEditingTestConnection: () => void;
  onEditingTestWrite: () => void;
  editingSyncStatus: string | null;
  editingSyncLoading: boolean;
  testWriteResult: { ok: boolean; message: string } | null;
  onTestAccounting: () => void;
  acctTestResult: { ok: boolean; detail: string } | null;
  acctSyncStats: { shootsLoaded: number; directLoaded: number; lastSync: string | null; error: string | null };
  onDebugRead: () => void;
  debugReadResult: DebugReadResult | null;
  sheetsSyncState: SyncState;
}

function SettingsPanel(props: SettingsPanelProps) {
  const {
    lastSavedAt, lastBackupAt, autoBackupEnabled, setAutoBackupEnabled,
    keepBackupHistory, setKeepBackupHistory, backupFolderName, backupFolderHandle,
    saveBackup, chooseBackupFolder, clearStoredFolderHandle,
    setBackupFolderHandle, setBackupFolderName,
    canUndo, undo, importDataMerge, importDataReplace,
    clearShootsAndDirect, clearCalendarEvents, protectedReset, onClose,
    gcalAccessToken, gcalConnectedEmail, gcalCalendars, gcalSelectedIds, setGcalSelectedIds,
    gcalLoading, gcalError, connectGoogle, disconnectGoogle,
    syncGoogleCalendar, importCalendarFile, rebuildCalendarCache, hasCalendarEvents, gcalSyncStats,
    showDebugStats, setShowDebugStats, appHealth,
    onEditingSyncNow, onEditingTestConnection, onEditingTestWrite, editingSyncStatus, editingSyncLoading, testWriteResult,
    onTestAccounting, acctTestResult, acctSyncStats, onDebugRead, debugReadResult, sheetsSyncState,
  } = props;

  const [openSection, setOpenSection] = React.useState<string | null>(null);
  const [showCalendarPicker, setShowCalendarPicker] = React.useState(false);
  const { testResult, runTestSave } = useTestSave();
  const folderSupported = hasFileSystemAccess();
  const hasClientId = !!((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim());

  function toggle(id: string) {
    setOpenSection(prev => prev === id ? null : id);
  }

  const lastSaveStr = lastSavedAt
    ? lastSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const lastBackupStr = lastBackupAt
    ? `${lastBackupAt.toLocaleDateString([], { month: "short", day: "numeric" })} ${lastBackupAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : null;

  return (
    <div className="w-full sm:w-[300px] rounded-t-[24px] sm:rounded-[18px] border border-stone-200/70 bg-white shadow-[0_-8px_48px_rgba(0,0,0,0.13)] sm:shadow-[0_8px_48px_rgba(0,0,0,0.13)] backdrop-blur-md overflow-hidden"
      style={{ maxHeight: "85vh", overflowY: "auto" }}
    >
      {/* Mobile drag handle */}
      <div className="sm:hidden flex justify-center pt-2.5 pb-1">
        <div className="h-1 w-10 rounded-full bg-stone-200" />
      </div>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100">
        <p className="text-[11px] font-bold text-stone-700 tracking-wide uppercase tracking-[0.15em]">Settings</p>
        <button onClick={onClose} className="rounded-full p-1 hover:bg-stone-100 text-stone-400 hover:text-stone-600 transition">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      {/* Auto Save */}
      <SettingsAccordion
        id="autosave"
        open={openSection === "autosave"}
        onToggle={toggle}
        icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
        title="Auto Save"
        meta={
          <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-600">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {lastSaveStr}
          </span>
        }
      >
        <SRow>
          <SLabel>Status</SLabel>
          <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            ON
          </span>
        </SRow>
        <SRow>
          <SLabel>Storage</SLabel>
          <SValue>Browser localStorage</SValue>
        </SRow>
        <SRow>
          <SLabel>Folder backup</SLabel>
          <SValue className={folderSupported ? "" : "text-amber-600"}>{folderSupported ? "Supported" : "Not supported"}</SValue>
        </SRow>
        <SRow>
          <button
            onClick={runTestSave}
            className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1 text-[10px] font-medium text-stone-600 hover:border-stone-300 hover:bg-white transition active:scale-95"
          >
            Test Save
          </button>
          {testResult === "ok" && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Works
            </span>
          )}
          {testResult === "fail" && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-red-600">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              Failed
            </span>
          )}
          {testResult === "idle" && <span className="text-[9px] text-stone-300">Verify storage</span>}
        </SRow>
      </SettingsAccordion>

      {/* Backup */}
      <SettingsAccordion
        id="backup"
        open={openSection === "backup"}
        onToggle={toggle}
        icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>}
        title="Backup"
        meta={
          <span className="text-[9px] text-stone-400 font-medium">
            {lastBackupStr ? lastBackupStr : "Never"}
          </span>
        }
      >
        {/* Save now */}
        <SBtn onClick={saveBackup}>
          <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save Backup Now
          <span className="ml-auto text-[9px] text-stone-400">.json</span>
        </SBtn>

        {/* Choose folder — desktop only */}
        {folderSupported && (
          <SBtn onClick={chooseBackupFolder}>
            <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Choose Folder
            {backupFolderName && <span className="ml-auto text-[9px] rounded-full bg-stone-100 px-2 py-0.5 text-stone-500 font-normal truncate max-w-[90px]">{backupFolderName}</span>}
          </SBtn>
        )}

        {/* Auto backup + history toggles (folder-linked) */}
        {folderSupported && backupFolderHandle && (
          <>
            <SRow>
              <SLabel>Auto backup</SLabel>
              <Toggle value={autoBackupEnabled} onChange={setAutoBackupEnabled} />
            </SRow>
            <SRow>
              <SLabel>Keep history</SLabel>
              <Toggle value={keepBackupHistory} onChange={setKeepBackupHistory} />
            </SRow>
          </>
        )}

        {/* Info row */}
        <div className="rounded-xl bg-stone-50 px-3 py-2 mt-0.5 space-y-1">
          <SRow className="!px-0 !py-0.5">
            <SLabel>Mode</SLabel>
            <SValue>{keepBackupHistory ? "Keep history" : "Latest only"}</SValue>
          </SRow>
          {lastBackupStr && (
            <SRow className="!px-0 !py-0.5">
              <SLabel>Last backup</SLabel>
              <SValue>{lastBackupStr}</SValue>
            </SRow>
          )}
          {backupFolderName && (
            <SRow className="!px-0 !py-0.5">
              <SLabel>Folder</SLabel>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-[10px] text-stone-600 font-medium truncate max-w-[80px]">{backupFolderName}</span>
                <button
                  onClick={async () => { await clearStoredFolderHandle(); setBackupFolderHandle(null); setBackupFolderName(""); }}
                  className="text-stone-300 hover:text-stone-500 transition"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </SRow>
          )}
          {!folderSupported && (
            <p className="text-[9px] text-stone-400 leading-snug pt-0.5">
              On iPhone/iPad: tap Save Backup → choose <span className="font-medium text-stone-500">Save to Files</span>.
            </p>
          )}
        </div>

        {/* Undo */}
        {canUndo && (
          <SBtn onClick={undo}>
            <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
            Undo last change
          </SBtn>
        )}
      </SettingsAccordion>

      {/* Import */}
      <SettingsAccordion
        id="import"
        open={openSection === "import"}
        onToggle={toggle}
        icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>}
        title="Import"
        meta={<span className="text-[9px] text-stone-400">.json</span>}
      >
        <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-[11px] font-medium text-stone-700 hover:bg-stone-50 transition active:scale-[0.98]">
          <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
          Merge backup
          <span className="ml-auto text-[9px] text-stone-400 font-normal">adds records</span>
          <input type="file" accept="application/json" onChange={importDataMerge} className="hidden" />
        </label>
        <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-[11px] font-medium text-amber-700 hover:bg-amber-50 transition active:scale-[0.98]">
          <svg className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
          Replace all data
          <span className="ml-auto text-[9px] text-amber-400 font-normal">overwrites</span>
          <input type="file" accept="application/json" onChange={importDataReplace} className="hidden" />
        </label>
      </SettingsAccordion>

      {/* Google Calendar */}
      <SettingsAccordion
        id="gcal"
        open={openSection === "gcal"}
        onToggle={toggle}
        icon={
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
        }
        title="Google Calendar"
        meta={
          gcalAccessToken
            ? <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600">LIVE</span>
            : <span className="text-[9px] text-stone-400">Not connected</span>
        }
      >
        {gcalAccessToken ? (
          <>
            {/* Status row */}
            <SRow>
              <SLabel>Status</SLabel>
              <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Live
              </span>
            </SRow>

            {/* Sync debug stats */}
            <div className="mx-1 rounded-xl bg-stone-50 border border-stone-100 px-3 py-2.5 space-y-1.5">
              <p className="text-[9px] uppercase tracking-[0.15em] text-stone-400 font-medium">Sync status</p>
              {gcalConnectedEmail && (
                <div className="flex items-center justify-between">
                  <span className="text-[9.5px] text-stone-400">Account</span>
                  <span className="text-[9.5px] font-medium text-stone-600 truncate max-w-[140px]">{gcalConnectedEmail}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[9.5px] text-stone-400">Connected</span>
                  <span className="text-[9.5px] font-semibold text-emerald-600">Yes</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[9.5px] text-stone-400">Calendars</span>
                  <span className="text-[9.5px] font-semibold text-stone-600">{gcalSelectedIds.size}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[9.5px] text-stone-400">Fetched</span>
                  <span className="text-[9.5px] font-semibold text-stone-600">{gcalSyncStats.fetched || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[9.5px] text-stone-400">Updated</span>
                  <span className="text-[9.5px] font-semibold text-sky-600">{gcalSyncStats.updated || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[9.5px] text-stone-400">Added</span>
                  <span className="text-[9.5px] font-semibold text-emerald-600">{gcalSyncStats.added || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[9.5px] text-stone-400">Removed</span>
                  <span className="text-[9.5px] font-semibold text-rose-500">{gcalSyncStats.removed || "—"}</span>
                </div>
                <div className="col-span-2 flex items-center justify-between pt-0.5 border-t border-stone-100">
                  <span className="text-[9.5px] text-stone-400">Last sync</span>
                  <span className="text-[9.5px] font-medium text-stone-500">
                    {gcalSyncStats.lastSyncAt
                      ? gcalSyncStats.lastSyncAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                      : "—"}
                  </span>
                </div>
              </div>
            </div>

            {/* Calendar selector */}
            {gcalCalendars.length > 0 && (
              <SRow>
                <SLabel>Calendars</SLabel>
                <div className="relative flex-shrink-0">
                  <button
                    onClick={() => setShowCalendarPicker(p => !p)}
                    className="flex items-center gap-1 rounded-full border border-stone-200 bg-white/80 px-2 py-1 text-[10px] font-medium text-stone-600 hover:border-stone-300 transition"
                  >
                    {gcalSelectedIds.size} of {gcalCalendars.length}
                    <svg className="h-2.5 w-2.5 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {showCalendarPicker && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setShowCalendarPicker(false)} />
                      <div className="absolute right-0 top-full mt-1.5 z-40 w-60 rounded-2xl border border-stone-200/70 bg-white shadow-[0_8px_32px_rgba(0,0,0,0.12)] overflow-hidden">
                        <p className="px-3.5 pt-3 pb-1 text-[9px] uppercase tracking-[0.2em] text-stone-400 font-medium">Calendars to sync</p>
                        <div className="max-h-44 overflow-y-auto px-1.5 pb-2">
                          {gcalCalendars.map(cal => {
                            const selected = gcalSelectedIds.has(cal.id);
                            return (
                              <label key={cal.id} className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-stone-50 transition">
                                <input type="checkbox" checked={selected} onChange={() => { const next = new Set(gcalSelectedIds); selected ? next.delete(cal.id) : next.add(cal.id); setGcalSelectedIds(next); }} className="h-3.5 w-3.5 rounded accent-stone-800" />
                                <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: cal.backgroundColor || "#888" }} />
                                <span className="text-[12px] text-stone-700 font-medium truncate flex-1">{cal.summary}</span>
                                {cal.primary && <span className="text-[9px] text-stone-400">Primary</span>}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </SRow>
            )}

            {/* Refresh */}
            <SBtn
              onClick={syncGoogleCalendar}
              variant={gcalLoading || gcalSelectedIds.size === 0 ? "default" : "default"}
            >
              {gcalLoading
                ? <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                : <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>}
              {gcalLoading ? "Syncing…" : "Refresh Calendar"}
            </SBtn>

            {/* Import .ics */}
            <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-[11px] font-medium text-stone-700 hover:bg-stone-50 transition active:scale-[0.98]">
              <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
              Import .ics
              <span className="ml-auto text-[9px] text-stone-400 font-normal">calendar file</span>
              <input type="file" accept=".ics,text/calendar" onChange={importCalendarFile} className="hidden" />
            </label>

            {/* Rebuild cache */}
            {hasCalendarEvents && (
              <SBtn onClick={rebuildCalendarCache}>
                <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                Rebuild Cache
              </SBtn>
            )}

            {/* Disconnect */}
            <SBtn onClick={disconnectGoogle} variant="amber">
              <svg className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Disconnect Google
            </SBtn>
          </>
        ) : (
          <>
            <SRow>
              <SLabel>Status</SLabel>
              <SValue>Not connected</SValue>
            </SRow>

            {/* Connect — always request write scope so events can be created/deleted */}
            <SBtn onClick={() => connectGoogle(true)} variant="default">
              <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
              {gcalLoading ? "Connecting…" : "Sign in with Google"}
            </SBtn>

            {/* Import .ics even when not connected */}
            <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-[11px] font-medium text-stone-700 hover:bg-stone-50 transition active:scale-[0.98]">
              <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
              Import .ics
              <span className="ml-auto text-[9px] text-stone-400 font-normal">calendar file</span>
              <input type="file" accept=".ics,text/calendar" onChange={importCalendarFile} className="hidden" />
            </label>

            {!hasClientId && (
              <div className="rounded-xl bg-amber-50 border border-amber-100 px-3.5 py-2.5 space-y-1 mx-1">
                <p className="text-[11px] font-semibold text-amber-800">Setup required</p>
                <p className="text-[10px] text-amber-700">Set <code className="font-mono bg-amber-100 px-1 rounded">VITE_GOOGLE_CLIENT_ID</code> in .env, then restart.</p>
              </div>
            )}
          </>
        )}

        {gcalError && (
          <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 mx-1">
            <p className="text-[11px] text-red-700">{gcalError}</p>
          </div>
        )}

        {/* Debug: show counted events */}
        <SRow>
          <SLabel>Show counted events</SLabel>
          <button
            onClick={() => setShowDebugStats(!showDebugStats)}
            className={`relative h-4 w-7 rounded-full transition-colors duration-200 flex-shrink-0 ${showDebugStats ? "bg-amber-400" : "bg-stone-200"}`}
          >
            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 ${showDebugStats ? "translate-x-3.5" : "translate-x-0.5"}`} />
          </button>
        </SRow>
        {showDebugStats && (
          <p className="text-[9px] text-amber-600 px-3 pb-1 leading-snug">Debug panel visible in calendar. Check console for full log.</p>
        )}
      </SettingsAccordion>

      {/* Editing Sync */}
      <SettingsAccordion
        id="editing-sync"
        open={openSection === "editing-sync"}
        onToggle={toggle}
        icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>}
        title="Editing Sync"
        meta={
          editingSyncStatus && (editingSyncStatus.startsWith("Connected") || editingSyncStatus.includes("job"))
            ? <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600">CONNECTED</span>
            : undefined
        }
      >
        <EditingSyncWizard
          onTestConnection={onEditingTestConnection}
          onTestWrite={onEditingTestWrite}
          onSyncNow={onEditingSyncNow}
          syncStatus={editingSyncStatus}
          syncLoading={editingSyncLoading}
          testWriteResult={testWriteResult}
        />

        {/* Sheet sync debug stats */}
        <div className="mx-1 mt-1 rounded-xl bg-stone-50 border border-stone-100 px-3 py-2.5 space-y-1.5">
          <p className="text-[9px] uppercase tracking-[0.15em] text-stone-400 font-medium">Sheet sync status</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[9.5px] text-stone-400">Status</span>
              <span className={`text-[9.5px] font-semibold ${sheetsSyncState.status === "ok" ? "text-emerald-600" : sheetsSyncState.status === "syncing" ? "text-sky-600" : sheetsSyncState.status === "error" ? "text-rose-500" : "text-stone-400"}`}>
                {sheetsSyncState.status === "ok" ? "Live" : sheetsSyncState.status === "syncing" ? "Syncing…" : sheetsSyncState.status === "error" ? "Error" : sheetsSyncState.status === "offline" ? "Cached" : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[9.5px] text-stone-400">Rows</span>
              <span className="text-[9.5px] font-semibold text-stone-600">{sheetsSyncState.rowCount || "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[9.5px] text-stone-400">From cache</span>
              <span className={`text-[9.5px] font-semibold ${sheetsSyncState.fromCache ? "text-amber-500" : "text-emerald-600"}`}>
                {sheetsSyncState.fromCache ? "Yes" : "No"}
              </span>
            </div>
            {sheetsSyncState.sheetName && (
              <div className="flex items-center justify-between">
                <span className="text-[9.5px] text-stone-400">Tab</span>
                <span className="text-[9.5px] font-semibold text-stone-600 truncate max-w-[80px]">{sheetsSyncState.sheetName}</span>
              </div>
            )}
            <div className="col-span-2 flex items-center justify-between pt-0.5 border-t border-stone-100">
              <span className="text-[9.5px] text-stone-400">Last sync</span>
              <span className="text-[9.5px] font-medium text-stone-500">
                {sheetsSyncState.lastSynced
                  ? sheetsSyncState.lastSynced.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                  : "—"}
              </span>
            </div>
            {sheetsSyncState.error && (
              <div className="col-span-2 pt-0.5 border-t border-stone-100">
                <p className="text-[9px] text-rose-500 font-medium break-all">{sheetsSyncState.error}</p>
              </div>
            )}
          </div>
        </div>
      </SettingsAccordion>

      {/* Accounting Sync */}
      <SettingsAccordion
        id="accounting-sync"
        open={openSection === "accounting-sync"}
        onToggle={toggle}
        icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>}
        title="Accounting Sheet"
      >
        <div className="mx-1 space-y-2">
          {/* Live sync stats */}
          <div className="rounded-xl bg-stone-50 border border-stone-100 divide-y divide-stone-100 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[10px] text-stone-500">Sheet ID source</span>
              <span className="text-[10px] font-mono text-stone-700">GOOGLE_SHEET_ID</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[10px] text-stone-500">Loaded Shoots</span>
              <span className="text-[10px] font-semibold text-stone-800">{acctSyncStats.shootsLoaded} rows</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[10px] text-stone-500">Loaded Direct</span>
              <span className="text-[10px] font-semibold text-stone-800">{acctSyncStats.directLoaded} rows</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[10px] text-stone-500">Last sync</span>
              <span className="text-[10px] text-stone-600">{acctSyncStats.lastSync ?? '—'}</span>
            </div>
            {acctSyncStats.error && (
              <div className="px-3 py-2">
                <span className="text-[10px] text-red-600 break-all">{acctSyncStats.error}</span>
              </div>
            )}
          </div>
          <p className="px-1 text-[10px] text-stone-500 leading-snug">
            Full end-to-end test: verifies access to <code className="font-mono text-stone-600">GOOGLE_SHEET_ID</code>, ensures Shoots/Direct/Price tabs and headers exist, writes a test row, reads it back, then removes it.
          </p>
          <button
            onClick={onTestAccounting}
            disabled={editingSyncLoading}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-[11px] font-medium text-teal-800 hover:bg-teal-100 transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
          >
            {editingSyncLoading
              ? <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              : <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            }
            {editingSyncLoading ? "Testing…" : "Test Accounting Sheet"}
          </button>
          {acctTestResult && (
            <div className={`rounded-xl border px-3 py-2.5 ${acctTestResult.ok ? "bg-emerald-50 border-emerald-100" : "bg-red-50 border-red-100"}`}>
              <pre className={`text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all ${acctTestResult.ok ? "text-emerald-700" : "text-red-700"}`}>
                {acctTestResult.detail}
              </pre>
            </div>
          )}

          {/* Debug read button */}
          <button
            onClick={onDebugRead}
            disabled={editingSyncLoading}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-[11px] font-medium text-stone-600 hover:bg-stone-100 transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
          >
            {editingSyncLoading
              ? <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              : <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            }
            {editingSyncLoading ? "Reading…" : "Debug Google Sheet Read"}
          </button>
          {debugReadResult && (
            <div className={`rounded-xl border px-3 py-2.5 space-y-2 ${debugReadResult.ok ? "bg-stone-50 border-stone-200" : "bg-red-50 border-red-200"}`}>
              {!debugReadResult.ok && <p className="text-[10px] font-semibold text-red-700">{debugReadResult.error}</p>}
              {debugReadResult.ok && <p className="text-[10px] font-mono text-stone-500">Sheet: {debugReadResult.sheetId}</p>}
              {([debugReadResult.shoots, debugReadResult.direct, debugReadResult.price]).filter(Boolean).map(tab => tab && (
                <details key={tab.tab} open={tab.parsedCount === 0} className="group">
                  <summary className="cursor-pointer list-none flex items-center gap-2 text-[11px] font-semibold text-stone-700 hover:text-stone-900">
                    <svg className="h-3 w-3 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                    {tab.tab}
                    <span className={`ml-auto font-mono text-[10px] ${tab.parsedCount > 0 ? "text-emerald-600" : "text-red-500"}`}>
                      {tab.rawCount} raw → {tab.parsedCount} parsed, {tab.rejectedCount} rejected
                    </span>
                  </summary>
                  <div className="mt-1.5 ml-4 space-y-1.5">
                    {tab.error && <p className="text-[10px] text-red-600 font-mono">{tab.error}</p>}
                    {tab.headerRow && (
                      <div>
                        <p className="text-[9px] uppercase tracking-wider text-stone-400 mb-0.5">Header row (row 1)</p>
                        <pre className="text-[9px] font-mono text-stone-600 whitespace-pre-wrap break-all bg-white/70 rounded px-2 py-1">{JSON.stringify(tab.headerRow)}</pre>
                      </div>
                    )}
                    {tab.first3Raw.length > 0 && (
                      <div>
                        <p className="text-[9px] uppercase tracking-wider text-stone-400 mb-0.5">First 3 raw data rows</p>
                        <pre className="text-[9px] font-mono text-stone-600 whitespace-pre-wrap break-all bg-white/70 rounded px-2 py-1 max-h-28 overflow-y-auto">{JSON.stringify(tab.first3Raw, null, 2)}</pre>
                      </div>
                    )}
                    {tab.first3Parsed.length > 0 && (
                      <div>
                        <p className="text-[9px] uppercase tracking-wider text-stone-400 mb-0.5">First 3 parsed objects</p>
                        <pre className="text-[9px] font-mono text-emerald-700 whitespace-pre-wrap break-all bg-emerald-50/70 rounded px-2 py-1 max-h-28 overflow-y-auto">{JSON.stringify(tab.first3Parsed, null, 2)}</pre>
                      </div>
                    )}
                    {tab.rejected.length > 0 && (
                      <div>
                        <p className="text-[9px] uppercase tracking-wider text-stone-400 mb-0.5">Rejected rows (up to 10)</p>
                        <pre className="text-[9px] font-mono text-red-600 whitespace-pre-wrap break-all bg-red-50/70 rounded px-2 py-1 max-h-28 overflow-y-auto">{tab.rejected.map(r => `row ${r.rowIndex}: ${r.reason}\n  raw: ${JSON.stringify(r.raw)}`).join("\n")}</pre>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      </SettingsAccordion>

      {/* App Health */}
      <SettingsAccordion
        id="health"
        open={openSection === "health"}
        onToggle={toggle}
        icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
        title="App Health"
      >
        <div className="rounded-xl bg-stone-50 divide-y divide-stone-100 overflow-hidden mt-0.5">
          <SRow className="!rounded-none !px-3 !py-2">
            <SLabel>Shoots</SLabel>
            <SValue>{appHealth.shootCount}</SValue>
          </SRow>
          <SRow className="!rounded-none !px-3 !py-2">
            <SLabel>Calendar events</SLabel>
            <SValue>{appHealth.calendarEventCount}</SValue>
          </SRow>
          <SRow className="!rounded-none !px-3 !py-2">
            <SLabel>Saved invoices</SLabel>
            <SValue>{appHealth.invoiceCount}</SValue>
          </SRow>
          <SRow className="!rounded-none !px-3 !py-2">
            <SLabel>Storage used</SLabel>
            <SValue>{appHealth.localStorageKb} KB</SValue>
          </SRow>
          <SRow className="!rounded-none !px-3 !py-2">
            <SLabel>Last saved</SLabel>
            <SValue>{lastSavedAt ? lastSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</SValue>
          </SRow>
          <SRow className="!rounded-none !px-3 !py-2">
            <SLabel>Documents folder</SLabel>
            <SValue className={appHealth.docsConnected ? "text-emerald-600" : "text-stone-400"}>
              {appHealth.docsConnected ? "Connected" : "Not connected"}
            </SValue>
          </SRow>
          <SRow className="!rounded-none !px-3 !py-2">
            <SLabel>Backup folder</SLabel>
            <SValue className={appHealth.backupFolderConnected ? "text-emerald-600" : "text-stone-400"}>
              {appHealth.backupFolderConnected ? "Connected" : "Not connected"}
            </SValue>
          </SRow>
          {lastBackupAt && (
            <SRow className="!rounded-none !px-3 !py-2">
              <SLabel>Last backup</SLabel>
              <SValue>{lastBackupAt.toLocaleDateString([], { month: "short", day: "numeric" })}</SValue>
            </SRow>
          )}
        </div>
      </SettingsAccordion>

      {/* Danger Zone */}
      <SettingsAccordion
        id="danger"
        open={openSection === "danger"}
        onToggle={toggle}
        danger
        icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
        title="Danger Zone"
      >
        <SBtn onClick={() => { clearShootsAndDirect(); onClose(); }} variant="amber">
          <svg className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Clear Shoots + Direct Data
        </SBtn>
        <p className="text-[9px] text-stone-400 leading-snug px-3 pb-1">Keeps prices and invoices. Can be undone.</p>

        <SBtn onClick={() => { clearCalendarEvents(); }} variant="default">
          <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          Clear Calendar Cache
        </SBtn>
        <p className="text-[9px] text-stone-400 leading-snug px-3 pb-1">Removes Calendar tab import only.</p>

        <SBtn onClick={() => { protectedReset(); onClose(); }} variant="red">
          <svg className="h-3.5 w-3.5 text-red-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          Reset all data
        </SBtn>
      </SettingsAccordion>
    </div>
  );
}

// ─── User session ─────────────────────────────────────────────────────────────

type UserRole = "admin" | "editor_guest";

interface CurrentUser {
  id:          string;
  displayName: string;
  role:        UserRole;
  allowedTabs: string[];
  accentColor: string;
}

// DB row shape from user_roles table
interface DbUserProfile {
  id:           string;
  display_name: string;
  role:         string;
  allowed_tabs: string[];
  accent_color: string;
}

const SESSION_KEY        = "sasha-photo-user-session";
const LAST_ACTIVITY_KEY  = "sasha-photo-last-activity";
const INACTIVITY_MS      = 30 * 60 * 1000; // 30 minutes

function loadSession(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY) ?? "0");
    if (lastActivity && Date.now() - lastActivity > INACTIVITY_MS) {
      localStorage.removeItem(SESSION_KEY);
      console.log("[Auth] Session expired due to inactivity — logged out");
      return null;
    }
    const u = JSON.parse(raw) as CurrentUser;
    // Back-compat: fill defaults if session was saved before these fields existed
    if (!u.allowedTabs || !Array.isArray(u.allowedTabs)) {
      u.allowedTabs = u.role === "admin"
        ? ["Dashboard","Shoots","Direct","Invoices","Prices","Calendar","Editing"]
        : ["Calendar","Editing"];
    }
    if (!u.accentColor) u.accentColor = "#c2a96e";
    console.log("[Auth] Session restored — Current User:", u.displayName, "| Role:", u.role, "| Tabs:", u.allowedTabs);
    return u;
  } catch { return null; }
}

function saveSession(u: CurrentUser | null) {
  if (u) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(u));
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
  } else {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LAST_ACTIVITY_KEY);
  }
}

function touchActivity() {
  localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Supabase client for login (module-level singleton) ───────────────────────

const _supabaseLogin = _createClientForLogin(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);

// ─── User profiles (loaded from DB at login, cached here) ────────────────────
// This is populated dynamically — do not add hardcoded users here.
let _cachedDbProfiles: DbUserProfile[] | null = null;

async function loadDbProfiles(): Promise<DbUserProfile[]> {
  if (_cachedDbProfiles) return _cachedDbProfiles;
  const { data } = await _supabaseLogin
    .from("user_roles")
    .select("id, display_name, role, allowed_tabs, accent_color")
    .order("display_name");
  _cachedDbProfiles = (data ?? []) as DbUserProfile[];
  return _cachedDbProfiles;
}

function invalidateProfileCache() { _cachedDbProfiles = null; }

// ─── Login screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }: { onLogin: (user: CurrentUser) => void }) {
  const [profiles,    setProfiles]    = React.useState<DbUserProfile[]>([]);
  const [loadingList, setLoadingList] = React.useState(true);
  const [selectedId,  setSelectedId]  = React.useState<string | null>(null);
  const [pins,        setPins]        = React.useState(["", "", "", ""]);
  const [error,       setError]       = React.useState("");
  const [loading,     setLoading]     = React.useState(false);
  const [shake,       setShake]       = React.useState(false);
  const pinRefs = [
    React.useRef<HTMLInputElement>(null),
    React.useRef<HTMLInputElement>(null),
    React.useRef<HTMLInputElement>(null),
    React.useRef<HTMLInputElement>(null),
  ];

  React.useEffect(() => {
    loadDbProfiles().then(p => { setProfiles(p); setLoadingList(false); }).catch(() => setLoadingList(false));
  }, []);

  const profile = profiles.find(p => p.id === selectedId);
  const accent  = profile?.accent_color ?? "#c2a96e";

  function selectUser(id: string) {
    setSelectedId(id);
    setPins(["", "", "", ""]);
    setError("");
    setTimeout(() => pinRefs[0].current?.focus(), 80);
  }

  function handlePinKey(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      if (pins[idx] !== "") {
        const next = [...pins]; next[idx] = ""; setPins(next);
      } else if (idx > 0) {
        const next = [...pins]; next[idx - 1] = ""; setPins(next);
        setTimeout(() => pinRefs[idx - 1].current?.focus(), 0);
      }
      e.preventDefault();
    } else if (/^\d$/.test(e.key)) {
      // Handle direct digit keypress — ensures the correct digit lands even if
      // the browser fires onChange with a multi-char value (e.g. Android keyboards)
      e.preventDefault();
      const next = [...pins];
      next[idx] = e.key;
      setPins(next);
      setError("");
      if (idx < 3) setTimeout(() => pinRefs[idx + 1].current?.focus(), 0);
      if (idx === 3) submitPin(next.join(""));
    }
  }

  function handlePinChange(idx: number, val: string) {
    // onKeyDown with e.preventDefault() already handled digit keys on desktop.
    // This path handles mobile soft-keyboard taps where keyDown may not fire.
    const digit = val.replace(/\D/g, "").slice(-1);
    if (!digit) return;
    const next = [...pins];
    next[idx] = digit;
    setPins(next);
    setError("");
    if (idx < 3) setTimeout(() => pinRefs[idx + 1].current?.focus(), 0);
    if (idx === 3) submitPin(next.join(""));
  }

  async function submitPin(pinStr: string) {
    if (!selectedId) return;
    setLoading(true);
    setError("");
    try {
      const hash = await sha256hex(pinStr);
      const { data, error: dbErr } = await _supabaseLogin
        .from("user_roles")
        .select("id, display_name, role, pin_hash, allowed_tabs, accent_color")
        .eq("id", selectedId)
        .eq("pin_hash", hash)
        .maybeSingle();
      if (dbErr || !data) {
        console.warn("[Auth] Login failed — wrong PIN or user not found");
        setShake(true);
        setError("Wrong PIN");
        setPins(["", "", "", ""]);
        setTimeout(() => { setShake(false); pinRefs[0].current?.focus(); }, 500);
        return;
      }
      const allowedTabs: string[] = (data.allowed_tabs ?? []).length
        ? (data.allowed_tabs as string[])
        : data.role === "admin" ? ADMIN_TABS_ALL : ["Calendar", "Editing"];
      const user: CurrentUser = {
        id:          data.id,
        displayName: data.display_name,
        role:        data.role as UserRole,
        allowedTabs,
        accentColor: data.accent_color ?? "#c2a96e",
      };
      console.log("[Auth] Login Success");
      console.log("[Auth] Current User:", user.displayName);
      console.log("[Auth] Current Role:", user.role);
      console.log("[Auth] Permission Check — allowed tabs:", user.allowedTabs);
      onLogin(user);
    } catch {
      setError("Connection error");
    } finally {
      setLoading(false);
    }
  }

  const filledCount = pins.filter(p => p !== "").length;

  // Grid: 2 cols for ≤4 users, wrap for more
  const gridCols = profiles.length <= 2 ? "grid-cols-2" : profiles.length === 3 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className="min-h-screen bg-[#f6efe4] flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-[400px] space-y-4">

        {/* Logo */}
        <div className="flex flex-col items-center gap-2 mb-2">
          <img src="/Sasha_Popovic_|_Photography_Bora_Bora.png" alt="Logo" className="h-9 w-auto object-contain" />
          <p className="text-[11px] text-stone-500 uppercase tracking-[0.2em] font-medium">Photography · Bora Bora</p>
        </div>

        {/* Card */}
        <div className="rounded-[22px] bg-white border border-stone-200/80 shadow-[0_4px_32px_rgba(0,0,0,0.09)] overflow-hidden">

          {/* User selector */}
          <div className="px-6 pt-6 pb-5 border-b border-stone-100">
            <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-stone-400 mb-3 text-center">Who are you?</p>
            {loadingList ? (
              <div className="flex justify-center py-6">
                <svg className="h-5 w-5 animate-spin text-stone-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              </div>
            ) : (
              <div className={`grid gap-3 ${gridCols}`}>
                {profiles.map(p => {
                  const isSelected = selectedId === p.id;
                  const pAccent = p.accent_color ?? "#c2a96e";
                  const initial = p.display_name.charAt(0).toUpperCase();
                  return (
                    <button
                      key={p.id}
                      onClick={() => selectUser(p.id)}
                      className="flex flex-col items-center gap-2 rounded-[16px] py-4 px-3 border-2 transition-all"
                      style={{
                        borderColor: isSelected ? pAccent : "#e7e5e4",
                        background:  isSelected ? pAccent + "12" : "#fafaf9",
                        boxShadow:   isSelected ? `0 0 0 1px ${pAccent}40` : "none",
                      }}
                    >
                      <div
                        className="h-12 w-12 rounded-full flex items-center justify-center text-[18px] font-bold text-white shadow-sm"
                        style={{ background: isSelected ? pAccent : "#c5bfb8" }}
                      >
                        {initial}
                      </div>
                      <div className="text-center">
                        <p className="text-[12px] font-bold text-stone-800">{p.display_name}</p>
                        <p className="text-[9px] text-stone-400 mt-0.5">
                          {p.role === "admin" ? "Full access" : "Editor"}
                        </p>
                      </div>
                      {isSelected && <div className="h-1.5 w-1.5 rounded-full" style={{ background: pAccent }} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* PIN entry */}
          <div className="px-6 py-5">
            {!selectedId ? (
              <p className="text-[11px] text-stone-300 text-center py-3">Select a user above</p>
            ) : (
              <div className="space-y-4">
                <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-stone-400 text-center">
                  PIN for {profile?.display_name}
                </p>

                <div
                  className="flex justify-center gap-3"
                  style={shake ? { animation: "shake 0.4s ease" } : {}}
                >
                  {pins.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={pinRefs[idx]}
                      type="password"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={e => handlePinChange(idx, e.target.value)}
                      onKeyDown={e => handlePinKey(idx, e)}
                      className="h-14 w-14 rounded-2xl border-2 text-center text-[22px] font-bold text-stone-900 outline-none transition-all"
                      style={{
                        borderColor: digit ? accent : "#e7e5e4",
                        background:  digit ? accent + "14" : "#fafaf9",
                      }}
                    />
                  ))}
                </div>

                <div className="flex justify-center gap-1.5">
                  {[0,1,2,3].map(i => (
                    <div key={i} className="h-1.5 w-1.5 rounded-full transition-all"
                      style={{ background: i < filledCount ? accent : "#e7e5e4" }} />
                  ))}
                </div>

                {error && <p className="text-[10.5px] text-red-500 font-medium text-center">{error}</p>}
                {loading && <p className="text-[10px] text-stone-400 text-center">Checking…</p>}
              </div>
            )}
          </div>
        </div>

        <p className="text-center text-[9px] text-stone-400">Bora Bora · 2026</p>
      </div>

      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%,60%  { transform: translateX(-6px); }
          40%,80%  { transform: translateX(6px); }
        }
      `}</style>
    </div>
  );
}

// ─── Tab access ───────────────────────────────────────────────────────────────

const ADMIN_TABS_ALL  = ["Dashboard", "Dashboard V2", "Shoots", "Direct", "Invoices", "Prices", "Calendar", "Editing", ...(DEBUG_MODE ? ["Debug"] : [])];
const ALL_TABS        = ADMIN_TABS_ALL;
const ACCOUNTING_TABS = ["Dashboard", "Shoots", "Direct", "Invoices", "Prices"];

function tabsForUser(user: CurrentUser): string[] {
  // Admin always gets all tabs — ignore stored allowedTabs so new tabs are visible immediately
  if (user.role === "admin") return ADMIN_TABS_ALL;
  // Non-admin: respect the stored allowedTabs list, filtered to known tabs
  if (user.allowedTabs?.length) {
    return ALL_TABS.filter(t => user.allowedTabs.includes(t));
  }
  return ["Calendar", "Editing"];
}

// ─── Admin Settings — User Management ────────────────────────────────────────

const ACCENT_PRESETS = ["#c2a96e","#7aabb8","#a8c4a0","#c27b7b","#a89fc2","#8fb8c0","#c2b07b","#9db8a8"];

interface AdminUserForm {
  id:          string;   // empty = new user
  displayName: string;
  role:        UserRole;
  pin:         string;
  allowedTabs: string[];
  accentColor: string;
}

const _adminFnUrl = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/user-admin`;
const _adminHeaders = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY as string}`,
};

async function adminFetch(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  try {
    const res = await fetch(`${_adminFnUrl}/${path}`, {
      method:  "POST",
      headers: _adminHeaders,
      body:    JSON.stringify(body),
    });
    const json = await res.json() as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: (json.error as string) ?? `HTTP ${res.status}` };
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

async function adminFetchUsers(): Promise<DbUserProfile[]> {
  try {
    const res = await fetch(`${_adminFnUrl}/users`, { headers: _adminHeaders });
    const json = await res.json() as { users?: DbUserProfile[] };
    return json.users ?? [];
  } catch {
    return [];
  }
}

function AdminSettingsPanel({ onClose, currentUserId }: { onClose: () => void; currentUserId: string }) {
  const [users,   setUsers]   = React.useState<DbUserProfile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving,  setSaving]  = React.useState(false);
  const [editingUser, setEditingUser] = React.useState<AdminUserForm | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{ msg: string; ok: boolean } | null>(null);

  React.useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    setLoading(true);
    const data = await adminFetchUsers();
    setUsers(data);
    setLoading(false);
  }

  function startNew() {
    setEditingUser({ id: "", displayName: "", role: "editor_guest", pin: "", allowedTabs: ["Calendar","Editing"], accentColor: "#7aabb8" });
    setFeedback(null);
  }

  function startEdit(u: DbUserProfile) {
    setEditingUser({
      id:          u.id,
      displayName: u.display_name,
      role:        u.role as UserRole,
      pin:         "",
      allowedTabs: u.allowed_tabs ?? [],
      accentColor: u.accent_color ?? "#c2a96e",
    });
    setFeedback(null);
  }

  function toggleTab(tab: string) {
    if (!editingUser) return;
    const tabs = editingUser.allowedTabs.includes(tab)
      ? editingUser.allowedTabs.filter(t => t !== tab)
      : [...editingUser.allowedTabs, tab];
    setEditingUser({ ...editingUser, allowedTabs: tabs });
  }

  async function saveUser() {
    if (!editingUser) return;
    if (!editingUser.displayName.trim()) { setFeedback({ msg: "Name is required.", ok: false }); return; }
    if (editingUser.id === "" && editingUser.pin.length !== 4) { setFeedback({ msg: "PIN must be 4 digits.", ok: false }); return; }
    if (editingUser.pin && editingUser.pin.length !== 4) { setFeedback({ msg: "PIN must be 4 digits.", ok: false }); return; }
    if (!/^\d{4}$/.test(editingUser.pin) && editingUser.pin !== "") { setFeedback({ msg: "PIN must be 4 digits.", ok: false }); return; }
    if (editingUser.allowedTabs.length === 0) { setFeedback({ msg: "Select at least one tab.", ok: false }); return; }

    setSaving(true);
    setFeedback(null);
    try {
      const isNew = editingUser.id === "";
      const payload: Record<string, unknown> = {
        admin_id:     currentUserId,
        id:           isNew ? undefined : editingUser.id,
        display_name: editingUser.displayName.trim(),
        role:         editingUser.role,
        allowed_tabs: editingUser.allowedTabs,
        accent_color: editingUser.accentColor,
      };
      if (editingUser.pin) payload.pin = editingUser.pin;

      const { ok, error } = await adminFetch("upsert-user", payload);
      if (!ok) { setFeedback({ msg: error ?? "Save failed.", ok: false }); return; }

      invalidateProfileCache();
      setFeedback({ msg: isNew ? "User created." : "Saved.", ok: true });
      setEditingUser(null);
      await loadUsers();
    } finally {
      setSaving(false);
    }
  }

  async function deleteUser(id: string) {
    setSaving(true);
    const { ok, error } = await adminFetch("delete-user", { admin_id: currentUserId, target_id: id });
    setSaving(false);
    if (!ok) { setFeedback({ msg: error ?? "Delete failed.", ok: false }); return; }
    invalidateProfileCache();
    setDeleteConfirm(null);
    setFeedback({ msg: "User deleted.", ok: true });
    await loadUsers();
  }

  const tabLabels: Record<string, string> = {
    Dashboard: "Dashboard", "Dashboard V2": "Dashboard V2", Shoots: "Shoots", Direct: "Direct",
    Invoices: "Invoices", Prices: "Prices", Calendar: "Calendar", Editing: "Editing",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-stone-900/50 backdrop-blur-[2px]" />
      <div
        className="relative w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-[22px] sm:rounded-[28px] bg-white shadow-[0_32px_96px_rgba(0,0,0,0.22)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="sm:hidden flex justify-center pt-2 pb-0">
          <div className="h-1 w-8 rounded-full bg-stone-200" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2.5 sm:px-6 sm:pt-5 sm:pb-4 border-b border-stone-100">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-stone-400">Admin</p>
            <h2 className="text-[16px] font-bold text-stone-900 mt-0.5">User Management</h2>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-stone-300 hover:bg-stone-100 hover:text-stone-600 transition">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 sm:px-6 sm:py-5 sm:space-y-4">

          {/* Feedback */}
          {feedback && (
            <div className={`rounded-2xl px-4 py-2.5 text-[11px] font-medium ${feedback.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
              {feedback.msg}
            </div>
          )}

          {/* Edit / Create form */}
          {editingUser ? (
            <div className="rounded-[18px] border border-stone-200 bg-stone-50/60 p-4 space-y-3 sm:p-5 sm:space-y-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-stone-500">
                {editingUser.id ? "Edit User" : "New User"}
              </p>

              {/* Name */}
              <div className="space-y-1.5">
                <label className="text-[9px] uppercase tracking-[0.18em] text-stone-400 font-bold">Display Name</label>
                <input
                  type="text"
                  value={editingUser.displayName}
                  onChange={e => setEditingUser({ ...editingUser, displayName: e.target.value })}
                  placeholder="e.g. Sasha"
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-[9px] sm:py-2.5 text-[16px] md:text-[13px] text-stone-900 placeholder:text-stone-300 focus:border-stone-400 focus:outline-none"
                />
              </div>

              {/* Role */}
              <div className="space-y-1.5">
                <label className="text-[9px] uppercase tracking-[0.18em] text-stone-400 font-bold">Role</label>
                <div className="flex gap-2">
                  {(["admin","editor_guest"] as UserRole[]).map(r => (
                    <button
                      key={r}
                      onClick={() => {
                        const tabs = r === "admin" ? ADMIN_TABS_ALL : ["Calendar","Editing"];
                        setEditingUser({ ...editingUser, role: r, allowedTabs: tabs });
                      }}
                      className="flex-1 rounded-xl py-2 text-[11px] font-semibold border-2 transition-all"
                      style={{
                        borderColor: editingUser.role === r ? "#78716c" : "#e7e5e4",
                        background:  editingUser.role === r ? "#1c1917" : "#fafaf9",
                        color:       editingUser.role === r ? "#fff"    : "#78716c",
                      }}
                    >
                      {r === "admin" ? "Admin" : "Editor"}
                    </button>
                  ))}
                </div>
              </div>

              {/* PIN */}
              <div className="space-y-1.5">
                <label className="text-[9px] uppercase tracking-[0.18em] text-stone-400 font-bold">
                  {editingUser.id ? "New PIN (leave blank to keep current)" : "PIN (4 digits)"}
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={editingUser.pin}
                  onChange={e => setEditingUser({ ...editingUser, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                  placeholder="••••"
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-[9px] sm:py-2.5 text-[16px] md:text-[13px] tracking-[0.4em] focus:border-stone-400 focus:outline-none"
                />
              </div>

              {/* Tab access */}
              <div className="space-y-2">
                <label className="text-[9px] uppercase tracking-[0.18em] text-stone-400 font-bold">Tab Access</label>
                <div className="flex flex-wrap gap-1.5">
                  {ALL_TABS.map(tab => {
                    const on = editingUser.allowedTabs.includes(tab);
                    return (
                      <button
                        key={tab}
                        onClick={() => toggleTab(tab)}
                        className="rounded-full px-3 py-1 text-[10.5px] font-medium border-2 transition-all"
                        style={{
                          borderColor: on ? "#1c1917" : "#e7e5e4",
                          background:  on ? "#1c1917" : "#fafaf9",
                          color:       on ? "#fff"    : "#a8a29e",
                        }}
                      >
                        {tabLabels[tab]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Accent color */}
              <div className="space-y-2">
                <label className="text-[9px] uppercase tracking-[0.18em] text-stone-400 font-bold">Avatar Color</label>
                <div className="flex gap-2 flex-wrap">
                  {ACCENT_PRESETS.map(c => (
                    <button
                      key={c}
                      onClick={() => setEditingUser({ ...editingUser, accentColor: c })}
                      className="h-7 w-7 rounded-full border-2 transition-all"
                      style={{
                        background:  c,
                        borderColor: editingUser.accentColor === c ? "#1c1917" : "transparent",
                        boxShadow:   editingUser.accentColor === c ? "0 0 0 2px white, 0 0 0 4px #1c1917" : "none",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => { setEditingUser(null); setFeedback(null); }}
                  className="flex-1 rounded-2xl border border-stone-200 py-2 sm:py-2.5 text-[12px] font-semibold text-stone-600 hover:bg-stone-50 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={saveUser}
                  disabled={saving}
                  className="flex-1 rounded-2xl py-2 sm:py-2.5 text-[12px] font-semibold text-white bg-stone-900 hover:bg-stone-800 transition disabled:opacity-50"
                >
                  {saving ? "Saving…" : editingUser.id ? "Save Changes" : "Create User"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={startNew}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-stone-200 py-2.5 sm:py-3.5 text-[12px] font-semibold text-stone-500 hover:border-stone-400 hover:text-stone-700 transition"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add New User
            </button>
          )}

          {/* User list */}
          {loading ? (
            <div className="flex justify-center py-6"><svg className="h-5 w-5 animate-spin text-stone-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div>
          ) : (
            <div className="space-y-2">
              {users.map(u => {
                const accent = u.accent_color ?? "#c2a96e";
                const initial = u.display_name.charAt(0).toUpperCase();
                const isCurrentUser = u.id === currentUserId;
                return (
                  <div key={u.id} className="flex items-center gap-3 rounded-[16px] border border-stone-100 bg-white px-3.5 py-2.5 sm:px-4 sm:py-3">
                    {/* Avatar */}
                    <div className="h-9 w-9 rounded-full flex items-center justify-center text-[14px] font-bold text-white flex-shrink-0" style={{ background: accent }}>
                      {initial}
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[13px] font-bold text-stone-900 truncate">{u.display_name}</p>
                        {isCurrentUser && <span className="text-[8px] font-bold uppercase tracking-wide text-stone-400 bg-stone-100 rounded-full px-1.5 py-0.5">you</span>}
                      </div>
                      <p className="text-[9.5px] text-stone-400 mt-0.5">
                        {u.role === "admin" ? "Admin" : "Editor"} · {(u.allowed_tabs ?? []).join(", ") || "No tabs"}
                      </p>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => startEdit(u)}
                        className="rounded-xl border border-stone-200 px-3 py-1.5 text-[10.5px] font-medium text-stone-600 hover:bg-stone-50 transition"
                      >
                        Edit
                      </button>
                      {!isCurrentUser && (
                        deleteConfirm === u.id ? (
                          <div className="flex gap-1">
                            <button onClick={() => setDeleteConfirm(null)} className="rounded-xl border border-stone-200 px-2 py-1.5 text-[10px] text-stone-400 hover:bg-stone-50 transition">No</button>
                            <button onClick={() => deleteUser(u.id)} disabled={saving} className="rounded-xl border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] text-red-600 hover:bg-red-100 transition">Yes, delete</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(u.id)}
                            className="rounded-xl border border-stone-100 px-2 py-1.5 text-[10.5px] text-stone-300 hover:border-red-200 hover:text-red-500 transition"
                            title="Delete user"
                          >
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Other-user presence indicator ───────────────────────────────────────────

interface OtherUserPresence {
  displayName: string;
  lastSeenAt:  string;
  lastTab:     string;
  isOnline:    boolean; // seen in last 5 min
}

function AppShell() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(loadSession);

  if (!currentUser) {
    return <LoginScreen onLogin={user => { saveSession(user); setCurrentUser(user); }} />;
  }
  return (
    <AppMain
      currentUser={currentUser}
      onLogout={() => { saveSession(null); setCurrentUser(null); }}
    />
  );
}

export default function PhotographyAccountingApp() {
  return <AppShell />;
}

interface DuplicateModalProps {
  date: string; client: string;
  detail1Label: string; detail1Value: string;
  detail2Label?: string; detail2Value?: string;
  amountLabel?: string; amountValue?: string;
  onCancel: () => void; onConfirm: () => void;
}
function DuplicateConfirmModal({ date, client, detail1Label, detail1Value, detail2Label, detail2Value, amountLabel, amountValue, onCancel, onConfirm }: DuplicateModalProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-stone-900/50 backdrop-blur-[3px]" />
      <div className="relative w-full max-w-sm rounded-[24px] sm:rounded-[28px] bg-white shadow-[0_24px_80px_rgba(0,0,0,0.22)] p-4 sm:p-6" onClick={e => e.stopPropagation()}>
        {/* Icon */}
        <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full bg-amber-100 mx-auto mb-3 sm:mb-4">
          <svg className="h-5 w-5 sm:h-6 sm:w-6 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <h2 className="text-center text-base font-bold text-stone-900 mb-0.5">Possible duplicate client</h2>
        <p className="text-center text-sm text-stone-500 mb-3 sm:mb-4">This client already exists for this date.</p>
        {/* Existing record */}
        <div className="rounded-[16px] sm:rounded-[18px] bg-stone-50 border border-stone-200/70 px-3.5 py-2.5 sm:py-3.5 mb-3 sm:mb-5 space-y-1.5 sm:space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-stone-400 uppercase tracking-wide">Date</span>
            <span className="font-semibold text-stone-800">{date}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-stone-400 uppercase tracking-wide">Client</span>
            <span className="font-semibold text-stone-800 truncate max-w-[180px] text-right">{client}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-stone-400 uppercase tracking-wide">{detail1Label}</span>
            <span className="font-semibold text-stone-800">{detail1Value}</span>
          </div>
          {detail2Label && detail2Value && (
            <div className="flex justify-between text-xs">
              <span className="text-stone-400 uppercase tracking-wide">{detail2Label}</span>
              <span className="font-semibold text-stone-800">{detail2Value}</span>
            </div>
          )}
          {amountLabel && amountValue && (
            <div className="flex justify-between text-xs border-t border-stone-200/60 pt-1.5 mt-1.5">
              <span className="text-stone-400 uppercase tracking-wide">{amountLabel}</span>
              <span className="font-bold text-stone-900">{amountValue}</span>
            </div>
          )}
        </div>
        {/* Buttons */}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border border-stone-200 py-2 sm:py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50 transition"
            autoFocus
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-full bg-stone-900 py-2 sm:py-2.5 text-sm font-semibold text-white hover:bg-stone-700 transition"
          >
            Add Anyway
          </button>
        </div>
      </div>
    </div>
  );
}

function AppMain({ currentUser, onLogout }: { currentUser: CurrentUser; onLogout: () => void }) {
  const saved = loadSavedData();
  const allowedTabs = tabsForUser(currentUser);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const last = saved?.activeTab || "";
    return allowedTabs.includes(last) ? last : allowedTabs[0];
  });

  function safeSetTab(tab: string) {
    if (allowedTabs.includes(tab)) setActiveTab(tab);
  }
  const [shoots, setShoots] = useState<Shoot[]>((saved?.shoots || initialShoots).map(normalizeShoot));
  const [directIncome, setDirectIncome] = useState<DirectRow[]>((saved?.directIncome || initialDirectIncome).map(normalizeDirect));
  // Sheet is authoritative; start with localStorage/initialPricing as placeholder, overwritten on load
  const [pricing, setPricing] = useState<PricingRow[]>(dedupePricing(saved?.pricing || initialPricing));
  const [form, setForm] = useState<ShootForm>(() => makeEmptyShoot(pricing));
  const [directForm, setDirectForm] = useState<DirectForm>(emptyDirect);
  const [priceForm, setPriceForm] = useState<PriceForm>(emptyPrice);
  const shootFormRef = React.useRef<HTMLDivElement>(null);
  const [editingShootId, setEditingShootId] = useState<number | null>(null);
  const [editingDirectId, setEditingDirectId] = useState<number | null>(null);
  const [editingPriceId, setEditingPriceId] = useState<number | null>(null);
  const [query, setQuery] = useState<string>(saved?.query || "");
  const [dashboardYear, setDashboardYear] = useState<string>(saved?.dashboardYear || "All");
  const [dashboardHotel, setDashboardHotel] = useState<string>(saved?.dashboardHotel || "All Hotels");
  const [dashboardMonth, setDashboardMonth] = useState<string>(saved?.dashboardMonth || "All");
  const [invoiceHotel, setInvoiceHotel] = useState<string>(saved?.invoiceHotel || "Four Seasons");
  const [invoiceYear, setInvoiceYear] = useState<string>(saved?.invoiceYear || "2026");
  const [invoiceMonth, setInvoiceMonth] = useState<string>(saved?.invoiceMonth || "05");
  const [invoiceDepartment, setInvoiceDepartment] = useState<string>(saved?.invoiceDepartment || "All Departments");
  const [generatedInvoice, setGeneratedInvoice] = useState<GeneratedInvoice | null>(saved?.generatedInvoice || null);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>(saved?.calendarEvents || []);
  const [invoiceSequences, setInvoiceSequences] = useState<Record<string, number>>(saved?.invoiceSequences || {});
  const [savedInvoices, setSavedInvoices] = useState<SavedInvoice[]>(saved?.savedInvoices || []);
  const [editingJobs, setEditingJobs] = useState<EditingJob[]>([]);
  const [sheetsSyncState, setSheetsSyncState] = useState<SyncState>({ status: "idle", lastSynced: null, error: null, fromCache: false, rowCount: 0 });
  const [sheetJobs, setSheetJobs] = useState<SheetJob[]>([]);
  const [editingSyncLoading, setEditingSyncLoading] = useState(false);
  const [chromeH, setChromeH] = useState(110);
  const chromeRef = useRef<HTMLDivElement>(null);
  const [editingSyncStatus, setEditingSyncStatus] = useState<string | null>(null);
  const [testWriteResult, setTestWriteResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [acctTestResult, setAcctTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [debugReadResult, setDebugReadResult] = useState<DebugReadResult | null>(null);
  const [acctSyncStats, setAcctSyncStats] = useState<{ shootsLoaded: number; directLoaded: number; lastSync: string | null; error: string | null }>({ shootsLoaded: 0, directLoaded: 0, lastSync: null, error: null });
  const [backupFolderHandle, setBackupFolderHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [backupFolderName, setBackupFolderName] = useState<string>("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCounter = useRef(0);
  const [autoBackupEnabled, setAutoBackupEnabled] = useState<boolean>(saved?.autoBackupEnabled ?? false);
  const [keepBackupHistory, setKeepBackupHistory] = useState<boolean>(saved?.keepBackupHistory ?? false);
  const [lastBackupAt, setLastBackupAt] = useState<Date | null>(saved?.lastBackupAt ? new Date(saved.lastBackupAt) : null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [liveTime, setLiveTime] = useState(() => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

  // Duplicate prevention
  type DuplicateInfo = { date: string; client: string; detail1Label: string; detail1Value: string; detail2Label?: string; detail2Value?: string; amountLabel?: string; amountValue?: string; };
  const [duplicateModal, setDuplicateModal] = useState<DuplicateInfo | null>(null);
  const duplicateResolveRef = useRef<((v: boolean) => void) | null>(null);
  function showDuplicateConfirm(info: DuplicateInfo): Promise<boolean> {
    return new Promise(resolve => { duplicateResolveRef.current = resolve; setDuplicateModal(info); });
  }

  // Save-in-progress guards (prevent double-clicks)
  const [shootSaving, setShootSaving] = useState(false);
  const [directSaving, setDirectSaving] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setLiveTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), 10000);
    return () => clearInterval(t);
  }, []);
  const [docsConnected, setDocsConnected] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [docsOpen, setDocsOpen] = useState<boolean>(false);
  const [adminSettingsOpen, setAdminSettingsOpen] = useState<boolean>(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState<boolean>(false);
  const [docsRefreshTrigger, setDocsRefreshTrigger] = useState<number>(0);

  // Force-close Settings panels if user is not admin
  React.useEffect(() => {
    if (currentUser.role !== "admin") {
      setSettingsOpen(false);
      setAdminSettingsOpen(false);
    }
  }, [currentUser.role]);
  const prevGeneratedInvoiceRef = useRef<GeneratedInvoice | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [showDebugStats, setShowDebugStats] = useState<boolean>(() => localStorage.getItem("debugStats") === "1");
  React.useEffect(() => { localStorage.setItem("debugStats", showDebugStats ? "1" : "0"); }, [showDebugStats]);

  // Check docs folder connectivity (re-check when Documents panel opens/closes)
  useEffect(() => {
    getStoredDocsHandle().then(h => setDocsConnected(h !== null)).catch(() => setDocsConnected(false));
  }, [docsOpen]);

  const appHealth: AppHealthStats = useMemo(() => ({
    shootCount: shoots.length,
    calendarEventCount: calendarEvents.length,
    invoiceCount: savedInvoices.length,
    localStorageKb: Math.round((window.localStorage.getItem(STORAGE_KEY) ?? "").length / 1024),
    docsConnected,
    backupFolderConnected: backupFolderHandle !== null,
  }), [shoots.length, calendarEvents.length, savedInvoices.length, docsConnected, backupFolderHandle]);

  // Auto-save PDF to Documents whenever a new invoice is generated
  useEffect(() => {
    const prev = prevGeneratedInvoiceRef.current;
    prevGeneratedInvoiceRef.current = generatedInvoice;
    // Only fire when invoice actually changes to a non-null value
    if (!generatedInvoice) return;
    if (prev?.invoiceNumber === generatedInvoice.invoiceNumber &&
        prev?.totalTTC === generatedInvoice.totalTTC) return;
    (async () => {
      const saved = await saveInvoiceToDocuments(generatedInvoice);
      if (saved) {
        showToast("Invoice PDF saved to Documents", "success");
        setDocsRefreshTrigger(n => n + 1);
      } else {
        showToast("Invoice created. Connect a Documents folder to auto-save PDFs.", "success");
      }
    })();
  }, [generatedInvoice]);

  // Google Calendar connection state
  const [gcalAccessToken, setGcalAccessToken] = useState<string | null>(() => {
    // Restore token from localStorage on page load (persists across tab closes/browser restarts)
    try {
      const token = localStorage.getItem(GCAL_TOKEN_KEY);
      const expiry = Number(localStorage.getItem(GCAL_TOKEN_EXPIRY_KEY) ?? "0");
      if (token && expiry > Date.now()) return token;
    } catch { /* ignore */ }
    return null;
  });
  const [gcalConnectedEmail, setGcalConnectedEmail] = useState<string>(() => {
    try { return localStorage.getItem(GCAL_ACCOUNT_KEY) ?? ""; } catch { return ""; }
  });
  const [gcalCalendars, setGcalCalendars] = useState<GCalendarListEntry[]>([]);
  const [gcalSelectedIds, setGcalSelectedIds] = useState<Set<string>>(() => {
    const saved = loadSavedData();
    return saved?.gcalSelectedIds?.length ? new Set(saved.gcalSelectedIds) : new Set();
  });
  const [gcalLoading, setGcalLoading] = useState(false);
  const [gcalError, setGcalError] = useState<string | null>(null);
  const [gapiReady, setGapiReady] = useState(false);
  const [gcalHasWriteScope, setGcalHasWriteScope] = useState<boolean>(() => {
    const saved = loadSavedData();
    return saved?.gcalHasWriteScope ?? false;
  });
  const [gcalSyncStats, setGcalSyncStats] = useState<{
    added: number; updated: number; removed: number; fetched: number; lastSyncAt: Date | null;
  }>({ added: 0, updated: 0, removed: 0, fetched: 0, lastSyncAt: null });

  useEffect(() => {
    let attempts = 0;
    const wait = setInterval(() => {
      attempts++;
      if (window.gapi) {
        clearInterval(wait);
        gapiLoadClient().then(() => setGapiReady(true)).catch(() => {});
      }
      if (attempts > 40) clearInterval(wait);
    }, 250);
    return () => clearInterval(wait);
  }, []);

  // Proactively refresh Google token when it's within 5 min of expiry
  useEffect(() => {
    if (!gcalAccessToken) return;
    const REFRESH_BEFORE_MS = 5 * 60 * 1000;
    let timeout: ReturnType<typeof setTimeout>;
    function scheduleRefresh() {
      try {
        const expiry = Number(localStorage.getItem(GCAL_TOKEN_EXPIRY_KEY) ?? "0");
        const msUntilRefresh = expiry - REFRESH_BEFORE_MS - Date.now();
        if (msUntilRefresh <= 0) {
          _reconnectSilently().catch(() => {});
          return;
        }
        timeout = setTimeout(() => {
          _reconnectSilently().catch(() => {});
        }, msUntilRefresh);
      } catch { /**/ }
    }
    scheduleRefresh();
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcalAccessToken]);

  // Auto-restore Google connection on page load.
  // Three cases handled when gapiReady fires:
  //   1. Token still valid in localStorage  → fetch calendars + sync immediately
  //   2. Token expired but GCAL_CONNECTED_KEY set → attempt silent re-auth, then sync
  //   3. No prior connection → do nothing
  const gcalRestoreAttempted = React.useRef(false);
  useEffect(() => {
    if (!gapiReady || gcalRestoreAttempted.current) return;
    gcalRestoreAttempted.current = true;

    const wasConnected = (() => { try { return localStorage.getItem(GCAL_CONNECTED_KEY) === "1"; } catch { return false; } })();
    const savedWriteScope = (() => { try { return localStorage.getItem(GCAL_WRITE_SCOPE_KEY) === "1"; } catch { return false; } })();
    const currentToken = gcalAccessToken; // valid if expiry check passed in useState init

    if (!wasConnected && !currentToken) return; // user never connected

    (async () => {
      setGcalLoading(true);
      let token = currentToken;
      try {
        // Case 2: token expired but user was previously connected — try silent re-auth
        if (!token) {
          const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
          if (!clientId || !window.google?.accounts?.oauth2) {
            setGcalError("Reconnect Google Calendar");
            return;
          }
          console.log("Google Calendar: token expired, attempting silent re-auth on startup");
          try {
            token = await _requestGoogleToken(clientId, savedWriteScope, true);
            setGcalAccessToken(token);
            setGcalHasWriteScope(savedWriteScope);
          } catch {
            console.warn("Google Calendar: silent re-auth failed on startup — user must reconnect manually");
            setGcalError("Session expired — tap Connect to reconnect Google Calendar");
            return;
          }
        }

        console.log("Google Calendar: restoring session from localStorage");
        const cals = await fetchGoogleCalendars(token);
        setGcalCalendars(cals);
        const savedIds = [...gcalSelectedIds].filter(id => cals.some(c => c.id === id));
        const resolvedIds = new Set<string>(
          savedIds.length > 0 ? savedIds : cals.find(c => c.primary) ? [cals.find(c => c.primary)!.id] : []
        );
        if (savedIds.length === 0 && resolvedIds.size > 0) {
          setGcalSelectedIds(resolvedIds);
        }
        if (resolvedIds.size > 0) {
          console.log("Google Calendar: auto-syncing after session restore");
          await _syncGoogleCalendarWithToken(token, resolvedIds);
        }
      } catch (e) {
        console.warn("Google Calendar: session restore failed", e);
        setGcalAccessToken(null);
        _clearTokenStorage();
        setGcalError("Session expired — tap Connect to reconnect Google Calendar");
      } finally {
        setGcalLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapiReady]);

  // Internal helper — runs the OAuth popup and resolves with the new access token.
  // Used by connectGoogle and the auto-reconnect path.
  function _persistToken(token: string) {
    try {
      localStorage.setItem(GCAL_TOKEN_KEY, token);
      // Access tokens last ~1h; store with 55-min expiry to be safe
      localStorage.setItem(GCAL_TOKEN_EXPIRY_KEY, String(Date.now() + 55 * 60 * 1000));
    } catch { /**/ }
  }

  function _clearTokenStorage() {
    try {
      localStorage.removeItem(GCAL_TOKEN_KEY);
      localStorage.removeItem(GCAL_TOKEN_EXPIRY_KEY);
    } catch { /**/ }
  }

  async function _requestGoogleToken(clientId: string, writeScope: boolean, silent = false): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const client = window.google!.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: writeScope ? GOOGLE_SCOPES_WRITE : GOOGLE_SCOPES_READ,
        prompt: silent ? "none" : undefined,
        callback: (resp) => {
          if (resp.error || !resp.access_token) {
            reject(new Error(resp.error || "OAuth failed"));
          } else {
            _persistToken(resp.access_token);
            resolve(resp.access_token);
          }
        },
      });
      client.requestAccessToken();
    });
  }

  async function connectGoogle(writeScope = false) {
    const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
    if (!clientId) {
      setGcalError("Google Client ID not configured. Add VITE_GOOGLE_CLIENT_ID= in the .env file, then restart.");
      console.error("Google Calendar: VITE_GOOGLE_CLIENT_ID is not set");
      return;
    }
    if (!window.google?.accounts?.oauth2) {
      setGcalError("Google Identity Services not loaded yet. Please wait a moment and try again.");
      console.error("Google Calendar: google.accounts.oauth2 is not available");
      return;
    }
    if (!gapiReady) {
      setGcalError("Google API client not ready yet. Please wait a moment and try again.");
      console.error("Google Calendar: gapi client not ready");
      return;
    }
    setGcalError(null);
    setGcalLoading(true);
    try {
      const accessToken = await _requestGoogleToken(clientId, writeScope);
      setGcalAccessToken(accessToken);
      setGcalHasWriteScope(writeScope);
      // Mark as persistently connected so startup can auto-reconnect
      try {
        localStorage.setItem(GCAL_CONNECTED_KEY, "1");
        localStorage.setItem(GCAL_WRITE_SCOPE_KEY, writeScope ? "1" : "0");
      } catch { /**/ }
      console.log(`Google Calendar: connected (writeScope=${writeScope})`);

      const cals = await fetchGoogleCalendars(accessToken);
      setGcalCalendars(cals);
      // Save account email (primary calendar summary = email address)
      const primaryCal = cals.find(c => c.primary);
      const email = primaryCal?.summary ?? primaryCal?.id ?? "";
      if (email) {
        setGcalConnectedEmail(email);
        try { localStorage.setItem(GCAL_ACCOUNT_KEY, email); } catch { /**/ }
      }

      // Restore previously selected calendar IDs if they still exist, else fall back to primary
      const restored = [...gcalSelectedIds].filter(id => cals.some(c => c.id === id));
      if (restored.length > 0) {
        setGcalSelectedIds(new Set(restored));
      } else {
        const primary = cals.find(c => c.primary);
        if (primary) setGcalSelectedIds(new Set([primary.id]));
      }

      // Resolve the final set of IDs to sync — use restored/primary (not stale closure state)
      const resolvedIds = new Set<string>(
        restored.length > 0 ? restored : (cals.find(c => c.primary) ? [cals.find(c => c.primary)!.id] : [])
      );

      // Auto-sync with the resolved IDs (state hasn't flushed yet so pass explicitly)
      if (resolvedIds.size > 0) {
        console.log("Google Calendar: auto-syncing after connect");
        // Small delay to let setGcalLoading(false) render before sync starts
        setTimeout(() => _syncGoogleCalendarWithToken(accessToken, resolvedIds), 100);
      }

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to connect";
      if (!msg.includes("popup_closed") && !msg.includes("access_denied")) {
        setGcalError(msg);
        console.error("Google Calendar Sync Error:", e);
      }
    } finally {
      setGcalLoading(false);
    }
  }

  // Token-expiry aware reconnect — called when a gapi call returns 401.
  // Tries to silently refresh; if that fails, prompts the user.
  async function _reconnectSilently(): Promise<string | null> {
    const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
    if (!clientId || !window.google?.accounts?.oauth2) return null;
    try {
      console.log("Google Calendar: token expired, attempting silent re-auth");
      const token = await _requestGoogleToken(clientId, gcalHasWriteScope, true);
      setGcalAccessToken(token);
      console.log("Google Calendar: silent re-auth succeeded");
      return token;
    } catch {
      // Silent failed — try interactive popup
      try {
        const token = await _requestGoogleToken(clientId, gcalHasWriteScope, false);
        setGcalAccessToken(token);
        return token;
      } catch (e2) {
        console.error("Google Calendar: re-auth failed", e2);
        setGcalAccessToken(null);
        _clearTokenStorage();
        setGcalError("Google session expired. Please reconnect Google Calendar.");
        return null;
      }
    }
  }

  function disconnectGoogle() {
    if (gcalAccessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(gcalAccessToken, () => {
        console.log("Google Calendar: token revoked");
      });
    }
    setGcalAccessToken(null);
    setGcalCalendars([]);
    setGcalConnectedEmail("");
    setGcalError(null);
    setGcalHasWriteScope(false);
    setGcalSyncStats({ added: 0, updated: 0, removed: 0, fetched: 0, lastSyncAt: null });
    _clearTokenStorage();
    try {
      localStorage.removeItem(GCAL_CONNECTED_KEY);
      localStorage.removeItem(GCAL_WRITE_SCOPE_KEY);
      localStorage.removeItem(GCAL_ACCOUNT_KEY);
    } catch { /**/ }
    // Keep gcalSelectedIds so next reconnect auto-selects the same calendars
  }

  // Core sync logic — accepts explicit token + selectedIds so it can be called
  // both from syncGoogleCalendar (uses current state) and from connectGoogle
  // (passes the newly obtained token before state has flushed).
  async function _syncGoogleCalendarWithToken(token: string, selectedIds: Set<string>): Promise<void> {
    if (!token || selectedIds.size === 0) return;
    setGcalLoading(true);
    setGcalError(null);
    try {
      const itemsWithCalId: Array<{ item: GCalendarEventItem; calId: string }> = [];
      for (const calId of selectedIds) {
        const items = await fetchGoogleEvents(token, calId);
        items.forEach(item => itemsWithCalId.push({ item, calId }));
      }
      let idx = 0;
      const freshEvents = itemsWithCalId
        .flatMap(({ item, calId }) => gCalEventToCalendarEvents(item, idx++, calId))
        .filter((e): e is CalendarEvent => e !== null);

      console.log(`Calendar events loaded: ${freshEvents.length} from ${selectedIds.size} calendar(s)`);

      // Capture counts from inside the state updater
      const syncStatsCapture = { added: 0, updated: 0, removed: 0 };

      setCalendarEvents(existing => {
        const freshGoogleIds = new Set(freshEvents.map(e => e.googleEventId).filter(Boolean) as string[]);
        // Build a set of base Google IDs (strip the _d{date} suffix from multi-day expansions)
        const freshBaseIds = new Set<string>();
        for (const gid of freshGoogleIds) {
          const base = gid.replace(/_d\d{4}-\d{2}-\d{2}$/, "");
          freshBaseIds.add(base);
          freshBaseIds.add(gid);
        }

        // Remove local events whose googleEventId (or base ID) no longer exists in Google
        const surviving = existing.filter(e => {
          if (!e.googleEventId) return true;
          const base = e.googleEventId.replace(/_d\d{4}-\d{2}-\d{2}$/, "");
          if (freshBaseIds.has(e.googleEventId) || freshBaseIds.has(base)) return true;
          console.log(`Deleted events removed: "${e.title}" (${e.date}) [${e.googleEventId}]`);
          return false;
        });

        // Index by googleEventId only — no title/date fallback, Google ID is the canonical key
        const byGoogleId = new Map(surviving.filter(e => e.googleEventId).map(e => [e.googleEventId!, e]));

        let added = 0;
        let updated = 0;
        const result = [...surviving];

        for (const ev of freshEvents) {
          const match = ev.googleEventId ? byGoogleId.get(ev.googleEventId) : undefined;

          if (match) {
            // Google is source of truth — always overwrite all Google-owned fields
            const needsUpdate =
              ev.date        !== match.date        ||
              ev.time        !== match.time        ||
              ev.endTime     !== match.endTime     ||
              ev.title       !== match.title       ||
              ev.description !== match.description ||
              ev.location    !== match.location;

            if (needsUpdate) {
              const i = result.indexOf(match);
              if (i !== -1) {
                result[i] = {
                  ...match,
                  date:           ev.date,
                  time:           ev.time,
                  endTime:        ev.endTime,
                  title:          ev.title,
                  description:    ev.description,
                  location:       ev.location,
                  googleEventId:  ev.googleEventId ?? match.googleEventId,
                  gcalCalendarId: ev.gcalCalendarId ?? match.gcalCalendarId,
                  // Preserve local-only app fields
                  imported:       match.imported,
                };
                updated++;
                byGoogleId.set(result[i].googleEventId!, result[i]);
                console.log(`Updated events detected: "${ev.title}" (${ev.date} ${ev.time ?? ""})`);
              }
            }
          } else {
            // New event in Google — add to local
            result.push(ev);
            added++;
            if (ev.googleEventId) byGoogleId.set(ev.googleEventId, ev);
          }
        }

        const deduped = dedupeCalendarEvents(result);

        const removed = existing.length - surviving.length;
        syncStatsCapture.added   = added;
        syncStatsCapture.updated = updated;
        syncStatsCapture.removed = removed;
        const parts: string[] = [];
        if (added   > 0) parts.push(`${added} added`);
        if (updated > 0) parts.push(`${updated} updated`);
        if (removed > 0) parts.push(`${removed} removed`);
        if (parts.length) showToast(parts.join(", "), "success");
        return deduped;
      });

      setGcalSyncStats({
        fetched:   freshEvents.length,
        added:     syncStatsCapture.added,
        updated:   syncStatsCapture.updated,
        removed:   syncStatsCapture.removed,
        lastSyncAt: new Date(),
      });
      console.log(`Google sync success — fetched=${freshEvents.length} added=${syncStatsCapture.added} updated=${syncStatsCapture.updated} removed=${syncStatsCapture.removed}`);
    } catch (e: unknown) {
      const status = (e as { status?: number; result?: { error?: { code?: number } } })?.status
        ?? (e as { result?: { error?: { code?: number } } })?.result?.error?.code;
      if (status === 401) {
        // Token expired — try silent reconnect then retry once
        console.error("Google sync fail: 401 token expired, attempting re-auth", e);
        const newToken = await _reconnectSilently();
        if (newToken) {
          try {
            await _syncGoogleCalendarWithToken(newToken, selectedIds);
          } catch (retryErr) {
            console.error("Google sync fail (retry):", retryErr);
            setGcalError("Sync failed after token refresh. Please reconnect.");
            showToast("Google Calendar sync failed", "error");
          }
        }
      } else {
        const msg = e instanceof Error ? e.message : "Sync failed";
        console.error("Google sync fail:", e);
        setGcalError(msg);
        showToast("Google Calendar sync failed", "error");
      }
    } finally {
      setGcalLoading(false);
    }
  }

  async function syncGoogleCalendar() {
    if (!gcalAccessToken || gcalSelectedIds.size === 0) return;
    await _syncGoogleCalendarWithToken(gcalAccessToken, gcalSelectedIds);
  }
  const undoStack = useRef<UndoSnapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  // Refs to always-current state for use inside callbacks without stale closures
  const shootsRef = useRef(shoots);
  const directIncomeRef = useRef(directIncome);
  const pricingRef = useRef(pricing);
  const generatedInvoiceRef = useRef(generatedInvoice);
  const savedInvoicesRef = useRef(savedInvoices);
  const invoiceSequencesRef = useRef(invoiceSequences);
  const editingJobsRef = useRef(editingJobs);
  useEffect(() => { shootsRef.current = shoots; }, [shoots]);
  useEffect(() => { directIncomeRef.current = directIncome; }, [directIncome]);
  useEffect(() => { pricingRef.current = pricing; }, [pricing]);
  useEffect(() => { generatedInvoiceRef.current = generatedInvoice; }, [generatedInvoice]);
  useEffect(() => { savedInvoicesRef.current = savedInvoices; }, [savedInvoices]);
  useEffect(() => { invoiceSequencesRef.current = invoiceSequences; }, [invoiceSequences]);
  useEffect(() => { editingJobsRef.current = editingJobs; }, [editingJobs]);

  // ── Google Sheets sync (via edge function — no OAuth required) ───────────────
  const syncInProgress = useRef(false);
  // Tracks jobs that have a pending local stage move not yet confirmed by the sheet.
  // Keys: job.id, Values: ISO timestamp of when the move started.
  // syncFromSheet will not overwrite these until the move is confirmed or times out.
  const pendingMoves = useRef<Map<string, { stage: string; movedAt: number }>>(new Map());
  const PENDING_MOVE_TIMEOUT_MS = 20_000; // 20 s — max time to hold a pending move

  const syncFromSheet = useCallback(async () => {
    if (syncInProgress.current) return;
    syncInProgress.current = true;
    setSheetsSyncState(s => ({ ...s, status: "syncing", error: null }));
    console.log("[SYNC_START]");
    try {
      const { jobs, fromCache, sheetId, sheetName, gid } = await fetchSheetJobs();

      // Merge: don't let a stale sheet read overwrite a pending local move.
      // A "pending move" is one started within the last PENDING_MOVE_TIMEOUT_MS.
      const now = Date.now();
      const pending = pendingMoves.current;
      // Expire stale pending entries
      for (const [id, entry] of pending) {
        if (now - entry.movedAt > PENDING_MOVE_TIMEOUT_MS) pending.delete(id);
      }

      const merged = jobs.map(job => {
        const p = pending.get(job.id);
        if (p && now - p.movedAt <= PENDING_MOVE_TIMEOUT_MS) {
          // Preserve the local stage until the sheet confirms the move
          return { ...job, sasha: { ...job.sasha, stage: p.stage as import("./sheetsSync").SashaStage } };
        }
        return job;
      });

      setSheetJobs(merged);
      setSheetsSyncState({ status: fromCache ? "offline" : "ok", lastSynced: new Date(), error: null, fromCache, rowCount: jobs.length, sheetId, sheetName, gid });
      console.log(`[SYNC_SUCCESS] ${jobs.length} jobs, fromCache=${fromCache}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      setSheetsSyncState(s => ({ ...s, status: "error", error: msg }));
      showToast(msg, "error");
      console.error("[SYNC_ERROR]", msg);
    } finally {
      syncInProgress.current = false;
    }
  }, []);

  const handleSaveSasha = useCallback(async (job: SheetJob, sasha: SashaData) => {
    const actor  = currentUser.displayName;
    const isSasha  = actor.toLowerCase().includes("sasha");
    const isGerman = actor.toLowerCase().includes("german") || actor.toLowerCase().includes("hermann");

    const commentChanged = sasha.comment !== job.sasha.comment;
    const requestChanged = sasha.request !== job.sasha.request;

    let reviewStatus: SashaReviewStatus = sasha.reviewStatus ?? "";
    let actionReason: SashaActionReason = sasha.actionReason ?? "";

    if (commentChanged || requestChanged) {
      if (isSasha)       reviewStatus = "waiting_german";
      else if (isGerman) reviewStatus = "waiting_sasha";
      if (commentChanged) actionReason = "new_comment";
    }

    const updatedSasha: SashaData = { ...sasha, reviewStatus, actionReason };
    const updated: SheetJob = { ...job, sasha: updatedSasha };
    setSheetJobs(prev => prev.map(j => j.id === job.id ? updated : j));

    const action = commentChanged ? "updated comment" : requestChanged ? "updated request" : "updated fields";
    const { cached } = await writeSashaColumns(updated, actor, action);
    logCardActivity({ jobId: job.id, sheetRow: job.sheetRow, actor, action }).catch(() => {});
    showToast(cached ? "Saved locally — will sync when online" : "Saved to Google Sheets", cached ? "error" : "success");
    if (!cached) {
      syncInProgress.current = false;
      await syncFromSheet();
    }
  }, [currentUser.displayName, syncFromSheet]);

  const handleMarkReviewed = useCallback(async (job: SheetJob) => {
    const actor = currentUser.displayName;
    const updatedSasha: SashaData = { ...job.sasha, reviewStatus: "reviewed", actionReason: "" };
    setSheetJobs(prev => prev.map(j => j.id === job.id ? { ...j, sasha: updatedSasha } : j));
    await writeReviewStatus(job, "reviewed", actor, "");
    syncInProgress.current = false;
    await syncFromSheet();
  }, [currentUser.displayName, syncFromSheet]);

  const handlePhotosSaved = useCallback(async (job: SheetJob, photosToEdit: number | null) => {
    const actor    = currentUser.displayName;
    const isSasha  = actor.toLowerCase().includes("sasha");
    const isGerman = actor.toLowerCase().includes("german") || actor.toLowerCase().includes("hermann");
    const reviewStatus: SashaReviewStatus = isSasha ? "waiting_german" : isGerman ? "waiting_sasha" : (job.sasha.reviewStatus ?? "");
    const actionReason: SashaActionReason = "photos_added";
    const updatedSasha: SashaData = { ...job.sasha, reviewStatus, actionReason };
    setSheetJobs(prev => prev.map(j => j.id === job.id ? { ...j, sasha: updatedSasha } : j));
    await writeReviewStatus(job, reviewStatus, actor, actionReason);
    syncInProgress.current = false;
    await syncFromSheet();
    void photosToEdit; // used by caller for display; sync reads from sheet
  }, [currentUser.displayName, syncFromSheet]);

  const handleSaveEmail = useCallback(async (job: SheetJob, emails: string) => {
    setSheetJobs(prev => prev.map(j =>
      j.id === job.id ? { ...j, herman: { ...j.herman, emails } } : j
    ));
    const { ok } = await writeEmailColumn(job, emails);
    showToast(ok ? "Email saved to Sheet" : "Email save failed", ok ? "success" : "error");
    if (ok) {
      syncInProgress.current = false;
      await syncFromSheet();
    }
  }, [syncFromSheet]);

  const handleMoveStage = useCallback(async (job: SheetJob, toGroup: CardGroup) => {
    const actor = currentUser.displayName;
    const oldStage = job.sasha.stage;

    // Register pending move so concurrent syncs don't overwrite this card's stage
    pendingMoves.current.set(job.id, { stage: toGroup, movedAt: Date.now() });

    // Optimistic update so the card stays in the new column immediately
    const updatedSasha = { ...job.sasha, stage: toGroup as import("./sheetsSync").SashaStage };
    setSheetJobs(prev => prev.map(j => j.id === job.id ? { ...j, sasha: updatedSasha } : j));

    console.log(`[MOVE_STAGE_SHEET_WRITE] id=${job.id} row=${job.sheetRow} from=${oldStage} to=${toGroup} actor=${actor}`);
    const { ok, blockEndRow } = await moveJobStage(job, toGroup, actor);
    logCardActivity({ jobId: job.id, sheetRow: job.sheetRow, actor, action: "moved stage", oldStage, newStage: toGroup }).catch(() => {});
    const blockMsg = blockEndRow > job.sheetRow ? ` (rows ${job.sheetRow}–${blockEndRow})` : "";

    if (ok) {
      showToast(`Stage updated${blockMsg}`, "success");
      // Clear pending move — the sheet is now authoritative
      pendingMoves.current.delete(job.id);
      // Force a fresh sheet read so both users see the authoritative state
      syncInProgress.current = false;
      await syncFromSheet();
      console.log(`[MOVE_STAGE_SHEET_READ] confirmed job=${job.id} newStage=${toGroup}`);
    } else {
      showToast("Stage saved locally — sheet write failed", "error");
      // Keep pending move entry so the optimistic stage survives the next poll
      // Roll back the sheetJobs optimistic update — the pending move map still guards it
      setSheetJobs(prev => prev.map(j => j.id === job.id ? job : j));
      pendingMoves.current.delete(job.id);
    }
  }, [currentUser.displayName, syncFromSheet]);


  const handleEditingTestConnection = useCallback(async () => {
    setEditingSyncLoading(true);
    setEditingSyncStatus(null);
    try {
      const result = await testSheetConnection();
      setEditingSyncStatus(result.message);
      if (result.ok) {
        // Auto-load jobs after a successful test
        await syncFromSheet();
      }
    } finally {
      setEditingSyncLoading(false);
    }
  }, [syncFromSheet]);

  const handleTestWrite = useCallback(async () => {
    setTestWriteResult(null);
    setEditingSyncLoading(true);
    try {
      const result = await testSheetWrite();
      setTestWriteResult({ ok: result.ok, message: result.message });
      if (result.ok) {
        syncInProgress.current = false;
        await syncFromSheet();
      }
    } finally {
      setEditingSyncLoading(false);
    }
  }, [syncFromSheet]);

  const handleEditingSyncNow = useCallback(async () => {
    setEditingSyncLoading(true);
    try {
      await syncFromSheet();
      flushDirtyCache().catch(() => {});
    } finally {
      setEditingSyncLoading(false);
    }
  }, [syncFromSheet]);

  const handleTestAccounting = useCallback(async () => {
    setAcctTestResult(null);
    setEditingSyncLoading(true);
    try {
      const result = await testAccountingSheet();
      setAcctTestResult(result);
    } finally {
      setEditingSyncLoading(false);
    }
  }, []);

  const handleDebugRead = useCallback(async () => {
    setDebugReadResult(null);
    setEditingSyncLoading(true);
    try {
      const result = await debugSheetRead();
      console.log("[DEBUG-READ] result:", JSON.stringify(result, null, 2));
      setDebugReadResult(result);
    } finally {
      setEditingSyncLoading(false);
    }
  }, []);

  // Auto-sync on first load and whenever the Editing tab is opened
  const prevActiveTab = useRef<string>("");
  useEffect(() => {
    if (activeTab === "Editing" && prevActiveTab.current !== "Editing") {
      flushDirtyCache().catch(() => {});
      syncFromSheet();
    }
    prevActiveTab.current = activeTab;
  }, [activeTab, syncFromSheet]);

  // Also auto-sync on initial app load if on Editing tab
  useEffect(() => {
    if (activeTab === "Editing") syncFromSheet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load prices from Google Sheet on startup — sheet is source of truth
  useEffect(() => {
    fetchPrices().then(result => {
      console.log(`[SYNC] prices | ok=${result.ok} | fetched=${result.prices?.length ?? 'undefined'} | error=${result.error ?? 'none'}`);
      if (result.ok && Array.isArray(result.prices) && result.prices.length > 0) {
        const rows = result.prices.map(p => ({
          id:           Number(p.id) || p.sheetRow,
          hotel:        p.hotel,
          photoPackage: p.photoPackage,
          department:   p.department,
          ht:           p.ht,
        }));
        setPricing(rows);
        showToast(`Loaded ${rows.length} prices from Google Sheet`, "success");
        console.log(`[SYNC] prices | loaded ${rows.length} rows`);
        rows.slice(0, 5).forEach(r => console.log(`  [price] ${r.hotel} | ${r.photoPackage} | ${r.department} | ht=${r.ht}`));
      } else if (result.ok && result.prices?.length === 0) {
        console.warn("[SYNC] prices | 0 rows returned — keeping cached prices. Check Price tab headers.");
        showToast("Price tab read returned 0 parsed rows — check headers in Google Sheet", "error");
      } else if (!result.ok) {
        console.warn("[SYNC] prices | fetch failed — keeping cached prices:", result.error);
        showToast(`Prices load failed: ${result.error ?? "Unknown error"}`, "error");
      }
    }).catch(err => console.warn("[SYNC] prices | exception — keeping cached prices:", err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch prices whenever the Prices tab becomes active
  useEffect(() => {
    if (activeTab !== "Prices") return;
    fetchPrices().then(result => {
      if (result.ok && result.prices && result.prices.length > 0) {
        const rows = result.prices.map(p => ({
          id:           Number(p.id) || p.sheetRow,
          hotel:        p.hotel,
          photoPackage: p.photoPackage,
          department:   p.department,
          ht:           p.ht,
        }));
        setPricing(rows);
        console.log(`Loaded prices from tab Price: ${rows.length} rows`);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Load Shoots + Direct from Google Sheet on startup — sheet is source of truth
  useEffect(() => {
    const now = () => new Date().toLocaleTimeString();
    console.log('[Accounting Sync] startup load — fetching Shoots + Direct');
    Promise.all([fetchAllShoots(), fetchAllDirect()]).then(([shootsResult, directResult]) => {
      let shootsLoaded = 0;
      let directLoaded = 0;
      let error: string | null = null;

      console.log(`[SYNC] startup | tab Shoots | fetched=${shootsResult.ok ? (shootsResult.shoots?.length ?? 0) : 'ERROR'} | error=${shootsResult.ok ? 'none' : shootsResult.error}`);
      if (shootsResult.ok && Array.isArray(shootsResult.shoots) && shootsResult.shoots.length > 0) {
        const rows = shootsResult.shoots.map(s => normalizeShoot({
          id: s.id, date: s.date, hotel: s.hotel, client: s.client,
          eventType: s.eventType, photoPackage: s.photoPackage, department: s.department,
          source: s.source, ht: s.ht, tax: s.tax, finalAmount: s.finalAmount, status: s.status,
        }));
        const replaced = safeReplaceShoots(rows, 'startup');
        if (replaced) shootsLoaded = rows.length;
      } else if (!shootsResult.ok) {
        error = `Shoots: ${shootsResult.error ?? 'Unknown error'}`;
        console.warn('[SYNC] startup | tab Shoots | load failed — keeping cached state |', shootsResult.error);
      } else {
        console.log('[SYNC] startup | tab Shoots | 0 rows returned — keeping cached state');
      }

      console.log(`[SYNC] startup | tab Direct | fetched=${directResult.ok ? (directResult.direct?.length ?? 0) : 'ERROR'} | error=${directResult.ok ? 'none' : directResult.error}`);
      if (directResult.ok && Array.isArray(directResult.direct) && directResult.direct.length > 0) {
        const rows = directResult.direct.map(d => normalizeDirect({ id: d.id, date: d.date, client: d.client, income: d.income, amount: d.amount }));
        setDirectIncome(rows);
        directLoaded = rows.length;
        console.log('[Accounting Sync] tab Direct | loaded', rows.length, 'rows');
      } else if (!directResult.ok) {
        const msg = `Direct: ${directResult.error ?? 'Unknown error'}`;
        error = error ? `${error} | ${msg}` : msg;
        console.warn('[SYNC] startup | tab Direct | load failed — keeping cached state |', directResult.error);
      } else {
        console.log('[SYNC] startup | tab Direct | 0 rows returned — keeping cached state');
      }

      setAcctSyncStats({ shootsLoaded, directLoaded, lastSync: now(), error });
    }).catch(err => {
      const msg = err instanceof Error ? err.message : 'Network error';
      console.warn('[SYNC] startup load exception — keeping all cached state |', msg);
      setAcctSyncStats(prev => ({ ...prev, error: msg }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch shoots whenever the Shoots tab becomes active
  useEffect(() => {
    if (activeTab !== "Shoots") return;
    fetchAllShoots().then(result => {
      console.log(`[SYNC] tab-active | fetched=${result.ok ? (result.shoots?.length ?? 0) : 'ERROR'} | local=${shootsRef.current.length}`);
      if (result.ok && Array.isArray(result.shoots) && result.shoots.length > 0) {
        const rows = result.shoots.map(s => normalizeShoot({
          id:           s.id,
          date:         s.date,
          hotel:        s.hotel,
          client:       s.client,
          eventType:    s.eventType,
          photoPackage: s.photoPackage,
          department:   s.department,
          source:       s.source,
          ht:           s.ht,
          tax:          s.tax,
          finalAmount:  s.finalAmount,
          status:       s.status,
        }));
        safeReplaceShoots(rows, 'tab-active');
      } else if (!result.ok) {
        console.warn('[SYNC] tab-active | fetch failed — keeping cached state |', result.error);
      } else {
        console.log('[SYNC] tab-active | 0 rows returned — keeping cached state');
      }
    }).catch(err => console.warn('[SYNC] tab-active | exception — keeping cached state |', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Manual refresh for Direct tab — re-fetches Direct (and Shoots) from Google Sheet
  const [acctRefreshing, setAcctRefreshing] = useState(false);
  const refreshAccounting = useCallback(async () => {
    if (acctRefreshing) return;
    setAcctRefreshing(true);
    const now = () => new Date().toLocaleTimeString();
    try {
      const [shootsResult, directResult] = await Promise.all([fetchAllShoots(), fetchAllDirect()]);
      let shootsLoaded = 0;
      let directLoaded = 0;
      let error: string | null = null;
      if (shootsResult.ok && Array.isArray(shootsResult.shoots) && shootsResult.shoots.length > 0) {
        const rows = shootsResult.shoots.map(s => normalizeShoot({ id: s.id, date: s.date, hotel: s.hotel, client: s.client, eventType: s.eventType, photoPackage: s.photoPackage, department: s.department, source: s.source, ht: s.ht, tax: s.tax, finalAmount: s.finalAmount, status: s.status }));
        safeReplaceShoots(rows, 'manual-refresh');
        shootsLoaded = rows.length;
      } else if (!shootsResult.ok) { error = `Shoots: ${shootsResult.error ?? 'Unknown'}`; }
      if (directResult.ok && Array.isArray(directResult.direct) && directResult.direct.length > 0) {
        setDirectIncome(directResult.direct.map(d => normalizeDirect({ id: d.id, date: d.date, client: d.client, income: d.income, amount: d.amount })));
        directLoaded = directResult.direct.length;
      } else if (!directResult.ok) {
        const msg = `Direct: ${directResult.error ?? 'Unknown'}`;
        error = error ? `${error} | ${msg}` : msg;
      }
      setAcctSyncStats({ shootsLoaded, directLoaded, lastSync: now(), error });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setAcctSyncStats(prev => ({ ...prev, error: msg }));
    } finally {
      setAcctRefreshing(false);
    }
  }, [acctRefreshing, safeReplaceShoots, setDirectIncome, setAcctSyncStats]);


  // Auto-sync Google Calendar when the Calendar tab becomes active (if connected)
  useEffect(() => {
    if (activeTab === "Calendar" && gcalAccessToken && gcalSelectedIds.size > 0) {
      syncGoogleCalendar();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Background poll every 45s while a Google Calendar token is live (any tab)
  useEffect(() => {
    if (!gcalAccessToken || gcalSelectedIds.size === 0) return;
    const timer = setInterval(() => {
      _syncGoogleCalendarWithToken(gcalAccessToken, gcalSelectedIds).catch(() => {});
    }, 45_000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcalAccessToken, gcalSelectedIds]);

  // Poll every 15s while on Editing tab — keeps both users in sync
  useEffect(() => {
    if (activeTab !== "Editing") return;
    const timer = setInterval(() => { syncFromSheet(); }, 15_000);
    return () => clearInterval(timer);
  }, [activeTab, syncFromSheet]);

  // Re-sync when the browser tab regains visibility after being hidden
  // Calendar: any background period triggers sync (catches deleted/changed events immediately)
  // Editing: only after >5 min to avoid disruptive flushes on quick tab switches
  const lastVisibleAt = useRef<number>(Date.now());
  useEffect(() => {
    const EDITING_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
    const CALENDAR_IDLE_THRESHOLD_MS = 30_000;
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        lastVisibleAt.current = Date.now();
      } else {
        const idleMs = Date.now() - lastVisibleAt.current;
        if (activeTab === "Editing" && idleMs >= EDITING_IDLE_THRESHOLD_MS) {
          flushDirtyCache().catch(() => {});
          syncFromSheet();
        }
        if (gcalAccessToken && gcalSelectedIds.size > 0 && idleMs >= CALENDAR_IDLE_THRESHOLD_MS) {
          console.log(`Google Calendar: re-syncing after ${Math.round(idleMs / 1000)}s in background`);
          _syncGoogleCalendarWithToken(gcalAccessToken, gcalSelectedIds).catch(() => {});
        }
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, gcalAccessToken, gcalSelectedIds, syncFromSheet]);

  // ── Inactivity auto-logout ────────────────────────────────────────────────
  useEffect(() => {
    const events = ["click", "keydown", "mousemove", "touchstart", "scroll"] as const;
    const handler = () => touchActivity();
    events.forEach(ev => window.addEventListener(ev, handler, { passive: true }));

    const check = setInterval(() => {
      const last = Number(localStorage.getItem(LAST_ACTIVITY_KEY) ?? "0");
      if (last && Date.now() - last > INACTIVITY_MS) onLogout();
    }, 60_000);

    return () => {
      events.forEach(ev => window.removeEventListener(ev, handler));
      clearInterval(check);
    };
  }, [onLogout]);

  // ── Activity ping on tab change ────────────────────────────────────────────
  useEffect(() => {
    pingUserActivity(currentUser.id, currentUser.displayName, activeTab, `viewing ${activeTab}`).catch(() => {});
  }, [activeTab, currentUser.id, currentUser.displayName]);

  // ── Other-user presence polling ────────────────────────────────────────────
  const [otherUserPresence, setOtherUserPresence] = useState<OtherUserPresence | null>(null);

  useEffect(() => {
    async function pollPresence() {
      try {
        const other = await fetchOtherUserActivity(currentUser.id);
        if (other) {
          const seenAt = new Date(other.lastSeenAt);
          const isOnline = Date.now() - seenAt.getTime() < 5 * 60 * 1000;
          setOtherUserPresence({
            displayName: other.displayName,
            lastSeenAt:  other.lastSeenAt,
            lastTab:     other.lastTab,
            isOnline,
          });
        } else {
          setOtherUserPresence(null);
        }
      } catch { /* silent */ }
    }
    pollPresence();
    const timer = setInterval(pollPresence, 30_000);
    return () => clearInterval(timer);
  }, [currentUser.id]);

  const snapshot = useCallback(() => {
    const snap: UndoSnapshot = {
      shoots: shootsRef.current,
      directIncome: directIncomeRef.current,
      pricing: pricingRef.current,
      generatedInvoice: generatedInvoiceRef.current,
      savedInvoices: savedInvoicesRef.current,
      invoiceSequences: invoiceSequencesRef.current,
      editingJobs: editingJobsRef.current,
    };
    undoStack.current = [snap, ...undoStack.current].slice(0, 20);
    setCanUndo(true);
  }, []);

  function undo() {
    const [top, ...rest] = undoStack.current;
    if (!top) return;
    undoStack.current = rest;
    setShoots(top.shoots);
    setDirectIncome(top.directIncome);
    setPricing(top.pricing);
    setGeneratedInvoice(top.generatedInvoice);
    setSavedInvoices(top.savedInvoices);
    setInvoiceSequences(top.invoiceSequences);
    setEditingJobs(top.editingJobs);
    setCanUndo(rest.length > 0);
    showToast("Undo successful", "success");
  }

  const showToast = useCallback((message: string, type: Toast["type"]) => {
    const id = ++toastCounter.current;
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2000);
  }, []);

  const handleAddToEditing = useCallback(async (
    event: CalendarEvent,
    result: { type: "resort" | "direct" | "editing_only"; shoot?: Shoot; directRow?: DirectRow; editingJob: NewEditingJob }
  ) => {
    // Duplicate check for shoot
    if (result.type === "resort" && result.shoot) {
      const s = result.shoot;
      const normClient = normalizeStr(s.client);
      const normHotel  = normalizeStr(s.hotel);
      const dupShoot = shoots.find(ex =>
        ex.date === s.date &&
        normalizeStr(ex.client) === normClient &&
        normalizeStr(ex.hotel) === normHotel
      );
      if (dupShoot) {
        const go = await showDuplicateConfirm({
          date: dupShoot.date, client: dupShoot.client,
          detail1Label: "Hotel", detail1Value: dupShoot.hotel,
          detail2Label: "Package", detail2Value: dupShoot.photoPackage,
          amountLabel: "Amount", amountValue: dupShoot.finalAmount ? `${dupShoot.finalAmount.toLocaleString()} XPF` : "—",
        });
        if (!go) return;
      }
    }
    // Duplicate check for direct income
    if (result.type === "direct" && result.directRow) {
      const d = result.directRow;
      const normClient = normalizeStr(d.client);
      const dupDirect = directIncome.find(ex =>
        ex.date === d.date &&
        normalizeStr(ex.client) === normClient &&
        ex.income === d.income
      );
      if (dupDirect) {
        const go = await showDuplicateConfirm({
          date: dupDirect.date, client: dupDirect.client,
          detail1Label: "Income type", detail1Value: dupDirect.income,
          amountLabel: "Amount", amountValue: dupDirect.amount ? `$${dupDirect.amount.toLocaleString()}` : "—",
        });
        if (!go) return;
      }
    }

    const job: NewEditingJob = { ...result.editingJob, actor: currentUser.displayName, editingAddedAt: result.editingJob.editingAddedAt || new Date().toISOString() };
    console.log("[handleAddToEditing] action:", result.type, "| job:", job);
    const t0 = performance.now();
    const addResult = await addJobToSheet(job);
    console.log(`[PERF] addJobToSheet: ${(performance.now() - t0).toFixed(0)}ms`);

    if (!addResult.ok) {
      showToast(`Google Sheet error: ${addResult.error ?? "Write failed"}`, "error");
      return;
    }

    snapshot();

    if (result.type === "resort" && result.shoot) {
      // 1. Optimistic update — instant UI response
      setShoots(rows => [result.shoot!, ...rows]);

      // 2. Write to sheet in background — do NOT await before showing UI
      const sheetRow: ShootSheetRow = {
        id:             result.shoot.id,
        date:           result.shoot.date,
        hotel:          result.shoot.hotel,
        client:         result.shoot.client,
        eventType:      result.shoot.eventType,
        photoPackage:   result.shoot.photoPackage,
        department:     result.shoot.department,
        source:         result.shoot.source,
        ht:             result.shoot.ht,
        tax:            result.shoot.tax,
        finalAmount:    result.shoot.finalAmount,
        status:         result.shoot.status,
        country:        "",
        originalSource: "",
      };
      const tWrite = performance.now();
      writeShootToSheet(sheetRow).then(writeResult => {
        console.log(`[PERF] writeShootToSheet: ${(performance.now() - tWrite).toFixed(0)}ms | ok=${writeResult.ok}`);
        if (!writeResult.ok) {
          console.warn("[handleAddToEditing] writeShootToSheet failed:", writeResult.error);
          showToast(`Sheet write failed: ${writeResult.error ?? "Unknown error"}`, "error");
        }
      });

    } else if (result.type === "direct" && result.directRow) {
      // 1. Optimistic update — instant UI response
      setDirectIncome(rows => [normalizeDirect(result.directRow!), ...rows]);

      // 2. Write to sheet in background
      const payload: DirectSheetRow = {
        id:     result.directRow.id,
        date:   result.directRow.date,
        client: result.directRow.client,
        income: result.directRow.income,
        amount: result.directRow.amount,
      };
      const tWrite = performance.now();
      writeDirectToSheet(payload).then(writeResult => {
        console.log(`[PERF] writeDirectToSheet: ${(performance.now() - tWrite).toFixed(0)}ms | ok=${writeResult.ok}`);
        if (!writeResult.ok) {
          console.warn("[handleAddToEditing] writeDirectToSheet failed:", writeResult.error);
          showToast(`Direct write failed: ${writeResult.error ?? "Unknown error"}`, "error");
        }
      });

    } else {
      console.log("[handleAddToEditing] editing_only — no accounting row created");
    }

    if (addResult.alreadyExists) {
      showToast(
        result.type === "editing_only"
          ? "Already in Editing Pipeline."
          : "Pipeline row already exists — accounting updated.",
        "success"
      );
    } else {
      showToast(
        result.type === "editing_only"
          ? "Added to Editing Pipeline."
          : "Added successfully.",
        "success"
      );
    }

    syncInProgress.current = false;
    const tSync = performance.now();
    await syncFromSheet();
    console.log(`[PERF] syncFromSheet: ${(performance.now() - tSync).toFixed(0)}ms`);
    console.log(`[PERF] handleAddToEditing total: ${(performance.now() - t0).toFixed(0)}ms`);
  }, [currentUser.displayName, syncFromSheet, showToast, snapshot, setShoots, setDirectIncome, shoots, directIncome]);

  const handleRemoveFromAccounting = useCallback(async (event: CalendarEvent) => {
    const { hotel, client } = parseCalendarTitle(event);
    const toRemoveShoots = shoots.filter(s =>
      s.date === event.date &&
      (s.client.toLowerCase() === client.toLowerCase() || s.hotel.toLowerCase() === hotel.toLowerCase())
    );
    const toRemoveDirect = directIncome.filter(r =>
      r.date === event.date && r.client.toLowerCase() === client.toLowerCase()
    );
    console.log("[handleRemoveFromAccounting] shoots:", toRemoveShoots, "direct:", toRemoveDirect);

    // Delete shoots from sheet first
    for (const shoot of toRemoveShoots) {
      const result = await deleteShootFromSheet({
        id: shoot.id, date: shoot.date, hotel: shoot.hotel,
        client: shoot.client, photoPackage: shoot.photoPackage,
      });
      console.log(`[handleRemoveFromAccounting] shoot delete | id=${shoot.id} | ok=${result.ok} | method=${result.matchMethod ?? "?"}`);
      if (!result.ok) {
        showToast(`Sheet delete failed: ${result.error ?? "Unknown error"}`, "error");
        return;
      }
    }

    // Delete direct income from sheet
    for (const row of toRemoveDirect) {
      const result = await deleteDirectFromSheet({ id: row.id, date: row.date, client: row.client, income: row.income, amount: row.amount });
      console.log(`[handleRemoveFromAccounting] direct delete | id=${row.id} | ok=${result.ok}`);
      if (!result.ok) {
        showToast(`Sheet delete failed: ${result.error ?? "Unknown error"}`, "error");
        return;
      }
    }

    // Reload both from sheet as source of truth
    snapshot();
    const [shootsResult, directResult] = await Promise.all([fetchAllShoots(), fetchAllDirect()]);
    if (shootsResult.ok && Array.isArray(shootsResult.shoots)) {
      const mapped = shootsResult.shoots.map(s => normalizeShoot({
        id: s.id, date: s.date, hotel: s.hotel, client: s.client,
        eventType: s.eventType, photoPackage: s.photoPackage, department: s.department,
        source: s.source, ht: s.ht, tax: s.tax, finalAmount: s.finalAmount, status: s.status,
      }));
      safeReplaceShoots(mapped, "handleRemoveFromAccounting");
    } else if (toRemoveShoots.length > 0) {
      setShoots(rows => rows.filter(s => !toRemoveShoots.some(r => r.id === s.id)));
    }
    if (directResult.ok && directResult.direct) {
      setDirectIncome(directResult.direct.map(d => normalizeDirect({ id: d.id, date: d.date, client: d.client, income: d.income, amount: d.amount })));
    } else if (toRemoveDirect.length > 0) {
      setDirectIncome(rows => rows.filter(r => !toRemoveDirect.some(d => d.id === r.id)));
    }

    setCalendarEvents(evs => evs.map(e => e.id === event.id ? { ...e, imported: false } : e));
    showToast("Removed from Accounting", "success");
  }, [snapshot, shoots, directIncome, setShoots, setDirectIncome, setCalendarEvents, showToast]);

  const handleRemoveFromShoots = useCallback(async (event: CalendarEvent) => {
    const { hotel, client } = parseCalendarTitle(event);
    const toRemove = shoots.filter(s =>
      s.date === event.date &&
      (s.client.toLowerCase() === client.toLowerCase() || s.hotel.toLowerCase() === hotel.toLowerCase())
    );
    console.log("[handleRemoveFromShoots] toRemove:", toRemove);
    if (toRemove.length === 0) {
      showToast("No matching shoot found", "error");
      return;
    }
    for (const shoot of toRemove) {
      const result = await deleteShootFromSheet({
        id:           shoot.id,
        date:         shoot.date,
        hotel:        shoot.hotel,
        client:       shoot.client,
        photoPackage: shoot.photoPackage,
      });
      console.log(`[handleRemoveFromShoots] sheet delete | id=${shoot.id} | ok=${result.ok} | matchMethod=${result.matchMethod ?? "?"} | sheetRow=${result.sheetRow ?? "?"}`);
      if (!result.ok) {
        showToast(`Sheet delete failed: ${result.error ?? "Unknown error"}`, "error");
        return;
      }
    }
    const refreshed = await fetchAllShoots();
    console.log(`[handleRemoveFromShoots] reload | ok=${refreshed.ok} | count=${refreshed.shoots?.length ?? "undefined"}`);
    snapshot();
    if (refreshed.ok && Array.isArray(refreshed.shoots)) {
      const mapped = refreshed.shoots.map(s => normalizeShoot({
        id: s.id, date: s.date, hotel: s.hotel, client: s.client,
        eventType: s.eventType, photoPackage: s.photoPackage, department: s.department,
        source: s.source, ht: s.ht, tax: s.tax, finalAmount: s.finalAmount, status: s.status,
      }));
      safeReplaceShoots(mapped, "handleRemoveFromShoots");
    } else {
      setShoots(rows => rows.filter(s => !toRemove.some(r => r.id === s.id)));
    }
    showToast("Removed from Shoots", "success");
  }, [snapshot, shoots, setShoots, showToast]);

  const handleRemoveFromDirect = useCallback(async (event: CalendarEvent) => {
    const { client } = parseCalendarTitle(event);
    const toRemove = directIncome.filter(r =>
      r.date === event.date && r.client.toLowerCase() === client.toLowerCase()
    );
    console.log("[handleRemoveFromDirect] toRemove:", toRemove);
    if (toRemove.length === 0) {
      showToast("No matching direct income found", "error");
      return;
    }
    for (const row of toRemove) {
      const result = await deleteDirectFromSheet({ id: row.id, date: row.date, client: row.client, income: row.income, amount: row.amount });
      console.log(`[handleRemoveFromDirect] sheet delete | id=${row.id} | ok=${result.ok} | found=${result.found}`);
      if (!result.ok) {
        showToast(`Sheet delete failed: ${result.error ?? "Unknown error"}`, "error");
        return;
      }
    }
    setDirectIncome(rows => rows.filter(r => !toRemove.some(d => d.id === r.id)));
    showToast("Removed from Direct", "success");
  }, [snapshot, directIncome, setDirectIncome, showToast]);

  const handleRemoveFromEditing = useCallback(async (_event: CalendarEvent, jobs: SheetJob[]) => {
    const results = await Promise.all(jobs.map(j => clearSheetRow(j)));
    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      showToast(`Failed to remove from pipeline: ${failed[0].error ?? "Sheet error"}`, "error");
      return;
    }
    // Sheet confirmed — now remove from local state
    setSheetJobs(prev => prev.filter(j => !jobs.some(rj => rj.id === j.id)));
    showToast("Removed from Editing Pipeline", "success");
    // Re-fetch from sheet to rebuild cards from source of truth
    syncInProgress.current = false;
    await syncFromSheet();
    console.log("pipeline refresh complete");
  }, [showToast, setSheetJobs, syncFromSheet]);

  const handleRemoveJobFromPipeline = useCallback(async (job: SheetJob) => {
    const result = await clearSheetRow(job);
    if (!result.ok) {
      showToast(`Failed to remove from pipeline: ${result.error ?? "Sheet error"}`, "error");
      return;
    }
    // Sheet confirmed — now remove from local state
    setSheetJobs(prev => prev.filter(j => j.id !== job.id));
    showToast("Removed from Editing Pipeline", "success");
    // Re-fetch from sheet to rebuild cards from source of truth
    syncInProgress.current = false;
    await syncFromSheet();
    console.log("pipeline refresh complete");
  }, [showToast, setSheetJobs, syncFromSheet]);
  useEffect(() => {
    if (!hasFileSystemAccess()) return;
    getStoredFolderHandle().then(handle => {
      if (handle) { setBackupFolderHandle(handle); setBackupFolderName(handle.name); }
    });
  }, []);

  useEffect(() => { setShoots(rows => rows.map(normalizeShoot)); }, []);

  // Measure sticky chrome height so the Editing board can fill the rest of the viewport exactly.
  useEffect(() => {
    const el = chromeRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setChromeH(el.getBoundingClientRect().height));
    ro.observe(el);
    setChromeH(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveData({ activeTab, shoots: uniqueShoots(shoots.map(normalizeShoot)), directIncome: uniqueDirectIncome(directIncome), pricing: dedupePricing(pricing), query, dashboardYear, dashboardHotel, dashboardMonth, invoiceHotel, invoiceYear, invoiceMonth, invoiceDepartment, generatedInvoice, calendarEvents, invoiceSequences, savedInvoices, autoBackupEnabled, keepBackupHistory, lastBackupAt: lastBackupAt?.toISOString(), gcalSelectedIds: [...gcalSelectedIds], gcalHasWriteScope });
      setLastSavedAt(new Date());
    }, 400);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [activeTab, shoots, directIncome, pricing, query, dashboardYear, dashboardHotel, dashboardMonth, invoiceHotel, invoiceYear, invoiceMonth, invoiceDepartment, generatedInvoice, calendarEvents, invoiceSequences, savedInvoices, autoBackupEnabled, keepBackupHistory, lastBackupAt]);
  useEffect(() => { if (!editingShootId && !form.client.trim()) setForm(makeEmptyShoot(pricing)); }, [pricing]);

  // Auto-backup to folder on data changes (debounced 3s)
  const autoBackupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepBackupHistoryRef = useRef(keepBackupHistory);
  useEffect(() => { keepBackupHistoryRef.current = keepBackupHistory; }, [keepBackupHistory]);
  const backupFolderHandleRef = useRef(backupFolderHandle);
  useEffect(() => { backupFolderHandleRef.current = backupFolderHandle; }, [backupFolderHandle]);

  useEffect(() => {
    if (!autoBackupEnabled || !backupFolderHandleRef.current) return;
    if (autoBackupTimer.current) clearTimeout(autoBackupTimer.current);
    autoBackupTimer.current = setTimeout(async () => {
      const handle = backupFolderHandleRef.current;
      if (!handle) return;
      try {
        const ok = await verifyPermission(handle);
        if (!ok) { showToast("Cloud backup needs permission. Choose folder again.", "error"); return; }
    const content = JSON.stringify({ shoots, directIncome, pricing, calendarEvents, savedInvoices, generatedInvoice, invoiceSequences, autoBackupEnabled, keepBackupHistory: keepBackupHistoryRef.current, lastBackupAt }, null, 2);
        await writeToFolderAtomic(handle, BACKUP_MAIN_FILE, content);
        if (keepBackupHistoryRef.current) {
          const histFilename = backupTimestampedFilename();
          const hf = await handle.getFileHandle(histFilename, { create: true });
          const hw = await hf.createWritable({ keepExistingData: false });
          await hw.write(content);
          await hw.close();
        }
        setLastBackupAt(new Date());
      } catch { /* silent on auto — avoid toast spam */ }
    }, 12000);
    return () => { if (autoBackupTimer.current) clearTimeout(autoBackupTimer.current); };
  // Only data changes should trigger auto-backup, not UI state or filters
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shoots, directIncome, pricing, savedInvoices, generatedInvoice, invoiceSequences, autoBackupEnabled]);

  const years = useMemo(() => getYears(shoots, directIncome), [shoots, directIncome]);
  const dashboardFiltered = useMemo(() => filterDashboard(shoots, directIncome, dashboardYear, dashboardHotel, dashboardMonth), [shoots, directIncome, dashboardYear, dashboardHotel, dashboardMonth]);
  const stats = useMemo(() => calculateTotals(dashboardFiltered.filteredShoots, dashboardFiltered.filteredDirectAll), [dashboardFiltered]);

  // Debug: log year filter state and direct income counts
  useEffect(() => {
    const byYear: Record<string, { count: number; amount: number }> = {};
    directIncome.forEach(r => {
      const y = yearFromMonth(monthKey(r.date));
      if (!y) return;
      if (!byYear[y]) byYear[y] = { count: 0, amount: 0 };
      byYear[y].count++;
      byYear[y].amount += parseAmount(r.amount);
    });
    console.log("[Dashboard Debug] availableYears:", years);
    console.log("[Dashboard Debug] selectedYear:", dashboardYear);
    console.log("[Dashboard Debug] directIncome total rows:", directIncome.length);
    console.log("[Dashboard Debug] direct rows counted (filteredDirectAll):", dashboardFiltered.filteredDirectAll.length);
    console.log("[Dashboard Debug] direct total (filteredDirectAll):", dashboardFiltered.filteredDirectAll.reduce((s, r) => s + parseAmount(r.amount), 0));
    console.log("[Dashboard Debug] direct by year:", JSON.stringify(byYear));
  }, [years, dashboardYear, directIncome, dashboardFiltered]);

  const monthlyData = useMemo(() => buildMonthlyData(dashboardFiltered.filteredShoots, dashboardFiltered.filteredDirectAll), [dashboardFiltered]);
  const timelineData = useMemo(() => buildMonthlyData(shoots, directIncome), [shoots, directIncome]);
  const headerDirectHotelStats = useMemo(() => ["St. Regis", "Le Moana", "Conrad"].map(name => {
    const rows = dashboardFiltered.filteredDirectAll.filter(row => row.income === name);
    return { label: name, count: rows.length, amount: rows.reduce((sum, row) => sum + parseAmount(row.amount), 0) };
  }), [dashboardFiltered]);
  const filteredShoots = shoots
    .filter(row => `${row.date} ${row.hotel} ${row.client} ${row.eventType} ${row.photoPackage} ${row.department} ${row.source}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const invoiceMonthKey = `${invoiceYear}-${invoiceMonth}`;
  const invoiceRows = getInvoiceRows(shoots, invoiceHotel, invoiceMonthKey, invoiceDepartment);

  function updateForm(field: string, value: string) {
    setForm(current => {
      const updated = { ...current, [field]: value };
      if (field === "hotel" || field === "photoPackage" || field === "department") {
        const price = findPrice(pricing, updated.hotel, updated.photoPackage, updated.department);
        if (price) { updated.ht = String(price.ht); updated.tax = String(calculateTax(price.ht)); updated.finalAmount = String(calculateFinalAmount(price.ht)); }
      }
      if (field === "ht") { updated.tax = String(calculateTax(value)); updated.finalAmount = String(calculateFinalAmount(value)); }
      if (field === "tax") updated.finalAmount = String(toNumber(updated.ht) + toNumber(value));
      return updated;
    });
  }

  async function saveShoot() {
    if (!form.client.trim()) return;
    if (shootSaving) return;
    setShootSaving(true);
    try {

    const isNew = !editingShootId;

    const row: Shoot = normalizeShoot({
      id: editingShootId || Date.now(),
      ...form,
      ht: toNumber(form.ht),
      tax: toNumber(form.tax),
      finalAmount: toNumber(form.finalAmount),
    });

    // ── NEW SHOOT ──────────────────────────────────────────
    if (isNew) {
      // Duplicate check
      const normClient = normalizeStr(row.client);
      const normHotel  = normalizeStr(row.hotel);
      const dup = shoots.find(s =>
        s.date === row.date &&
        normalizeStr(s.client) === normClient &&
        normalizeStr(s.hotel) === normHotel
      );
      if (dup) {
        const go = await showDuplicateConfirm({
          date: dup.date, client: dup.client,
          detail1Label: "Hotel", detail1Value: dup.hotel,
          detail2Label: "Package", detail2Value: dup.photoPackage,
          amountLabel: "Amount", amountValue: dup.finalAmount ? `${dup.finalAmount.toLocaleString()} XPF` : "—",
        });
        if (!go) return;
      }

      console.log('[saveShoot] NEW shoot — writing to Sheet first');

      const initResult = await initAccountingHeaders();
      console.log('[saveShoot] initAccountingHeaders:', JSON.stringify(initResult));

      if (!initResult.ok) {
        showToast(`Sheet not ready: ${initResult.error ?? 'Unknown error'}`, 'error');
        return;
      }

      const sheetRow: ShootSheetRow = {
        id:             row.id,
        date:           row.date,
        hotel:          row.hotel,
        client:         row.client,
        eventType:      row.eventType,
        photoPackage:   row.photoPackage,
        department:     row.department,
        source:         row.source,
        ht:             row.ht,
        tax:            row.tax,
        finalAmount:    row.finalAmount,
        status:         row.status,
        country:        '',
        originalSource: '',
      };

      // 1. Optimistic update — instant UI
      snapshot();
      setShoots(rows => [row, ...rows]);
      setEditingShootId(null);
      setForm(makeEmptyShoot(pricing));
      showToast('Shoot saved.', 'success');

      // 2. Write to sheet in background
      const tWrite = performance.now();
      writeShootToSheet(sheetRow).then(writeResult => {
        console.log(`[PERF] saveShoot writeShootToSheet: ${(performance.now() - tWrite).toFixed(0)}ms | ok=${writeResult.ok}`);
        if (!writeResult.ok) {
          showToast(`Sheet write failed: ${writeResult.error ?? 'Unknown error'}`, 'error');
        }
      });
      return;
    }

    // ── EDIT EXISTING SHOOT ────────────────────────────────
    console.log('[saveShoot] EDIT shoot — id:', row.id);

    const sheetRow: ShootSheetRow = {
      id:             row.id,
      date:           row.date,
      hotel:          row.hotel,
      client:         row.client,
      eventType:      row.eventType,
      photoPackage:   row.photoPackage,
      department:     row.department,
      source:         row.source,
      ht:             row.ht,
      tax:            row.tax,
      finalAmount:    row.finalAmount,
      status:         row.status,
      country:        '',
      originalSource: '',
    };

    const writeResult = await writeShootToSheet(sheetRow);
    console.log('[saveShoot] edit writeShootToSheet result:', JSON.stringify(writeResult));

    if (!writeResult.ok) {
      showToast(`Sheet update failed: ${writeResult.error ?? 'Unknown error'}`, 'error');
      return;
    }

    // Sheet confirmed OK — now update local state
    snapshot();
    setShoots(rows => rows.map(item => item.id === editingShootId ? row : item));
    setEditingShootId(null);
    setForm(makeEmptyShoot(pricing));
    showToast('Shoot updated in Google Sheet', 'success');
    } finally {
      setShootSaving(false);
    }
  }
  function editShoot(row: Shoot) {
    setEditingShootId(row.id);
    setForm({ ...row, ht: String(row.ht), tax: String(row.tax), finalAmount: String(row.finalAmount) });
    setActiveTab("Shoots");
    setTimeout(() => shootFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  // Safe replacement: never wipes shoots with an empty/suspicious fetch result.
  // Rules:
  //   1. fetched must be a non-empty array
  //   2. if current count > 10 and fetched drops by >70%, block and show error
  //   3. write backup to localStorage before replacing
  function safeReplaceShoots(fetched: Shoot[], context: string): boolean {
    const current = shootsRef.current;
    console.log(`[SYNC] ${context} | fetched=${fetched.length} local=${current.length}`);

    if (!Array.isArray(fetched) || fetched.length === 0) {
      console.error(`[SYNC] ${context} | BLOCKED — fetched array is empty or invalid`);
      return false;
    }

    if (current.length > 10 && fetched.length < current.length * 0.3) {
      console.error(`[SYNC] ${context} | BLOCKED — dangerous drop: ${current.length} → ${fetched.length} (>70% reduction)`);
      showToast(`Sync protection triggered: expected ~${current.length} shoots, got ${fetched.length}. State not changed.`, "error");
      return false;
    }

    // Backup current state before overwriting
    try {
      localStorage.setItem("shoots_backup", JSON.stringify(current));
    } catch { /* quota exceeded — non-fatal */ }

    console.log(`[SYNC] ${context} | replacing state YES | ${current.length} → ${fetched.length} rows`);
    setShoots(fetched);
    return true;
  }

  async function deleteShoot(shoot: Shoot) {
    if (!window.confirm("Delete this shoot? This cannot be undone without Undo.")) return;
    const id = shoot.id;
    console.log(`[DELETE SHOOT] id=${id} | date=${shoot.date} | hotel=${shoot.hotel} | client=${shoot.client}`);

    // Delete from Sheet first — local state only changes on confirmed sheet write
    const result = await deleteShootFromSheet({
      id:           shoot.id,
      date:         shoot.date,
      hotel:        shoot.hotel,
      client:       shoot.client,
      photoPackage: shoot.photoPackage,
    });
    if (!result.ok) {
      console.error(`[DELETE SHOOT] FAILED | id=${id} | ${result.error ?? "Unknown error"}`);
      showToast(`Google Sheet delete failed: ${result.error ?? "Unknown error"}`, "error");
      return;
    }
    console.log(`[DELETE SHOOT] soft delete success | id=${id} | sheetRow=${result.sheetRow ?? "?"} | matchMethod=${result.matchMethod ?? "?"}`);

    // Read back from Sheet as source of truth — with full safety guards
    const refreshed = await fetchAllShoots();
    console.log(`[DELETE SHOOT] reload | ok=${refreshed.ok} | count=${refreshed.shoots?.length ?? "undefined"}`);

    snapshot();
    const deleted = shootsRef.current.find(r => r.id === id);

    if (refreshed.ok && Array.isArray(refreshed.shoots)) {
      const mapped = refreshed.shoots.map(s => normalizeShoot({
        id: s.id, date: s.date, hotel: s.hotel, client: s.client,
        eventType: s.eventType, photoPackage: s.photoPackage, department: s.department,
        source: s.source, ht: s.ht, tax: s.tax, finalAmount: s.finalAmount, status: s.status,
      }));
      const replaced = safeReplaceShoots(mapped, `deleteShoot id=${id}`);
      if (!replaced) {
        console.log(`[DELETE SHOOT] safety guard blocked read-back replace — applying local filter for id=${id}`);
        setShoots(rows => rows.filter(row => row.id !== id));
      }
    } else {
      console.warn(`[DELETE SHOOT] read-back fetch failed — applying local filter for id=${id}`);
      setShoots(rows => rows.filter(row => row.id !== id));
    }

    if (deleted) {
      setCalendarEvents(evs => evs.map(ev => {
        if (ev.date !== deleted.date) return ev;
        const { hotel, client, pkg } = parseCalendarTitle(ev);
        if (hotel.toLowerCase() === deleted.hotel.toLowerCase()
          && client.toLowerCase() === deleted.client.toLowerCase()
          && (pkg || "").toLowerCase() === deleted.photoPackage.toLowerCase())
          return { ...ev, imported: false };
        return ev;
      }));
    }
    showToast("Shoot deleted from Google Sheet", "success");
  }

  type RecoveryState = { status: "idle" } | { status: "loading" } | { status: "done"; count: number } | { status: "error"; error: string; rawRows?: unknown[][] };
  const [recoveryState, setRecoveryState] = React.useState<RecoveryState>({ status: "idle" });

  async function recoverShootsFromSheet() {
    setRecoveryState({ status: "loading" });
    console.log("[RECOVERY] starting — calling /shoots-read-all");

    try {
      const result = await fetchAllShoots();
      console.log("[RECOVERY] response ok:", result.ok, "| shoots length:", result.shoots?.length ?? "undefined");
      if (result.shoots && result.shoots.length > 0) {
        console.log("[RECOVERY] first 3 rows:", JSON.stringify(result.shoots.slice(0, 3), null, 2));
      }

      if (result.ok && Array.isArray(result.shoots) && result.shoots.length > 0) {
        const rows = result.shoots.map(s => normalizeShoot({
          id: s.id, date: s.date, hotel: s.hotel, client: s.client,
          eventType: s.eventType, photoPackage: s.photoPackage, department: s.department,
          source: s.source, ht: s.ht, tax: s.tax, finalAmount: s.finalAmount, status: s.status,
        }));
        snapshot();
        setShoots(rows);
        try { localStorage.setItem("shoots_backup", JSON.stringify(rows)); } catch { /* quota */ }
        showToast(`Recovered ${rows.length} shoots from Google Sheet`, "success");
        setRecoveryState({ status: "done", count: rows.length });
        console.log("[RECOVERY] SUCCESS — restored", rows.length, "shoots");
      } else if (result.ok && result.shoots?.length === 0) {
        // Sheet returned 0 rows — attempt raw read for debug
        console.warn("[RECOVERY] /shoots-read-all returned 0 rows — attempting raw read");
        const rawUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sheets-sync/shoots-raw`;
        const rawRes = await fetch(rawUrl, {
          headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
        });
        if (rawRes.ok) {
          const rawJson = await rawRes.json() as { ok: boolean; rawRows?: unknown[][] };
          console.log("[RECOVERY] raw rows:", JSON.stringify(rawJson.rawRows?.slice(0, 5)));
          const rawRows = rawJson.rawRows ?? [];
          // Map manually: A=id B=date C=hotel D=client E=eventType F=photoPackage G=department H=source I=ht J=tax K=finalAmount L=status M=country N=originalSource
          const parseNum = (v: unknown) => typeof v === "number" ? v : (parseInt(String(v ?? "0").replace(/\D/g, ""), 10) || 0);
          const recovered = rawRows.slice(1).map((r: unknown, i) => {
            const row = r as unknown[];
            const id = String(row?.[0] ?? "").trim();
            if (!id) return null;
            const status = String(row?.[11] ?? "").trim();
            if (status === "Deleted") return null;
            return normalizeShoot({
              id: Number(id) || (i + 2),
              date: String(row?.[1] ?? "").trim(),
              hotel: String(row?.[2] ?? "").trim(),
              client: String(row?.[3] ?? "").trim(),
              eventType: String(row?.[4] ?? "").trim(),
              photoPackage: String(row?.[5] ?? "").trim(),
              department: String(row?.[6] ?? "").trim(),
              source: String(row?.[7] ?? "").trim(),
              ht: parseNum(row?.[8]),
              tax: parseNum(row?.[9]),
              finalAmount: parseNum(row?.[10]),
              status,
            });
          }).filter(Boolean) as ReturnType<typeof normalizeShoot>[];

          if (recovered.length > 0) {
            snapshot();
            setShoots(recovered);
            showToast(`Recovered ${recovered.length} shoots via raw fallback`, "success");
            setRecoveryState({ status: "done", count: recovered.length });
            console.log("[RECOVERY] raw fallback SUCCESS —", recovered.length, "shoots");
          } else {
            setRecoveryState({ status: "error", error: "Sheet Shoots tab appears empty — all rows may be marked Deleted or missing IDs", rawRows: rawJson.rawRows });
          }
        } else {
          // Raw endpoint not available — show debug info
          setRecoveryState({ status: "error", error: `/shoots-read-all returned 0 rows. Check that the Shoots tab exists in GOOGLE_SHEET_ID and has non-Deleted rows with IDs in column A.` });
        }
      } else {
        const msg = result.error ?? "Unknown error from /shoots-read-all";
        console.error("[RECOVERY] FAILED:", msg);
        setRecoveryState({ status: "error", error: msg });
        showToast(`Recovery failed: ${msg}`, "error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      console.error("[RECOVERY] exception:", msg);
      setRecoveryState({ status: "error", error: msg });
      showToast(`Recovery error: ${msg}`, "error");
    }
  }
  async function saveDirectIncome() {
    if (directSaving) return;
    setDirectSaving(true);
    try {
    const isNew = !editingDirectId;
    const row: DirectRow = { id: editingDirectId || Date.now(), ...directForm, amount: toNumber(directForm.amount) };
    const payload = { id: row.id, date: row.date, client: row.client, income: row.income, amount: row.amount };
    console.log(`[direct] saveDirectIncome | isNew=${isNew} | id=${row.id} | payload:`, JSON.stringify(payload));

    if (isNew) {
      // Duplicate check
      const normClient = normalizeStr(row.client);
      const dup = directIncome.find(d =>
        d.date === row.date &&
        normalizeStr(d.client) === normClient &&
        d.income === row.income
      );
      if (dup) {
        const go = await showDuplicateConfirm({
          date: dup.date, client: dup.client,
          detail1Label: "Income type", detail1Value: dup.income,
          amountLabel: "Amount", amountValue: dup.amount ? `$${dup.amount.toLocaleString()}` : "—",
        });
        if (!go) return;
      }

      // 1. Optimistic update — instant UI
      snapshot();
      setDirectIncome(rows => [normalizeDirect(row), ...rows]);
      setEditingDirectId(null);
      setDirectForm(emptyDirect);
      showToast("Direct income saved.", "success");

      // 2. Write to sheet in background
      const tWrite = performance.now();
      writeDirectToSheet(payload).then(result => {
        console.log(`[PERF] saveDirectIncome writeDirectToSheet: ${(performance.now() - tWrite).toFixed(0)}ms | ok=${result.ok}`);
        if (!result.ok) {
          console.error(`[direct] write failed | id=${row.id} | ${result.error}`);
          showToast(`Sheet write failed: ${result.error ?? "Unknown error"}`, "error");
        }
      });
      return;

    } else {
      const result = await updateDirectInSheet(payload);
      if (!result.ok) {
        console.error(`[direct] update failed | id=${row.id} | ${result.error}`);
        showToast(`Sheet update failed: ${result.error ?? "Unknown error"}`, "error");
        return;
      }
      console.log(`[direct] update success | id=${row.id}`);
    }

    // Edit path only — read back as source of truth
    const tRefresh = performance.now();
    const refreshed = await fetchAllDirect();
    console.log(`[PERF] saveDirectIncome fetchAllDirect (edit): ${(performance.now() - tRefresh).toFixed(0)}ms`);
    snapshot();
    if (refreshed.ok && refreshed.direct) {
      console.log(`[direct] read-back: ${refreshed.direct.length} rows`);
      setDirectIncome(refreshed.direct.map(d => normalizeDirect({ id: d.id, date: d.date, client: d.client, income: d.income, amount: d.amount })));
    } else {
      setDirectIncome(rows => rows.map(item => item.id === editingDirectId ? row : item));
    }
    setEditingDirectId(null);
    setDirectForm(emptyDirect);
    showToast("Direct income updated.", "success");
    } finally {
      setDirectSaving(false);
    }
  }
  function editDirect(row: DirectRow) { setEditingDirectId(row.id); setDirectForm({ date: row.date, client: row.client, income: row.income, amount: String(row.amount) }); setActiveTab("Direct"); }
  async function deleteDirect(id: number) {
    if (!window.confirm("Delete this direct income row?")) return;
    const row = directIncome.find(r => r.id === id);
    console.log(`[direct] deleteDirect | id=${id}`);
    const result = await deleteDirectFromSheet({ id, date: row?.date, client: row?.client, income: row?.income, amount: row?.amount });
    if (!result.ok) {
      console.error(`[direct] delete failed | id=${id} | ${result.error}`);
      showToast(`Sheet delete failed: ${result.error ?? "Unknown error"}`, "error");
      return;
    }
    console.log(`[direct] delete success | id=${id}`);
    const refreshed = await fetchAllDirect();
    snapshot();
    if (refreshed.ok && refreshed.direct) {
      console.log(`[direct] read-back after delete: ${refreshed.direct.length} rows`);
      setDirectIncome(refreshed.direct.map(d => normalizeDirect({ id: d.id, date: d.date, client: d.client, income: d.income, amount: d.amount })));
    } else {
      setDirectIncome(rows => rows.filter(row => row.id !== id));
    }
    showToast("Direct income deleted", "success");
  }
  async function savePrice() {
    const ht = toNumber(priceForm.ht);
    if (!priceForm.hotel || !priceForm.photoPackage || !priceForm.department || ht <= 0) return;
    if (ht < 10000) { alert("Price looks too low. Please enter the full HT amount in XPF."); return; }

    const rowId = editingPriceId
      || pricing.find(r => r.hotel === priceForm.hotel && r.photoPackage === priceForm.photoPackage && r.department === priceForm.department)?.id
      || Date.now();

    console.log(`[prices] saving | id=${rowId} | ${priceForm.hotel} | ${priceForm.photoPackage} | ${priceForm.department} | ht=${ht}`);

    // Write to Sheet first — no local update until confirmed
    const result = await writePriceRow({ id: rowId, hotel: priceForm.hotel, photoPackage: priceForm.photoPackage, department: priceForm.department, ht });
    if (!result.ok) {
      console.error(`[prices] write failed | id=${rowId} | ${result.error}`);
      showToast(`Sheet sync failed: ${result.error ?? "unknown error"}`, "error");
      return;
    }
    console.log(`[prices] saved to sheet row ${result.sheetRow} (isUpdate=${result.isUpdate})`);

    // Sheet confirmed — read back as source of truth
    const refreshed = await fetchPrices();
    snapshot();
    if (refreshed.ok && refreshed.prices?.length) {
      console.log(`[prices] read-back: ${refreshed.prices.length} rows`);
      setPricing(refreshed.prices.map(p => ({ id: Number(p.id) || p.sheetRow, hotel: p.hotel, photoPackage: p.photoPackage, department: p.department, ht: p.ht })));
    }
    setEditingPriceId(null);
    setPriceForm(emptyPrice);
    showToast("Price saved to Google Sheet", "success");
  }
  function editPrice(row: PricingRow) { setEditingPriceId(row.id); setPriceForm({ hotel: row.hotel, photoPackage: row.photoPackage, department: row.department, ht: String(row.ht) }); setActiveTab("Prices"); }
  async function deletePrice(id: number) {
    if (!window.confirm("Delete this price?")) return;
    const row = pricing.find(r => r.id === id);
    if (!row) return;
    console.log(`[prices] delete | id=${id} | ${row.hotel} | ${row.photoPackage} | ${row.department}`);

    // Delete from Sheet first — no local change until confirmed
    const result = await deletePriceRow({ hotel: row.hotel, photoPackage: row.photoPackage, department: row.department });
    if (!result.ok) {
      console.error(`[prices] delete failed | id=${id} | ${result.error}`);
      showToast(`Sheet delete failed: ${result.error ?? "unknown error"}`, "error");
      return;
    }
    console.log(`[prices] delete success | id=${id} | found=${result.found}`);

    // Sheet confirmed — read back as source of truth
    const refreshed = await fetchPrices();
    snapshot();
    if (refreshed.ok && refreshed.prices !== undefined) {
      console.log(`[prices] read-back after delete: ${refreshed.prices.length} rows`);
      setPricing(refreshed.prices.map(p => ({ id: Number(p.id) || p.sheetRow, hotel: p.hotel, photoPackage: p.photoPackage, department: p.department, ht: p.ht })));
    } else {
      setPricing(rows => rows.filter(r => r.id !== id));
    }
    showToast("Price removed from Google Sheet", "success");
  }
  function generateInvoice() {
    const rows = getInvoiceRows(shoots, invoiceHotel, invoiceMonthKey, invoiceDepartment);
    const code = hotelCode(invoiceHotel);
    const invoiceId = `${invoiceHotel}|${invoiceMonthKey}|${invoiceDepartment}`;
    const existing = savedInvoices.find(inv => inv.id === invoiceId);
    if (existing) {
      if (!window.confirm(`An invoice already exists for ${invoiceHotel} — ${monthName(invoiceMonth)} ${invoiceYear}.\nRegenerate it using current shoots? The invoice number will be kept.`)) return;
      snapshot();
      const updatedInv: SavedInvoice = { ...existing, rows, totalHT: rows.reduce((s, r) => s + toNumber(r.ht), 0), totalTax: rows.reduce((s, r) => s + toNumber(r.tax), 0), totalTTC: rows.reduce((s, r) => s + toNumber(r.finalAmount), 0), dateModified: invoiceDateText(new Date()), status: "Regenerated" };
      setSavedInvoices(list => list.map(inv => inv.id === invoiceId ? updatedInv : inv));
      const gi: GeneratedInvoice = { invoiceNumber: updatedInv.invoiceNumber, invoiceDate: updatedInv.invoiceDate, hotel: updatedInv.hotel, department: updatedInv.department, month: updatedInv.month, rows: updatedInv.rows, totalHT: updatedInv.totalHT, totalTax: updatedInv.totalTax, totalTTC: updatedInv.totalTTC };
      setGeneratedInvoice(gi);
      return;
    }
    snapshot();
    const nextSeq = (invoiceSequences[code] || 0) + 1;
    setInvoiceSequences(prev => ({ ...prev, [code]: nextSeq }));
    const invoiceDate = invoiceDateText(new Date());
    const invoiceNumber = makeInvoiceNumber(invoiceHotel, invoiceMonthKey, nextSeq);
    const newInv: SavedInvoice = { id: invoiceId, invoiceNumber, invoiceDate, hotel: HOTEL_INFO[invoiceHotel], hotelKey: invoiceHotel, department: invoiceDepartment, monthKey: invoiceMonthKey, year: invoiceYear, month: `${monthName(invoiceMonth)} ${invoiceYear}`, rows, totalHT: rows.reduce((s, r) => s + toNumber(r.ht), 0), totalTax: rows.reduce((s, r) => s + toNumber(r.tax), 0), totalTTC: rows.reduce((s, r) => s + toNumber(r.finalAmount), 0), status: "Original" };
    setSavedInvoices(list => [newInv, ...list]);
    setGeneratedInvoice({ invoiceNumber, invoiceDate, hotel: HOTEL_INFO[invoiceHotel], department: invoiceDepartment, month: `${monthName(invoiceMonth)} ${invoiceYear}`, rows, totalHT: newInv.totalHT, totalTax: newInv.totalTax, totalTTC: newInv.totalTTC });
  }
  function regenerateInvoice(inv: SavedInvoice) {
    if (!window.confirm(`Regenerate invoice ${inv.invoiceNumber}?\nThis will rebuild it from current shoots and update the totals.`)) return;
    snapshot();
    const rows = getInvoiceRows(shoots, inv.hotelKey, inv.monthKey, inv.department);
    const updated: SavedInvoice = { ...inv, rows, totalHT: rows.reduce((s, r) => s + toNumber(r.ht), 0), totalTax: rows.reduce((s, r) => s + toNumber(r.tax), 0), totalTTC: rows.reduce((s, r) => s + toNumber(r.finalAmount), 0), dateModified: invoiceDateText(new Date()), status: "Regenerated" };
    setSavedInvoices(list => list.map(i => i.id === inv.id ? updated : i));
    setGeneratedInvoice({ invoiceNumber: updated.invoiceNumber, invoiceDate: updated.invoiceDate, hotel: updated.hotel, department: updated.department, month: updated.month, rows: updated.rows, totalHT: updated.totalHT, totalTax: updated.totalTax, totalTTC: updated.totalTTC });
  }
  function deleteInvoice(inv: SavedInvoice) {
    const confirmed = window.confirm(
      `Delete invoice ${inv.invoiceNumber} and its PDF document?\n\nThis will remove the invoice record and delete the PDF from Documents if found.`
    );
    if (!confirmed) return;
    snapshot();
    setSavedInvoices(list => list.filter(i => i.id !== inv.id));
    if (generatedInvoice?.invoiceNumber === inv.invoiceNumber) setGeneratedInvoice(null);
    // Try to delete matching PDF from Documents folder (fire and forget with feedback)
    getStoredDocsHandle().then(async root => {
      if (!root) {
        showToast(`Invoice ${inv.invoiceNumber} removed. No Documents folder connected.`, "success");
        return;
      }
      const deleted = await findAndDeleteInvoicePdf(root, inv.invoiceNumber);
      if (deleted) {
        showToast(`Invoice ${inv.invoiceNumber} and PDF deleted.`, "success");
        setDocsRefreshTrigger(n => n + 1);
      } else {
        showToast(`Invoice removed. PDF file was not found in Documents.`, "success");
      }
    });
  }
  function downloadAllInvoicesFor(filter: { year?: string; month?: string; hotel?: string }) {
    const matches = savedInvoices.filter(inv => {
      if (filter.year && inv.year !== filter.year) return false;
      if (filter.month && inv.monthKey.slice(5) !== filter.month) return false;
      if (filter.hotel && inv.hotelKey !== filter.hotel) return false;
      return true;
    });
    if (!matches.length) { alert("No invoices found for this selection."); return; }
    matches.forEach(inv => {
      const gi: GeneratedInvoice = { invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, hotel: inv.hotel, department: inv.department, month: inv.month, rows: inv.rows, totalHT: inv.totalHT, totalTax: inv.totalTax, totalTTC: inv.totalTTC };
      downloadInvoicePdf(gi);
    });
  }
  async function chooseBackupFolder() {
    if (!hasFileSystemAccess()) { showToast("Folder picker not supported in this browser. Backups will download normally.", "error"); return; }
    try {
      const handle = await window.showDirectoryPicker!({ mode: "readwrite" });
      setBackupFolderHandle(handle);
      setBackupFolderName(handle.name);
      await storeFolderHandle(handle);
      showToast(`Backup folder set: ${handle.name}`, "success");
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError") showToast("Could not access folder. Permission denied.", "error");
    }
  }
  async function performFolderBackup(handle: FileSystemDirectoryHandle, folderName: string): Promise<boolean> {
    const ok = await verifyPermission(handle);
    if (!ok) { showToast("Permission denied. Choose the folder again.", "error"); return false; }
    const content = JSON.stringify({ shoots, directIncome, pricing, calendarEvents, savedInvoices, generatedInvoice, invoiceSequences, autoBackupEnabled, keepBackupHistory, lastBackupAt }, null, 2);
    await writeToFolderAtomic(handle, BACKUP_MAIN_FILE, content);
    if (keepBackupHistory) {
      const histFilename = backupTimestampedFilename();
      const hf = await handle.getFileHandle(histFilename, { create: true });
      const hw = await hf.createWritable({ keepExistingData: false });
      await hw.write(content);
      await hw.close();
      showToast(`Backup saved to ${folderName}/ (+history copy)`, "success");
    } else {
      showToast(`Backup saved to ${folderName}/${BACKUP_MAIN_FILE}`, "success");
    }
    setLastBackupAt(new Date());
    return true;
  }

  async function saveBackup() {
    if (hasFileSystemAccess() && backupFolderHandle) {
      try {
        await performFolderBackup(backupFolderHandle, backupFolderName);
        return;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return;
        showToast("Backup failed. Falling back to download.", "error");
      }
    } else if (hasFileSystemAccess() && !backupFolderHandle) {
      try {
        const handle = await window.showDirectoryPicker!({ mode: "readwrite" });
        setBackupFolderHandle(handle);
        setBackupFolderName(handle.name);
        await storeFolderHandle(handle);
        await performFolderBackup(handle, handle.name);
        return;
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return;
        showToast("Folder access failed. Downloading instead.", "error");
      }
    }
    // Fallback: download with fixed filename
    downloadJson(BACKUP_MAIN_FILE, { shoots, directIncome, pricing, calendarEvents, savedInvoices, generatedInvoice, invoiceSequences, autoBackupEnabled, keepBackupHistory, lastBackupAt });
    setLastBackupAt(new Date());
    showToast("Backup downloaded successfully.", "success");
  }
  function openImportPreview(file: File, mode: "merge" | "replace") {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as SavedData;
        const emptyShoots = !Array.isArray(data.shoots) || data.shoots.length === 0;
        const emptyDirect = !Array.isArray(data.directIncome) || data.directIncome.length === 0;
        setImportPreview({ data, mode, emptyShoots, emptyDirect, isEmpty: emptyShoots && emptyDirect });
      } catch {
        alert("This file could not be read. Use JSON backup format.");
      }
    };
    reader.readAsText(file);
  }
  function importDataMerge(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    openImportPreview(file, "merge");
  }
  function importDataReplace(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    openImportPreview(file, "replace");
  }
  function confirmImport() {
    if (!importPreview) return;
    const { data, mode } = importPreview;
    snapshot();
    if (mode === "merge") {
      if (Array.isArray(data.shoots)) {
        setShoots(rows => uniqueShoots([
          ...(data.shoots as Shoot[]).map(normalizeShoot),
          ...rows.map(normalizeShoot),
        ]));
      }
      if (Array.isArray(data.directIncome)) {
        setDirectIncome(rows => uniqueDirectIncome([
          ...(data.directIncome as DirectRow[]).map(normalizeDirect),
          ...rows,
        ]));
      }
      if (Array.isArray(data.pricing)) {
        setPricing(rows => dedupePricing([...rows, ...(data.pricing as PricingRow[])]));
      }
      showToast("Backup merged successfully.", "success");
    } else {
      if (Array.isArray(data.shoots)) setShoots((data.shoots as Shoot[]).map(normalizeShoot));
      if (Array.isArray(data.directIncome)) setDirectIncome((data.directIncome as DirectRow[]).map(normalizeDirect));
      if (Array.isArray(data.pricing)) setPricing(data.pricing as PricingRow[]);
      if (Array.isArray(data.calendarEvents)) setCalendarEvents(data.calendarEvents as CalendarEvent[]);
      if (Array.isArray(data.savedInvoices)) setSavedInvoices(data.savedInvoices as SavedInvoice[]);
      if (data.generatedInvoice !== undefined) setGeneratedInvoice(data.generatedInvoice as GeneratedInvoice | null);
      if (data.invoiceSequences && typeof data.invoiceSequences === "object") setInvoiceSequences(data.invoiceSequences as Record<string, number>);
      if (Array.isArray(data.editingJobs)) setEditingJobs(data.editingJobs as EditingJob[]);
      showToast("All data replaced from backup — Undo to restore.", "success");
    }
    setImportPreview(null);
    setSettingsOpen(false);
  }
  function protectedReset() { if (!window.confirm("This can delete saved data on this device. Continue?")) return; const typed = window.prompt("Type DELETE to confirm."); if (typed !== "DELETE") return; window.localStorage.removeItem(STORAGE_KEY); window.location.reload(); }
  function clearShootsAndDirect() {
    if (!window.confirm("Remove all shoots and direct income from this device?\n\nPrices and invoices will be kept. This can be undone.")) return;
    snapshot();
    setShoots([]);
    setDirectIncome([]);
    showToast("Shoots + Direct data cleared — Undo to restore", "success");
  }
  function importCalendarFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const newEvents = parseIcsEvents(String(reader.result || ""));
      setCalendarEvents(existing => {
        // Merge: add new events not already present — match by date+time+title (time-aware)
        const existingKeys = new Set(existing.map(e => `${e.date}__${e.time ?? ""}__${normalizeTitle(e.title)}`));
        const toAdd = newEvents.filter(e => !existingKeys.has(`${e.date}__${e.time ?? ""}__${normalizeTitle(e.title)}`));
        showToast(`${toAdd.length} new events added (${newEvents.length} in file).`, "success");
        return toAdd.length > 0 ? [...existing, ...toAdd] : existing;
      });
    };
    reader.readAsText(file);
    event.target.value = "";
  }
  function addCalendarEventAsShoot(eventItem: CalendarEvent) { snapshot(); const shoot = calendarEventToShoot(eventItem, pricing); setShoots(rows => [shoot, ...rows]); setCalendarEvents(events => events.map(item => item.id === eventItem.id ? { ...item, imported: true } : item)); }
  function clearCalendarEvents() {
    if (!window.confirm("Clear calendar import cache?\n\nThis removes all imported calendar events from the Calendar tab. Your shoots and invoice data are not affected. This can be undone.")) return;
    snapshot();
    setCalendarEvents([]);
    showToast("Calendar cache cleared — Undo to restore", "success");
  }
  function removeCalendarEvent(event: CalendarEvent) {
    snapshot();
    setCalendarEvents(existing => existing.filter(e => e.id !== event.id));
    showToast("Event removed from Calendar view — Undo to restore", "success");
  }
  async function handleDeleteFromGoogle(event: CalendarEvent) {
    if (!gcalAccessToken || !event.googleEventId) {
      showToast("Cannot delete: no Google Event ID", "error");
      return;
    }
    const calId = event.gcalCalendarId || gcalTargetId();
    try {
      await deleteGoogleCalendarEvent(gcalAccessToken, calId, event.googleEventId);
      setCalendarEvents(existing => existing.filter(e => e.id !== event.id));
      showToast("Deleted from Google Calendar", "success");
      // Auto-sync to confirm deletion and pull any other remote changes
      setTimeout(() => syncGoogleCalendar(), 800);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Google Calendar Sync Error (delete):", e);
      showToast(`Failed to delete from Google Calendar: ${msg}`, "error");
    }
  }

  async function rebuildCalendarCache() {
    if (gcalAccessToken && gcalSelectedIds.size > 0) {
      // Hard refresh: clear all Google-sourced events, re-fetch everything from Google
      console.log("Calendar: hard refresh — clearing stale cache and re-fetching from Google");
      setCalendarEvents(existing => existing.filter(e => !e.googleEventId));
      await _syncGoogleCalendarWithToken(gcalAccessToken, gcalSelectedIds);
      console.log("Cache refreshed");
    } else {
      // No connection — just dedupe local events
      setCalendarEvents(existing => {
        const deduped = dedupeCalendarEvents(existing);
        const removed = existing.length - deduped.length;
        showToast(removed > 0 ? `Rebuilt: removed ${removed} duplicate${removed !== 1 ? "s" : ""}` : "Calendar already clean", "success");
        console.log(`Cache refreshed (local dedupe): removed ${removed} duplicates`);
        return deduped;
      });
    }
  }

  function gcalTargetId(): string {
    return gcalSelectedIds.size > 0 ? [...gcalSelectedIds][0] : "primary";
  }

  async function handleSaveToGoogleCalendar(event: CalendarEvent): Promise<void> {
    if (!gcalAccessToken || !gcalHasWriteScope) {
      showToast("Connect with write access to save to Google Calendar", "error");
      return;
    }
    const calId = event.gcalCalendarId || gcalTargetId();
    try {
      if (event.googleEventId) {
        await updateGoogleCalendarEvent(gcalAccessToken, calId, event.googleEventId, event);
        showToast("Updated Google Calendar", "success");
      } else {
        const googleEventId = await createGoogleCalendarEvent(gcalAccessToken, calId, event);
        setCalendarEvents(evs => evs.map(e => e.id === event.id ? { ...e, googleEventId, gcalCalendarId: calId } : e));
        showToast("Saved to Google Calendar", "success");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Google Calendar Sync Error (save):", e);
      showToast(`Failed to save to Google Calendar: ${msg}`, "error");
    }
  }

  // Updates a local calendar event and, if it has a googleEventId + write scope, pushes to Google.
  // After a successful Google update, auto-syncs from Google as source of truth.
  async function handleUpdateCalendarEvent(original: CalendarEvent, updated: CalendarEvent): Promise<void> {
    if (updated.googleEventId) {
      if (!gcalAccessToken || !gcalHasWriteScope) {
        showToast("Reconnect Google Calendar with edit permission to update Google Calendar.", "error");
        return;
      }
      const calId = updated.gcalCalendarId || gcalTargetId();
      try {
        await updateGoogleCalendarEvent(gcalAccessToken, calId, updated.googleEventId, updated);
        showToast("Google Calendar updated", "success");
      } catch (e: unknown) {
        const apiErr = e as { result?: { error?: { message?: string } } };
        const detail = apiErr?.result?.error?.message ?? (e instanceof Error ? e.message : JSON.stringify(e));
        console.error("Google Calendar update failed", e);
        showToast(`Google Calendar write failed: ${detail}`, "error");
        return;
      }
      // Update local state immediately so the modal reflects the change
      snapshot();
      setCalendarEvents(evs => evs.map(e => e.id === original.id ? updated : e));
      // Then sync Google as source of truth
      setTimeout(() => syncGoogleCalendar(), 800);
    } else {
      // Local-only event — just update locally
      snapshot();
      setCalendarEvents(evs => evs.map(e => e.id === original.id ? updated : e));
      showToast("Event updated", "success");
    }
  }

  async function handleAddManualCalendarEvent(eventData: { date: string; time?: string; endTime?: string; title: string; description: string; location: string }): Promise<void> {
    const calId = gcalTargetId();

    // If connected but missing write scope, request it then retry
    if (gcalAccessToken && !gcalHasWriteScope) {
      showToast("Requesting write permission for Google Calendar…", "success");
      await connectGoogle(true);
      // connectGoogle is async but setGcalAccessToken/setGcalHasWriteScope are state updates
      // — the caller should retry after the modal closes; surface a clear message
      showToast("Write permission granted. Please add the event again.", "success");
      return;
    }

    // Must have write scope to proceed
    if (!gcalAccessToken || !gcalHasWriteScope) {
      showToast("Connect Google Calendar with write permission to add events.", "error");
      return;
    }

    // Build the event resource matching the required format
    const resource = {
      summary:     eventData.title,
      description: eventData.description || "",
      location:    eventData.location    || "",
      start: eventData.time
        ? { dateTime: `${eventData.date}T${eventData.time}:00-10:00`, timeZone: "Pacific/Tahiti" }
        : { date: eventData.date },
      end: eventData.endTime
        ? { dateTime: `${eventData.date}T${eventData.endTime}:00-10:00`, timeZone: "Pacific/Tahiti" }
        : eventData.time
        ? { dateTime: `${eventData.date}T${eventData.time}:00-10:00`, timeZone: "Pacific/Tahiti" }
        : { date: eventData.date },
    };

    try {
      window.gapi!.client.setToken({ access_token: gcalAccessToken });
      console.log("[gcal] inserting event", { calId, resource });
      const res = await window.gapi!.client.calendar.events.insert({ calendarId: calId, resource });
      const googleEventId: string = res.result.id;
      console.log("[gcal] insert success, googleEventId=", googleEventId);

      const calEvent: CalendarEvent = {
        id:             Date.now(),
        date:           eventData.date,
        time:           eventData.time,
        endTime:        eventData.endTime,
        title:          eventData.title,
        description:    eventData.description,
        location:       eventData.location,
        imported:       false,
        googleEventId,
        gcalCalendarId: calId,
      };
      snapshot();
      setCalendarEvents(evs => [...evs, calEvent]);
      showToast("Saved to Google Calendar", "success");
      setTimeout(() => syncGoogleCalendar(), 1200);
    } catch (e: unknown) {
      // Surface the full API error so the user knows exactly what went wrong
      const apiErr = e as { result?: { error?: { message?: string; code?: number } }; status?: number };
      const detail =
        apiErr?.result?.error?.message
        ?? (e instanceof Error ? e.message : JSON.stringify(e));
      console.error("Google Calendar insert failed", e);
      showToast(`Google Calendar write failed: ${detail}`, "error");
      // Do NOT save locally — event must exist in Google first
    }
  }

  const tabContent = <>
    {activeTab === "Dashboard" && <Dashboard years={years} year={dashboardYear} setYear={setDashboardYear} hotel={dashboardHotel} setHotel={setDashboardHotel} month={dashboardMonth} setMonth={setDashboardMonth} monthlyData={monthlyData} timelineData={timelineData} shoots={dashboardFiltered.filteredShoots} directIncome={dashboardFiltered.filteredDirectAll} allShoots={shoots} allDirectIncome={directIncome} stats={stats} calendarEvents={calendarEvents} />}
    {activeTab === "Dashboard V2" && <DashboardV2 shoots={shoots} directIncome={directIncome} savedInvoices={savedInvoices} calendarEvents={calendarEvents} onTabChange={setActiveTab} />}
    {activeTab === "Shoots" && <ShootsPanel form={form} updateForm={updateForm} saveShoot={saveShoot} editingShootId={editingShootId} query={query} setQuery={setQuery} rows={filteredShoots} allShoots={shoots} years={years} editShoot={editShoot} deleteShoot={deleteShoot} formRef={shootFormRef} recoverShoots={recoverShootsFromSheet} recoveryState={recoveryState} isSaving={shootSaving} />}
    {activeTab === "Direct" && <DirectPanel directForm={directForm} setDirectForm={setDirectForm} saveDirectIncome={saveDirectIncome} editingDirectId={editingDirectId} rows={directIncome} editDirect={editDirect} deleteDirect={deleteDirect} isSaving={directSaving} syncStats={acctSyncStats} onRefreshSync={refreshAccounting} syncRefreshing={acctRefreshing} />}
    {activeTab === "Invoices" && <InvoicesPanel years={years} invoiceHotel={invoiceHotel} setInvoiceHotel={setInvoiceHotel} invoiceYear={invoiceYear} setInvoiceYear={setInvoiceYear} invoiceMonth={invoiceMonth} setInvoiceMonth={setInvoiceMonth} invoiceDepartment={invoiceDepartment} setInvoiceDepartment={setInvoiceDepartment} generateInvoice={generateInvoice} invoiceRows={invoiceRows} editShoot={editShoot} deleteShoot={deleteShoot} generatedInvoice={generatedInvoice} allShoots={shoots} savedInvoices={savedInvoices} regenerateInvoice={regenerateInvoice} deleteInvoice={deleteInvoice} downloadAllInvoicesFor={downloadAllInvoicesFor} onInvoiceSaved={(saved) => { if (saved) { showToast("Invoice PDF saved to Documents", "success"); setDocsRefreshTrigger(n => n + 1); } else { showToast("Documents folder not connected. PDF was not saved.", "error"); } }} />}
    {activeTab === "Prices" && <PricesPanel priceForm={priceForm} setPriceForm={setPriceForm} savePrice={savePrice} pricing={pricing} editingPriceId={editingPriceId} editPrice={editPrice} deletePrice={deletePrice} />}
    {activeTab === "Calendar" && <CalendarPanel calendarEvents={calendarEvents} importCalendarFile={importCalendarFile} addCalendarEventAsShoot={addCalendarEventAsShoot} clearCalendarEvents={clearCalendarEvents} rebuildCalendarCache={rebuildCalendarCache} gcalAccessToken={gcalAccessToken} gcalCalendars={gcalCalendars} gcalSelectedIds={gcalSelectedIds} setGcalSelectedIds={setGcalSelectedIds} gcalLoading={gcalLoading} gcalError={gcalError} gapiReady={gapiReady} connectGoogle={connectGoogle} disconnectGoogle={disconnectGoogle} syncGoogleCalendar={syncGoogleCalendar} shoots={shoots} pricing={pricing} showDebugStats={showDebugStats} onAddToEditing={currentUser.role === "admin" ? handleAddToEditing : undefined} isAdmin={currentUser.role === "admin"} sheetJobs={sheetJobs} onQuickAddShoot={currentUser.role === "admin" ? async ({ date, hotel, client, eventType, photoPackage }) => {
      const syntheticEvent: CalendarEvent = { id: Date.now(), date, title: `${hotel} — ${client}`, description: "", location: hotel, imported: false };
      const editingJob: NewEditingJob = { date, galleryName: client, resort: hotel, photoPackage, occasion: eventType, notes: "", actor: currentUser.displayName, editingAddedAt: new Date().toISOString() };
      const isResort = RESORT_HOTELS.includes(hotel);
      if (isResort) {
        const priceRow = findPrice(pricing, hotel, photoPackage, "Concierge");
        const ht = priceRow?.ht ?? 0;
        const shoot: Shoot = { id: Date.now(), date, hotel, client, eventType, photoPackage, department: "Concierge", source: "Resort", ht, tax: calculateTax(ht), finalAmount: calculateFinalAmount(ht), status: "To invoice" };
        await handleAddToEditing(syntheticEvent, { type: "resort", shoot, editingJob });
      } else {
        const directRow: DirectRow = { id: Date.now(), date, client, income: photoPackage || "Photo Session", amount: 0 };
        await handleAddToEditing(syntheticEvent, { type: "direct", directRow, editingJob });
      }
    } : undefined} onRemoveFromAccounting={currentUser.role === "admin" ? handleRemoveFromAccounting : undefined} onRemoveFromShoots={currentUser.role === "admin" ? handleRemoveFromShoots : undefined} onRemoveFromDirect={currentUser.role === "admin" ? handleRemoveFromDirect : undefined} onRemoveFromEditing={currentUser.role === "admin" ? handleRemoveFromEditing : undefined} onRemoveFromCalendar={removeCalendarEvent} onDeleteFromGoogle={currentUser.role === "admin" ? handleDeleteFromGoogle : undefined} onSaveToGoogleCalendar={gcalHasWriteScope && gcalAccessToken ? handleSaveToGoogleCalendar : undefined} onUpdateCalendarEvent={handleUpdateCalendarEvent} onAddManualCalendarEvent={handleAddManualCalendarEvent} gcalHasWriteScope={gcalHasWriteScope} directIncome={directIncome} />}
    {activeTab === "Debug" && <DebugPanel shoots={shoots} directIncome={directIncome} savedInvoices={savedInvoices} dashboardYear={dashboardYear} dashboardMonth={dashboardMonth} dashboardHotel={dashboardHotel} filteredDirectAll={dashboardFiltered.filteredDirectAll} />}
    {activeTab === "Editing" && (
      <EditingPipelinePanel
        sheetJobs={sheetJobs}
        syncState={sheetsSyncState}
        onSyncNow={handleEditingSyncNow}
        onSaveSasha={handleSaveSasha}
        onSaveEmail={handleSaveEmail}
        onMoveStage={handleMoveStage}
        onMarkReviewed={handleMarkReviewed}
        onPhotosSaved={handlePhotosSaved}
        onRemoveJob={currentUser.role === "admin" ? handleRemoveJobFromPipeline : undefined}
        currentUserName={currentUser.displayName}
      />
    )}
  </>;

  return (
    <div className={`min-h-screen text-stone-900 transition-colors duration-500 ${activeTab === "Dashboard" ? "dashboard-page-bg" : "bg-[#f6efe4]"}`}>
      {/* Documents panel */}
      {docsOpen && (
        <DocumentsPanel
          onClose={() => setDocsOpen(false)}
          onToast={showToast}
          refreshTrigger={docsRefreshTrigger}
          onDeleteFile={async (_file, invoiceNumber) => {
            if (!invoiceNumber) return "proceed";
            // Remove matching invoice from state — file system deletion proceeds after
            const match = savedInvoicesRef.current.find(i => i.invoiceNumber === invoiceNumber);
            if (match) {
              snapshot();
              setSavedInvoices(list => list.filter(i => i.invoiceNumber !== invoiceNumber));
              if (generatedInvoiceRef.current?.invoiceNumber === invoiceNumber) setGeneratedInvoice(null);
            }
            return "proceed";
          }}
        />
      )}

      {/* Import preview modal */}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          onConfirm={confirmImport}
          onCancel={() => setImportPreview(null)}
        />
      )}

      {/* Admin Settings — user management */}
      {adminSettingsOpen && currentUser.role === "admin" && (
        <AdminSettingsPanel
          onClose={() => setAdminSettingsOpen(false)}
          currentUserId={currentUser.id}
        />
      )}
      {/* Duplicate confirmation modal */}
      {duplicateModal && (
        <DuplicateConfirmModal
          {...duplicateModal}
          onCancel={() => { duplicateResolveRef.current?.(false); setDuplicateModal(null); }}
          onConfirm={() => { duplicateResolveRef.current?.(true); setDuplicateModal(null); }}
        />
      )}

      {/* Toast notifications */}
      {/* Desktop: bottom-right stack. Mobile: single toast at bottom above browser bar */}
      <div className="fixed bottom-5 right-5 z-[200] hidden sm:flex flex-col gap-2 pointer-events-none no-print">
        {toasts.map(t => (
          <div
            key={t.id}
            onClick={() => setToasts(ts => ts.filter(x => x.id !== t.id))}
            className={`pointer-events-auto flex items-center gap-2.5 rounded-2xl px-4 py-3 shadow-lg text-sm font-medium transition-all cursor-pointer ${t.type === "success" ? "bg-stone-900 text-white" : "bg-red-700 text-white"}`}
          >
            <span>{t.type === "success" ? "✓" : "✕"}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
      {/* Mobile: single toast, discreet, above browser bar */}
      <div
        className="fixed left-1/2 -translate-x-1/2 z-[200] sm:hidden pointer-events-none no-print"
        style={{ bottom: "calc(72px + env(safe-area-inset-bottom))" }}
      >
        {toasts.slice(-1).map(t => (
          <div
            key={t.id}
            onClick={() => setToasts(ts => ts.filter(x => x.id !== t.id))}
            className={`pointer-events-auto flex items-center gap-2 rounded-2xl shadow-lg font-medium cursor-pointer ${t.type === "success" ? "bg-stone-900 text-white" : "bg-red-600 text-white"}`}
            style={{ padding: "10px 14px", fontSize: "12px", maxWidth: "88vw", borderRadius: "16px" }}
          >
            <span className="flex-shrink-0">{t.type === "success" ? "✓" : "✕"}</span>
            <span className="flex-1 min-w-0 truncate">{t.message}</span>
            <button
              onClick={e => { e.stopPropagation(); setToasts(ts => ts.filter(x => x.id !== t.id)); }}
              className="flex-shrink-0 ml-1 opacity-60 hover:opacity-100 transition"
              aria-label="Dismiss"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        ))}
      </div>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .invoice-print, .invoice-print * { visibility: visible; }
          .invoice-print {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            background: #fbf7ef;
            padding: 18mm;
          }
          .invoice-print table { font-size: 10px !important; }
          .invoice-print th { padding-bottom: 6px !important; }
          .invoice-print td { padding-top: 5px !important; padding-bottom: 5px !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      {/* Sticky chrome: nav + header */}
      <div ref={chromeRef} className={`sticky top-0 z-40 no-print ${activeTab === "Dashboard" ? "dashboard-chrome-glass" : "bg-[#f6efe4] shadow-[0_1px_0_0_rgba(0,0,0,0.06)]"}`}>

        {/* ── Header / Navigation ──────────────────────────────────────────── */}
        <div className="px-3 pt-1.5 pb-0 md:px-6">
          <div className="mx-auto max-w-[1600px]">

            {/* Main row: Logo | Desktop tabs | Controls */}
            <div className="flex items-center gap-2 md:gap-3 py-1.5 md:py-2">

              {/* Logo + Business name — left */}
              <div className="flex items-center gap-2 md:gap-2.5 flex-shrink-0 min-w-0">
                <img src="/Sasha_Popovic_|_Photography_Bora_Bora.png" alt="Sasha Popovic Photography" className="h-7 md:h-9 w-auto object-contain flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] sm:text-[11px] md:text-[13px] font-bold tracking-tight text-stone-900 leading-none truncate">Sasha Popovic Photography</p>
                  <p className="text-[9px] md:text-[10px] text-stone-400 mt-0.5 hidden sm:block">Bora Bora, French Polynesia</p>
                </div>
              </div>

              {/* Tabs — desktop only, centered */}
              <div className="hidden md:flex flex-1 justify-center min-w-0">
                <div className="rounded-full bg-[#eadfce] p-[3px] shadow-sm">
                  <div className="flex gap-0 text-[11px]">
                    {allowedTabs.map(tab => (
                      <button
                        key={tab}
                        onClick={() => safeSetTab(tab)}
                        className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-center font-medium transition-all ${
                          activeTab === tab
                            ? "bg-stone-900 text-white shadow-sm"
                            : "text-stone-500 hover:text-stone-800"
                        }`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right side controls */}
              <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto md:ml-0">

                {/* Status dot — dot only, no text */}
                <div
                  title={sheetsSyncState.status === "syncing" ? "Syncing…" : sheetsSyncState.status === "ok" ? "Live" : sheetsSyncState.status === "error" ? "Sync error" : "Offline"}
                  className="flex items-center gap-1 rounded-full border border-stone-200 bg-white/80 px-2 py-1.5 h-7"
                >
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${
                    sheetsSyncState.status === "syncing" ? "bg-amber-400 animate-pulse" :
                    sheetsSyncState.status === "ok" ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.8)]" :
                    sheetsSyncState.status === "error" ? "bg-rose-400" : "bg-stone-300"
                  }`} />
                  {(gcalAccessToken || gcalLoading) && (
                    <span
                      className={`h-2 w-2 rounded-full flex-shrink-0 ${gcalLoading ? "bg-amber-400 animate-pulse" : "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.8)]"}`}
                      title={gcalLoading ? "Calendar syncing…" : "Calendar live"}
                    />
                  )}
                </div>

                {/* Current user — profile dropdown */}
                <div className="relative">
                  <button
                    onClick={() => { setProfileMenuOpen(o => !o); setSettingsOpen(false); setDocsOpen(false); }}
                    title={currentUser.displayName}
                    className={`flex items-center gap-1.5 rounded-full border px-2 sm:px-2.5 py-1.5 h-7 text-[11px] font-medium transition ${
                      profileMenuOpen || settingsOpen
                        ? "border-stone-800 bg-stone-900 text-white"
                        : "border-stone-200 bg-white/80 text-stone-600 hover:bg-white hover:border-stone-300"
                    }`}
                  >
                    <span className={`h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 border ${
                      profileMenuOpen || settingsOpen
                        ? "border-white/30 bg-white/20 text-white"
                        : "border-stone-200 bg-stone-100 text-stone-600"
                    }`}>
                      {currentUser.displayName.charAt(0).toUpperCase()}
                    </span>
                    <span className="hidden sm:inline">{currentUser.displayName.split(" ")[0]}</span>
                    <svg className="hidden sm:block h-2.5 w-2.5 flex-shrink-0 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>

                {/* Profile dropdown */}
                {profileMenuOpen && !settingsOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setProfileMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1.5 z-50 w-56 rounded-2xl border border-stone-200/60 bg-white shadow-xl overflow-hidden">
                      {/* User header */}
                      <div className="px-4 py-3 bg-stone-50/80 border-b border-stone-100">
                        <p className="text-[12px] font-bold text-stone-900 leading-tight">{currentUser.displayName}</p>
                        <p className="text-[10px] text-stone-400 mt-0.5 capitalize">{currentUser.role}</p>
                      </div>

                      {/* Other user presence — shown if someone else is online */}
                      {otherUserPresence && (
                        <div className="px-4 py-2.5 border-b border-stone-100 flex items-center gap-2.5">
                          <span className={`h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 border ${
                            otherUserPresence.isOnline
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                              : "border-stone-200 bg-stone-100 text-stone-500"
                          }`}>
                            {otherUserPresence.displayName.charAt(0).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium text-stone-700 leading-tight truncate">{otherUserPresence.displayName.split(" ")[0]}</p>
                            <p className={`text-[10px] mt-0.5 ${otherUserPresence.isOnline ? "text-emerald-500" : "text-stone-400"}`}>{otherUserPresence.isOnline ? "Online now" : "Recently active"}</p>
                          </div>
                        </div>
                      )}

                      <div className="py-1">
                        {/* Docs */}
                        <button
                          onClick={() => { setProfileMenuOpen(false); setDocsOpen(true); }}
                          className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-[12px] text-stone-700 hover:bg-stone-50 transition"
                        >
                          <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                          </svg>
                          Documents
                        </button>

                        {/* Sync now */}
                        <button
                          onClick={() => { setProfileMenuOpen(false); syncFromSheet(); }}
                          disabled={sheetsSyncState.status === "syncing"}
                          className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-[12px] text-stone-700 hover:bg-stone-50 transition disabled:opacity-40"
                        >
                          <svg className={`h-3.5 w-3.5 text-stone-400 flex-shrink-0 ${sheetsSyncState.status === "syncing" ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
                          </svg>
                          {sheetsSyncState.status === "syncing" ? "Syncing…" : "Sync Now"}
                        </button>

                        {/* Admin-only items */}
                        {currentUser.role === "admin" && (
                          <button
                            onClick={() => { setProfileMenuOpen(false); setAdminSettingsOpen(true); }}
                            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-[12px] text-stone-700 hover:bg-stone-50 transition"
                          >
                            <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                            </svg>
                            User Management
                          </button>
                        )}
                        {currentUser.role === "admin" && (
                          <button
                            onClick={() => { setProfileMenuOpen(false); setSettingsOpen(true); }}
                            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-[12px] text-stone-700 hover:bg-stone-50 transition"
                          >
                            <svg className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                            </svg>
                            App Settings
                          </button>
                        )}
                      </div>

                      <div className="border-t border-stone-100 py-1">
                        <button
                          onClick={() => { setProfileMenuOpen(false); onLogout(); }}
                          className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-[12px] text-red-500 hover:bg-red-50 transition"
                        >
                          <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                          </svg>
                          Log Out
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* Settings panel — admin-only, anchored to profile button */}
                {currentUser.role === "admin" && settingsOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setSettingsOpen(false)} />
                    <div className="fixed bottom-0 left-0 right-0 z-50 sm:absolute sm:bottom-auto sm:left-auto sm:right-0 sm:top-full sm:mt-1">
                      <SettingsPanel
                        lastSavedAt={lastSavedAt}
                        lastBackupAt={lastBackupAt}
                        autoBackupEnabled={autoBackupEnabled}
                        setAutoBackupEnabled={setAutoBackupEnabled}
                        keepBackupHistory={keepBackupHistory}
                        setKeepBackupHistory={setKeepBackupHistory}
                        backupFolderName={backupFolderName}
                        backupFolderHandle={backupFolderHandle}
                        saveBackup={saveBackup}
                        chooseBackupFolder={chooseBackupFolder}
                        clearStoredFolderHandle={clearStoredFolderHandle}
                        setBackupFolderHandle={setBackupFolderHandle}
                        setBackupFolderName={setBackupFolderName}
                        canUndo={canUndo}
                        undo={undo}
                        importDataMerge={importDataMerge}
                        importDataReplace={importDataReplace}
                        clearShootsAndDirect={clearShootsAndDirect}
                        clearCalendarEvents={clearCalendarEvents}
                        protectedReset={protectedReset}
                        onClose={() => setSettingsOpen(false)}
                        gcalAccessToken={gcalAccessToken}
                        gcalConnectedEmail={gcalConnectedEmail}
                        gcalCalendars={gcalCalendars}
                        gcalSelectedIds={gcalSelectedIds}
                        setGcalSelectedIds={setGcalSelectedIds}
                        gcalLoading={gcalLoading}
                        gcalError={gcalError}
                        gapiReady={gapiReady}
                        connectGoogle={connectGoogle}
                        disconnectGoogle={disconnectGoogle}
                        syncGoogleCalendar={syncGoogleCalendar}
                        importCalendarFile={importCalendarFile}
                        rebuildCalendarCache={rebuildCalendarCache}
                        hasCalendarEvents={calendarEvents.length > 0}
                        gcalSyncStats={gcalSyncStats}
                        showDebugStats={showDebugStats}
                        setShowDebugStats={setShowDebugStats}
                        appHealth={appHealth}
                        onEditingSyncNow={handleEditingSyncNow}
                        onEditingTestConnection={handleEditingTestConnection}
                        onEditingTestWrite={handleTestWrite}
                        editingSyncStatus={editingSyncStatus}
                        editingSyncLoading={editingSyncLoading}
                        testWriteResult={testWriteResult}
                        onTestAccounting={handleTestAccounting}
                        acctTestResult={acctTestResult}
                        acctSyncStats={acctSyncStats}
                        onDebugRead={handleDebugRead}
                        debugReadResult={debugReadResult}
                        sheetsSyncState={sheetsSyncState}
                      />
                    </div>
                  </>
                )}
              </div>

              </div>{/* end right side controls */}

            </div>

            {/* Mobile tabs row */}
            <div className="md:hidden pb-1.5">
              <div className="rounded-full bg-[#eadfce] p-[2px] shadow-sm overflow-hidden">
                <div className="overflow-x-auto flex gap-0 text-[11px]" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}>
                  {allowedTabs.map(tab => (
                    <button
                      key={tab}
                      onClick={() => safeSetTab(tab)}
                      className={`flex-shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-center font-medium transition-all ${
                        activeTab === tab
                          ? "bg-stone-900 text-white shadow-sm"
                          : "text-stone-500 hover:text-stone-800"
                      }`}
                    >
                      {tab === "Dashboard V2" ? "Dash V2" : tab}
                    </button>
                  ))}
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── Editorial KPI Header — shown for admin on accounting tabs ── */}
        {ACCOUNTING_TABS.includes(activeTab) && currentUser.role === "admin" && (
          <div className="px-5 pb-0 md:px-8">
            <div className="mx-auto max-w-[1600px]">

              {/* KPI Strip — 2 cols mobile / 3 cols tablet / 5 cols desktop */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 lg:py-10">
                {/* HT SALES — col 1 always */}
                <div className="flex flex-col gap-2.5 px-4 py-5 md:px-6 md:py-7 lg:px-0 lg:pr-8 lg:py-0 border-r border-b lg:border-b-0 border-[rgba(26,23,20,0.1)]">
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1.4px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>HT Sales</p>
                  <div className="flex items-center gap-2">
                    <TrendingUp size={16} strokeWidth={1.5} style={{ color: "#4F8A5B", flexShrink: 0 }} />
                    <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "clamp(20px, 5.5vw, 27px)", fontWeight: 400, letterSpacing: "-0.5px", color: "#4F8A5B", lineHeight: 1, fontFeatureSettings: "'tnum'" }} className="tabular-nums">{numberOnly(stats.ht)}</p>
                  </div>
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>XPF</p>
                </div>

                {/* TVA 13% — col 2; gains right border at md+ */}
                <div className="flex flex-col gap-2.5 px-4 py-5 md:px-6 md:py-7 lg:px-8 lg:py-0 border-b md:border-r lg:border-b-0 border-[rgba(26,23,20,0.1)]">
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1.4px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>TVA 13%</p>
                  <div className="flex items-center gap-2">
                    <Receipt size={16} strokeWidth={1.5} style={{ color: "#6F6A64", flexShrink: 0 }} />
                    <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "clamp(20px, 5.5vw, 27px)", fontWeight: 400, letterSpacing: "-0.5px", color: "#6F6A64", lineHeight: 1, fontFeatureSettings: "'tnum'" }} className="tabular-nums">{numberOnly(stats.tax)}</p>
                  </div>
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>XPF</p>
                </div>

                {/* TTC REVENUE — full-width on mobile (col-span-2), col 3 on tablet, col 3 on desktop */}
                <div className="flex flex-col gap-2.5 px-4 py-5 md:px-6 md:py-7 lg:px-8 lg:py-0 col-span-2 md:col-span-1 border-b lg:border-b-0 lg:border-r border-[rgba(26,23,20,0.1)]">
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1.4px", color: "#B0902F", textTransform: "uppercase" }}>TTC Revenue</p>
                  <div className="flex items-center gap-2">
                    <Coins size={18} strokeWidth={1.5} style={{ color: "#B0902F", flexShrink: 0 }} />
                    <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "clamp(22px, 6vw, 30px)", fontWeight: 500, letterSpacing: "-0.5px", color: "#B0902F", lineHeight: 1, fontFeatureSettings: "'tnum'" }} className="tabular-nums">{numberOnly(stats.finalAmount)}</p>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1px", color: "#B0902F", textTransform: "uppercase" }}>XPF</p>
                    <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>Incl. Tax</p>
                  </div>
                </div>

                {/* DIRECT — col 1 in last row at mobile/tablet, col 4 at desktop */}
                <div className="flex flex-col gap-2.5 px-4 py-5 md:px-6 md:py-7 lg:px-8 lg:py-0 border-r border-[rgba(26,23,20,0.1)]">
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1.4px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>Direct</p>
                  <div className="flex items-center gap-2">
                    <Users size={16} strokeWidth={1.5} style={{ color: "#4F8A5B", flexShrink: 0 }} />
                    <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "clamp(20px, 5.5vw, 27px)", fontWeight: 400, letterSpacing: "-0.5px", color: "#4F8A5B", lineHeight: 1, fontFeatureSettings: "'tnum'" }} className="tabular-nums">{usd(stats.direct)}</p>
                  </div>
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>Clients</p>
                </div>

                {/* SHOOTS — col 2 in last row at mobile/tablet, col 5 at desktop */}
                <div className="flex flex-col gap-2.5 px-4 py-5 md:px-6 md:py-7 lg:px-0 lg:pl-8 lg:py-0 border-[rgba(26,23,20,0.1)]">
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1.4px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>Shoots</p>
                  <div className="flex items-center gap-2">
                    <Camera size={16} strokeWidth={1.5} style={{ color: "#6F6A64", flexShrink: 0 }} />
                    <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "clamp(20px, 5.5vw, 27px)", fontWeight: 400, letterSpacing: "-0.5px", color: "#6F6A64", lineHeight: 1, fontFeatureSettings: "'tnum'" }} className="tabular-nums">{dashboardFiltered.filteredShoots.length}</p>
                  </div>
                  <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9.5px", letterSpacing: "1px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>Sessions</p>
                </div>
              </div>

              {/* Hairline divider */}
              <div style={{ borderTop: "1px solid rgba(26,23,20,0.1)" }} />

              {/* By Hotel */}
              <div className="py-5 md:py-7">

                {/* Mobile: horizontal scroll cards (hidden at md+) */}
                <div className="md:hidden">
                  <span className="flex items-center gap-1.5 mb-3 px-1" style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", letterSpacing: "3px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>
                    <Building2 size={12} strokeWidth={1.5} style={{ color: "rgba(26,23,20,0.4)" }} />
                    By Hotel
                  </span>
                  <div className="flex gap-3 overflow-x-auto pb-1" style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
                    {headerDirectHotelStats.map((row, i) => {
                      const dotColor = ["#C58A86", "#C9A84C", "#7E96B0"][i];
                      return (
                        <div key={row.label} style={{ background: "#EFE7D7", borderRadius: 16, padding: "16px 20px", minWidth: 118, flexShrink: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block", flexShrink: 0 }} />
                            <span style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: 13, fontWeight: 600, color: "#1A1714" }}>{row.label}</span>
                          </div>
                          <span style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: 26, fontWeight: 600, color: "#1A1714", lineHeight: 1, fontFeatureSettings: "'tnum'", display: "block" }} className="tabular-nums">{row.count}</span>
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "rgba(26,23,20,0.45)", letterSpacing: "1px", display: "block", marginTop: 6 }} className="tabular-nums">{usd(row.amount)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Tablet+: horizontal pill (hidden below md) */}
                <div className="hidden md:flex justify-center">
                  <div
                    className="flex flex-wrap items-center gap-y-4 w-full"
                    style={{
                      background: "#EFE7D7",
                      borderRadius: 28,
                      padding: "26px 38px",
                      maxWidth: 1100,
                      gap: 32,
                      justifyContent: "space-between",
                    }}
                  >
                    {/* Label */}
                    <span className="flex items-center gap-1.5" style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", letterSpacing: "3px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase", flexShrink: 0 }}>
                      <Building2 size={14} strokeWidth={1.5} style={{ color: "rgba(26,23,20,0.4)" }} />
                      By Hotel
                    </span>

                    {/* Hotel groups */}
                    <div className="flex flex-wrap items-center gap-y-3" style={{ gap: 0, flex: 1, justifyContent: "space-around" }}>
                      {headerDirectHotelStats.map((row, i) => {
                        const dotColor = ["#C58A86", "#C9A84C", "#7E96B0"][i];
                        return (
                          <React.Fragment key={row.label}>
                            {i > 0 && (
                              <div style={{ width: 1, height: 26, background: "rgba(26,23,20,0.12)", flexShrink: 0, margin: "0 24px" }} />
                            )}
                            <div className="flex items-center" style={{ gap: 10 }}>
                              {/* Dot + name */}
                              <div className="flex items-center" style={{ gap: 8 }}>
                                <span className="rounded-full flex-shrink-0" style={{ display: "inline-block", width: 10, height: 10, background: dotColor }} />
                                <span style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "14px", fontWeight: 600, color: "#1A1714" }}>{row.label}</span>
                              </div>
                              {/* Count */}
                              <span style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "22px", fontWeight: 600, color: "#1A1714", fontFeatureSettings: "'tnum'", lineHeight: 1, marginLeft: 8 }} className="tabular-nums">{row.count}</span>
                              {/* Revenue */}
                              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "rgba(26,23,20,0.45)", letterSpacing: "1px", marginLeft: 4 }} className="tabular-nums">{usd(row.amount)}</span>
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                </div>

              </div>

            </div>
          </div>
        )}
      </div>

      {/* Tab content */}
      {activeTab === "Editing" ? (
        <div className="flex flex-col" style={{ height: `calc(100dvh - ${chromeH}px)` }}>
          <div className="mx-auto w-full max-w-[1600px] flex-1 min-h-0 flex flex-col px-0 md:px-0 pt-0">
            {tabContent}
          </div>
        </div>
      ) : (
        <div className={`pb-6 md:px-5 ${activeTab === "Calendar" ? "px-2 pt-1.5 md:pt-2" : "px-3 pt-2"} ${activeTab === "Dashboard" ? "min-h-screen" : ""}`}>
          <div className="mx-auto max-w-[1600px]">
            {tabContent}
          </div>
        </div>
      )}

    </div>
  );
}

interface DashboardProps { years: string[]; year: string; setYear: (v: string) => void; hotel: string; setHotel: (v: string) => void; month: string; setMonth: (v: string) => void; monthlyData: { month: string; revenue: number }[]; timelineData: { month: string; revenue: number }[]; shoots: Shoot[]; directIncome: DirectRow[]; allShoots: Shoot[]; allDirectIncome: DirectRow[]; stats: { ht: number; tax: number; finalAmount: number; direct: number; net: number }; calendarEvents: CalendarEvent[]; }

// ─── Revenue Overview Chart ───────────────────────────────────────────────────
function RevenueOverviewChart({ shoots, directIncome, years = [] }: { shoots: Shoot[]; directIncome: DirectRow[]; years?: string[] }) {
  const [mode, setMode] = React.useState<'ht' | 'ttc' | 'direct'>('ht');
  const currentYear = String(new Date().getFullYear());
  const [chartYear, setChartYear] = React.useState<string>(
    years.includes(currentYear) ? currentYear : (years[years.length - 1] ?? currentYear)
  );
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const selectedYear = Number(chartYear);

  const safeShots = Array.isArray(shoots) ? shoots : [];
  const safeDirect = Array.isArray(directIncome) ? directIncome : [];

  const mHT    = Array(12).fill(0) as number[];
  const mTTC   = Array(12).fill(0) as number[];
  const mDirect = Array(12).fill(0) as number[];

  safeShots.forEach(s => {
    const d = new Date(s.date);
    if (d.getFullYear() === selectedYear) {
      mHT[d.getMonth()]  += (s.ht ?? 0);
      mTTC[d.getMonth()] += (s.finalAmount ?? 0);
    }
  });
  safeDirect.forEach(r => {
    const d = new Date(r.date);
    if (d.getFullYear() === selectedYear) mDirect[d.getMonth()] += (r.amount ?? 0);
  });

  const data  = mode === 'ht' ? mHT : mode === 'ttc' ? mTTC : mDirect;
  const color = mode === 'direct' ? '#22c55e' : '#E5B93C';

  const W = 560, H = 180;
  const pl = 44, pr = 16, pt = 28, pb = 30;
  const cW = W - pl - pr, cH = H - pt - pb;
  const rawMax = Math.max(...data, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const niceMax = Math.ceil(rawMax / mag) * mag || 1;
  const gradId = `rovg_app_${mode}_${chartYear}`;

  const pts = data.map((v, i) => ({
    x: pl + i / (data.length - 1) * cW,
    y: pt + (1 - v / niceMax) * cH,
    v,
  }));
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const baseY = (pt + cH).toFixed(2);
  const fillD = `${pathD} L${pts[pts.length-1].x.toFixed(2)},${baseY} L${pl},${baseY} Z`;
  const yTicks = [0, niceMax / 2, niceMax].map(t => ({ v: t, y: pt + (1 - t / niceMax) * cH }));
  const hasData = data.some(v => v > 0);

  // Year options: union of years from shoots + direct + current year
  const allYears = Array.from(new Set([
    ...safeShots.map(s => String(new Date(s.date).getFullYear())),
    ...safeDirect.map(r => String(new Date(r.date).getFullYear())),
    ...(Array.isArray(years) ? years : []),
  ])).filter(y => /^\d{4}$/.test(y)).sort();
  const yearOptions = allYears.length > 0 ? allYears : [currentYear];

  return (
    <div className="dashboard-glass transition-transform duration-200 hover:-translate-y-0.5">
      <div className="p-5 pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-2.5">
            <div style={{ width:30, height:30, borderRadius:9, background:"rgba(255,255,255,0.75)", border:"1px solid rgba(255,255,255,0.6)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, boxShadow:"0 2px 8px rgba(15,23,42,0.06)" }}>
              <TrendingUp size={14} strokeWidth={1.5} className="text-stone-500" />
            </div>
            <p className="text-[9.5px] uppercase tracking-[0.18em] text-stone-400 font-semibold">
              Revenue Overview ({mode.toUpperCase()})
            </p>
          </div>
          <div className="flex items-center gap-0.5 flex-wrap">
            {(['ht', 'ttc', 'direct'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`text-[9px] font-bold px-2.5 py-1 rounded-full transition ${
                  mode === m ? 'bg-stone-900 text-white' : 'text-stone-400 hover:text-stone-600'
                }`}>
                {m.toUpperCase()}
              </button>
            ))}
            <span className="text-[9px] text-stone-300 ml-1.5 mr-1">|</span>
            {yearOptions.length > 1 ? (
              <div className="relative inline-flex items-center">
                <select
                  value={chartYear}
                  onChange={e => setChartYear(e.target.value)}
                  className="appearance-none text-[9px] font-medium text-stone-500 bg-transparent border border-stone-200 rounded-full pl-2 pr-5 py-0.5 cursor-pointer outline-none hover:border-stone-400 transition"
                >
                  {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-2 w-2 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
            ) : (
              <span className="text-[9px] text-stone-400 font-medium">{chartYear}</span>
            )}
          </div>
        </div>
        {!hasData ? (
          <div className="flex items-center justify-center h-24 text-[11px] text-stone-400">No revenue data for {chartYear}</div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: 120 }} preserveAspectRatio="xMidYMid meet">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.20" />
                <stop offset="100%" stopColor={color} stopOpacity="0.01" />
              </linearGradient>
            </defs>
            {yTicks.map((t, i) => (
              <g key={i}>
                <line x1={pl} y1={t.y.toFixed(2)} x2={W - pr} y2={t.y.toFixed(2)} stroke="#f0ece6" strokeWidth={i === 0 ? "0.6" : "0.8"} />
                <text x={pl - 5} y={(t.y + 3.5).toFixed(2)} textAnchor="end" fontSize="8" fill="#c2b89a" fontFamily="system-ui, sans-serif">{compactMoney(t.v)}</text>
              </g>
            ))}
            <path d={fillD} fill={`url(#${gradId})`} />
            <path d={pathD} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            {pts.map((p, i) => (
              <g key={i}>
                {p.v > 0 && (
                  <>
                    <text x={p.x.toFixed(2)} y={(p.y - 8).toFixed(2)} textAnchor="middle" fontSize="7.5" fill="#7c6f5b" fontWeight="600" fontFamily="system-ui, sans-serif">{compactMoney(p.v)}</text>
                    <circle cx={p.x.toFixed(2)} cy={p.y.toFixed(2)} r="4" fill="white" stroke={color} strokeWidth="2" />
                  </>
                )}
                <text x={p.x.toFixed(2)} y={(H - 6).toFixed(2)} textAnchor="middle" fontSize="8" fill="#b5a898" fontFamily="system-ui, sans-serif">{MONTHS[i]}</text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

// ─── Shoot Analytics Card ─────────────────────────────────────────────────────
function CalendarAnalyticsCard({
  allShoots,
  allDirectIncome,
  activeHotel,
  activeYear,
  availableYears: yearOptions,
}: {
  allShoots: Shoot[];
  allDirectIncome: DirectRow[];
  activeHotel: string;
  activeYear: string;
  availableYears: string[];
}) {
  const now      = new Date();
  const realYear = String(now.getFullYear());

  // ── Style constants ────────────────────────────────────────────────────────
  const dc      = (d: number) => d > 0 ? "#4F8A5B" : d < 0 ? "#B86B63" : "#6F6A64";
  const sgn     = (d: number) => d > 0 ? "+" : "";
  const MONO    = "'DM Mono', monospace";
  const GROTESK = "'Inter', 'Hanken Grotesk', system-ui, sans-serif";
  const MUTED   = "rgba(26,23,20,0.4)";
  const BR      = "rgba(26,23,20,0.1)";
  const MONTH_FULL = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const MO_SHORT   = ["J","F","M","A","M","J","J","A","S","O","N","D"];
  const fmtD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const fmtK = (n: number) => {
    if (Math.abs(n) >= 1_000_000) return (n/1_000_000).toFixed(1)+"M";
    if (Math.abs(n) >= 1_000)     return Math.round(n/1_000)+"K";
    return new Intl.NumberFormat("de-DE").format(Math.round(n));
  };

  // ── Derive hotel/year from Dashboard props ─────────────────────────────────
  // If Dashboard year = "All", default to current year. Non-hotel types (Tips etc.) → "All Hotels".
  const hotelNames = Object.keys(HOTEL_DOT_COLORS);
  const aHotel = hotelNames.includes(activeHotel) ? activeHotel : "All Hotels";
  const aYear  = activeYear === "All" ? realYear : activeYear;

  // ── State (analytics-specific only) ────────────────────────────────────────
  const [compareTo, setCompareTo] = React.useState("Previous Year");
  const [mode,      setMode]      = React.useState<"ytd"|"month"|"last30"|"fullyear">("ytd");
  const [localYear, setLocalYear] = React.useState(() => aYear);

  const noComparison = compareTo === "No Comparison";
  const compareYear  = String(Number(localYear) - 1);

  // ── Date ranges by mode ────────────────────────────────────────────────────
  const ranges = React.useMemo(() => {
    const mo  = String(now.getMonth()+1).padStart(2,"0");
    const day = String(now.getDate()).padStart(2,"0");
    const md  = `${mo}-${day}`;
    const mon = MONTH_FULL[now.getMonth()];
    const d   = now.getDate();

    if (mode === "ytd") return {
      thisStart:`${localYear}-01-01`,       thisEnd:`${localYear}-${md}`,
      prevStart:`${compareYear}-01-01`, prevEnd:`${compareYear}-${md}`,
      label:`Jan 1 – ${mon} ${d}, ${localYear}`,
      prevLabel:`Jan 1 – ${mon} ${d}, ${compareYear}`,
    };
    if (mode === "month") return {
      thisStart:`${localYear}-${mo}-01`,       thisEnd:`${localYear}-${mo}-${day}`,
      prevStart:`${compareYear}-${mo}-01`, prevEnd:`${compareYear}-${mo}-${day}`,
      label:`${mon} 1–${d}, ${localYear}`,
      prevLabel:`${mon} 1–${d}, ${compareYear}`,
    };
    if (mode === "last30") {
      const t1=new Date(now), t0=new Date(now); t0.setDate(t0.getDate()-30);
      const p1=new Date(now); p1.setDate(p1.getDate()-31);
      const p0=new Date(now); p0.setDate(p0.getDate()-61);
      return {
        thisStart:fmtD(t0), thisEnd:fmtD(t1),
        prevStart:fmtD(p0), prevEnd:fmtD(p1),
        label:`${MONTH_FULL[t0.getMonth()]} ${t0.getDate()} – ${MONTH_FULL[t1.getMonth()]} ${t1.getDate()}`,
        prevLabel:`${MONTH_FULL[p0.getMonth()]} ${p0.getDate()} – ${MONTH_FULL[p1.getMonth()]} ${p1.getDate()}`,
      };
    }
    return {
      thisStart:`${localYear}-01-01`,       thisEnd:`${localYear}-12-31`,
      prevStart:`${compareYear}-01-01`, prevEnd:`${compareYear}-12-31`,
      label:`Full Year ${localYear}`,
      prevLabel:`Full Year ${compareYear}`,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, localYear, compareYear]);

  const { thisStart, thisEnd, prevStart, prevEnd } = ranges;

  // ── Dedup ──────────────────────────────────────────────────────────────────
  const dedupShoots = React.useMemo(() => {
    const seen = new Set<string>();
    return allShoots.filter(r => {
      if (!r.date || !r.hotel) return false;
      const k = `${r.date}|${(r.client||"").toLowerCase().trim()}|${r.hotel}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
  }, [allShoots]);

  const dedupDirect = React.useMemo(() => {
    const seen = new Set<string>();
    return allDirectIncome.filter(r => {
      if (!r.date) return false;
      const k = `${r.date}|${(r.client||"").toLowerCase().trim()}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
  }, [allDirectIncome]);

  // ── Range-filtered data ────────────────────────────────────────────────────
  const shootsThis = React.useMemo(() =>
    dedupShoots.filter(r => { const d=r.date||""; return d>=thisStart && d<=thisEnd && (aHotel==="All Hotels"||r.hotel===aHotel); }),
  [dedupShoots, thisStart, thisEnd, aHotel]);

  const shootsPrev = React.useMemo(() =>
    dedupShoots.filter(r => { const d=r.date||""; return d>=prevStart && d<=prevEnd && (aHotel==="All Hotels"||r.hotel===aHotel); }),
  [dedupShoots, prevStart, prevEnd, aHotel]);

  const directThis = React.useMemo(() =>
    dedupDirect.filter(r => { const d=r.date||""; return d>=thisStart && d<=thisEnd; }),
  [dedupDirect, thisStart, thisEnd]);

  const directPrev = React.useMemo(() =>
    dedupDirect.filter(r => { const d=r.date||""; return d>=prevStart && d<=prevEnd; }),
  [dedupDirect, prevStart, prevEnd]);

  // ── KPI aggregates ─────────────────────────────────────────────────────────
  const directFactor  = aHotel === "All Hotels";
  const thisShoots    = shootsThis.length + (directFactor ? directThis.length : 0);
  const prevShoots    = shootsPrev.length + (directFactor ? directPrev.length : 0);
  const thisDirectCt  = directThis.length;
  const prevDirectCt  = directPrev.length;
  const thisHT        = shootsThis.reduce((s,r) => s+(r.ht||0), 0);
  const prevHT        = shootsPrev.reduce((s,r) => s+(r.ht||0), 0);
  const thisTTC       = shootsThis.reduce((s,r) => s+(r.finalAmount||0), 0);
  const prevTTC       = shootsPrev.reduce((s,r) => s+(r.finalAmount||0), 0);
  const thisDirectRev = directThis.reduce((s,r) => s+(r.amount||0), 0);
  const prevDirectRev = directPrev.reduce((s,r) => s+(r.amount||0), 0);

  // ── Booking pace ───────────────────────────────────────────────────────────
  const rangeDays = (s: string, e: string) =>
    Math.max(Math.round((new Date(e).getTime()-new Date(s).getTime())/86400000)+1, 1);
  const thisDays = rangeDays(thisStart, thisEnd);
  const prevDays = rangeDays(prevStart, prevEnd);
  const thisPace = thisDays > 0 ? thisShoots/thisDays : 0;
  const prevPace = prevDays > 0 ? prevShoots/prevDays : 0;
  const pacePct  = prevPace > 0 ? Math.round((thisPace-prevPace)/prevPace*100) : null;

  // ── Forecast ───────────────────────────────────────────────────────────────
  const isCurrentYear = localYear === realYear;
  const forecast = React.useMemo(() => {
    if (!isCurrentYear) return null;
    if (mode === "month") {
      const elapsed     = now.getDate();
      const daysInMonth = new Date(Number(aYear), now.getMonth()+1, 0).getDate();
      const pace        = elapsed > 0 ? shootsThis.length/elapsed : 0;
      return { current: shootsThis.length, projected: Math.round(pace*daysInMonth), daysLeft: daysInMonth-elapsed, label:`Proj. end of ${MONTH_FULL[now.getMonth()]}` };
    }
    if (mode === "ytd") {
      const startOfYear = new Date(Number(localYear), 0, 1);
      const dayOfYear   = Math.max(Math.round((now.getTime()-startOfYear.getTime())/86400000)+1, 1);
      const daysInYear  = 365+(Number(localYear)%4===0?1:0);
      const pace        = dayOfYear > 0 ? thisShoots/dayOfYear : 0;
      return { current: thisShoots, projected: Math.round(pace*daysInYear), daysLeft: daysInYear-dayOfYear, label:`Proj. end of ${localYear}` };
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isCurrentYear, shootsThis.length, thisShoots, aYear]);

  // ── Change metrics ─────────────────────────────────────────────────────────
  const diff    = thisShoots - prevShoots;
  const pct     = prevShoots  > 0 ? Math.round((diff/(prevShoots))*100)           : null;
  const htDiff  = thisHT      - prevHT;
  const htPct   = prevHT      > 0 ? Math.round((htDiff/prevHT)*100)               : null;
  const dirDiff = thisDirectCt- prevDirectCt;
  const dirPct  = prevDirectCt> 0 ? Math.round((dirDiff/prevDirectCt)*100)        : null;
  const drDiff  = thisDirectRev-prevDirectRev;

  // ── Business health ────────────────────────────────────────────────────────
  const health = (() => {
    if (pct === null) return { label:"No Data",        color:"#9c9186", bg:"rgba(156,145,134,0.08)" };
    if (pct >= 10)    return { label:"Excellent",       color:"#4F8A5B", bg:"rgba(79,138,91,0.10)"  };
    if (pct >= 0)     return { label:"Good",            color:"#5e8a6e", bg:"rgba(94,138,110,0.08)" };
    if (pct >= -10)   return { label:"Stable",          color:"#8a7a4f", bg:"rgba(138,122,79,0.08)" };
    return                   { label:"Needs Attention", color:"#B86B63", bg:"rgba(184,107,99,0.08)" };
  })();

  // ── Hotel breakdown (range-based, hotels only — Direct shown separately) ────
  const analyticsHotels = Object.entries(HOTEL_DOT_COLORS).map(([name,color])=>({name,color}));
  const hotelRows = (aHotel==="All Hotels" ? analyticsHotels : analyticsHotels.filter(h=>h.name===aHotel))
    .map(h => {
      const ty = dedupShoots.filter(r => (r.date||"")>=thisStart && (r.date||"")<=thisEnd && r.hotel===h.name).length;
      const py = dedupShoots.filter(r => (r.date||"")>=prevStart && (r.date||"")<=prevEnd && r.hotel===h.name).length;
      const d=ty-py, p=py>0?Math.round((d/py)*100):null;
      const trend = d>0?"▲":d<0?"▼":"▬";
      const trendColor = d>0?"#4F8A5B":d<0?"#B86B63":"#9c9186";
      return { ...h, ty, py, d, p, trend, trendColor };
    })
    .filter(h=>h.ty>0||h.py>0)
    .sort((a,b)=>b.ty-a.ty);

  const directTy    = directFactor ? directThis.length : 0;
  const directPy    = directFactor ? directPrev.length : 0;
  const directD     = directTy-directPy;
  const directP     = directPy>0 ? Math.round((directD/directPy)*100) : null;
  // Hotel bars show hotels only — no Direct row mixed in
  const maxBarVal = Math.max(...hotelRows.flatMap(r => [r.ty, r.py]), 1);

  // ── Insights (use % for decline to avoid confusion with Top Hotel) ──────────
  const topHotel      = hotelRows[0] ?? null;
  // Biggest growth = highest positive absolute diff
  const biggestGrowth = [...hotelRows].filter(h=>h.d>0).sort((a,b)=>b.d-a.d)[0] ?? null;
  // Biggest decline = worst % change (most negative pct) — avoids showing Top Hotel as decline
  const biggestDecline = [...hotelRows]
    .filter(h=>h.p!==null && h.p<0)
    .sort((a,b)=>(a.p??0)-(b.p??0))[0] ?? null;

  // ── Monthly trend — SVG line chart (full year, respects hotel filter) ────────
  const monthlyShootCounts = React.useMemo(() => {
    const counts = Array(12).fill(0);
    dedupShoots.forEach(r => {
      if (!(r.date||"").startsWith(localYear)) return;
      if (aHotel!=="All Hotels" && r.hotel!==aHotel) return;
      const mo = parseInt((r.date||"").slice(5,7),10)-1;
      if (mo>=0&&mo<12) counts[mo]++;
    });
    if (aHotel==="All Hotels") dedupDirect.forEach(r => {
      if (!(r.date||"").startsWith(localYear)) return;
      const mo = parseInt((r.date||"").slice(5,7),10)-1;
      if (mo>=0&&mo<12) counts[mo]++;
    });
    return counts;
  }, [dedupShoots, dedupDirect, localYear, aHotel]);
  const sparkMax = Math.max(...monthlyShootCounts, 1);

  // ── Options ────────────────────────────────────────────────────────────────
  const compareOptions = ["Previous Year", "Same Period Last Year", "No Comparison"];
  const MODES = [
    { key:"fullyear" as const, label:"Full Year"    },
    { key:"ytd"      as const, label:"YTD"          },
    { key:"month"    as const, label:"This Month"   },
    { key:"last30"   as const, label:"Last 30 Days" },
  ];
  const last30 = mode === "last30";
  void last30;
  const selS: React.CSSProperties = {
    fontFamily:GROTESK, fontSize:"12px", fontWeight:500, color:"#1A1714",
    background:"rgba(255,255,255,0.7)", backdropFilter:"blur(12px)", WebkitBackdropFilter:"blur(12px)",
    border:`0.5px solid ${BR}`, borderRadius:8,
    padding:"6px 26px 6px 10px", appearance:"none", WebkitAppearance:"none", cursor:"pointer", outline:"none",
  };
  const kpiIcons = [Camera, Camera, TrendingUp, Coins, TrendingUp, Users, TrendingUp];

  return (
    <div className="dashboard-glass overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">

      {/* ── Header: title + 4 always-visible filter controls ── */}
      <div style={{ padding:"14px 22px 12px", borderBottom:`0.5px solid ${BR}` }}>

        {/* Title row */}
        <div className="flex items-center gap-2.5 mb-3">
          <div style={{ width:34, height:34, borderRadius:11, background:"rgba(255,255,255,0.75)", border:"1px solid rgba(255,255,255,0.6)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, boxShadow:"0 2px 10px rgba(15,23,42,0.07)" }}>
            <Camera size={15} strokeWidth={1.5} style={{ color:MUTED }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p style={{ fontFamily:GROTESK, fontSize:"15px", fontWeight:700, color:"#1A1714", lineHeight:1, letterSpacing:"-0.2px" }}>Shoot Analytics</p>
              {aHotel!=="All Hotels" && (
                <span style={{ fontFamily:MONO, fontSize:"7px", letterSpacing:"0.8px", background:"rgba(194,169,110,0.18)", color:"#8a6a20", borderRadius:4, padding:"2px 6px", textTransform:"uppercase" }}>{aHotel}</span>
              )}
            </div>
            <p style={{ fontFamily:MONO, fontSize:"7.5px", letterSpacing:"1px", color:MUTED, marginTop:2, textTransform:"uppercase" }}>{ranges.label}</p>
          </div>
        </div>

        {/* Filter row — Year · Period · Compare — always visible */}
        <div className="flex flex-wrap items-center gap-2">

          {/* Year selector */}
          <div style={{ position:"relative" }}>
            <select value={localYear} onChange={e=>setLocalYear(e.target.value)} style={selS}>
              {[...new Set([...(yearOptions.length>0?yearOptions:[]),"2022","2023","2024","2025","2026"])]
                .sort((a,b)=>Number(b)-Number(a))
                .map(y=><option key={y} value={y}>{y}</option>)}
            </select>
            <ChevronDown size={11} strokeWidth={1.5} style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", color:MUTED, pointerEvents:"none" }} />
          </div>

          {/* Period tabs */}
          <div style={{ display:"flex", background:"rgba(26,23,20,0.06)", borderRadius:10, padding:3, gap:2, flexWrap:"wrap" }}>
            {MODES.map(m => (
              <button key={m.key} onClick={()=>setMode(m.key)} style={{
                fontFamily:MONO, fontSize:"8.5px", letterSpacing:"0.8px", textTransform:"uppercase",
                padding:"5px 9px", borderRadius:7, border:"none", cursor:"pointer",
                background: mode===m.key ? "white" : "transparent",
                color:      mode===m.key ? "#1A1714" : MUTED,
                fontWeight: mode===m.key ? 600 : 400,
                boxShadow:  mode===m.key ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                transition:"all 0.15s ease",
              }}>{m.label}</button>
            ))}
          </div>

          {/* Compare selector — always visible */}
          <div style={{ position:"relative" }}>
            <select value={compareTo} onChange={e=>setCompareTo(e.target.value)} style={selS}>
              {compareOptions.map(o=><option key={o} value={o}>{o}</option>)}
            </select>
            <ChevronDown size={11} strokeWidth={1.5} style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", color:MUTED, pointerEvents:"none" }} />
          </div>

        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3 p-4"
        style={{ borderBottom:`0.5px solid ${BR}` }}>
        {([
          { label:"Shoots (this)", value:String(thisShoots),  sub:ranges.label,     color:"#1A1714",    mono:false, small:false, bg:"rgba(255,255,255,0.5)" },
          { label:"Shoots (prev)", value:noComparison?"—":String(prevShoots),  sub:noComparison?"—":ranges.prevLabel, color:"#6F6A64", mono:false, small:false, bg:"rgba(255,255,255,0.5)" },
          { label:"Change",        value:noComparison?"—":pct!==null?`${sgn(diff)}${pct}%`:`${sgn(diff)}${diff}`, sub:noComparison?"":(`${sgn(diff)}${diff} shoots`), color:noComparison?MUTED:dc(diff), mono:true, small:false, bg:"rgba(255,255,255,0.5)" },
          { label:"HT Revenue",    value:fmtK(thisHT)+" XPF", sub:noComparison?"":htPct!==null?`${sgn(htDiff)}${htPct}% vs prev`:"vs prev", color:"#1A1714", mono:false, small:false, bg:"rgba(255,255,255,0.5)" },
          { label:"Booking Pace",  value:`${thisPace.toFixed(2)}/d`, sub:noComparison?"":pacePct!==null?`${sgn(pacePct??0)}${pacePct}% vs prev`:`prev: ${prevPace.toFixed(2)}/d`, color:noComparison?MUTED:dc(pacePct??0), mono:true, small:false, bg:"rgba(255,255,255,0.5)" },
          { label:"Direct Clients",value:directFactor?String(thisDirectCt):"—",   sub:!noComparison&&directFactor&&dirPct!==null?`${sgn(dirDiff)}${dirPct}% vs prev`:"this period", color:dc(dirDiff), mono:false, small:false, bg:"rgba(255,255,255,0.5)" },
          { label:"Health Score",  value:health.label, sub:noComparison?"":pct!==null?`${sgn(diff)}${pct}% vs prev`:"not enough data", color:health.color, mono:false, small:true, bg:health.bg },
        ] as const).map((k,i) => (
          <div key={i} style={{ background:"rgba(255,255,255,0.72)", borderRadius:18, padding:"14px", border:"1px solid rgba(255,255,255,0.60)", boxShadow:"0 8px 28px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.70)" }}>
            <div style={{ width:36, height:36, borderRadius:11, background:"rgba(255,255,255,0.85)", border:"1px solid rgba(255,255,255,0.65)", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:10, boxShadow:"0 2px 8px rgba(15,23,42,0.05)", flexShrink:0 }}>
              {React.createElement(kpiIcons[i] as React.ElementType, { size:16, strokeWidth:1.6, style:{ color:"rgba(26,23,20,0.45)" } })}
            </div>
            <p style={{ fontFamily:MONO, fontSize:"7.5px", letterSpacing:"1.5px", color:MUTED, textTransform:"uppercase", marginBottom:5 }}>{k.label}</p>
            <p style={{ fontFamily:k.mono?MONO:GROTESK, fontSize:k.small?"15px":k.mono?"16px":"24px", fontWeight:700, color:k.color, lineHeight:1.1, wordBreak:"break-word" }}>{k.value}</p>
            <p style={{ fontFamily:MONO, fontSize:"7.5px", color:MUTED, marginTop:6 }}>{k.sub}</p>
          </div>
        ))}
      </div>

      {/* ── Main body ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
        style={{ borderBottom:`0.5px solid ${BR}` }}>

        {/* ── Hotel Performance ── */}
        <div style={{ padding:"16px 22px", borderRight:`0.5px solid ${BR}` }}>
          <div className="flex items-center justify-between" style={{ marginBottom:10 }}>
            <p style={{ fontFamily:MONO, fontSize:"8px", letterSpacing:"1.5px", color:MUTED, textTransform:"uppercase" }}>Hotel Performance</p>
            <div className="flex items-center gap-3">
              {[{bg:"#1A1714", opacity:0.7, lbl:"This"},{bg:"rgba(26,23,20,0.15)", opacity:1, lbl:"Prev"}].map((leg,li)=>(
                <div key={li} className="flex items-center gap-1">
                  <div style={{ width:10, height:4, borderRadius:2, background:leg.bg, opacity:leg.opacity }} />
                  <span style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase", letterSpacing:"0.8px" }}>{leg.lbl}</span>
                </div>
              ))}
            </div>
          </div>
          {hotelRows.length === 0 && (
            <p style={{ fontFamily:MONO, fontSize:"9px", color:MUTED, textTransform:"uppercase" }}>No data for selected filters</p>
          )}
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            {hotelRows.map(h => {
              const bp  = Math.min(100, Math.max(maxBarVal>0?(h.ty/maxBarVal)*100:0, h.ty>0?2:0));
              const pp  = Math.min(100, Math.max(maxBarVal>0?(h.py/maxBarVal)*100:0, h.py>0?2:0));
              return (
                <div key={h.name}>
                  <div className="flex items-center justify-between" style={{ marginBottom:2 }}>
                    <div className="flex items-center gap-1.5 min-w-0" style={{ flex:1 }}>
                      <span style={{ fontFamily:MONO, fontSize:"10px", color:h.trendColor, flexShrink:0, lineHeight:1 }}>{h.trend}</span>
                      <span style={{ width:5, height:5, borderRadius:"50%", background:h.color, flexShrink:0, display:"inline-block" }} />
                      <span style={{ fontFamily:GROTESK, fontSize:"11.5px", fontWeight:500, color:"#1A1714", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{h.name}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0" style={{ marginLeft:6 }}>
                      <span style={{ fontFamily:GROTESK, fontSize:"13px", fontWeight:700, color:"#1A1714", minWidth:18, textAlign:"right" }}>{h.ty}</span>
                      <span style={{ fontFamily:MONO, fontSize:"9.5px", color:"#9c9186", minWidth:16, textAlign:"right" }}>{h.py}</span>
                      <span style={{ fontFamily:MONO, fontSize:"9px", fontWeight:600, color:dc(h.d), minWidth:36, textAlign:"right" }}>
                        {h.p!==null?`${sgn(h.d)}${h.p}%`:h.d!==0?`${sgn(h.d)}${h.d}`:"—"}
                      </span>
                    </div>
                  </div>
                  <div style={{ position:"relative", height:4, background:"rgba(26,23,20,0.05)", borderRadius:99 }}>
                    {h.py>0 && <div style={{ position:"absolute", left:0, top:0, height:"100%", width:`${pp}%`, background:"rgba(26,23,20,0.14)", borderRadius:99 }} />}
                    <div style={{ position:"absolute", left:0, top:0, height:"100%", width:`${bp}%`, background:h.color, borderRadius:99, transition:"width 0.6s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right panel ── */}
        <div style={{ padding:"16px 22px", display:"flex", flexDirection:"column", gap:10 }}>

          {/* Forecast card */}
          {forecast && (
            <div style={{ background:"rgba(255,255,255,0.80)", borderRadius:14, padding:"10px 12px", border:"1px solid rgba(255,255,255,0.55)", boxShadow:"0 8px 24px rgba(15,23,42,0.07)" }}>
              <div className="flex items-center justify-between" style={{ marginBottom:6 }}>
                <span style={{ fontFamily:MONO, fontSize:"7.5px", letterSpacing:"1.2px", color:MUTED, textTransform:"uppercase" }}>Forecast</span>
                <span style={{ fontSize:10 }}>📈</span>
              </div>
              <div className="flex items-end gap-3">
                <div>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase" }}>Now</p>
                  <p style={{ fontFamily:GROTESK, fontSize:"18px", fontWeight:700, color:"#1A1714", lineHeight:1 }}>{forecast.current}</p>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED }}>shoots so far</p>
                </div>
                <div style={{ width:1, height:30, background:BR, flexShrink:0 }} />
                <div>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase" }}>Projected</p>
                  <p style={{ fontFamily:GROTESK, fontSize:"18px", fontWeight:700, color:"#4F8A5B", lineHeight:1 }}>{forecast.projected}</p>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED }}>{forecast.label}</p>
                </div>
                <div style={{ flex:1, textAlign:"right" }}>
                  <p style={{ fontFamily:MONO, fontSize:"7.5px", color:MUTED }}>{forecast.daysLeft}d left</p>
                </div>
              </div>
            </div>
          )}

          {/* Booking pace */}
          <div style={{ background:"rgba(255,255,255,0.80)", borderRadius:14, padding:"10px 12px", border:"1px solid rgba(255,255,255,0.55)", boxShadow:"0 8px 24px rgba(15,23,42,0.07)" }}>
            <p style={{ fontFamily:MONO, fontSize:"7.5px", letterSpacing:"1.2px", color:MUTED, textTransform:"uppercase", marginBottom:6 }}>Booking Pace</p>
            <div className="flex items-center gap-3">
              <div>
                <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase" }}>This</p>
                <p style={{ fontFamily:GROTESK, fontSize:"16px", fontWeight:700, color:"#1A1714" }}>{thisPace.toFixed(2)}</p>
                <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED }}>shoots/day</p>
              </div>
              <div style={{ width:1, height:28, background:BR, flexShrink:0 }} />
              <div>
                <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase" }}>Prev</p>
                <p style={{ fontFamily:GROTESK, fontSize:"16px", fontWeight:700, color:"#6F6A64" }}>{prevPace.toFixed(2)}</p>
                <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED }}>shoots/day</p>
              </div>
              {pacePct !== null && (
                <div style={{ marginLeft:"auto" }}>
                  <span style={{ fontFamily:MONO, fontSize:"12px", fontWeight:700, color:dc(pacePct) }}>{sgn(pacePct)}{pacePct}%</span>
                </div>
              )}
            </div>
          </div>

          {/* Direct clients detail */}
          {directFactor && (
            <div style={{ background:"rgba(255,255,255,0.80)", borderRadius:14, padding:"10px 12px", border:"1px solid rgba(255,255,255,0.55)", boxShadow:"0 8px 24px rgba(15,23,42,0.07)" }}>
              <p style={{ fontFamily:MONO, fontSize:"7.5px", letterSpacing:"1.2px", color:MUTED, textTransform:"uppercase", marginBottom:6 }}>Direct Clients</p>
              <div className="flex items-center gap-3">
                <div>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase" }}>This</p>
                  <p style={{ fontFamily:GROTESK, fontSize:"16px", fontWeight:700, color:"#1A1714" }}>{thisDirectCt}</p>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED }}>{fmtK(thisDirectRev)} XPF</p>
                </div>
                <div style={{ width:1, height:28, background:BR, flexShrink:0 }} />
                <div>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase" }}>Prev</p>
                  <p style={{ fontFamily:GROTESK, fontSize:"16px", fontWeight:700, color:"#6F6A64" }}>{prevDirectCt}</p>
                  <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED }}>{fmtK(prevDirectRev)} XPF</p>
                </div>
                {dirPct !== null && (
                  <div style={{ marginLeft:"auto", textAlign:"right" }}>
                    <p style={{ fontFamily:MONO, fontSize:"12px", fontWeight:700, color:dc(dirDiff) }}>{sgn(dirDiff)}{dirPct}%</p>
                    <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED }}>{sgn(drDiff)}{fmtK(drDiff)} XPF</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 2×2 insight cards */}
          <div className="grid grid-cols-2 gap-1.5">
            {([
              { icon:"🏆", label:"Top Hotel",
                name:topHotel?.name??"—",
                stat:topHotel?`${topHotel.ty} shoots this period`:"",
                sc:"#1A1714" },
              { icon:"📈", label:"Biggest Growth",
                name:biggestGrowth?.name??"—",
                stat:biggestGrowth?`+${biggestGrowth.d} shoots (+${biggestGrowth.p??0}%)`:"No growth this period",
                sc:"#4F8A5B" },
              { icon:"📉", label:"Biggest Decline",
                name:biggestDecline?.name??"—",
                stat:biggestDecline?`${biggestDecline.p??0}% vs prev (${biggestDecline.d})`:
                     topHotel&&topHotel.d<0?"All hotels declining":"No declines",
                sc:"#B86B63" },
              { icon:"👤", label:"Direct Clients",
                name:directFactor?String(thisDirectCt):"—",
                stat:directFactor&&dirPct!==null?`${sgn(dirDiff)}${dirPct}% vs prev period`:"select All Hotels",
                sc:dc(dirDiff) },
            ] as const).map((ins,ii) => (
              <div key={ii} style={{ background:"rgba(255,255,255,0.80)", borderRadius:12, padding:"8px 10px", border:"1px solid rgba(255,255,255,0.55)", boxShadow:"0 6px 18px rgba(15,23,42,0.07)" }}>
                <div className="flex items-center gap-1" style={{ marginBottom:2 }}>
                  <span style={{ fontSize:9 }}>{ins.icon}</span>
                  <span style={{ fontFamily:MONO, fontSize:"6.5px", letterSpacing:"1px", color:MUTED, textTransform:"uppercase" }}>{ins.label}</span>
                </div>
                <p style={{ fontFamily:GROTESK, fontSize:"12px", fontWeight:700, color:"#1A1714", lineHeight:1.2, wordBreak:"break-word" }}>{ins.name}</p>
                <p style={{ fontFamily:MONO, fontSize:"8px", color:ins.sc, marginTop:1 }}>{ins.stat}</p>
              </div>
            ))}
          </div>

          {/* Monthly line chart */}
          <div style={{ background:"rgba(255,255,255,0.80)", borderRadius:12, padding:"10px 12px", border:"1px solid rgba(255,255,255,0.55)", boxShadow:"0 6px 18px rgba(15,23,42,0.07)" }}>
            <p style={{ fontFamily:MONO, fontSize:"7.5px", letterSpacing:"1px", color:MUTED, textTransform:"uppercase", marginBottom:6 }}>Monthly Trend — {localYear}</p>
            <div style={{ position:"relative" }}>
              {/* SVG line chart */}
              <svg viewBox="0 0 240 48" style={{ width:"100%", height:48, display:"block", overflow:"visible" }}>
                {/* Zero baseline */}
                <line x1="0" y1="44" x2="240" y2="44" stroke="rgba(26,23,20,0.06)" strokeWidth="0.5"/>
                {/* Area fill */}
                {sparkMax > 0 && (
                  <path
                    d={[
                      ...monthlyShootCounts.map((v,i) => {
                        const x = i/(12-1)*232+4;
                        const y = 4 + (1-(v/sparkMax))*40;
                        return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`;
                      }),
                      `L${(11/(12-1)*232+4).toFixed(1)},44`,
                      `L4,44 Z`
                    ].join(' ')}
                    fill="rgba(26,23,20,0.05)"
                  />
                )}
                {/* Line */}
                {sparkMax > 0 && (
                  <polyline
                    points={monthlyShootCounts.map((v,i) => {
                      const x = i/(12-1)*232+4;
                      const y = 4 + (1-(v/sparkMax))*40;
                      return `${x.toFixed(1)},${y.toFixed(1)}`;
                    }).join(' ')}
                    fill="none" stroke="#1A1714" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"
                  />
                )}
                {/* Data points */}
                {monthlyShootCounts.map((v,i) => {
                  const x = i/(12-1)*232+4;
                  const y = 4 + (sparkMax>0?(1-(v/sparkMax))*40:40);
                  const cur = String(now.getFullYear())===aYear && now.getMonth()===i;
                  return (
                    <g key={i}>
                      {v > 0 && <circle cx={x} cy={y} r={cur?3.5:2} fill={cur?"#c2a96e":"white"} stroke={cur?"#c2a96e":"#1A1714"} strokeWidth="1.2"/>}
                      {/* Month labels */}
                      <text x={x} y="48" textAnchor="middle" fontSize="6" fill={cur?"#c2a96e":MUTED} fontFamily={MONO}>{MO_SHORT[i]}</text>
                      {/* Value labels for non-zero */}
                      {v > 0 && <text x={x} y={y-5} textAnchor="middle" fontSize="6" fill={cur?"#c2a96e":"#6F6A64"} fontFamily={MONO}>{v}</text>}
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between flex-wrap gap-2" style={{ padding:"8px 22px" }}>
        <p style={{ fontFamily:MONO, fontSize:"7.5px", letterSpacing:"0.8px", color:MUTED, textTransform:"uppercase" }}>
          {ranges.label} · {thisShoots} shoots{!noComparison && ` · ${sgn(diff)}${diff} vs prev${pct!==null?` (${sgn(diff)}${pct}%)`:""}` }
          {" · "}HT: {fmtK(thisHT)} XPF{!noComparison && htPct!==null ? ` (${sgn(htDiff)}${htPct}%)` : ""}
          {" · "}TTC: {fmtK(thisTTC)} XPF
        </p>
        <p style={{ fontFamily:MONO, fontSize:"7px", color:MUTED, textTransform:"uppercase", letterSpacing:"0.8px" }}>Deduped photoshoots</p>
      </div>
    </div>
  );
}

// ─── Debug Panel ──────────────────────────────────────────────────────────────
function DebugPanel({ shoots, directIncome, savedInvoices, dashboardYear, dashboardMonth, dashboardHotel, filteredDirectAll }: {
  shoots: Shoot[];
  directIncome: DirectRow[];
  savedInvoices: unknown[];
  dashboardYear: string;
  dashboardMonth: string;
  dashboardHotel: string;
  filteredDirectAll: DirectRow[];
}) {
  const MONO: React.CSSProperties = { fontFamily: "'DM Mono', monospace" };
  const cell: React.CSSProperties = { ...MONO, fontSize: 11, padding: "4px 8px", borderBottom: "1px solid #e7e2dc", whiteSpace: "nowrap", verticalAlign: "top" };
  const hcell: React.CSSProperties = { ...cell, fontSize: 9, textTransform: "uppercase", letterSpacing: "1.3px", color: "#9c9186", fontWeight: 600, background: "#faf8f5" };

  // Per-row parser output
  const perRow = directIncome.map(r => {
    const origDate  = String(r.date ?? "");
    const origAmt   = r.amount;
    const parsedYr  = yearFromMonth(monthKey(origDate)) || "—";
    const parsedAmt = parseAmount(origAmt);
    return { id: r.id, origDate, client: r.client, income: r.income, origAmt, parsedYr, parsedAmt, badDate: parsedYr === "—", badAmt: parsedAmt === 0 && String(origAmt ?? "").trim() !== "" && String(origAmt ?? "").trim() !== "0" };
  });

  // By year
  const byYear: Record<string, { count: number; amount: number }> = {};
  perRow.forEach(r => {
    if (r.parsedYr === "—") return;
    if (!byYear[r.parsedYr]) byYear[r.parsedYr] = { count: 0, amount: 0 };
    byYear[r.parsedYr].count++;
    byYear[r.parsedYr].amount += r.parsedAmt;
  });

  const rows2022  = perRow.filter(r => r.parsedYr === "2022").slice(0, 20);
  const rows2025  = perRow.filter(r => r.parsedYr === "2025").slice(0, 20);
  const badDates  = perRow.filter(r => r.badDate);
  const badAmts   = perRow.filter(r => r.badAmt);

  const SH = { fontFamily: "'DM Mono', monospace", fontSize: 9, letterSpacing: "1.5px", textTransform: "uppercase" as const, color: "#9c9186", marginBottom: 6, marginTop: 20 };
  const Th = (p: { children: React.ReactNode }) => <th style={hcell}>{p.children}</th>;
  const Td = (p: { children: React.ReactNode; warn?: boolean }) => <td style={{ ...cell, color: p.warn ? "#c2410c" : "#1A1714" }}>{p.children}</td>;

  function DataTable({ rows }: { rows: typeof perRow }) {
    if (!rows.length) return <p style={{ ...MONO, fontSize: 10, color: "#9c9186", marginTop: 4 }}>No rows.</p>;
    return (
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead><tr><Th>id</Th><Th>original date</Th><Th>parsed year</Th><Th>client</Th><Th>income</Th><Th>original amount</Th><Th>parsed amount</Th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id} style={{ background: r.badDate || r.badAmt ? "rgba(253,186,116,0.15)" : "transparent" }}>
              <Td>{r.id}</Td>
              <Td warn={r.badDate}>{r.origDate || "(empty)"}</Td>
              <Td warn={r.badDate}>{r.parsedYr}</Td>
              <Td>{r.client || "(empty)"}</Td>
              <Td>{r.income}</Td>
              <Td warn={r.badAmt}>{String(r.origAmt)}</Td>
              <Td>{r.parsedAmt}</Td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 0", maxWidth: 1100 }}>
      {/* ── DATA SOURCE ─────────────────────────────────────────────────── */}
      <p style={{ ...SH, marginTop: 0 }}>Data Source</p>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {[
          { label: "Shoots loaded", value: shoots.length },
          { label: "Direct rows loaded", value: directIncome.length },
          { label: "Invoices saved", value: (savedInvoices as unknown[]).length },
        ].map(item => (
          <div key={item.label} style={{ background: "#fff", border: "1px solid #e7e2dc", borderRadius: 12, padding: "12px 20px", minWidth: 160 }}>
            <p style={{ ...MONO, fontSize: 9, letterSpacing: "1.2px", textTransform: "uppercase", color: "#9c9186" }}>{item.label}</p>
            <p style={{ ...MONO, fontSize: 28, fontWeight: 700, color: "#1A1714", lineHeight: 1.2, marginTop: 4 }}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* ── DIRECT BY YEAR ──────────────────────────────────────────────── */}
      <p style={SH}>Direct Data Analysis — by year</p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: 360 }}>
          <thead><tr><Th>year</Th><Th>row count</Th><Th>total amount (USD)</Th></tr></thead>
          <tbody>
            {(["2022","2023","2024","2025","2026"] as const).map(yr => {
              const d = byYear[yr] ?? { count: 0, amount: 0 };
              return (
                <tr key={yr} style={{ background: yr === dashboardYear ? "rgba(245,200,74,0.12)" : "transparent" }}>
                  <td style={{ ...cell, fontWeight: yr === dashboardYear ? 700 : 400 }}>{yr} {yr === dashboardYear ? "← selected" : ""}</td>
                  <td style={cell}>{d.count}</td>
                  <td style={cell}>${d.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── FILTER DEBUG ────────────────────────────────────────────────── */}
      <p style={SH}>Filter Debug</p>
      <div style={{ background: "#fff", border: "1px solid #e7e2dc", borderRadius: 12, padding: "14px 18px" }}>
        <p style={{ ...MONO, fontSize: 11, color: "#1A1714", marginBottom: 6 }}>
          Current filters: year=<b>{dashboardYear}</b> month=<b>{dashboardMonth}</b> hotel=<b>{dashboardHotel}</b>
        </p>
        <p style={{ ...MONO, fontSize: 11, color: "#1A1714" }}>
          Rows before filter: <b>{directIncome.length}</b>
        </p>
        <p style={{ ...MONO, fontSize: 11, color: "#1A1714" }}>
          Rows after filter (filteredDirectAll): <b>{filteredDirectAll.length}</b>
        </p>
        <p style={{ ...MONO, fontSize: 11, color: "#1A1714" }}>
          Total amount after filter: <b>${filteredDirectAll.reduce((s, r) => s + parseAmount(r.amount), 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
        </p>
      </div>

      {/* ── FIRST 20 FROM 2022 ──────────────────────────────────────────── */}
      <p style={SH}>First 20 Direct rows parsed as 2022 ({perRow.filter(r => r.parsedYr === "2022").length} total)</p>
      <DataTable rows={rows2022} />

      {/* ── FIRST 20 FROM 2025 ──────────────────────────────────────────── */}
      <p style={SH}>First 20 Direct rows parsed as 2025 ({perRow.filter(r => r.parsedYr === "2025").length} total)</p>
      <DataTable rows={rows2025} />

      {/* ── INVALID DATES ───────────────────────────────────────────────── */}
      <p style={{ ...SH, color: badDates.length ? "#c2410c" : "#9c9186" }}>
        Rows with unparseable date ({badDates.length})
      </p>
      <DataTable rows={badDates} />

      {/* ── INVALID AMOUNTS ─────────────────────────────────────────────── */}
      <p style={{ ...SH, color: badAmts.length ? "#c2410c" : "#9c9186" }}>
        Rows with unparseable amount ({badAmts.length})
      </p>
      <DataTable rows={badAmts} />

      {/* ── FULL PARSER TABLE ───────────────────────────────────────────── */}
      <p style={SH}>Full parser output — all {perRow.length} Direct rows</p>
      <DataTable rows={perRow} />
    </div>
  );
}

function Dashboard({ years, year, setYear, hotel, setHotel, month, setMonth, monthlyData, timelineData, shoots, directIncome, allShoots, allDirectIncome, stats, calendarEvents }: DashboardProps) {
  const [showDebug, setShowDebug] = React.useState(false);
  const packageRows = groupSum(shoots, "photoPackage", "count");
  const hotelRows = groupSum(shoots, "hotel", "ht");
  const directRows = groupSum(directIncome, "income", "amount");
  const directClientRows = groupSum(directIncome, "client", "amount");
  const directBookingCount = shoots.filter(row => row.source !== "Resort").length;
  const resortBookingCount = shoots.filter(row => row.source === "Resort").length;
  const hotelSessionRows = DASHBOARD_HOTELS.map(name => ({ label: name, value: shoots.filter(row => row.hotel === name).length }));

  // Debug stats — computed from allDirectIncome (full unfiltered set)
  const debugStats = React.useMemo(() => {
    const byYear: Record<string, { count: number; amount: number }> = {};
    const badDate: { id: number; rawDate: string }[] = [];
    const badAmount: { id: number; date: string; rawAmount: unknown }[] = [];
    allDirectIncome.forEach(r => {
      const rawDate = String(r.date ?? "").trim();
      const y = yearFromMonth(monthKey(rawDate));
      if (!y) {
        badDate.push({ id: r.id, rawDate });
      } else {
        if (!byYear[y]) byYear[y] = { count: 0, amount: 0 };
        byYear[y].count++;
        byYear[y].amount += parseAmount(r.amount);
      }
      const rawAmt = String(r.amount ?? "").trim();
      if (parseAmount(r.amount) === 0 && rawAmt !== "" && rawAmt !== "0") {
        badAmount.push({ id: r.id, date: rawDate, rawAmount: r.amount });
      }
    });
    return { byYear, badDate, badAmount };
  }, [allDirectIncome]);

  return (
    <div className="dashboard-page-glass space-y-4">
      {/* Editorial filter bar */}
      <div className="dashboard-glass flex flex-col items-center gap-3 mt-6 md:mt-8 px-5 py-4 md:flex-row md:justify-center md:flex-wrap">
        {/* Label */}
        <span className="flex items-center gap-1.5" style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", letterSpacing: "2px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase" }}>
          <SlidersHorizontal size={12} strokeWidth={1.5} style={{ color: "rgba(26,23,20,0.4)" }} />
          Filters
        </span>

        {/* Controls — stacked on mobile, horizontal row on md+ */}
        <div className="flex flex-col md:flex-row md:flex-wrap items-stretch md:items-center justify-center gap-2 md:gap-4 w-full md:w-auto max-w-xs md:max-w-none">

          {/* Hotels */}
          <div className="relative w-full md:w-auto">
            <select
              value={hotel}
              onChange={e => setHotel(e.target.value)}
              className="w-full md:w-auto"
              style={{ height: 44, padding: "0 36px 0 16px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.65)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", fontSize: 13, fontWeight: 500, color: "#1A1714", fontFamily: "'Hanken Grotesk', sans-serif", cursor: "pointer", appearance: "none", outline: "none" }}
            >
              <option value="All Hotels">All Hotels</option>
              {HOTELS.map(h => <option key={h} value={h}>{h}</option>)}
              {["Tips", "Extra Photos", "Prints"].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-2.5 w-2.5" style={{ color: "rgba(26,23,20,0.4)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>

          {/* Year */}
          <div className="relative w-full md:w-auto">
            <select
              value={year}
              onChange={e => setYear(e.target.value)}
              className="w-full md:w-auto"
              style={{ height: 44, padding: "0 36px 0 16px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.65)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", fontSize: 13, fontWeight: 500, color: "#1A1714", fontFamily: "'Hanken Grotesk', sans-serif", cursor: "pointer", appearance: "none", outline: "none" }}
            >
              <option value="All">All Years</option>
              {Array.from(new Set(years)).sort((a, b) => Number(b) - Number(a)).map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-2.5 w-2.5" style={{ color: "rgba(26,23,20,0.4)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>

          {/* Month */}
          <div className="relative w-full md:w-auto">
            <select
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="w-full md:w-auto"
              style={{ height: 44, padding: "0 36px 0 16px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.65)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", fontSize: 13, fontWeight: 500, color: "#1A1714", fontFamily: "'Hanken Grotesk', sans-serif", cursor: "pointer", appearance: "none", outline: "none" }}
            >
              <option value="All">All Months</option>
              {MONTH_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l.slice(0, 3)}</option>)}
            </select>
            <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-2.5 w-2.5" style={{ color: "rgba(26,23,20,0.4)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>

          {/* Session count + clear — always in a row */}
          <div className="flex items-center justify-center gap-3">
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", letterSpacing: "1px", textTransform: "uppercase", color: "#B0902F" }}>{shoots.length} Sessions</span>
            {(hotel !== "All Hotels" || year !== "All" || month !== "All") && (
              <button
                onClick={() => { setHotel("All Hotels"); setYear("All"); setMonth("All"); }}
                style={{ fontSize: 12, color: "rgba(26,23,20,0.4)", background: "none", border: "none", cursor: "pointer", textDecoration: "none" }}
                onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
                onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}
              >Clear</button>
            )}
          </div>

        </div>
      </div>

      <CalendarAnalyticsCard
        allShoots={allShoots}
        allDirectIncome={allDirectIncome}
        activeHotel={hotel}
        activeYear={year}
        availableYears={years}
      />

      {/* Charts grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card><PanelTitle title="Photo packages" subtitle="Total orders" icon={<BarChart2 size={16} strokeWidth={1.5} className="text-stone-500" />} /><VerticalBarChart rows={packageRows} valueLabel="sessions" multiColor /></Card>
        <Card><PanelTitle title="Hotels" subtitle="HT sales" icon={<Building2 size={16} strokeWidth={1.5} className="text-stone-500" />} /><VerticalBarChart rows={hotelRows} moneyMode /></Card>
      </div>
      {/* Revenue Overview — uses ALL data, unaffected by dashboard filters */}
        <RevenueOverviewChart shoots={allShoots} directIncome={allDirectIncome} years={years} />
        {/* Lower grid — 1 col mobile, 2 tablet, 4 wide */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card><PanelTitle title="Hotel sessions" subtitle="By resort" icon={<Building2 size={16} strokeWidth={1.5} className="text-stone-500" />} /><HotelSessionCards rows={hotelSessionRows} /></Card>
          <Card><PanelTitle title="Direct clients" subtitle="By client" icon={<Users size={16} strokeWidth={1.5} className="text-stone-500" />} /><MiniBarList rows={directClientRows} moneyMode usdMode /></Card>
          <Card><PanelTitle title="Direct / Extra earnings" subtitle="By source" icon={<Receipt size={16} strokeWidth={1.5} className="text-stone-500" />} /><VerticalBarChart rows={directRows} moneyMode usdMode accent /></Card>
          <Card>
            <PanelTitle title="Direct vs Resort" subtitle="Booking source" icon={<BarChart2 size={16} strokeWidth={1.5} className="text-stone-500" />} />
            <div className="grid grid-cols-2 gap-3 p-4 pt-1">
              <CountBlock label="Direct" value={directBookingCount} />
              <CountBlock label="Resort" value={resortBookingCount} />
            </div>
          </Card>
        </div>

      {/* ── Direct Income Debug Panel ─────────────────────────────────────── */}
      <div className="dashboard-glass overflow-hidden" style={{ borderRadius:16 }}>
        <button
          onClick={() => setShowDebug(v => !v)}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: "9px", letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(26,23,20,0.45)" }}
        >
          <span>Direct Income Debug · {allDirectIncome.length} total rows loaded · {directIncome.length} visible (year={year})</span>
          <span style={{ fontSize: 10 }}>{showDebug ? "▲" : "▼"}</span>
        </button>
        {showDebug && (
          <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
            {/* By year */}
            <div>
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "8px", letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(26,23,20,0.4)", marginBottom: 6 }}>By Year (all rows)</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
                {Object.entries(debugStats.byYear).sort(([a],[b]) => a.localeCompare(b)).map(([yr, s]) => (
                  <span key={yr} style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: yr === year ? "#B0902F" : "rgba(26,23,20,0.6)", fontWeight: yr === year ? 700 : 400 }}>
                    {yr}: {s.count} rows · ${s.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </span>
                ))}
                {Object.keys(debugStats.byYear).length === 0 && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "rgba(26,23,20,0.4)" }}>No rows with valid dates</span>}
              </div>
            </div>
            {/* Filtered */}
            <div>
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "8px", letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(26,23,20,0.4)", marginBottom: 4 }}>
                Filtered rows (year={year}, month={month}): {directIncome.length} rows · ${directIncome.reduce((s, r) => s + parseAmount(r.amount), 0).toLocaleString("en-US", { maximumFractionDigits: 0 })} total
              </p>
            </div>
            {/* Bad dates */}
            {debugStats.badDate.length > 0 && (
              <div>
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "8px", letterSpacing: "1.5px", textTransform: "uppercase", color: "#d97706", marginBottom: 4 }}>
                  Invalid/unparseable dates ({debugStats.badDate.length} rows):
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {debugStats.badDate.slice(0, 10).map(b => (
                    <span key={b.id} style={{ fontFamily: "'DM Mono', monospace", fontSize: "9px", background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.4)", borderRadius: 6, padding: "2px 6px", color: "#92400e" }}>
                      id={b.id} "{b.rawDate || "(empty)"}"
                    </span>
                  ))}
                  {debugStats.badDate.length > 10 && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "9px", color: "rgba(26,23,20,0.4)" }}>+{debugStats.badDate.length - 10} more</span>}
                </div>
              </div>
            )}
            {/* Bad amounts */}
            {debugStats.badAmount.length > 0 && (
              <div>
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "8px", letterSpacing: "1.5px", textTransform: "uppercase", color: "#d97706", marginBottom: 4 }}>
                  Unparseable amounts ({debugStats.badAmount.length} rows):
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {debugStats.badAmount.slice(0, 8).map(b => (
                    <span key={b.id} style={{ fontFamily: "'DM Mono', monospace", fontSize: "9px", background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.4)", borderRadius: 6, padding: "2px 6px", color: "#92400e" }}>
                      id={b.id} {b.date} "{String(b.rawAmount)}"
                    </span>
                  ))}
                </div>
              </div>
            )}
            {debugStats.badDate.length === 0 && debugStats.badAmount.length === 0 && (
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "9px", color: "rgba(26,23,20,0.4)" }}>All rows have valid dates and amounts.</p>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

function FilterMenu({ title, children }: { title: string; children: React.ReactNode }) { return <div><p className="mb-2.5 text-[10px] uppercase tracking-[0.28em] text-stone-400">{title}</p>{children}</div>; }
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <div className={`dashboard-glass transition-transform duration-200 hover:-translate-y-0.5 ${className}`}>{children}</div>; }
function PanelTitle({ title, subtitle, icon }: { title: string; subtitle: string; icon?: React.ReactNode }) { return <div className="p-5 pb-3 flex items-start gap-3">{icon && <div style={{ width:38, height:38, borderRadius:11, background:"rgba(255,255,255,0.80)", border:"1px solid rgba(255,255,255,0.65)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, boxShadow:"0 2px 10px rgba(15,23,42,0.07)", marginTop:1 }}>{icon}</div>}<div><p style={{ fontSize:"9px", letterSpacing:"2px", textTransform:"uppercase", color:"rgba(26,23,20,0.4)", fontWeight:500, marginBottom:3 }}>{subtitle}</p><h3 style={{ fontSize:"19px", fontWeight:700, color:"#1A1714", letterSpacing:"-0.3px", lineHeight:1.2, margin:0 }}>{title}</h3></div></div>; }
function CountBlock({ label, value }: { label: string; value: number }) { return <div className="dashboard-glass p-5 text-center transition-transform duration-200 hover:-translate-y-0.5"><p className="text-[10px] uppercase tracking-[0.2em] text-stone-400">{label}</p><p className="mt-2 text-4xl font-bold text-stone-900">{value}</p></div>; }
function DarkMiniKpi({ title, value, suffix = "XPF", color = "bg-white/5" }: { title: string; value: number; suffix?: string; color?: string }) {
  return <div className={`${color} rounded-3xl border border-white/10 p-4`}><p className="text-[10px] uppercase tracking-[0.22em] text-white/45">{title}</p><div className="mt-2 flex items-end gap-1"><span className="text-xl font-light tracking-tight text-white/90">{numberOnly(value)}</span><span className="pb-0.5 text-[10px] uppercase tracking-[0.15em] text-white/35">{suffix}</span></div></div>;
}
function StatCard({ title, value, color }: { title: string; value: string; color: string }) { return <div className={`${color} rounded-[22px] border border-white/40 p-4`}><p className="text-[10px] uppercase tracking-[0.2em] text-stone-500">{title}</p><p className="mt-2 text-lg font-semibold tracking-tight text-stone-900">{value}</p></div>; }

function MiniStatBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.min(Math.round((value / Math.max(max, 1)) * 100), 100);
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400">{label}</span>
        <span className="text-xs font-semibold text-stone-700">{pct}%</span>
      </div>
      <div className="mt-1.5 h-6 w-28 overflow-hidden rounded-full bg-stone-200/60">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function BigKpi({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-white/70 border border-stone-200 text-base shadow-sm">{icon}</div>
      <div>
        <p className="text-2xl font-bold tracking-tight leading-none">{value}</p>
        <p className="text-[10px] uppercase tracking-[0.2em] text-stone-400">{label}</p>
      </div>
    </div>
  );
}
function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button onClick={onClick} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${active ? "bg-stone-900 text-white shadow-sm" : "bg-stone-100 text-stone-500 hover:bg-stone-200 hover:text-stone-900"}`}>{children}</button>; }
function SideButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button onClick={onClick} className={`mb-1 block w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium transition ${active ? "text-stone-900 shadow-sm" : "text-stone-500 hover:bg-stone-100 hover:text-stone-900"}`} style={active ? { background: "#f5c84a" } : {}}>{children}</button>; }
function DashboardCard({ title, value, main = false }: { title: string; value: number; main?: boolean }) { return <div className={`rounded-[20px] p-4 shadow-sm ${main ? "text-stone-900" : "border border-stone-200/60 bg-white/80 text-stone-900"}`} style={main ? { background: "#f5c84a" } : {}}><p className={`text-[10px] uppercase tracking-[0.24em] ${main ? "text-stone-600" : "text-stone-400"}`}>{title}</p><div className="mt-3 flex items-end gap-1"><span className={`${main ? "text-3xl" : "text-2xl"} font-bold tracking-tight`}>{numberOnly(value)}</span><span className={`${main ? "text-stone-600" : "text-stone-400"} pb-0.5 text-[10px] uppercase tracking-[0.12em]`}>XPF</span></div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1 block text-[10px] uppercase tracking-[0.2em] text-stone-400">{label}</span>{children}</label>; }
function Input({ value, onChange, type = "text", placeholder = "" }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) { return <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} className="w-full rounded-xl border border-stone-200/70 bg-white/80 px-3 py-2 text-sm outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100" />; }
function Select({ value, options, onChange, labels = {} }: { value: string; options: string[]; onChange: (v: string) => void; labels?: Record<string, string> }) { return <select value={value} onChange={e => onChange(e.target.value)} className="w-full rounded-xl border border-stone-200/70 bg-white/80 px-3 py-2 text-sm outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100">{options.map(option => <option key={option} value={option}>{labels[option] || option}</option>)}</select>; }
function Badge({ children }: { children: React.ReactNode }) { return <span className="inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">{children}</span>; }
function Section({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) { const bg = tone === "client" ? "bg-white/80 border border-stone-200/60" : tone === "details" ? "bg-amber-50/70 border border-amber-200/40" : "bg-stone-50/70 border border-stone-200/40"; return <div className={`${bg} rounded-[20px] p-4`}><p className="mb-3 text-[10px] uppercase tracking-[0.2em] text-stone-400">{title}</p>{children}</div>; }

function HotelSessionCards({ rows }: { rows: GroupRow[] }) { return <div className="grid grid-cols-2 gap-2 p-4 pt-1">{rows.map(row => <div key={row.label} className="dashboard-glass p-3 text-center transition-transform duration-200 hover:-translate-y-0.5"><p className="text-[10px] font-medium text-stone-500 truncate">{row.label}</p><p className="mt-1.5 text-2xl font-bold text-stone-900">{row.value}</p><p className="text-[10px] uppercase tracking-[0.18em] text-stone-400">shoots</p></div>)}</div>; }
function MiniBarList({ rows, moneyMode = false, usdMode = false }: { rows: GroupRow[]; moneyMode?: boolean; usdMode?: boolean }) { if (!rows.length) return <div className="px-4 pb-4 text-sm text-stone-400">No data yet.</div>; const max = Math.max(...rows.map(r => r.value), 1); return <div className="space-y-2.5 p-4 pt-1">{rows.slice(0, 6).map(row => <div key={row.label}><div className="mb-1 flex justify-between gap-3 text-xs"><span className="truncate text-stone-600">{row.label}</span><strong className="text-stone-800">{moneyMode ? (usdMode ? usd(row.value) : money(row.value)) : row.value}</strong></div><div className="h-1.5 rounded-full bg-stone-100"><div className="h-1.5 rounded-full" style={{ width: `${Math.max((row.value / max) * 100, 6)}%`, background: "#f5c84a" }} /></div></div>)}</div>; }
function LineChart({ data }: { data: { month: string; revenue: number }[] }) { void data; return null; }

const MULTI_BAR_PALETTE = [
  { from: "#f5c84a", to: "#e8a820" },
  { from: "#e8c49a", to: "#c9995e" },
  { from: "#d4c5b0", to: "#b8a68e" },
  { from: "#f0d9b0", to: "#d4aa70" },
  { from: "#c8b89a", to: "#a89070" },
  { from: "#ead5a8", to: "#c8a85c" },
];
function VerticalBarChart({ rows, moneyMode = false, usdMode = false, valueLabel = "", accent = false, multiColor = false }: { rows: GroupRow[]; moneyMode?: boolean; usdMode?: boolean; valueLabel?: string; accent?: boolean; multiColor?: boolean }) {
  void usdMode;
  if (!rows.length) return <div className="px-4 pb-4 text-sm text-stone-400">No data yet.</div>;
  const shown = rows.slice(0, 6);
  const max = Math.max(...shown.map(r => toNumber(r.value)), 1);
  const MAX_BAR_PX = 160;
  return (
    <div className="px-5 pb-5 pt-2">
      <div className="flex items-end gap-2 px-1" style={{ height: `${MAX_BAR_PX + 28}px` }}>
        {shown.map((row, index) => {
          const barPx = Math.max(Math.round((toNumber(row.value) / max) * MAX_BAR_PX), 12);
          const palette = MULTI_BAR_PALETTE[index % MULTI_BAR_PALETTE.length];
          const gradient = multiColor
            ? `linear-gradient(to bottom, ${palette.from}, ${palette.to})`
            : accent
            ? "linear-gradient(to bottom, #f5c84a, #e8a820)"
            : index === 0
            ? "linear-gradient(to bottom, #f5c84a, #e8a820)"
            : "linear-gradient(to bottom, #e5ddd0, #cfc5b4)";
          return (
            <div key={row.label} className="flex flex-1 flex-col items-center justify-end gap-2">
              <span className="text-[11px] font-bold text-stone-700 leading-none tabular-nums">
                {moneyMode ? compactMoney(row.value) : row.value}
              </span>
              <div
                className="w-full rounded-2xl transition-all duration-500"
                style={{
                  height: `${barPx}px`,
                  minWidth: "24px",
                  maxWidth: "48px",
                  background: gradient,
                  boxShadow: "0 2px 10px rgba(0,0,0,0.07)",
                  borderRadius: "12px",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2 px-1">
        {shown.map(row => (
          <div key={row.label} className="flex-1 text-center">
            <span className="block text-[9px] font-medium uppercase tracking-[0.10em] text-stone-400 leading-tight break-words hyphens-auto">{row.label}</span>
          </div>
        ))}
      </div>
      {valueLabel && <p className="mt-2 text-center text-[10px] text-stone-400">{valueLabel}</p>}
    </div>
  );
}

interface ShootsPanelProps { form: ShootForm; updateForm: (field: string, value: string) => void; saveShoot: () => void; editingShootId: number | null; query: string; setQuery: (v: string) => void; rows: Shoot[]; allShoots: Shoot[]; years: string[]; editShoot: (row: Shoot) => void; deleteShoot: (row: Shoot) => void; formRef: React.RefObject<HTMLDivElement>; recoverShoots: () => void; recoveryState: { status: string; count?: number; error?: string; rawRows?: unknown[][] }; isSaving?: boolean; }
function CField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-[3px] block text-[9px] uppercase tracking-[0.18em] text-stone-400/80">{label}</span>
      {children}
    </label>
  );
}
function CInput({ value, onChange, type = "text", placeholder = "" }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} className="w-full rounded-lg border border-stone-200/80 bg-white/95 px-2.5 py-[6px] text-[12px] text-stone-800 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 placeholder:text-stone-300" />;
}
function CSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return <select value={value} onChange={e => onChange(e.target.value)} className="w-full rounded-lg border border-stone-200/80 bg-white/95 px-2.5 py-[6px] text-[12px] text-stone-800 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 cursor-pointer appearance-none">{options.map(o => <option key={o}>{o}</option>)}</select>;
}

function ShootsPanel({ form, updateForm, saveShoot, editingShootId, query, setQuery, rows, allShoots, years, editShoot, deleteShoot, formRef, recoverShoots, recoveryState, isSaving }: ShootsPanelProps) {
  const [filterHotel, setFilterHotel] = React.useState("All Hotels");
  const [filterMonth, setFilterMonth] = React.useState("All");
  const [filterYear, setFilterYear] = React.useState("All");
  const [filterSource, setFilterSource] = React.useState("All Sources");
  const [filterDept, setFilterDept] = React.useState("All Departments");
  const [filterSort, setFilterSort] = React.useState("Date");
  const [formOpen, setFormOpen] = React.useState(false);
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  React.useEffect(() => { if (editingShootId) setFormOpen(true); }, [editingShootId]);

  const filtered = React.useMemo(() => {
    const q = query.toLowerCase();
    const results = allShoots.filter(row => {
      if (filterHotel !== "All Hotels" && row.hotel !== filterHotel) return false;
      if (filterYear !== "All" && !row.date.startsWith(filterYear)) return false;
      if (filterMonth !== "All" && monthKey(row.date).slice(5) !== filterMonth) return false;
      if (filterSource !== "All Sources" && row.source !== filterSource) return false;
      if (filterDept !== "All Departments" && row.department !== filterDept) return false;
      if (q && !`${row.date} ${row.hotel} ${row.client} ${row.eventType} ${row.photoPackage} ${row.department} ${row.source}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (filterSort === "Client") return results.sort((a, b) => a.client.localeCompare(b.client));
    if (filterSort === "Hotel") return results.sort((a, b) => a.hotel.localeCompare(b.hotel));
    return results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [allShoots, query, filterHotel, filterYear, filterMonth, filterSource, filterDept, filterSort]);

  void rows;

  const chipBase = "rounded-full border px-2.5 py-1 text-[11px] font-medium transition cursor-pointer whitespace-nowrap leading-none";
  const chipOn  = "border-stone-900 bg-stone-900 text-white";
  const chipOff = "border-stone-200 bg-white/80 text-stone-500 hover:border-stone-400 hover:text-stone-800";
  function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return <button className={`${chipBase} ${active ? chipOn : chipOff}`} onClick={onClick}>{label}</button>;
  }
  function FilterCard({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div className="rounded-xl border border-stone-200/70 bg-white/60 px-3 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <p className="mb-2 text-[9px] uppercase tracking-[0.22em] text-stone-400">{label}</p>
        <div className="flex flex-wrap gap-1.5">{children}</div>
      </div>
    );
  }

  function handleSave() { saveShoot(); setFormOpen(false); }
  function handleCancel() { updateForm("client", ""); setFormOpen(false); }

  return (
    <div className="space-y-3">
      {/* Recovery banner — shown whenever shoots list is empty */}
      {allShoots.length === 0 && (
        <div className="rounded-[20px] border-2 border-amber-300 bg-amber-50 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-400 text-stone-900">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-stone-800">No shoots visible in app</p>
              <p className="mt-0.5 text-xs text-stone-600">Your Google Sheet still has data. Use the button below to restore it.</p>
              <button
                onClick={recoverShoots}
                disabled={recoveryState.status === "loading"}
                className="mt-3 flex items-center gap-2 rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-stone-700 disabled:opacity-50"
              >
                {recoveryState.status === "loading"
                  ? <><svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Recovering…</>
                  : <><svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>Recover Shoots from Google Sheet</>
                }
              </button>
              {recoveryState.status === "error" && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-red-700 mb-1">Recovery failed</p>
                  <p className="text-[10px] text-red-600 font-mono break-all">{recoveryState.error}</p>
                  {recoveryState.rawRows && recoveryState.rawRows.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] text-red-500 hover:text-red-700">Show raw rows ({recoveryState.rawRows.length})</summary>
                      <pre className="mt-1 text-[9px] text-red-600 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{JSON.stringify(recoveryState.rawRows.slice(0, 10), null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
              {recoveryState.status === "done" && (
                <p className="mt-2 text-xs font-medium text-emerald-700">Restored {recoveryState.count} shoots successfully.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Always-visible recovery button when shoots exist (compact) */}
      {allShoots.length > 0 && (
        <div className="flex justify-end">
          <button
            onClick={recoverShoots}
            disabled={recoveryState.status === "loading"}
            className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white/80 px-3 py-1.5 text-[10px] font-medium text-stone-500 transition hover:border-stone-400 hover:text-stone-700 disabled:opacity-40"
          >
            {recoveryState.status === "loading"
              ? <><svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Syncing…</>
              : <><svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>Sync from Sheet</>
            }
            {recoveryState.status === "done" && <span className="text-emerald-600">{recoveryState.count} rows</span>}
          </button>
        </div>
      )}

      {/* Collapsible form card */}
      <div ref={formRef} className="lg:sticky lg:top-[220px] z-10">
        <div className="rounded-[20px] border border-stone-200/60 bg-white/80 shadow-sm backdrop-blur-sm overflow-hidden">

          {/* Toggle bar */}
          <button
            onClick={() => setFormOpen(o => !o)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-left transition hover:bg-stone-50/60 select-none"
          >
            <div className="flex items-center gap-2.5">
              <span className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold leading-none transition-colors ${formOpen ? "bg-stone-900 text-white" : "bg-amber-400 text-stone-900"}`}>
                {editingShootId ? "✎" : "+"}
              </span>
              <span className="text-[13px] font-semibold tracking-tight text-stone-800">
                {editingShootId ? "Edit shoot" : "Add shoot"}
              </span>
              {editingShootId && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-semibold tracking-wide text-amber-800">editing</span>
              )}
              {!formOpen && !editingShootId && (
                <span className="hidden sm:block text-[10px] text-stone-400 font-normal">· {allShoots.length} shoot{allShoots.length !== 1 ? "s" : ""} total</span>
              )}
            </div>
            <svg className={`h-3.5 w-3.5 text-stone-400 transition-transform duration-250 ${formOpen ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>

          {/* Expandable form body */}
          <div
            className="overflow-hidden transition-all duration-250 ease-in-out"
            style={{ maxHeight: formOpen ? "500px" : "0px", opacity: formOpen ? 1 : 0 }}
          >
            <div className="border-t border-stone-100/80 px-3 pb-3 pt-3">
              {/* 3 section columns on xl, stack on mobile */}
              <div className="grid gap-2 xl:grid-cols-3">

                {/* Client section */}
                <div className="rounded-[14px] bg-white/90 border border-stone-200/50 px-3 py-2.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
                  <p className="mb-2 text-[9px] uppercase tracking-[0.22em] text-stone-400/70 font-medium">Client</p>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-2">
                    <CField label="Date">
                      <CInput type="date" value={form.date} onChange={v => updateForm("date", v)} />
                    </CField>
                    <CField label="Client">
                      <CInput value={form.client} placeholder="Name" onChange={v => updateForm("client", v)} />
                    </CField>
                    <CField label="Hotel">
                      <CSelect value={form.hotel} options={HOTELS} onChange={v => updateForm("hotel", v)} />
                    </CField>
                    <CField label="Category">
                      <CSelect value={form.eventType} options={EVENT_TYPES} onChange={v => updateForm("eventType", v)} />
                    </CField>
                  </div>
                </div>

                {/* Booking section */}
                <div className="rounded-[14px] bg-amber-50/60 border border-amber-200/40 px-3 py-2.5 shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
                  <p className="mb-2 text-[9px] uppercase tracking-[0.22em] text-amber-700/50 font-medium">Booking</p>
                  <div className="grid grid-cols-1 gap-y-2">
                    <CField label="Package">
                      <CSelect value={form.photoPackage} options={PHOTO_PACKAGES} onChange={v => updateForm("photoPackage", v)} />
                    </CField>
                    <CField label="Department">
                      <CSelect value={form.department} options={DEPARTMENTS} onChange={v => updateForm("department", v)} />
                    </CField>
                    <CField label="Source">
                      <CSelect value={form.source} options={SOURCES} onChange={v => updateForm("source", v)} />
                    </CField>
                  </div>
                </div>

                {/* Price section */}
                <div className="rounded-[14px] bg-stone-50/70 border border-stone-200/40 px-3 py-2.5 shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
                  <p className="mb-2 text-[9px] uppercase tracking-[0.22em] text-stone-400/70 font-medium">Price</p>
                  <div className="grid grid-cols-3 sm:grid-cols-3 gap-x-2 gap-y-2 mb-3">
                    <CField label="HT">
                      <CInput type="number" value={form.ht} onChange={v => updateForm("ht", v)} />
                    </CField>
                    <CField label="TVA">
                      <CInput type="number" value={form.tax} onChange={v => updateForm("tax", v)} />
                    </CField>
                    <CField label="TTC">
                      <CInput type="number" value={form.finalAmount} onChange={v => updateForm("finalAmount", v)} />
                    </CField>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSave}
                      disabled={isSaving}
                      className="flex-1 rounded-full bg-stone-900 py-1.5 text-[11px] font-semibold text-white tracking-wide hover:bg-stone-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSaving ? "Saving…" : editingShootId ? "Update shoot" : "+ Add shoot"}
                    </button>
                    {editingShootId && (
                      <button
                        onClick={handleCancel}
                        className="rounded-full border border-stone-200 px-3 py-1.5 text-[11px] font-medium text-stone-500 hover:border-stone-400 hover:text-stone-700 transition"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <p className="mt-1.5 text-[9px] text-stone-400 leading-tight">Price auto-fills from Prices tab</p>
                </div>

              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Table card */}
      <Card>
        <div className="p-4 md:p-5">

          {/* Filter row */}
          <div className="flex items-center gap-2 mb-3">
            {/* Search */}
            <div className="relative flex-1 min-w-0">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-stone-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input
                value={query}
                placeholder="Search shoots, clients, hotels..."
                onChange={e => setQuery(e.target.value)}
                className="w-full rounded-xl border border-stone-200/80 bg-white/90 pl-9 pr-3 py-2 text-[12px] text-stone-800 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 placeholder:text-stone-300"
              />
            </div>

            {/* Desktop filter dropdowns */}
            <div className="hidden md:flex items-center gap-1.5 flex-shrink-0">
              {([
                { label: "Hotels", value: filterHotel, options: ["All Hotels", ...HOTELS], set: setFilterHotel, icon: <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
                { label: "Month", value: filterMonth === "All" ? "Month" : MONTH_OPTIONS.find(([v]) => v === filterMonth)?.[1]?.slice(0,3) ?? filterMonth, options: ["All", ...MONTH_OPTIONS.map(([v]) => v)], set: setFilterMonth, displayOptions: ["All", ...MONTH_OPTIONS.map(([,l]) => l.slice(0,3))], rawOptions: ["All", ...MONTH_OPTIONS.map(([v]) => v)], icon: <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
                { label: "Year", value: filterYear === "All" ? "Year" : filterYear, options: ["All", ...years], set: setFilterYear, icon: <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
                { label: "Source", value: filterSource === "All Sources" ? "Source" : filterSource, options: ["All Sources", ...SOURCES], set: setFilterSource, icon: <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> },
                { label: "Department", value: filterDept === "All Departments" ? "Dept" : filterDept, options: ["All Departments", ...DEPARTMENTS], set: setFilterDept, icon: <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
              ] as const).map(f => {
                const isActive = !["Hotels", "Month", "Year", "Source", "Dept"].includes(f.value as string);
                return (
                  <div key={f.label} className="relative flex items-center">
                    <span className={`pointer-events-none absolute left-2.5 z-10 ${isActive ? "text-white/60" : "text-stone-400"}`}>{f.icon}</span>
                    <select
                      value={"rawOptions" in f ? (filterMonth === "All" ? "All" : filterMonth) : f.value === f.label ? f.options[0] : f.value}
                      onChange={e => {
                        if ("rawOptions" in f) { setFilterMonth(e.target.value); }
                        else { f.set(e.target.value as never); }
                      }}
                      className={`appearance-none rounded-xl border pl-7 pr-7 py-2 text-[11px] font-medium cursor-pointer outline-none transition ${isActive ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200/80 bg-white/80 text-stone-600 hover:border-stone-300"}`}
                    >
                      {"displayOptions" in f
                        ? (f as unknown as { rawOptions: string[]; displayOptions: string[] }).rawOptions.map((raw, i) => <option key={raw} value={raw}>{(f as unknown as { displayOptions: string[] }).displayOptions[i]}</option>)
                        : f.options.map(o => <option key={o} value={o}>{o}</option>)
                      }
                    </select>
                    <svg className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${isActive ? "text-white/60" : "text-stone-400"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </div>
                );
              })}
            </div>

            {/* Mobile: Filters + Sort */}
            <div className="flex md:hidden items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => setFiltersOpen(true)}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] font-medium transition ${[filterHotel, filterMonth, filterYear, filterSource, filterDept].some(v => !["All Hotels","All","All Sources","All Departments"].includes(v)) ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200/80 bg-white/80 text-stone-600"}`}
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
                Filters
                {[filterHotel, filterMonth, filterYear, filterSource, filterDept].filter(v => !["All Hotels","All","All Sources","All Departments"].includes(v)).length > 0 && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-stone-900 text-[9px] font-bold">
                    {[filterHotel, filterMonth, filterYear, filterSource, filterDept].filter(v => !["All Hotels","All","All Sources","All Departments"].includes(v)).length}
                  </span>
                )}
              </button>
            </div>

            {/* Sort dropdown — desktop */}
            <div className="relative hidden md:flex items-center flex-shrink-0">
              <svg className="pointer-events-none absolute left-2.5 h-3 w-3 text-stone-400 z-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="9" y1="18" x2="15" y2="18"/></svg>
              <select
                value={filterSort}
                onChange={e => setFilterSort(e.target.value)}
                className="appearance-none rounded-xl border border-stone-200/80 bg-white/80 pl-7 pr-8 py-2 text-[11px] font-medium text-stone-600 cursor-pointer outline-none transition hover:border-stone-300"
              >
                {["Date", "Client", "Hotel"].map(o => <option key={o} value={o}>Sort: {o}</option>)}
              </select>
              <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            {/* Sort — mobile */}
            <div className="relative md:hidden flex items-center flex-shrink-0">
              <svg className="pointer-events-none absolute left-2.5 h-3 w-3 text-stone-400 z-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="9" y1="18" x2="15" y2="18"/></svg>
              <select
                value={filterSort}
                onChange={e => setFilterSort(e.target.value)}
                className="appearance-none rounded-xl border border-stone-200/80 bg-white/80 pl-7 pr-7 py-2 text-[11px] font-medium text-stone-600 cursor-pointer outline-none"
              >
                {["Date", "Client", "Hotel"].map(o => <option key={o} value={o}>Sort: {o}</option>)}
              </select>
              <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>

          {/* Mobile filters drawer */}
          {filtersOpen && (
            <>
              <div className="fixed inset-0 z-40 bg-stone-900/40 backdrop-blur-[2px]" onClick={() => setFiltersOpen(false)} />
              <div className="fixed bottom-0 left-0 right-0 z-50 rounded-t-[28px] bg-white shadow-[0_-8px_40px_rgba(0,0,0,0.15)] p-5">
                <div className="flex justify-center mb-4">
                  <div className="h-1 w-8 rounded-full bg-stone-200" />
                </div>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-bold text-stone-900">Filters</p>
                  <button onClick={() => { setFilterHotel("All Hotels"); setFilterMonth("All"); setFilterYear("All"); setFilterSource("All Sources"); setFilterDept("All Departments"); }} className="text-[11px] font-medium text-stone-400 hover:text-stone-600">Clear all</button>
                </div>
                <div className="space-y-4">
                  {[
                    { label: "Hotels", value: filterHotel, options: ["All Hotels", ...HOTELS], set: setFilterHotel },
                    { label: "Year", value: filterYear, options: ["All", ...years], set: setFilterYear },
                    { label: "Source", value: filterSource, options: ["All Sources", ...SOURCES], set: setFilterSource },
                    { label: "Department", value: filterDept, options: ["All Departments", ...DEPARTMENTS], set: setFilterDept },
                  ].map(f => (
                    <div key={f.label}>
                      <p className="text-[9px] uppercase tracking-[0.22em] text-stone-400 mb-2">{f.label}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {f.options.map(o => (
                          <button key={o} onClick={() => f.set(o)} className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${f.value === o ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-stone-50 text-stone-600"}`}>{o}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div>
                    <p className="text-[9px] uppercase tracking-[0.22em] text-stone-400 mb-2">Month</p>
                    <div className="flex flex-wrap gap-1.5">
                      {[["All","All"], ...MONTH_OPTIONS].map(([v, l]) => (
                        <button key={v} onClick={() => setFilterMonth(v)} className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${filterMonth === v ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-stone-50 text-stone-600"}`}>{l.slice(0,3)}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <button onClick={() => setFiltersOpen(false)} className="mt-5 w-full rounded-2xl bg-stone-900 py-3 text-sm font-semibold text-white">Apply</button>
              </div>
            </>
          )}

          <p className="mb-2 text-xs text-stone-400">{filtered.length} shoot{filtered.length !== 1 ? "s" : ""} found</p>
          <ShootsTable rows={filtered} onEdit={editShoot} onDelete={deleteShoot} />
        </div>
      </Card>
    </div>
  );
}

interface DirectPanelProps {
  directForm: DirectForm;
  setDirectForm: (v: DirectForm) => void;
  saveDirectIncome: () => void;
  editingDirectId: number | null;
  rows: DirectRow[];
  editDirect: (row: DirectRow) => void;
  deleteDirect: (id: number) => void;
  isSaving?: boolean;
  syncStats: { shootsLoaded: number; directLoaded: number; lastSync: string | null; error: string | null };
  onRefreshSync: () => Promise<void>;
  syncRefreshing: boolean;
}
function DirectPanel({ directForm, setDirectForm, saveDirectIncome, editingDirectId, rows, editDirect, deleteDirect, isSaving, syncStats, onRefreshSync, syncRefreshing }: DirectPanelProps) {
  const [filterYear,  setFilterYear]  = React.useState("All");
  const [filterMonth, setFilterMonth] = React.useState("All");

  // Derive available years from row dates
  const availableYears = React.useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => { const y = (r.date || "").slice(0, 4); if (/^\d{4}$/.test(y)) s.add(y); });
    return Array.from(s).sort((a, b) => Number(b) - Number(a));
  }, [rows]);

  const filteredRows = React.useMemo(() => {
    return [...rows]
      .filter(r => {
        if (filterYear !== "All" && !(r.date || "").startsWith(filterYear)) return false;
        if (filterMonth !== "All") {
          const mm = (r.date || "").slice(5, 7);
          if (mm !== filterMonth) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [rows, filterYear, filterMonth]);

  const MONO    = "'DM Mono', monospace";
  const GROTESK = "'Hanken Grotesk', sans-serif";
  const isStale = !syncStats.lastSync;
  const hasError = !!syncStats.error;

  const months = [
    ["01","Jan"],["02","Feb"],["03","Mar"],["04","Apr"],["05","May"],["06","Jun"],
    ["07","Jul"],["08","Aug"],["09","Sep"],["10","Oct"],["11","Nov"],["12","Dec"],
  ] as const;

  return (
    <div className="space-y-4">
      {/* ── Sync status bar ── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-1 pt-2">
        <div className="flex items-center gap-2.5">
          {/* Status dot */}
          <span style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0, display: "inline-block",
            background: hasError ? "#B86B63" : syncRefreshing ? "#C9A84C" : !isStale ? "#4F8A5B" : "#C9A84C",
            boxShadow: (!hasError && !isStale && !syncRefreshing) ? "0 0 0 3px rgba(79,138,91,0.18)" : undefined,
          }} />
          <span style={{ fontFamily: MONO, fontSize: "10px", letterSpacing: "1.5px", color: "rgba(26,23,20,0.5)", textTransform: "uppercase" }}>
            {syncRefreshing
              ? "Syncing…"
              : hasError
              ? `Sync error: ${syncStats.error}`
              : syncStats.lastSync
              ? `Last sync: ${syncStats.lastSync} · ${syncStats.directLoaded} rows`
              : "Not yet synced"}
          </span>
        </div>
        <button
          onClick={onRefreshSync}
          disabled={syncRefreshing}
          className="flex items-center gap-1.5"
          style={{
            fontFamily: MONO, fontSize: "9px", letterSpacing: "1.5px", textTransform: "uppercase",
            color: syncRefreshing ? "rgba(26,23,20,0.3)" : "rgba(26,23,20,0.6)",
            background: "rgba(26,23,20,0.04)", border: "0.5px solid rgba(26,23,20,0.12)",
            borderRadius: 20, padding: "5px 12px", cursor: syncRefreshing ? "default" : "pointer",
            transition: "all 0.15s",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: syncRefreshing ? "rotate(360deg)" : undefined, transition: "transform 0.6s linear" }}>
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          {syncRefreshing ? "Syncing…" : "Refresh Sync"}
        </button>
      </div>

      {/* ── Debug stats ── */}
      {(() => {
        const yearMap = new Map<string, { count: number; amount: number }>();
        rows.forEach(r => {
          const y = (r.date || "").slice(0, 4);
          if (!/^\d{4}$/.test(y)) return;
          const prev = yearMap.get(y) ?? { count: 0, amount: 0 };
          yearMap.set(y, { count: prev.count + 1, amount: prev.amount + parseAmount(r.amount) });
        });
        const yearStats = Array.from(yearMap.entries()).sort(([a], [b]) => b.localeCompare(a));
        return yearStats.length > 0 ? (
          <div style={{ padding: "6px 2px 2px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {yearStats.map(([yr, s]) => (
              <span key={yr} style={{ fontFamily: "'DM Mono', monospace", fontSize: "9px", letterSpacing: "1px", color: "rgba(26,23,20,0.45)", textTransform: "uppercase" }}>
                {yr}: {s.count} rows · ${s.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
            ))}
          </div>
        ) : null;
      })()}


      <Card>
        <div className="grid gap-3 p-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-4">
          <Input type="date" value={directForm.date} onChange={v => setDirectForm({ ...directForm, date: v })} />
          <Input value={directForm.client} placeholder="Client" onChange={v => setDirectForm({ ...directForm, client: v })} />
          <Select value={directForm.income} options={DIRECT_INCOME_OPTIONS} onChange={v => setDirectForm({ ...directForm, income: v })} />
          <Input type="number" value={directForm.amount} placeholder="Amount (USD)" onChange={v => setDirectForm({ ...directForm, amount: v })} />
        </div>
        <div className="px-4 pb-4">
          <button onClick={saveDirectIncome} disabled={isSaving} className="rounded-full bg-stone-900 px-6 py-2 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed">
            {isSaving ? "Saving…" : editingDirectId ? "Update" : "+ Add"}
          </button>
        </div>
      </Card>

      {/* ── Filters + table ── */}
      <Card>
        <div className="p-4 md:p-5">
          {/* Filter row */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-5">
            <span style={{ fontFamily: MONO, fontSize: "9px", letterSpacing: "1.5px", color: "rgba(26,23,20,0.4)", textTransform: "uppercase", flexShrink: 0 }}>Filter</span>
            {/* Year */}
            <div style={{ position: "relative", minWidth: 110 }}>
              <select
                value={filterYear}
                onChange={e => setFilterYear(e.target.value)}
                style={{ fontFamily: GROTESK, fontSize: "13px", fontWeight: 500, color: "#1A1714", background: "#fff", border: "0.5px solid rgba(26,23,20,0.12)", borderRadius: 20, padding: "6px 28px 6px 12px", appearance: "none", WebkitAppearance: "none", cursor: "pointer", outline: "none", width: "100%" }}
              >
                <option value="All">All Years</option>
                {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <ChevronDown size={11} strokeWidth={1.5} style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", color: "rgba(26,23,20,0.4)", pointerEvents: "none" }} />
            </div>
            {/* Month */}
            <div style={{ position: "relative", minWidth: 110 }}>
              <select
                value={filterMonth}
                onChange={e => setFilterMonth(e.target.value)}
                style={{ fontFamily: GROTESK, fontSize: "13px", fontWeight: 500, color: "#1A1714", background: "#fff", border: "0.5px solid rgba(26,23,20,0.12)", borderRadius: 20, padding: "6px 28px 6px 12px", appearance: "none", WebkitAppearance: "none", cursor: "pointer", outline: "none", width: "100%" }}
              >
                <option value="All">All Months</option>
                {months.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
              <ChevronDown size={11} strokeWidth={1.5} style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", color: "rgba(26,23,20,0.4)", pointerEvents: "none" }} />
            </div>
            {/* Count */}
            <span style={{ fontFamily: MONO, fontSize: "9px", color: "rgba(26,23,20,0.4)", letterSpacing: "0.5px", marginLeft: "auto" }}>
              {filteredRows.length} {filteredRows.length === 1 ? "row" : "rows"}
              {(filterYear !== "All" || filterMonth !== "All") && rows.length !== filteredRows.length && ` of ${rows.length}`}
            </span>
            {/* Clear */}
            {(filterYear !== "All" || filterMonth !== "All") && (
              <button
                onClick={() => { setFilterYear("All"); setFilterMonth("All"); }}
                style={{ fontFamily: MONO, fontSize: "9px", color: "rgba(26,23,20,0.5)", letterSpacing: "1px", textTransform: "uppercase", background: "none", border: "0.5px solid rgba(26,23,20,0.12)", borderRadius: 20, padding: "5px 10px", cursor: "pointer" }}
              >
                Clear
              </button>
            )}
          </div>

          <DirectTable rows={filteredRows} onEdit={editDirect} onDelete={deleteDirect} />
        </div>
      </Card>
    </div>
  );
}

interface InvoicesPanelProps { years: string[]; invoiceHotel: string; setInvoiceHotel: (v: string) => void; invoiceYear: string; setInvoiceYear: (v: string) => void; invoiceMonth: string; setInvoiceMonth: (v: string) => void; invoiceDepartment: string; setInvoiceDepartment: (v: string) => void; generateInvoice: () => void; invoiceRows: Shoot[]; editShoot: (row: Shoot) => void; deleteShoot: (row: Shoot) => void; generatedInvoice: GeneratedInvoice | null; allShoots: Shoot[]; savedInvoices: SavedInvoice[]; regenerateInvoice: (inv: SavedInvoice) => void; deleteInvoice: (inv: SavedInvoice) => void; downloadAllInvoicesFor: (filter: { year?: string; month?: string; hotel?: string }) => void; onInvoiceSaved?: (saved: boolean) => void; }
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <span onClick={() => onChange(!value)} className={`relative inline-block h-3.5 w-6 cursor-pointer rounded-full transition-colors ${value ? "bg-emerald-500" : "bg-stone-300"}`}>
      <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform ${value ? "translate-x-2.5" : "translate-x-0.5"}`} />
    </span>
  );
}

function StatusBadge({ status }: { status: SavedInvoice["status"] }) {
  const styles: Record<string, string> = { Original: "bg-emerald-100 text-emerald-800", Regenerated: "bg-amber-100 text-amber-800" };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${styles[status] || "bg-stone-100 text-stone-500"}`}>{status}</span>;
}
function InvoiceHistoryCard({ inv, onPreview, onRegenerate, onDelete }: { inv: SavedInvoice; onPreview: () => void; onRegenerate: () => void; onDelete: () => void }) {
  async function handleDownload() {
    const gi: GeneratedInvoice = { invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, hotel: inv.hotel, department: inv.department, month: inv.month, rows: inv.rows, totalHT: inv.totalHT, totalTax: inv.totalTax, totalTTC: inv.totalTTC };
    await downloadInvoicePdf(gi);
  }

  const statusAccent = inv.status === "Regenerated" ? "#f59e0b" : "#22c55e";

  return (
    <div className="flex items-stretch overflow-hidden rounded-[14px] border border-stone-200/50 bg-white shadow-sm">
      {/* Left accent strip — green for original, amber for regenerated */}
      <div className="w-[3.5px] flex-shrink-0 self-stretch" style={{ background: statusAccent }} />
      <div className="flex-1 px-3 py-3 min-w-0">
        {/* Row 1: invoice number + status + amount + action icons */}
        <div className="flex items-start justify-between gap-1 mb-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[13px] font-bold tracking-tight text-stone-900">{inv.invoiceNumber}</span>
              <StatusBadge status={inv.status} />
            </div>
            <p className="text-[11px] font-medium text-stone-600 mt-0.5 truncate">{inv.hotel.name}</p>
            <p className="text-[10px] text-stone-400">{inv.month} · {inv.department} · {inv.rows.length} shoot{inv.rows.length !== 1 ? "s" : ""}</p>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0 -mt-0.5 -mr-1">
            <div className="text-right mr-1">
              <span className="text-[14px] font-black tabular-nums text-stone-900">{numberOnly(inv.totalTTC)}</span>
              <span className="text-[9px] uppercase tracking-wide text-stone-400 ml-0.5">XPF</span>
            </div>
            <IconBtn onClick={e => { e.stopPropagation(); onPreview(); }} type="eye" />
            <IconBtn onClick={e => { e.stopPropagation(); handleDownload(); }} type="download" />
            <IconBtn onClick={e => { e.stopPropagation(); onRegenerate(); }} type="refresh" />
            <IconBtn onClick={e => { e.stopPropagation(); onDelete(); }} type="delete" />
          </div>
        </div>
      </div>
    </div>
  );
}
function InvoicesPanel({ years, invoiceHotel, setInvoiceHotel, invoiceYear, setInvoiceYear, invoiceMonth, setInvoiceMonth, invoiceDepartment, setInvoiceDepartment, generateInvoice, invoiceRows, editShoot, deleteShoot, generatedInvoice, allShoots, savedInvoices, regenerateInvoice, deleteInvoice, downloadAllInvoicesFor, onInvoiceSaved }: InvoicesPanelProps) {
  void allShoots;
  const [previewInvoice, setPreviewInvoice] = React.useState<GeneratedInvoice | null>(null);
  const [openYears, setOpenYears] = React.useState<Set<string>>(new Set());
  const [openMonths, setOpenMonths] = React.useState<Set<string>>(new Set());

  const historyByYear = React.useMemo(() => {
    const map = new Map<string, Map<string, SavedInvoice[]>>();
    savedInvoices.forEach(inv => {
      if (!map.has(inv.year)) map.set(inv.year, new Map());
      const byMonth = map.get(inv.year)!;
      if (!byMonth.has(inv.monthKey)) byMonth.set(inv.monthKey, []);
      byMonth.get(inv.monthKey)!.push(inv);
    });
    return map;
  }, [savedInvoices]);

  const sortedYears = Array.from(historyByYear.keys()).sort((a, b) => b.localeCompare(a));

  function toggleYear(y: string) { setOpenYears(s => { const n = new Set(s); n.has(y) ? n.delete(y) : n.add(y); return n; }); }
  function toggleMonth(mk: string) { setOpenMonths(s => { const n = new Set(s); n.has(mk) ? n.delete(mk) : n.add(mk); return n; }); }
  function handlePreview(inv: SavedInvoice) {
    setPreviewInvoice({ invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, hotel: inv.hotel, department: inv.department, month: inv.month, rows: inv.rows, totalHT: inv.totalHT, totalTax: inv.totalTax, totalTTC: inv.totalTTC });
  }

  const historyYears = sortedYears;
  const invoiceMonthKeyStr = `${invoiceYear}-${invoiceMonth}`;
  void invoiceMonthKeyStr;

  return (
    <div className="space-y-4">
      {/* Generator card */}
      <Card>
        <div className="p-4">
          <p className="mb-3 text-[10px] uppercase tracking-[0.28em] text-stone-400">New Invoice</p>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-5">
            <Select value={invoiceHotel} options={HOTELS} onChange={setInvoiceHotel} />
            <Select value={invoiceYear} options={years.length ? years : ["2026"]} onChange={setInvoiceYear} />
            <Select value={invoiceMonth} options={MONTH_OPTIONS.map(([v]) => v)} labels={Object.fromEntries(MONTH_OPTIONS)} onChange={setInvoiceMonth} />
            <Select value={invoiceDepartment} options={INVOICE_DEPARTMENTS} onChange={setInvoiceDepartment} />
            <button onClick={generateInvoice} className="rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white">Generate Invoice</button>
          </div>
          <p className="mt-3 text-xs text-stone-400">{invoiceRows.length} shoot{invoiceRows.length !== 1 ? "s" : ""} match for this selection.</p>
        </div>
      </Card>

      {/* Shoot rows preview */}
      {invoiceRows.length > 0 && (
        <Card>
          <div className="p-4 md:p-5">
            <p className="mb-3 text-[10px] uppercase tracking-[0.28em] text-stone-400">Shoot Rows Preview</p>
            <InvoiceDepartmentPreview rows={invoiceRows} onEdit={editShoot} onDelete={deleteShoot} />
          </div>
        </Card>
      )}

      {/* Most-recently generated preview */}
      {(generatedInvoice || previewInvoice) && (
        <div>
          {previewInvoice && previewInvoice !== generatedInvoice && (
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-stone-500">Previewing saved invoice</p>
              <button onClick={() => setPreviewInvoice(null)} className="text-xs text-stone-400 hover:text-stone-700 underline">Close preview</button>
            </div>
          )}
          <InvoicePreview invoice={previewInvoice || generatedInvoice!} onSaved={onInvoiceSaved} />
        </div>
      )}

      {/* Invoice History */}
      <Card>
        <div className="p-4 md:p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-[0.28em] text-stone-400">Invoice History</p>
              <p className="mt-0.5 text-xs text-stone-500">{savedInvoices.length} invoice{savedInvoices.length !== 1 ? "s" : ""} saved</p>
            </div>
            {savedInvoices.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => downloadAllInvoicesFor({ year: invoiceYear })} className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 shadow-sm transition hover:bg-stone-50">All {invoiceYear}</button>
                <button onClick={() => downloadAllInvoicesFor({ year: invoiceYear, month: invoiceMonth })} className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 shadow-sm transition hover:bg-stone-50">All {monthName(invoiceMonth).slice(0, 3)} {invoiceYear}</button>
                <button onClick={() => downloadAllInvoicesFor({ hotel: invoiceHotel })} className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 shadow-sm transition hover:bg-stone-50">All {invoiceHotel}</button>
              </div>
            )}
          </div>

          {savedInvoices.length === 0 && (
            <div className="rounded-2xl bg-stone-50 p-8 text-center text-sm text-stone-400">No invoices generated yet. Use the form above to create your first invoice.</div>
          )}

          <div className="space-y-3">
            {historyYears.map(y => {
              const byMonth = historyByYear.get(y)!;
              const yearOpen = openYears.has(y);
              const sortedMonths = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));
              const yearTotal = Array.from(byMonth.values()).flat().reduce((s, inv) => s + inv.totalTTC, 0);
              return (
                <div key={y} className="rounded-[20px] border border-stone-200/60 overflow-hidden">
                  <button onClick={() => toggleYear(y)} className="flex w-full items-center justify-between px-4 py-3 bg-stone-50/80 hover:bg-stone-100/60 transition text-left">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-stone-900">{y}</span>
                      <span className="text-[10px] uppercase tracking-[0.18em] text-stone-400">{Array.from(byMonth.values()).flat().length} invoices</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-stone-600">{money(yearTotal)}</span>
                      <span className="text-stone-400 text-xs">{yearOpen ? "▲" : "▼"}</span>
                    </div>
                  </button>
                  {yearOpen && (
                    <div className="p-3 space-y-2">
                      {sortedMonths.map(mk => {
                        const monthInvs = byMonth.get(mk)!;
                        const mOpen = openMonths.has(mk);
                        const mTotal = monthInvs.reduce((s, inv) => s + inv.totalTTC, 0);
                        const mName = monthName(mk.slice(5));
                        return (
                          <div key={mk} className="rounded-[16px] border border-stone-200/50 overflow-hidden">
                            <button onClick={() => toggleMonth(mk)} className="flex w-full items-center justify-between px-4 py-2.5 bg-white/60 hover:bg-stone-50 transition text-left">
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-semibold text-stone-700">{mName}</span>
                                <span className="text-[10px] text-stone-400">{monthInvs.length} invoice{monthInvs.length !== 1 ? "s" : ""}</span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-medium text-stone-500">{money(mTotal)}</span>
                                <span className="text-[10px] text-stone-400">{mOpen ? "▲" : "▼"}</span>
                              </div>
                            </button>
                            {mOpen && (
                              <div className="p-3">
                                {/* Mobile: calendar-style cards */}
                                <div className="flex flex-col gap-2 sm:hidden">
                                  {monthInvs.map(inv => (
                                    <InvoiceHistoryCard
                                      key={inv.id}
                                      inv={inv}
                                      onPreview={() => handlePreview(inv)}
                                      onRegenerate={() => regenerateInvoice(inv)}
                                      onDelete={() => deleteInvoice(inv)}
                                    />
                                  ))}
                                </div>
                                {/* Desktop: compact table */}
                                <div className="hidden sm:block overflow-x-auto rounded-[14px] border border-stone-200/50">
                                  <table className="w-full min-w-[560px]">
                                    <thead className="bg-stone-50/80 border-b border-stone-200/50">
                                      <tr>
                                        <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">Date</th>
                                        <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">Invoice No.</th>
                                        <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">Hotel</th>
                                        <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">Month</th>
                                        <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">Total TTC</th>
                                        <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">Status</th>
                                        <th className="px-3 py-2.5 w-[136px]" />
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {monthInvs.map((inv, i) => (
                                        <tr key={inv.id} className={`${i % 2 === 1 ? "bg-stone-50/40" : "bg-white"} border-t border-stone-100 hover:bg-stone-50/70 transition-colors`}>
                                          <td className="px-3 py-2.5 text-[12px] text-stone-500 tabular-nums whitespace-nowrap">{inv.invoiceDate}</td>
                                          <td className="px-3 py-2.5 text-[12.5px] font-bold text-stone-900 whitespace-nowrap">{inv.invoiceNumber}</td>
                                          <td className="px-3 py-2.5 text-[12px] text-stone-600 max-w-[150px] truncate">{inv.hotel.name}</td>
                                          <td className="px-3 py-2.5 text-[12px] text-stone-500 whitespace-nowrap">{inv.month}</td>
                                          <td className="px-3 py-2.5 text-right text-[13px] font-bold tabular-nums text-stone-900 whitespace-nowrap">{money(inv.totalTTC)}</td>
                                          <td className="px-3 py-2.5"><StatusBadge status={inv.status} /></td>
                                          <td className="px-3 py-2.5">
                                            <div className="flex items-center justify-end gap-0.5">
                                              <IconBtn onClick={e => { e.stopPropagation(); handlePreview(inv); }} type="eye" />
                                              <IconBtn onClick={async e => { e.stopPropagation(); const gi: GeneratedInvoice = { invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, hotel: inv.hotel, department: inv.department, month: inv.month, rows: inv.rows, totalHT: inv.totalHT, totalTax: inv.totalTax, totalTTC: inv.totalTTC }; await downloadInvoicePdf(gi); }} type="download" />
                                              <IconBtn onClick={e => { e.stopPropagation(); regenerateInvoice(inv); }} type="refresh" />
                                              <IconBtn onClick={e => { e.stopPropagation(); deleteInvoice(inv); }} type="delete" />
                                            </div>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

const PACKAGE_ORDER = ["50 photos", "100 photos", "150 photos", "200 photos", "Event / Custom"];
function sortPricingRows(rows: PricingRow[]): PricingRow[] {
  return [...rows].sort((a, b) => {
    const ai = PACKAGE_ORDER.indexOf(a.photoPackage);
    const bi = PACKAGE_ORDER.indexOf(b.photoPackage);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

interface PricesPanelProps { priceForm: PriceForm; setPriceForm: (v: PriceForm) => void; savePrice: () => void; pricing: PricingRow[]; editingPriceId: number | null; editPrice: (row: PricingRow) => void; deletePrice: (id: number) => void; }
function PricesPanel({ priceForm, setPriceForm, savePrice, pricing, editingPriceId, editPrice, deletePrice }: PricesPanelProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] text-stone-400">
          {pricing.length > 0
            ? <><span className="font-semibold text-stone-600">{pricing.length}</span> prices loaded from Google Sheet</>
            : <span className="text-amber-600 font-medium">No prices loaded — check Google Sheet Price tab</span>
          }
        </span>
      </div>
      <Card>
        <div className="grid gap-3 p-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-5">
          <Select value={priceForm.hotel} options={HOTELS} onChange={v => setPriceForm({ ...priceForm, hotel: v })} />
          <Select value={priceForm.photoPackage} options={PHOTO_PACKAGES} onChange={v => setPriceForm({ ...priceForm, photoPackage: v })} />
          <Select value={priceForm.department} options={DEPARTMENTS} onChange={v => setPriceForm({ ...priceForm, department: v })} />
          <Input type="number" value={priceForm.ht} placeholder="HT price (XPF)" onChange={v => setPriceForm({ ...priceForm, ht: v })} />
          <button onClick={savePrice} className="rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white">{editingPriceId ? "Update price" : "Save price"}</button>
        </div>
      </Card>
      {HOTELS.map(hotelName => {
        const hotelRows = sortPricingRows(dedupePricing(pricing).filter(r => r.hotel === hotelName));
        if (!hotelRows.length) return null;
        return (
          <Card key={hotelName}>
            <PanelTitle title={hotelName} subtitle="Prices" />
            <div className="p-4 pt-1 md:p-6 md:pt-1">
              <PricingTable rows={hotelRows} onEdit={editPrice} onDelete={deletePrice} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

const ROW_COLORS = ["bg-white", "bg-stone-50/80", "bg-amber-50/40", "bg-sky-50/40", "bg-emerald-50/30"];
function rowBg(i: number) { return ROW_COLORS[i % ROW_COLORS.length]; }

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}
function Td({ children, right = false, bold = false, muted = false, nowrap = false, className = "" }: { children: React.ReactNode; right?: boolean; bold?: boolean; muted?: boolean; nowrap?: boolean; className?: string }) {
  return <td className={`px-4 py-3.5 text-sm ${right ? "text-right whitespace-nowrap" : ""} ${nowrap ? "whitespace-nowrap" : ""} ${bold ? "font-semibold text-stone-900" : muted ? "text-stone-400" : "text-stone-700"} ${className}`}>{children}</td>;
}
function SourcePill({ value }: { value: string }) {
  const styles: Record<string, string> = { Resort: "bg-amber-100 text-amber-800", Direct: "bg-sky-100 text-sky-800", Concierge: "bg-teal-100 text-teal-800", Event: "bg-rose-100 text-rose-800" };
  const style = styles[value] || "bg-stone-100 text-stone-600";
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${style}`}>{value}</span>;
}
function ActionBtn({ onClick, variant }: { onClick: () => void; variant: "edit" | "delete" }) {
  return variant === "edit"
    ? <button onClick={onClick} className="inline-flex items-center justify-center rounded-lg border border-stone-200 bg-white px-4 py-1.5 text-xs font-medium text-stone-700 shadow-sm transition hover:bg-stone-50 hover:border-stone-300">Edit</button>
    : <button onClick={onClick} className="inline-flex items-center justify-center rounded-lg border border-red-100 bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 shadow-sm transition hover:bg-red-100">Delete</button>;
}
function EmptyRow({ cols, message }: { cols: number; message: string }) {
  return <tr><td colSpan={cols} className="px-4 py-10 text-center text-sm text-stone-400">{message}</td></tr>;
}

const DEPT_ACCENT: Record<string, string> = { Resort: "#f59e0b", Direct: "#0ea5e9", Concierge: "#14b8a6", Event: "#f43f5e" };
function deptAccent(dept: string): string { return DEPT_ACCENT[dept] ?? "#a8a29e"; }

function IconBtn({ onClick, type }: { onClick: (e: React.MouseEvent) => void; type: "edit" | "delete" | "eye" | "download" | "refresh" }) {
  const base = "flex items-center justify-center h-8 w-8 rounded-full flex-shrink-0 transition active:scale-95";
  const styles = {
    edit:     `${base} text-stone-400 hover:bg-stone-100 active:bg-stone-200`,
    delete:   `${base} text-red-400 hover:bg-red-50 active:bg-red-100`,
    eye:      `${base} text-stone-400 hover:bg-stone-100 active:bg-stone-200`,
    download: `${base} text-stone-400 hover:bg-stone-100 active:bg-stone-200`,
    refresh:  `${base} text-amber-500 hover:bg-amber-50 active:bg-amber-100`,
  };
  const icons: Record<string, React.ReactNode> = {
    edit:     <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
    delete:   <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
    eye:      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    download: <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    refresh:  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
  };
  return <button onClick={onClick} className={styles[type]}>{icons[type]}</button>;
}

function ShootsTable({ rows, onEdit, onDelete }: { rows: Shoot[]; onEdit: (row: Shoot) => void; onDelete: (row: Shoot) => void }) {
  const sorted = [...rows].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return (
    <>
      {/* Mobile: calendar-style cards */}
      <div className="mt-4 flex flex-col gap-2 sm:hidden">
        {!sorted.length && <p className="py-8 text-center text-sm text-stone-400">No records found.</p>}
        {sorted.map(row => {
          const accent = deptAccent(row.department);
          return (
            <div key={row.id} className="flex items-stretch overflow-hidden rounded-[14px] border border-stone-200/50 bg-white">
              <div className="w-[3.5px] flex-shrink-0 self-stretch" style={{ background: accent }} />
              <div className="flex-1 px-3 py-3 min-w-0">
                <div className="flex items-start justify-between gap-1 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-bold text-stone-900 line-clamp-2 leading-tight">{row.client}</p>
                    {row.hotel && <p className="text-[11px] font-medium text-stone-500 mt-0.5 truncate">{row.hotel}</p>}
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 -mt-0.5 -mr-1">
                    <span className="text-[11px] text-stone-400 tabular-nums whitespace-nowrap">{displayDate(row.date)}</span>
                    <IconBtn onClick={e => { e.stopPropagation(); onEdit(row); }} type="edit" />
                    <IconBtn onClick={e => { e.stopPropagation(); onDelete(row); }} type="delete" />
                  </div>
                </div>
                {(row.department || row.source || row.eventType || row.photoPackage) && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {row.department && <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap" style={{ background: accent + "20", color: accent }}>{row.department}</span>}
                    {row.source && row.source !== row.department && <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] bg-stone-100 text-stone-500 whitespace-nowrap">{row.source}</span>}
                    {row.eventType && <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] bg-stone-100 text-stone-500 whitespace-nowrap">{row.eventType}</span>}
                    {row.photoPackage && <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] bg-stone-50 text-stone-400 whitespace-nowrap">{row.photoPackage}</span>}
                  </div>
                )}
                <div className="flex items-center gap-3 pt-2 border-t border-stone-100">
                  <span className="text-[10px] text-stone-400 whitespace-nowrap">HT <span className="font-semibold text-stone-700">{money(row.ht)}</span></span>
                  <span className="text-[10px] text-stone-400 whitespace-nowrap">TVA <span className="font-medium text-stone-500">{money(row.tax)}</span></span>
                  <span className="text-[10px] text-stone-400 whitespace-nowrap">TTC <span className="font-black text-stone-900">{money(row.finalAmount)}</span></span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Desktop: compact table, newest first */}
      <div className="mt-4 hidden sm:block overflow-x-auto rounded-[18px] border border-stone-200/50">
        {!sorted.length
          ? <p className="py-8 text-center text-sm text-stone-400">No records found.</p>
          : <table className="w-full min-w-[820px]">
              <thead className="bg-stone-50/80 border-b border-stone-200/50">
                <tr>
                  {["Date","Client","Hotel","Dept","Source","Event","Package"].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">{h}</th>
                  ))}
                  {["HT","TVA","TTC"].map(h => (
                    <th key={h} className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">{h}</th>
                  ))}
                  <th className="px-3 py-2.5 w-[72px]" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const accent = deptAccent(row.department);
                  return (
                    <tr key={row.id} className={`${i % 2 === 1 ? "bg-stone-50/40" : "bg-white"} border-t border-stone-100 hover:bg-stone-50/70 transition-colors`}>
                      <td className="px-3 py-2.5 text-[12px] text-stone-500 tabular-nums whitespace-nowrap">{displayDate(row.date)}</td>
                      <td className="px-3 py-2.5 text-[12.5px] font-semibold text-stone-900 max-w-[160px] truncate">{row.client}</td>
                      <td className="px-3 py-2.5 text-[12px] text-stone-600 max-w-[120px] truncate">{row.hotel}</td>
                      <td className="px-3 py-2.5">
                        {row.department && <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap" style={{ background: accent + "20", color: accent }}>{row.department}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-stone-500 whitespace-nowrap">{row.source}</td>
                      <td className="px-3 py-2.5 text-[12px] text-stone-600 whitespace-nowrap">{row.eventType}</td>
                      <td className="px-3 py-2.5 text-[12px] text-stone-500 max-w-[120px] truncate">{row.photoPackage}</td>
                      <td className="px-3 py-2.5 text-right text-[12px] tabular-nums text-stone-600 whitespace-nowrap">{money(row.ht)}</td>
                      <td className="px-3 py-2.5 text-right text-[12px] tabular-nums text-stone-500 whitespace-nowrap">{money(row.tax)}</td>
                      <td className="px-3 py-2.5 text-right text-[13px] font-bold tabular-nums text-stone-900 whitespace-nowrap">{money(row.finalAmount)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <IconBtn onClick={e => { e.stopPropagation(); onEdit(row); }} type="edit" />
                          <IconBtn onClick={e => { e.stopPropagation(); onDelete(row); }} type="delete" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        }
      </div>
    </>
  );
}

function InvoiceDepartmentPreview({ rows, onEdit, onDelete }: { rows: Shoot[]; onEdit: (row: Shoot) => void; onDelete: (row: Shoot) => void }) {
  if (!rows.length) return <div className="rounded-2xl bg-white/60 p-6 text-center text-sm text-stone-500">No shoots for this hotel, month, and department.</div>;
  const groups = groupRowsByDepartment(rows);
  return <div className="space-y-6">{Object.entries(groups).map(([department, departmentRows]) => <div key={department}><h3 className="mb-3 text-lg font-semibold text-stone-700">{department}</h3><ShootsTable rows={departmentRows} onEdit={onEdit} onDelete={onDelete} /></div>)}</div>;
}

function DirectTable({ rows, onEdit, onDelete }: { rows: DirectRow[]; onEdit: (row: DirectRow) => void; onDelete: (id: number) => void }) {
  const sorted = [...rows].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return (
    <>
      {/* Mobile: cards */}
      <div className="flex flex-col gap-2 sm:hidden">
        {!sorted.length && <p className="py-8 text-center text-sm text-stone-400">No direct income yet.</p>}
        {sorted.map(row => {
          const accent = deptAccent(row.income);
          return (
            <div key={row.id} className="flex items-stretch overflow-hidden rounded-[14px] border border-stone-200/50 bg-white">
              <div className="w-[3.5px] flex-shrink-0 self-stretch" style={{ background: accent }} />
              <div className="flex-1 px-3 py-3 min-w-0">
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-bold text-stone-900 line-clamp-2 leading-tight">{row.client}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap" style={{ background: accent + "20", color: accent }}>{row.income}</span>
                      <span className="text-[11px] text-stone-400 tabular-nums">{displayDate(row.date)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 -mt-0.5 -mr-1">
                    <span className="text-[13px] font-black text-stone-900 tabular-nums whitespace-nowrap">{usd(row.amount)}</span>
                    <IconBtn onClick={e => { e.stopPropagation(); onEdit(row); }} type="edit" />
                    <IconBtn onClick={e => { e.stopPropagation(); onDelete(row.id); }} type="delete" />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Desktop: compact table, newest first */}
      <div className="hidden sm:block overflow-x-auto rounded-[18px] border border-stone-200/50">
        {!sorted.length
          ? <p className="py-8 text-center text-sm text-stone-400">No direct income yet.</p>
          : <table className="w-full min-w-[420px]">
              <thead className="bg-stone-50/80 border-b border-stone-200/50">
                <tr>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">Date</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">Client</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">Income Type</th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">Amount</th>
                  <th className="px-3 py-2.5 w-[72px]" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const accent = deptAccent(row.income);
                  return (
                    <tr key={row.id} className={`${i % 2 === 1 ? "bg-stone-50/40" : "bg-white"} border-t border-stone-100 hover:bg-stone-50/70 transition-colors`}>
                      <td className="px-3 py-2.5 text-[12px] text-stone-500 tabular-nums whitespace-nowrap">{displayDate(row.date)}</td>
                      <td className="px-3 py-2.5 text-[12.5px] font-semibold text-stone-900">{row.client}</td>
                      <td className="px-3 py-2.5">
                        <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap" style={{ background: accent + "20", color: accent }}>{row.income}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-[13px] font-bold tabular-nums text-stone-900 whitespace-nowrap">{usd(row.amount)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <IconBtn onClick={e => { e.stopPropagation(); onEdit(row); }} type="edit" />
                          <IconBtn onClick={e => { e.stopPropagation(); onDelete(row.id); }} type="delete" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        }
      </div>
    </>
  );
}

function PricingTable({ rows, onEdit, onDelete }: { rows: PricingRow[]; onEdit: (row: PricingRow) => void; onDelete: (id: number) => void }) {
  return (
    <>
      {/* Mobile: cards */}
      <div className="flex flex-col gap-2 sm:hidden">
        {!rows.length && <p className="py-8 text-center text-sm text-stone-400">No prices yet.</p>}
        {rows.map(row => {
          const accent = deptAccent(row.department);
          return (
            <div key={row.id} className="flex items-stretch overflow-hidden rounded-[14px] border border-stone-200/50 bg-white">
              <div className="w-[3.5px] flex-shrink-0 self-stretch" style={{ background: accent }} />
              <div className="flex-1 px-3 py-3 min-w-0">
                <div className="flex items-start justify-between gap-1 mb-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-bold text-stone-900 line-clamp-2 leading-tight">{row.photoPackage}</p>
                    {row.hotel && <p className="text-[11px] font-medium text-stone-500 mt-0.5 truncate">{row.hotel}</p>}
                    <span className="mt-1 inline-block text-[9px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap" style={{ background: accent + "20", color: accent }}>{row.department}</span>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 -mt-0.5 -mr-1">
                    <IconBtn onClick={e => { e.stopPropagation(); onEdit(row); }} type="edit" />
                    <IconBtn onClick={e => { e.stopPropagation(); onDelete(row.id); }} type="delete" />
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-2 border-t border-stone-100">
                  <span className="text-[10px] text-stone-400 whitespace-nowrap">HT <span className="font-semibold text-stone-700">{money(row.ht)}</span></span>
                  <span className="text-[10px] text-stone-400 whitespace-nowrap">TVA <span className="font-medium text-stone-500">{money(calculateTax(row.ht))}</span></span>
                  <span className="text-[10px] text-stone-400 whitespace-nowrap">TTC <span className="font-black text-stone-900">{money(calculateFinalAmount(row.ht))}</span></span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Desktop: compact table */}
      <div className="hidden sm:block overflow-x-auto rounded-[18px] border border-stone-200/50">
        {!rows.length
          ? <p className="py-8 text-center text-sm text-stone-400">No prices yet.</p>
          : <table className="w-full min-w-[440px]">
              <thead className="bg-stone-50/80 border-b border-stone-200/50">
                <tr>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">Hotel</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">Package</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400">Department</th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 whitespace-nowrap">HT</th>
                  <th className="px-3 py-2.5 w-[72px]" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const accent = deptAccent(row.department);
                  return (
                    <tr key={row.id} className={`${i % 2 === 1 ? "bg-stone-50/40" : "bg-white"} border-t border-stone-100 hover:bg-stone-50/70 transition-colors`}>
                      <td className="px-3 py-2.5 text-[12px] text-stone-600 whitespace-nowrap">{row.hotel}</td>
                      <td className="px-3 py-2.5 text-[12.5px] font-semibold text-stone-900">{row.photoPackage}</td>
                      <td className="px-3 py-2.5">
                        <span className="text-[9px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap" style={{ background: accent + "20", color: accent }}>{row.department}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-[13px] font-bold tabular-nums text-stone-900 whitespace-nowrap">{money(row.ht)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <IconBtn onClick={e => { e.stopPropagation(); onEdit(row); }} type="edit" />
                          <IconBtn onClick={e => { e.stopPropagation(); onDelete(row.id); }} type="delete" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        }
      </div>
    </>
  );
}
function InvoicePreview({ invoice, onSaved }: { invoice: GeneratedInvoice; onSaved?: (saved: boolean) => void }) {
  const rows = Array.isArray(invoice.rows) ? invoice.rows : [];
  const [saving, setSaving] = React.useState(false);
  const [savedToDocs, setSavedToDocs] = React.useState<boolean | null>(null);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSavedToDocs(null);
    const saved = await saveInvoiceToDocuments(invoice);
    setSavedToDocs(saved);
    setSaving(false);
    onSaved?.(saved);
  }

  return (
    <div className="invoice-print rounded-[28px] bg-[#fbf7ef] border border-stone-200 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-stone-400">Invoice preview</p>
          <h2 className="mt-2 text-3xl font-light">{invoice.invoiceNumber}</h2>
          <p className="mt-0.5 text-xs text-stone-400">{invoice.invoiceDate} · {invoice.month}</p>
        </div>
        <div className="no-print flex flex-col items-end gap-1.5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-2 text-xs text-white disabled:opacity-60 transition"
          >
            {saving ? (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            ) : (
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            )}
            Save PDF
          </button>
          {savedToDocs === true && (
            <span className="flex items-center gap-1 text-[9px] font-medium text-emerald-600">
              <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Saved to Documents
            </span>
          )}
          {savedToDocs === false && (
            <span className="text-[9px] text-stone-400">Documents folder not connected</span>
          )}
        </div>
      </div>
      <div className="mt-6 rounded-[24px] bg-white/60 p-3 border border-stone-100">
        <div className="mb-4">
          <p className="text-[10px] uppercase tracking-[0.2em] text-stone-400">Billed to</p>
          <h3 className="mt-1 text-lg font-medium">{invoice.hotel.name}</h3>
          <p className="text-xs text-stone-400">{invoice.hotel.address}</p>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full text-sm leading-snug">
            <thead>
              <tr className="border-b border-stone-200 text-left text-stone-400">
                <th className="pb-2 font-normal">Client</th>
                <th className="pb-2 font-normal">Hotel</th>
                <th className="pb-2 font-normal">Package</th>
                <th className="pb-2 text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-stone-400">No rows.</td></tr>}
              {rows.map(row => (
                <tr key={row.id} className="border-b border-stone-100">
                  <td className="py-1 font-medium">{row.client}</td>
                  <td className="py-1">{row.hotel}</td>
                  <td className="py-1">{row.photoPackage}</td>
                  <td className="py-1 text-right font-semibold">{money(row.finalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-5 flex justify-end">
          <div className="w-full rounded-3xl bg-stone-200 p-4 md:w-72">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-stone-700">Total TTC</span>
              <span className="flex items-baseline gap-1">
                <span className="text-xl font-bold text-stone-900">{numberOnly(invoice.totalTTC)}</span>
                <span className="text-xs text-stone-500">XPF</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Normalize a title for fuzzy duplicate matching: lowercase, strip punctuation, collapse spaces
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Dedup calendarEvents keeping the "best" version of each event:
//   - prefer events with googleEventId
//   - prefer events with time/endTime
//   - preserve imported:true from ANY duplicate
// Groups by: googleEventId → normalized title+date → title+date
function dedupeCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  // Score: higher = preferred. googleEventId > has time > has endTime
  function score(e: CalendarEvent): number {
    return (e.googleEventId ? 4 : 0) + (e.time ? 2 : 0) + (e.endTime ? 1 : 0);
  }

  // Group events into clusters of duplicates.
  // Two events are the same only if they share a googleEventId OR
  // have the same normalized title+date+time (time-slot match).
  // Events with different start times on the same day are NEVER merged —
  // they are distinct shoots that happen to have similar titles.
  type Cluster = { events: CalendarEvent[] };
  const clusters: Cluster[] = [];
  const byGoogleId = new Map<string, Cluster>();
  const byNormKey  = new Map<string, Cluster>();

  for (const ev of events) {
    let cluster: Cluster | undefined;

    if (ev.googleEventId) {
      cluster = byGoogleId.get(ev.googleEventId);
    }
    if (!cluster) {
      // Include time in key: same title + same time = same event; different time = different event
      const timeSlot = ev.time ?? "";
      const normKey = `${ev.date}__${timeSlot}__${normalizeTitle(ev.title)}`;
      cluster = byNormKey.get(normKey);
    }

    if (cluster) {
      cluster.events.push(ev);
    } else {
      cluster = { events: [ev] };
      clusters.push(cluster);
    }

    if (ev.googleEventId) byGoogleId.set(ev.googleEventId, cluster);
    const timeSlot = ev.time ?? "";
    const normKey = `${ev.date}__${timeSlot}__${normalizeTitle(ev.title)}`;
    byNormKey.set(normKey, cluster);
  }

  // Merge each cluster into a single best event
  return clusters.map(({ events: group }) => {
    const sorted = [...group].sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const anyImported = group.some(e => e.imported);
    const time = group.find(e => e.time)?.time ?? best.time;
    const endTime = group.find(e => e.endTime)?.endTime ?? best.endTime;
    const googleEventId = group.find(e => e.googleEventId)?.googleEventId ?? best.googleEventId;
    return { ...best, time, endTime, googleEventId, imported: anyImported || best.imported };
  });
}

interface CalendarPanelProps {
  calendarEvents: CalendarEvent[];
  importCalendarFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  addCalendarEventAsShoot: (event: CalendarEvent) => void;
  clearCalendarEvents: () => void;
  rebuildCalendarCache: () => void;
  gcalAccessToken: string | null;
  gcalCalendars: GCalendarListEntry[];
  gcalSelectedIds: Set<string>;
  setGcalSelectedIds: (ids: Set<string>) => void;
  gcalLoading: boolean;
  gcalError: string | null;
  gapiReady: boolean;
  gcalHasWriteScope: boolean;
  connectGoogle: (writeScope?: boolean) => void;
  disconnectGoogle: () => void;
  syncGoogleCalendar: () => void;
  shoots: Shoot[];
  directIncome: DirectRow[];
  sheetJobs?: SheetJob[];
  pricing: PricingRow[];
  onQuickAddShoot?: (data: { date: string; hotel: string; client: string; eventType: string; photoPackage: string }) => void;
  onAddToEditing?: (event: CalendarEvent, result: { type: "resort" | "direct" | "editing_only"; shoot?: Shoot; directRow?: DirectRow; editingJob: NewEditingJob }) => void;
  onRemoveFromAccounting?: (event: CalendarEvent) => Promise<void>;
  onRemoveFromShoots?: (event: CalendarEvent) => Promise<void>;
  onRemoveFromDirect?: (event: CalendarEvent) => Promise<void>;
  onRemoveFromEditing?: (event: CalendarEvent, jobs: SheetJob[]) => void;
  onRemoveFromCalendar?: (event: CalendarEvent) => void;
  onDeleteFromGoogle?: (event: CalendarEvent) => void;
  onSaveToGoogleCalendar?: (event: CalendarEvent) => Promise<void>;
  onUpdateCalendarEvent?: (original: CalendarEvent, updated: CalendarEvent) => Promise<void>;
  onAddManualCalendarEvent?: (eventData: { date: string; time?: string; endTime?: string; title: string; description: string; location: string }) => Promise<void>;
  isAdmin?: boolean;
  showDebugStats?: boolean;
}

// ─── Calendar helpers ────────────────────────────────────────────────────────

const HOTEL_DOT_COLORS: Record<string, string> = {
  "Four Seasons": "#c2a96e",
  "Westin":       "#b0b8b4",
  "Le Bora Bora": "#c26e6e",
  "Le Moana":     "#c2aa8a",
  "Thalasso":     "#8aac9e",
  "St. Regis":    "#c8a882",
  "Conrad":       "#9aaa96",
  "Mainland":     "#a8a29e",
};

const PERSONAL_KEYWORDS = [
  "birthday", "anniversaire de", "dentist", "doctor", "médecin",
  "reminder", "rappel", "haircut", "grocery", "gym",
  "hotel check", "check-in", "check-out",
  "maintenance", "meeting", "réunion", "test event",
  "personal", "perso",
  // Unambiguous travel/blocking words (NOT "confirm", "family" — those can be shoot types)
  "family trip", "travel", "voyage",
  "rest day", "off day",
];

// Short hotel abbreviations used in GCal titles — treated as hard photoshoot signals.
// Named GCAL_HOTEL_ABBREVS to avoid collision with the invoice HOTEL_CODES map above.
const GCAL_HOTEL_ABBREVS = ["cnr", "fsbb", "str", "lbb", "lmo", "ict", "wst", "mnt"];

// Keywords that positively identify a photography booking.
const PHOTO_KEYWORDS = [
  "photo", "photos", "shoot", "shooting", "session", "séance",
  "honeymoon", "lune de miel",
  "wedding", "mariage",
  "babymoon",
  "proposal", "demande",
  "engagement",
  "couple", "couples",
  "portrait",
  "family session", "famille",
  "maternity",
  "anniversary", "anniversaire photo",
  "boudoir",
  "ceremony", "reception",
];

// Test whether an event is a photography booking.
// Photoshoot-positive check ALWAYS runs before personal check:
// if a hotel name or hotel code appears, it is a shoot regardless of other words.
function isPhotographyEvent(event: CalendarEvent): boolean {
  const title = (event.title || "").toLowerCase();
  const desc  = (event.description || "").toLowerCase();
  const combined = title + " " + desc;
  // 1. Hard positive: hotel name in title/description → always a shoot
  if (Object.keys(HOTEL_DOT_COLORS).some(h => combined.includes(h.toLowerCase()))) return true;
  // 2. Hard positive: hotel code in title/description → always a shoot
  if (GCAL_HOTEL_ABBREVS.some(c => {
    // Match as whole word boundary to avoid false positives (e.g. "str" in "strategy")
    const re = new RegExp(`\\b${c}\\b`, "i");
    return re.test(combined);
  })) return true;
  // 3. Personal keywords block — only check after hotel guards fail
  if (PERSONAL_KEYWORDS.some(k => title.includes(k))) return false;
  // 4. Photo keywords → shoot
  if (PHOTO_KEYWORDS.some(k => combined.includes(k))) return true;
  return false;
}

// ─── Strict Analytics Counter ────────────────────────────────────────────────
// Used ONLY by Calendar Analytics — stricter than isPhotographyEvent.
// Requirements: hotel in TITLE + photoshoot keyword in TITLE + not excluded.

const ANALYTICS_EXCLUDE = /birthday|bday|family\s*birthday|papa|mama|\bkids\b|school|doctor|dentist|\blunch\b|\bdinner\b|flight|\btravel\b|holiday|vacation|\bblocked\b|unavailable|\boff\b|day\s*off|\bpersonal\b|reminder|cancelled|canceled|tentative|\bmaybe\b|\bhold\b|\boption\b|\bdraft\b/i;

const ANALYTICS_SHOOT_KEYWORDS = /photoshoot|photo\s*shoot|\bshoot\b|\bphotos?\b|wedding|honeymoon|proposal|engagement|anniversary|portrait|family\s*shoot|babymoon|session|ceremony|reception|boudoir|maternity|couple/i;

function isConfirmedHotelPhotoshoot(event: CalendarEvent): boolean {
  const title = (event.title || "").trim();
  if (!title) return false;
  // Hotel must appear in TITLE — not location or description
  const hotelInTitle = extractHotelFromText(title);
  if (!hotelInTitle) return false;
  // If title matches slash-format (Hotel / ... - Client) the slash alone is strong
  // evidence it's a shoot entry, so skip the keyword requirement for that format
  const isSlashFormat = /^[^/]+\/[^-]+-/.test(title);
  if (!isSlashFormat && !ANALYTICS_SHOOT_KEYWORDS.test(title)) return false;
  // Hard exclude: personal / cancelled keywords anywhere in title
  if (ANALYTICS_EXCLUDE.test(title)) return false;
  return true;
}

// Returns the hotel name detected from the TITLE only (for strict analytics)
function getAnalyticsHotel(event: CalendarEvent): string {
  return extractHotelFromText((event.title || "").trim());
}


function isPersonalEvent(event: CalendarEvent): boolean {
  const title = (event.title || "").toLowerCase();
  const desc  = (event.description || "").toLowerCase();
  const combined = title + " " + desc;

  // Hard guard: any hotel name or code → definitely NOT personal
  if (Object.keys(HOTEL_DOT_COLORS).some(h => combined.includes(h.toLowerCase()))) return false;
  if (GCAL_HOTEL_ABBREVS.some(c => {
    const re = new RegExp(`\\b${c}\\b`, "i");
    return re.test(combined);
  })) return false;
  // Hard guard: photo/shoot keywords → not personal
  if (PHOTO_KEYWORDS.some(k => combined.includes(k))) return false;

  // Clear personal/blocking signals (ambiguous words like "family", "confirm" excluded)
  const PERSONAL_STRONG = [
    "family trip", "travel", "voyage",
    "vacation", "holiday", "day off", "congé", "off day", "rest day",
    "personal", "perso",
    "blocked", "unavailable", "not available", "private",
    "flight",
    "trip",
  ];
  if (PERSONAL_STRONG.some(k => title.includes(k) || desc.includes(k))) return true;

  // Fallback: if it has no photoshoot signals and has a real title → treat as personal
  return !isPhotographyEvent(event) && (event.title || "").trim().length > 0;
}

// Short label for a personal event displayed in calendar cells and day sheet.
function personalEventLabel(event: CalendarEvent): string {
  const title = (event.title || "").trim();
  if (!title) return "Personal";
  // Return up to ~18 chars
  return title.length > 18 ? title.slice(0, 17) + "…" : title;
}

// Category label shown in the modal badge for personal events.
function personalCategoryLabel(event: CalendarEvent): string {
  const title = (event.title || "").toLowerCase();
  const desc  = (event.description || "").toLowerCase();
  if (["trip", "travel", "voyage"].some(k => title.includes(k) || desc.includes(k))) return "Trip / Travel";
  if (["family", "famille"].some(k => title.includes(k) || desc.includes(k))) return "Family";
  if (["blocked", "block", "hold"].some(k => title.includes(k))) return "Blocked";
  if (["vacation", "holiday", "day off", "congé"].some(k => title.includes(k))) return "Vacation";
  if (["confirmed", "confirm"].some(k => title.includes(k))) return "Confirmed";
  if (["personal", "perso"].some(k => title.includes(k))) return "Personal";
  return "Personal";
}

function getDateBucket(dateStr: string): "today" | "tomorrow" | "week" | "upcoming" | "past" {
  return getDateBucketTahiti(dateStr);
}
function daysUntil(dateStr: string): number {
  return daysUntilTahiti(dateStr);
}

function formatTime(time?: string): string {
  if (!time) return "";
  const [hStr, mStr] = time.split(":");
  const h = parseInt(hStr, 10);
  const m = mStr || "00";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${period}`;
}

// Sage-green time block: clock icon + start [→ end] — used in all cards and modal
const TIME_COLOR = "#6b9e82";

function TimeBlock({
  time, endTime, size = "md", showMissing = false,
}: {
  time?: string;
  endTime?: string;
  size?: "sm" | "md" | "lg";
  showMissing?: boolean;
}) {
  const sz = {
    sm: { clock: "h-2.5 w-2.5", text: "text-[10px]", arrow: "h-2.5 w-2.5", missing: "text-[9px]" },
    md: { clock: "h-3 w-3",     text: "text-[12px]", arrow: "h-2.5 w-2.5", missing: "text-[10px]" },
    lg: { clock: "h-3.5 w-3.5", text: "text-[14px]", arrow: "h-3 w-3",     missing: "text-[11px]" },
  }[size];

  if (!time) {
    if (!showMissing) return null;
    return (
      <div className="flex items-center gap-1 opacity-40">
        <svg className={`${sz.clock} flex-shrink-0 text-stone-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span className={`${sz.missing} text-stone-400 italic`}>Time not detected</span>
      </div>
    );
  }

  const startLabel = formatTime(time);
  const endLabel = endTime ? formatTime(endTime) : "";

  return (
    <div className="flex items-center gap-1.5" style={{ color: TIME_COLOR }}>
      <svg className={`${sz.clock} flex-shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
      <span className={`${sz.text} font-semibold tabular-nums`}>{startLabel}</span>
      {endLabel && (
        <>
          <svg className={`${sz.arrow} flex-shrink-0 opacity-50`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>
          </svg>
          <span className={`${sz.text} font-semibold tabular-nums`}>{endLabel}</span>
        </>
      )}
    </div>
  );
}

// Parse a time string like "4:30pm", "6am", "10:00", "16:30", "sunrise", "sunset"
// Returns "HH:MM" 24h string or undefined
function parseTimeFromText(text: string): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();

  // Named times
  if (/\bsunrise\b/.test(t)) return "06:00";
  if (/\bsunset\b/.test(t)) return "16:30";
  if (/\bgolden hour\b/.test(t)) return "16:30";

  // "at 4:30pm", "at 6am", "from 10:00", "starting 14:00"
  // Also plain "4:30 PM" / "4:30PM" / "04:30"
  const patterns = [
    // hh:mm am/pm
    /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i,
    // h am/pm (no minutes)
    /\b(\d{1,2})\s*(am|pm)\b/i,
    // hh:mm (24h, no am/pm — only if h 0-23, mm 0-59)
    /\b([01]?\d|2[0-3]):([0-5]\d)\b/,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let h = parseInt(m[1], 10);
    const mins = m[2] && /\d/.test(m[2]) ? m[2].padStart(2, "0") : "00";
    const period = (m[3] || m[2] || "").toLowerCase();
    if (period === "pm" && h < 12) h += 12;
    if (period === "am" && h === 12) h = 0;
    if (h > 23) continue;
    return `${String(h).padStart(2, "0")}:${mins}`;
  }
  return undefined;
}

// Add minutes to an "HH:MM" time string, returns "HH:MM"
function addMinutes(timeStr: string, mins: number): string {
  const [h, m] = timeStr.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Package → shoot duration in minutes
function pkgToMinutes(pkg: string): number {
  if (pkg.startsWith("50"))  return 60;
  if (pkg.startsWith("100")) return 120;
  if (pkg.startsWith("150")) return 180;
  if (pkg.startsWith("200")) return 240;
  return 60; // default for custom/event
}

// Returns resolved {time, endTime} for display — falls back to text parsing when event fields are missing
function getEventDisplayTime(event: CalendarEvent): { time: string | undefined; endTime: string | undefined } {
  // Normalize empty strings to undefined so falsy checks work consistently
  let time: string | undefined = event.time || undefined;
  let endTime: string | undefined = event.endTime || undefined;

  // Fallback: parse from description then title when no stored time
  if (!time) {
    time = parseTimeFromText(event.description || "") ?? parseTimeFromText(event.title || "");
  }

  // Calculate end time from package when missing
  if (time && !endTime) {
    const pkg = extractPackageFromText(event.title + " " + (event.description || "")) || "50 photos";
    endTime = addMinutes(time, pkgToMinutes(pkg));
  }

  return { time, endTime };
}

function cleanDescription(raw: string): string {
  if (!raw) return "";
  // Remove full HTML documents / meta headers
  let s = raw.replace(/<html[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*<\/html>/i, "");
  // Decode common HTML entities
  s = s
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#\d+;/g, " ");
  // Convert <br>, <p>, <div>, <li> to newlines
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div|li|tr)[^>]*>/gi, "\n");
  // Strip remaining HTML tags
  s = s.replace(/<[^>]+>/g, "");
  // Remove "This is an event reminder" boilerplate lines
  s = s.replace(/this is an? (event )?reminder[^\n]*/gi, "");
  // Collapse excessive whitespace/newlines
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function extractEmailsFromDescription(raw: string): string {
  if (!raw) return "";
  const cleaned = cleanDescription(raw);
  const matches = cleaned.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi);
  if (!matches) return "";
  return [...new Set(matches.map(e => e.toLowerCase()))].join(", ");
}

function relativeDateLabel(dateStr: string): string {
  const d = daysUntil(dateStr);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  if (d > 1 && d <= 7) {
    const [y, m, day] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, day).toLocaleDateString("en-US", { weekday: "long" });
  }
  const [y, mo, da] = dateStr.split("-").map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Quick-add shoot modal ────────────────────────────────────────────────────

function QuickAddShootModal({
  onSave, onClose,
}: {
  onSave: (data: { date: string; hotel: string; client: string; eventType: string; photoPackage: string }) => void;
  onClose: () => void;
}) {
  const today = tahitiDateStr();
  const [date, setDate] = React.useState(today);
  const [hotel, setHotel] = React.useState("Four Seasons");
  const [client, setClient] = React.useState("");
  const [eventType, setEventType] = React.useState("Honeymoon");
  const [photoPackage, setPhotoPackage] = React.useState("100 photos");

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function handleSave() {
    if (!client.trim()) return;
    onSave({ date, hotel, client: client.trim(), eventType, photoPackage });
    onClose();
  }

  const accentColor = HOTEL_DOT_COLORS[hotel] || "#a8a29e";

  const inputCls = "w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-[9px] sm:px-3.5 sm:py-2.5 text-[16px] md:text-[13px] text-stone-800 focus:border-stone-400 focus:bg-white focus:outline-none transition";
  const selectCls = "w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-[9px] sm:px-3.5 sm:py-2.5 text-[16px] md:text-[13px] text-stone-800 focus:border-stone-400 focus:bg-white focus:outline-none transition appearance-none";
  const labelCls = "block text-[9px] uppercase tracking-[0.12em] text-stone-400 font-semibold";

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-[2px]" />
      <div
        className="relative w-full md:max-w-sm md:rounded-[28px] rounded-t-[28px] bg-white shadow-[0_24px_80px_rgba(0,0,0,0.20)] flex flex-col modal-sheet"
        style={{ maxHeight: "82dvh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drag handle — mobile only */}
        <div className="md:hidden flex justify-center pt-2 pb-0 flex-shrink-0">
          <div className="h-1 w-10 rounded-full bg-stone-200" />
        </div>

        {/* Sticky header */}
        <div className="flex-shrink-0 border-b border-stone-100">
          <div className="h-[3px] w-full transition-all duration-300" style={{ background: accentColor }} />
          <div className="flex items-center justify-between px-4 pt-2.5 pb-2 sm:px-5 sm:pt-4 sm:pb-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-stone-400">Quick Add</p>
              <p className="text-[14px] sm:text-[15px] font-bold text-stone-900 leading-tight">New Shoot</p>
            </div>
            <button onClick={onClose} className="rounded-full p-1.5 text-stone-300 hover:bg-stone-100 hover:text-stone-600 transition -mr-1 flex-shrink-0">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="modal-body flex-1 overflow-y-auto overscroll-contain px-4 py-2.5 space-y-2 sm:px-5 sm:py-4 sm:space-y-4" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}>

          {/* Date + Hotel */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3">
            <div className="space-y-0.5">
              <label className={labelCls}>Date</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="space-y-0.5">
              <label className={labelCls}>Hotel</label>
              <select
                value={hotel}
                onChange={e => setHotel(e.target.value)}
                className={selectCls}
              >
                {HOTELS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-0.5">
            <label className={labelCls}>Client name</label>
            <input
              type="text"
              placeholder="e.g. Sarah & John"
              value={client}
              onChange={e => setClient(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
              autoFocus
              className={inputCls}
            />
          </div>

          {/* Occasion + Package */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3">
            <div className="space-y-0.5">
              <label className={labelCls}>Occasion</label>
              <select
                value={eventType}
                onChange={e => setEventType(e.target.value)}
                className={selectCls}
              >
                {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-0.5">
              <label className={labelCls}>Package</label>
              <select
                value={photoPackage}
                onChange={e => setPhotoPackage(e.target.value)}
                className={selectCls}
              >
                {PHOTO_PACKAGES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Sticky footer */}
        <div
          className="modal-footer flex-shrink-0 border-t border-stone-100 px-4 pt-2 space-y-1.5 sm:px-5 sm:pt-3 sm:space-y-2.5"
          style={{ paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}
        >
          <button
            onClick={handleSave}
            disabled={!client.trim()}
            className="w-full rounded-[14px] py-2.5 sm:py-3.5 text-[13px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: client.trim() ? accentColor : "#d4cfc9" }}
          >
            Add Shoot
          </button>
          <button
            onClick={onClose}
            className="w-full rounded-[14px] border border-stone-200 py-2 sm:py-3 text-[12.5px] font-medium text-stone-500 hover:bg-stone-50 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add to Sheet & Editing modal ────────────────────────────────────────────

// Hotels that bill through resort concierge and get auto-priced
// Mainland = direct client location, never resort-billed
const RESORT_HOTELS = ["Four Seasons", "St. Regis", "Conrad", "Le Moana", "Le Bora Bora", "Thalasso", "Westin"];

interface AddToSheetPayload {
  type: "resort" | "direct" | "editing_only";
  event: CalendarEvent;
  pricing: PricingRow[];
  onConfirm: (result: {
    type:         "resort" | "direct" | "editing_only";
    shoot?:       Shoot;
    directRow?:   DirectRow;
    editingJob:   NewEditingJob;
  }) => void;
  onClose: () => void;
}

const ALL_HOTELS_LIST = [...RESORT_HOTELS, "Mainland", "Unknown"] as const;

// ─── Add Calendar Event Modal ─────────────────────────────────────────────────

function AddCalendarEventModal({
  initialDate,
  gcalConnected,
  gcalHasWriteScope,
  onSave,
  onClose,
  onRequestWriteScope,
}: {
  initialDate?: string;
  gcalConnected: boolean;
  gcalHasWriteScope: boolean;
  onSave: (event: { date: string; time?: string; endTime?: string; title: string; description: string; location: string }) => void;
  onClose: () => void;
  onRequestWriteScope?: () => void;
}) {
  const today = tahitiDateStr();
  const [date,        setDate]        = React.useState(initialDate || today);
  const [title,       setTitle]       = React.useState("");
  const [time,        setTime]        = React.useState("");
  const [endTime,     setEndTime]     = React.useState("");
  const [description, setDescription] = React.useState("");
  const [location,    setLocation]    = React.useState("");

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function handleSave() {
    if (!title.trim() || !date) return;
    onSave({
      date,
      time:        time    || undefined,
      endTime:     endTime || undefined,
      title:       title.trim(),
      description: description.trim(),
      location:    location.trim(),
    });
    onClose();
  }

  const canSave = title.trim().length > 0 && date.length === 10;

  const inputCls = "w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-[9px] sm:px-3.5 sm:py-2.5 text-[16px] md:text-[13px] text-stone-800 outline-none focus:border-sky-300 focus:bg-white transition placeholder:text-stone-300";
  const labelCls = "block text-[9px] uppercase tracking-[0.12em] text-stone-400 font-semibold";

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-[2px]" />
      <div
        className="relative w-full md:max-w-sm md:rounded-[28px] rounded-t-[28px] bg-white shadow-[0_24px_80px_rgba(0,0,0,0.20)] flex flex-col modal-sheet"
        style={{ maxHeight: "82dvh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drag handle — mobile only */}
        <div className="md:hidden flex justify-center pt-2 pb-0 flex-shrink-0">
          <div className="h-1 w-10 rounded-full bg-stone-200" />
        </div>

        {/* Sticky header */}
        <div className="flex-shrink-0 border-b border-stone-100">
          <div className="h-[3px] w-full bg-sky-400" />
          <div className="flex items-center justify-between px-4 pt-2.5 pb-2 sm:px-5 sm:pt-4 sm:pb-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-sky-500">New Event</p>
              <p className="text-[14px] sm:text-[15px] font-bold text-stone-900 leading-tight">Calendar Event</p>
            </div>
            <button onClick={onClose} className="rounded-full p-1.5 text-stone-300 hover:bg-stone-100 hover:text-stone-600 transition -mr-1 flex-shrink-0">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        {/* Scrollable body — scrolls under keyboard on iOS */}
        <div className="modal-body flex-1 overflow-y-auto overscroll-contain px-4 py-2.5 space-y-2 sm:px-5 sm:py-4 sm:space-y-4" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}>

          <div className="space-y-0.5">
            <label className={labelCls}>Title</label>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && canSave) handleSave(); }}
              placeholder="e.g. Four Seasons — John Smith"
              className={inputCls}
            />
          </div>

          {/* Date + Start time side-by-side even on mobile */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <div className="space-y-0.5">
              <label className={labelCls}>Date</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="space-y-0.5">
              <label className={labelCls}>Start time</label>
              <input
                type="time"
                value={time}
                onChange={e => setTime(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {time && (
            <div className="space-y-0.5">
              <label className={labelCls}>End time</label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                className={inputCls}
              />
            </div>
          )}

          <div className="space-y-0.5">
            <label className={labelCls}>Location <span className="normal-case font-normal opacity-60">(optional)</span></label>
            <input
              type="text"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="e.g. Four Seasons Bora Bora"
              className={inputCls}
            />
          </div>

          <div className="space-y-0.5">
            <label className={labelCls}>Notes <span className="normal-case font-normal opacity-60">(optional)</span></label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Additional notes…"
              className={inputCls + " resize-none notes-area"}
            />
          </div>

          {gcalConnected && !gcalHasWriteScope && onRequestWriteScope && (
            <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5 flex items-start gap-2">
              <svg className="h-3.5 w-3.5 text-amber-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <div>
                <p className="text-[11px] text-amber-700 font-medium">Write permission needed to sync to Google Calendar.</p>
                <button onClick={onRequestWriteScope} className="mt-1 text-[10.5px] font-semibold text-amber-600 underline underline-offset-2">
                  Reconnect with write permission
                </button>
              </div>
            </div>
          )}
          {gcalConnected && gcalHasWriteScope && (
            <div className="flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5 text-sky-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <p className="text-[10px] text-sky-500 font-medium">Will sync to Google Calendar on save.</p>
            </div>
          )}
        </div>

        {/* Sticky footer with safe-area padding */}
        <div
          className="modal-footer flex-shrink-0 border-t border-stone-100 px-4 pt-2 space-y-1.5 sm:px-5 sm:pt-3 sm:space-y-2.5"
          style={{ paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}
        >
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="w-full rounded-[14px] bg-stone-900 py-2.5 sm:py-3.5 text-[13px] font-semibold text-white disabled:opacity-40 hover:bg-stone-700 active:scale-[0.98] transition"
          >
            {gcalConnected && gcalHasWriteScope ? "Save & Sync to Google Calendar" : "Save Event"}
          </button>
          <button
            onClick={onClose}
            className="w-full rounded-[14px] border border-stone-200 py-2 sm:py-3 text-[12.5px] font-medium text-stone-500 hover:bg-stone-50 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function AddToSheetModal({ type: initialType, event, pricing, onConfirm, onClose }: AddToSheetPayload) {
  const parsed = parseCalendarTitle(event);

  // Editable fields
  const [addType,      setAddType]      = React.useState<"resort" | "direct" | "editing_only">(initialType);
  const [hotel,        setHotel]        = React.useState(parsed.hotel || "Unknown");
  const [client,       setClient]       = React.useState(parsed.client || event.title);
  const [pkg,          setPkg]          = React.useState(parsed.pkg || "50 photos");
  const [occasion,     setOccasion]     = React.useState(parsed.eventType || "Honeymoon");
  const [notes,        setNotes]        = React.useState(extractEmailsFromDescription(event.description || ""));
  // Resort assignment
  const [department,   setDepartment]   = React.useState<"Concierge" | "Event">("Concierge");
  // Direct assignment
  const [directIncome, setDirectIncome] = React.useState(DIRECT_INCOME_OPTIONS[0]);
  const [saving,       setSaving]       = React.useState(false);

  const accentColor = HOTEL_DOT_COLORS[hotel] || "#a8a29e";

  const priceRow = addType === "resort"
    ? findPrice(pricing, hotel, pkg, department) ?? findPrice(pricing, hotel, pkg, "Concierge")
    : null;
  const ht = priceRow?.ht ?? 0;

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Auto-switch type when hotel changes
  function handleHotelChange(h: string) {
    setHotel(h);
    if (addType !== "editing_only") {
      setAddType(RESORT_HOTELS.includes(h) ? "resort" : "direct");
    }
  }

  async function handleSave() {
    setSaving(true);
    const editingJob: NewEditingJob = {
      date:           event.date,
      galleryName:    client.trim() || hotel,
      resort:         hotel,
      photoPackage:   pkg,
      occasion,
      notes,
      actor:          "Sasha",
      editingAddedAt: new Date().toISOString(),
    };
    console.log("[AddToSheet] type:", addType, "| job:", editingJob);

    if (addType === "resort") {
      const shoot: Shoot = {
        id:           Date.now(),
        date:         event.date,
        hotel,
        client:       client.trim() || hotel,
        eventType:    occasion,
        photoPackage: pkg,
        department,
        source:       "Resort",
        ht,
        tax:          calculateTax(ht),
        finalAmount:  calculateFinalAmount(ht),
        status:       "To invoice",
      };
      console.log("[AddToSheet] Shoot:", shoot);
      onConfirm({ type: "resort", shoot, editingJob });
    } else if (addType === "direct") {
      const directRow: DirectRow = {
        id:     Date.now(),
        date:   event.date,
        client: client.trim() || hotel,
        income: directIncome,
        amount: 0,
      };
      console.log("[AddToSheet] DirectRow:", directRow);
      onConfirm({ type: "direct", directRow, editingJob });
    } else {
      console.log("[AddToSheet] Editing only — job:", editingJob);
      onConfirm({ type: "editing_only", editingJob });
    }
    setSaving(false);
  }

  const btnLabel = addType === "resort"
    ? "Add to Resort + Editing"
    : addType === "direct"
    ? "Add to Direct + Editing"
    : "Add to Editing only";

  const SL = ({ children }: { children: React.ReactNode }) => (
    <p className="text-[8.5px] font-bold uppercase tracking-[0.15em] text-stone-400 mb-1.5">{children}</p>
  );
  const FL = ({ children }: { children: React.ReactNode }) => (
    <label className="block text-[9px] uppercase tracking-[0.12em] text-stone-400 font-semibold">{children}</label>
  );

  const inputCls = "w-full rounded-[12px] border border-stone-200 bg-stone-50 px-3 py-[9px] text-[16px] md:text-[13px] text-stone-800 focus:border-stone-400 focus:bg-white focus:outline-none transition";
  const selectCls = "w-full rounded-[12px] border border-stone-200 bg-stone-50 px-3 py-[9px] text-[16px] md:text-[13px] text-stone-800 focus:border-stone-400 focus:bg-white focus:outline-none transition appearance-none";

  return (
    <div className="fixed inset-0 z-[65] flex items-end md:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-stone-900/45 backdrop-blur-[2px]" />
      <div
        className="relative w-full md:max-w-sm md:rounded-[28px] rounded-t-[28px] bg-white shadow-[0_24px_80px_rgba(0,0,0,0.22)] flex flex-col modal-sheet"
        style={{ maxHeight: "82dvh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drag handle — mobile only */}
        <div className="md:hidden flex justify-center pt-2 pb-0 flex-shrink-0">
          <div className="h-1 w-10 rounded-full bg-stone-200" />
        </div>

        {/* Sticky header */}
        <div className="flex-shrink-0 border-b border-stone-100">
          <div className="h-[3px] w-full transition-all duration-300" style={{ background: accentColor }} />
          <div className="px-4 pt-2.5 pb-2 sm:px-5 sm:pt-4 sm:pb-3.5 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-stone-400">Add to Pipeline</p>
              <h3 className="text-[15px] font-bold text-stone-900 leading-tight truncate">{client || hotel}</h3>
              <p className="text-[10px] text-stone-400">{event.date}</p>
            </div>
            <button onClick={onClose} className="rounded-full p-1.5 text-stone-300 hover:bg-stone-100 hover:text-stone-600 transition flex-shrink-0 -mr-1">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div
          className="modal-body flex-1 overflow-y-auto overscroll-contain px-4 py-2.5 space-y-3 sm:px-5 sm:py-4 sm:space-y-5"
          style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
        >
          {/* ── Destination type selector ── */}
          <div>
            <SL>Destination</SL>
            <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
              {(["resort", "direct", "editing_only"] as const).map(t => {
                const sel = addType === t;
                const meta = {
                  resort:       { name: "Resort",  sub: "Shoots + Pipeline", icon: "🏨" },
                  direct:       { name: "Direct",  sub: "Direct + Pipeline", icon: "💳" },
                  editing_only: { name: "Editing", sub: "Pipeline only",     icon: "✂️" },
                };
                return (
                  <button
                    key={t}
                    onClick={() => setAddType(t)}
                    className="flex flex-col items-center gap-1 rounded-[12px] border-2 py-2.5 px-1.5 sm:py-3.5 text-center transition-all active:scale-[0.96]"
                    style={{
                      borderColor: sel ? accentColor : "#e7e5e4",
                      background:  sel ? accentColor : "#fafaf9",
                    }}
                  >
                    <span className="text-[11px] font-black leading-tight" style={{ color: sel ? "#fff" : "#78716c" }}>
                      {meta[t].name}
                    </span>
                    <span className="text-[8px] leading-tight" style={{ color: sel ? "rgba(255,255,255,0.75)" : "#a8a29e" }}>
                      {meta[t].sub}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Hotel picker ── */}
          <div>
            <SL>Hotel</SL>
            <div className="flex flex-wrap gap-1.5">
              {ALL_HOTELS_LIST.map(h => {
                const sel = hotel === h;
                const color = HOTEL_DOT_COLORS[h] || "#a8a29e";
                return (
                  <button
                    key={h}
                    onClick={() => handleHotelChange(h)}
                    className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-semibold border transition-all active:scale-[0.95]"
                    style={{
                      borderColor: sel ? color : "#e7e5e4",
                      background:  sel ? color : "#fafaf9",
                      color:       sel ? "#fff" : "#78716c",
                    }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: sel ? "rgba(255,255,255,0.6)" : color }} />
                    {h}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Event details ── */}
          <div className="space-y-2">
            <SL>Event details</SL>
            <div className="space-y-0.5">
              <FL>Client name</FL>
              <input
                value={client}
                onChange={e => setClient(e.target.value)}
                className={inputCls}
                placeholder="Client name…"
              />
            </div>
            {/* Package + Occasion side by side on mobile */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <FL>Package</FL>
                <select value={pkg} onChange={e => setPkg(e.target.value)} className={selectCls}>
                  {PHOTO_PACKAGES.map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <FL>Occasion</FL>
                <select value={occasion} onChange={e => setOccasion(e.target.value)} className={selectCls}>
                  {EVENT_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-0.5">
              <FL>Emails / notes</FL>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                className={inputCls + " resize-none"}
                placeholder="email@example.com"
              />
            </div>
          </div>

          {/* ── Resort: department ── */}
          {addType === "resort" && (
            <div>
              <SL>Department</SL>
              <div className="grid grid-cols-2 gap-2">
                {(["Concierge", "Event"] as const).map(d => {
                  const sel = department === d;
                  return (
                    <button
                      key={d}
                      onClick={() => setDepartment(d)}
                      className="rounded-[12px] border-2 py-2.5 text-[12px] font-bold transition-all active:scale-[0.96]"
                      style={{
                        borderColor: sel ? accentColor : "#e7e5e4",
                        background:  sel ? accentColor : "#fafaf9",
                        color:       sel ? "#fff" : "#78716c",
                      }}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 rounded-[12px] px-3 py-2" style={{ background: accentColor + "12" }}>
                {priceRow ? (
                  <p className="text-[11px] font-bold" style={{ color: accentColor }}>
                    {ht.toLocaleString()} XPF HT · {department}
                  </p>
                ) : (
                  <p className="text-[10.5px] text-stone-400">No price found for {hotel} / {pkg} / {department}</p>
                )}
              </div>
            </div>
          )}

          {/* ── Direct: income type ── */}
          {addType === "direct" && (
            <div>
              <SL>Direct income type</SL>
              <div className="flex flex-wrap gap-1.5">
                {DIRECT_INCOME_OPTIONS.map(opt => {
                  const sel = directIncome === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setDirectIncome(opt)}
                      className="rounded-full border-2 px-3 py-1.5 text-[11px] font-semibold transition-all active:scale-[0.95]"
                      style={{
                        borderColor: sel ? accentColor : "#e7e5e4",
                        background:  sel ? accentColor : "#fafaf9",
                        color:       sel ? "#fff" : "#78716c",
                      }}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[10px] text-stone-400">Amount will be 0 — fill it in the Direct tab after saving.</p>
            </div>
          )}

          {addType === "editing_only" && (
            <div className="rounded-[12px] bg-stone-50 border border-stone-100 px-3.5 py-2.5">
              <p className="text-[11px] text-stone-500 font-medium">Editing Pipeline only</p>
              <p className="text-[10px] text-stone-400 mt-0.5">No accounting entry will be created.</p>
            </div>
          )}
        </div>

        {/* Sticky footer */}
        <div
          className="modal-footer flex-shrink-0 border-t border-stone-100 px-4 pt-2 space-y-1.5 sm:px-5 sm:pt-3 sm:space-y-2.5"
          style={{ paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}
        >
          <button
            onClick={handleSave}
            disabled={saving || !client.trim()}
            className="w-full rounded-[14px] py-2.5 sm:py-3.5 text-[13px] font-bold text-white transition active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: accentColor }}
          >
            {saving ? "Adding…" : btnLabel}
          </button>
          <button
            onClick={onClose}
            className="w-full rounded-[14px] border border-stone-200 py-2 sm:py-3 text-[12.5px] font-medium text-stone-500 hover:bg-stone-50 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Event detail modal ───────────────────────────────────────────────────────

const MODAL_HOTELS = ["Four Seasons", "St. Regis", "Conrad", "Westin", "Le Bora Bora", "Le Moana", "Thalasso", "Mainland", "Unknown hotel"];
const MODAL_OCCASIONS = ["Honeymoon", "Wedding", "Anniversary", "Proposal", "Engagement", "Family", "Portrait", "Event", "Babymoon", "Other"];
const MODAL_PACKAGES = ["50 photos", "100 photos", "150 photos", "200 photos", "All photos", "Custom"];

function CalendarEventModal({
  event, onClose, shoots, directIncome, sheetJobs,
  gcalHasWriteScope,
  onAddWithType, onAddLegacy,
  onRemoveFromShoots, onRemoveFromDirect,
  onRemoveFromEditing, onRemoveFromCalendar,
  onDeleteFromGoogle, onSaveToGoogleCalendar, onRequestWriteScope,
  onUpdateEvent,
}: {
  event: CalendarEvent;
  onClose: () => void;
  shoots: Shoot[];
  directIncome: DirectRow[];
  sheetJobs?: SheetJob[];
  gcalHasWriteScope?: boolean;
  onAddWithType?: (type: "resort" | "direct" | "editing_only") => void;
  onAddLegacy?: () => void;
  onRemoveFromShoots?: () => Promise<void>;
  onRemoveFromDirect?: () => void;
  onRemoveFromEditing?: (jobs: SheetJob[]) => void;
  onRemoveFromCalendar?: () => void;
  onDeleteFromGoogle?: () => void;
  onSaveToGoogleCalendar?: () => void;
  onRequestWriteScope?: () => void;
  onUpdateEvent?: (original: CalendarEvent, updated: CalendarEvent) => Promise<void>;
}) {
  const { hotel, client, pkg, eventType, parsedFrom } = parseCalendarTitle(event);
  const isPersonal = isPersonalEvent(event);
  const personalCat = isPersonal ? personalCategoryLabel(event) : null;

  const matchingShoots = shoots.filter(s =>
    s.date === event.date &&
    (s.client.toLowerCase() === (client || "").toLowerCase() ||
     s.hotel.toLowerCase() === hotel.toLowerCase())
  );
  const isInShoots = matchingShoots.length > 0;

  const matchingJobs = (sheetJobs ?? []).filter(j => {
    const jDate = (j.herman.date || "").split("T")[0];
    if (jDate !== event.date) return false;
    const galleryLower = (j.herman.galleryName || "").toLowerCase();
    const clientLower  = (client || "").toLowerCase();
    const resortLower  = (j.herman.resort || "").toLowerCase();
    const hotelLower   = hotel.toLowerCase();
    return (clientLower && galleryLower.includes(clientLower)) ||
           (resortLower && hotelLower.includes(resortLower)) ||
           (hotelLower  && resortLower.includes(hotelLower));
  });
  const isInEditing = matchingJobs.length > 0;

  const matchingDirect = directIncome.filter(r =>
    r.date === event.date &&
    (client ? r.client.toLowerCase() === client.toLowerCase() : false)
  );
  const isInDirect = matchingDirect.length > 0;

  // Personal events use a neutral color; photoshoots use hotel color
  const dotColor = isPersonal ? "#c4bdb5" : (HOTEL_DOT_COLORS[hotel] || "#a8a29e");
  const [expanded,      setExpanded]      = React.useState(false);
  const [confirmAction, setConfirmAction] = React.useState<
    "remove_shoots" | "remove_direct" | "remove_editing" | "remove_calendar" | "delete_google" | null
  >(null);
  const [deletingGoogle, setDeletingGoogle] = React.useState(false);

  // ── Edit mode state ──
  const [editing,     setEditing]     = React.useState(false);
  const [saving,      setSaving]      = React.useState(false);
  const [saveError,   setSaveError]   = React.useState<string | null>(null);

  // Editable fields — initialised from parsed values
  const [editHotel,    setEditHotel]    = React.useState(hotel === "Unknown" ? "" : hotel);
  const [editClient,   setEditClient]   = React.useState(client);
  const [editOccasion, setEditOccasion] = React.useState(eventType || "Honeymoon");
  const [editPkg,      setEditPkg]      = React.useState(pkg || "50 photos");
  const [editDate,     setEditDate]     = React.useState(event.date);
  const [editTime,     setEditTime]     = React.useState(event.time || "");
  const [editEndTime,  setEditEndTime]  = React.useState(event.endTime || "");
  const [editNotes,    setEditNotes]    = React.useState(cleanDescription(event.description || ""));

  function enterEditMode() {
    // Re-initialise from current event values in case a sync updated them
    setEditHotel(hotel === "Unknown" ? "" : hotel);
    setEditClient(client);
    setEditOccasion(eventType || "Honeymoon");
    setEditPkg(pkg || "50 photos");
    setEditDate(event.date);
    setEditTime(event.time || "");
    setEditEndTime(event.endTime || "");
    setEditNotes(cleanDescription(event.description || ""));
    setSaveError(null);
    setEditing(true);
  }

  async function handleSave() {
    const hotelVal  = editHotel.trim() || "Unknown hotel";
    const clientVal = editClient.trim();
    // Rebuild title in canonical format: "Hotel — Client"
    const newTitle = clientVal ? `${hotelVal} — ${clientVal}` : hotelVal;

    const updatedEvent: CalendarEvent = {
      ...event,
      title:       newTitle,
      date:        editDate,
      time:        editTime  || undefined,
      endTime:     editEndTime || undefined,
      description: [editOccasion, editPkg, editNotes].filter(Boolean).join("\n"),
      location:    hotelVal,
    };

    setSaving(true);
    setSaveError(null);
    try {
      if (onUpdateEvent) {
        await onUpdateEvent(event, updatedEvent);
      }
      setEditing(false);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") { if (editing) setEditing(false); else onClose(); } };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, editing]);

  const notes      = cleanDescription(event.description || "");
  const noteLines  = notes ? notes.split("\n").filter(l => l.trim()) : [];
  const shortNotes = noteLines.slice(0, 3).join("\n");
  const hasMore    = noteLines.length > 3;

  const { time: dt, endTime: det } = getEventDisplayTime(event);
  const hasGoogleId = !!event.googleEventId;

  async function execConfirm() {
    if (confirmAction === "remove_shoots"  && onRemoveFromShoots)  { await onRemoveFromShoots(); onClose(); }
    else if (confirmAction === "remove_direct"   && onRemoveFromDirect)  { await onRemoveFromDirect(); onClose(); }
    else if (confirmAction === "remove_editing"  && onRemoveFromEditing) { onRemoveFromEditing(matchingJobs); onClose(); }
    else if (confirmAction === "remove_calendar" && onRemoveFromCalendar){ onRemoveFromCalendar(); onClose(); }
    else if (confirmAction === "delete_google"   && onDeleteFromGoogle)  {
      setDeletingGoogle(true);
      await onDeleteFromGoogle();
      setDeletingGoogle(false);
    }
  }

  // ── Reusable micro-components defined inline
  // Status badge
  function Badge({ active, label, activeColor }: { active: boolean; label: string; activeColor: string }) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 border text-[10px] font-semibold transition-all"
        style={active
          ? { background: activeColor + "12", borderColor: activeColor + "40", color: activeColor }
          : { background: "#f5f4f3", borderColor: "#e7e5e4", color: "#a8a29e" }
        }
      >
        {active
          ? <svg className="h-2.5 w-2.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
          : <svg className="h-2.5 w-2.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/></svg>
        }
        {label}
      </div>
    );
  }

  // Add action button
  function AddBtn({ type, label, sub, isAdded, icon }: {
    type: "resort" | "direct" | "editing_only";
    label: string;
    sub: string;
    isAdded: boolean;
    icon: React.ReactNode;
  }) {
    return (
      <button
        onClick={() => onAddWithType?.(type)}
        disabled={isAdded}
        className="flex flex-col items-start gap-1.5 rounded-[13px] border p-3 text-left transition-all disabled:cursor-default min-h-[72px]"
        style={{
          borderColor: isAdded ? "#e7e5e4" : dotColor + "50",
          background:  isAdded ? "#f9f8f7" : dotColor + "08",
        }}
      >
        <div className="flex items-center gap-1.5 w-full">
          <span style={{ color: isAdded ? "#c4bdb5" : dotColor }}>{icon}</span>
          <span className="text-[10.5px] font-bold leading-tight flex-1" style={{ color: isAdded ? "#c4bdb5" : "#292524" }}>{label}</span>
          {isAdded && (
            <svg className="h-3 w-3 flex-shrink-0" style={{ color: "#22c55e" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </div>
        <span className="text-[8.5px] font-medium pl-[18px]" style={{ color: isAdded ? "#c4bdb5" : "#a8a29e" }}>
          {isAdded ? "Already added" : sub}
        </span>
      </button>
    );
  }

  // Remove pill button
  function RemoveBtn({ action, label }: { action: typeof confirmAction; label: string }) {
    return (
      <button
        onClick={() => setConfirmAction(action)}
        className="rounded-[10px] border border-red-100 px-3 py-2 text-[10px] font-medium text-red-400 hover:bg-red-50 hover:border-red-200 transition"
      >{label}</button>
    );
  }

  // Confirm overlay
  const confirmMeta: Record<NonNullable<typeof confirmAction>, { title: string; note?: string; btnLabel: string; danger?: boolean }> = {
    remove_shoots:   { title: "Remove from Resort / Shoots?",   btnLabel: "Remove" },
    remove_direct:   { title: "Remove from Direct Income?",     btnLabel: "Remove" },
    remove_editing:  { title: "Remove from Editing Pipeline?",  note: "The Google Sheet row will be cleared.", btnLabel: "Remove from Pipeline" },
    remove_calendar: { title: "Remove from app Calendar?",      note: "This only removes the event from this app. Your Google Calendar is not affected.", btnLabel: "Remove from app" },
    delete_google:   { title: "Delete from Google Calendar?",   note: "This permanently deletes the event from your real Google Calendar. This cannot be undone.", btnLabel: "Delete from Google", danger: true },
  };

  // Shared input/select classes — h-11 on mobile (44px), auto height on desktop
  const inputCls  = "w-full h-11 px-3 text-[16px] rounded-2xl border border-stone-200 bg-stone-50 text-stone-800 placeholder:text-stone-300 outline-none focus:border-stone-400 focus:bg-white transition md:h-auto md:py-2.5 md:text-[11.5px] md:rounded-[10px]";
  const selectCls = "w-full h-11 px-3 text-[16px] rounded-2xl border border-stone-200 bg-stone-50 text-stone-800 outline-none focus:border-stone-400 focus:bg-white transition md:h-auto md:py-2.5 md:text-[11.5px] md:rounded-[10px]";
  const labelCls  = "block text-[10px] text-stone-500 font-medium mb-1 md:text-[9px] md:uppercase md:tracking-[0.1em] md:text-stone-400 md:mb-0.5";

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-[2px]" />
      <div
        className="relative w-full md:max-w-md rounded-t-[22px] md:rounded-[28px] bg-white border border-stone-200/60 shadow-[0_24px_80px_rgba(0,0,0,0.22)] overflow-y-auto md:overflow-hidden md:flex md:flex-col"
        style={{ maxHeight: "78dvh", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
        onClick={e => e.stopPropagation()}
      >
        {/* Mobile drag handle */}
        <div className="md:hidden flex justify-center pt-2 pb-0 flex-shrink-0">
          <div className="h-1 w-10 rounded-full bg-stone-200" />
        </div>

        {/* Header — sticky on mobile so it stays visible while body scrolls */}
        <div className="sticky top-0 z-10 bg-white flex-shrink-0">
          <div className="h-[3px] w-full" style={{ background: dotColor }} />
          <div className="px-4 py-2 border-b border-stone-100 md:px-5 md:pt-4 md:pb-3 md:border-b-0 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                <p className="text-[10px] uppercase tracking-[0.2em] text-stone-400">{relativeDateLabel(event.date)}</p>
                {!isPersonal && dt && <TimeBlock time={dt} endTime={det} size="sm" />}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {isPersonal ? (
                  <>
                    <h2 className="text-[17px] font-bold text-stone-900 leading-tight">{event.title || "Personal event"}</h2>
                    {personalCat && (
                      <span className="rounded-full px-2 py-0.5 text-[8.5px] font-semibold" style={{ background: "#f0ece8", color: "#78716c" }}>{personalCat}</span>
                    )}
                  </>
                ) : (
                  <>
                    <h2 className="text-[17px] font-bold text-stone-900 leading-tight">{hotel}</h2>
                    {parsedFrom === "default" && (
                      <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[8.5px] font-semibold text-amber-600">Unknown hotel</span>
                    )}
                  </>
                )}
              </div>
              {!isPersonal && client && <p className="text-[12.5px] text-stone-500 mt-0.5 truncate">{client}</p>}
              {isPersonal && event.description && (
                <p className="text-[11px] text-stone-500 mt-0.5 line-clamp-2">{event.description}</p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
              {onUpdateEvent && !editing && (
                <button
                  onClick={enterEditMode}
                  className="flex items-center gap-1 rounded-full border border-stone-200 px-2.5 py-1 text-[10px] font-medium text-stone-500 hover:border-stone-300 hover:bg-stone-50 hover:text-stone-700 transition"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  Edit
                </button>
              )}
              <button onClick={onClose} className="rounded-full p-1.5 text-stone-300 hover:bg-stone-100 hover:text-stone-600 transition">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2 md:flex-1 md:overflow-y-auto md:px-5 md:pb-5 md:space-y-5" style={{ scrollbarWidth: "none" } as React.CSSProperties}>
          {editing ? (
            /* ── EDIT MODE ── */
            <div className="space-y-2 md:space-y-3">
                  {!gcalHasWriteScope && (
                  <div className="rounded-[12px] border border-amber-200 bg-amber-50 px-3.5 py-3 space-y-1.5">
                    <p className="text-[11px] font-semibold text-amber-800">Write permission required</p>
                    <p className="text-[10px] text-amber-700 leading-relaxed">Reconnect Google Calendar with edit permission to update Google Calendar.</p>
                    {onRequestWriteScope && (
                      <button onClick={onRequestWriteScope} className="mt-1 text-[10.5px] font-semibold rounded-[10px] border border-amber-300 px-3 py-1.5 text-amber-700 hover:bg-amber-100 transition">
                        Reconnect with edit permission
                      </button>
                    )}
                  </div>
                  )}

                <div className="grid grid-cols-2 gap-1.5 md:gap-3">
                  <div>
                    <label className={labelCls}>Date</label>
                    <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Start time</label>
                    <input type="time" value={editTime} onChange={e => setEditTime(e.target.value)} placeholder="--:--" className={inputCls} />
                  </div>
                  <div className="col-span-2">
                    <label className={labelCls}>End time</label>
                    <input type="time" value={editEndTime} onChange={e => setEditEndTime(e.target.value)} placeholder="--:--" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Hotel / Title</label>
                  <select value={editHotel} onChange={e => setEditHotel(e.target.value)} className={selectCls}>
                    <option value="">— Select hotel —</option>
                    {MODAL_HOTELS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>

                <div>
                  <label className={labelCls}>Client name</label>
                  <input
                    type="text"
                    value={editClient}
                    onChange={e => setEditClient(e.target.value)}
                    placeholder="Client name…"
                    className={inputCls}
                  />
                </div>

                <div className="grid grid-cols-2 gap-1.5 md:gap-3">
                  <div>
                    <label className={labelCls}>Occasion</label>
                    <select value={editOccasion} onChange={e => setEditOccasion(e.target.value)} className={selectCls}>
                      {MODAL_OCCASIONS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Package</label>
                    <select value={editPkg} onChange={e => setEditPkg(e.target.value)} className={selectCls}>
                      {MODAL_PACKAGES.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder="Notes…"
                    rows={2}
                    className="w-full h-20 px-3 py-2 text-[16px] rounded-2xl border border-stone-200 bg-stone-50 text-stone-800 placeholder:text-stone-300 outline-none focus:border-stone-400 focus:bg-white transition resize-none md:h-auto md:py-2 md:text-[11.5px] md:rounded-[10px] mobile-textarea-compact"
                  />
                </div>

                {saveError && (
                  <p className="text-[10.5px] text-red-500 leading-relaxed">{saveError}</p>
                )}
              </div>
            ) : (
              /* ── VIEW MODE ── */
              <>
                {/* ── EVENT INFO ── */}
                <div className="rounded-[14px] border border-stone-100 bg-stone-50/50 divide-y divide-stone-100/80">
                  {[
                    { label: "Occasion", value: eventType || null },
                    { label: "Package",  value: pkg || null },
                    { label: "Location", value: event.location || null },
                  ].filter(r => r.value).map(r => (
                    <div key={r.label} className="flex items-baseline justify-between px-3.5 py-2 gap-3">
                      <span className="text-[9px] uppercase tracking-[0.15em] text-stone-400 font-medium flex-shrink-0">{r.label}</span>
                      <span className="text-[11px] font-semibold text-stone-700 text-right">{r.value}</span>
                    </div>
                  ))}
                  {noteLines.length > 0 && (
                    <div className="px-3.5 py-2.5">
                      <span className="text-[9px] uppercase tracking-[0.15em] text-stone-400 font-medium block mb-1">Notes</span>
                      <p className="text-[11px] text-stone-600 leading-relaxed whitespace-pre-wrap">
                        {expanded ? notes : shortNotes}{hasMore && !expanded ? "…" : ""}
                      </p>
                      {hasMore && (
                        <button onClick={() => setExpanded(v => !v)} className="mt-1 text-[10px] font-medium text-stone-400 hover:text-stone-600 transition">
                          {expanded ? "Show less" : "Read more"}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* ── CURRENT STATUS ── */}
                <div>
                  <p className="text-[8.5px] font-bold uppercase tracking-[0.2em] text-stone-400 mb-2">Current Status</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Badge active label="Calendar: Active" activeColor="#16a34a" />
                    <Badge active={isInShoots}  label="Resort / Shoots"    activeColor="#16a34a" />
                    <Badge active={isInDirect}  label="Direct Income"      activeColor="#0284c7" />
                    <Badge active={isInEditing} label="Editing Pipeline"   activeColor={dotColor} />
                  </div>
                </div>

                {/* ── ADD ACTIONS — hidden for personal/blocked events ── */}
                {!isPersonal && (onAddWithType || onAddLegacy) && (
                  <div>
                    <p className="text-[8.5px] font-bold uppercase tracking-[0.2em] text-stone-400 mb-2">Add to</p>
                    {onAddWithType ? (
                      <div className="grid grid-cols-3 gap-1.5">
                        <AddBtn
                          type="resort"
                          label="Resort"
                          sub="Shoots + Pipeline"
                          isAdded={isInShoots}
                          icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>}
                        />
                        <AddBtn
                          type="direct"
                          label="Direct"
                          sub="Direct tab + Pipeline"
                          isAdded={isInDirect}
                          icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
                        />
                        <AddBtn
                          type="editing_only"
                          label="Editing"
                          sub="Pipeline only"
                          isAdded={isInEditing}
                          icon={<svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
                        />
                      </div>
                    ) : (
                      <button
                        onClick={onAddLegacy}
                        disabled={isInShoots}
                        className="w-full flex items-center justify-center gap-2 rounded-[12px] py-2.5 text-[12px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-40"
                        style={{ background: dotColor }}
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        Add to Shoots
                      </button>
                    )}
                  </div>
                )}

                {/* ── REMOVE ACTIONS ── */}
                {(onRemoveFromCalendar || onRemoveFromShoots || onRemoveFromDirect || onRemoveFromEditing) && (
                  <div>
                    <p className="text-[8.5px] font-bold uppercase tracking-[0.2em] text-stone-400 mb-2">Remove from</p>

                    {confirmAction ? (
                      /* Inline confirm card */
                      <div className="rounded-[12px] border border-stone-200 bg-stone-50 px-4 py-3.5 space-y-2">
                        <p className="text-[12px] font-semibold text-stone-800">{confirmMeta[confirmAction].title}</p>
                        {confirmMeta[confirmAction].note && (
                          <p className="text-[10px] text-stone-500 leading-relaxed">{confirmMeta[confirmAction].note}</p>
                        )}
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={execConfirm}
                            disabled={deletingGoogle}
                            className="flex-1 rounded-[10px] py-2 text-[10.5px] font-semibold text-white transition disabled:opacity-50"
                            style={{ background: confirmMeta[confirmAction].danger ? "#ef4444" : "#78716c" }}
                          >
                            {deletingGoogle ? "Deleting…" : confirmMeta[confirmAction].btnLabel}
                          </button>
                          <button
                            onClick={() => setConfirmAction(null)}
                            className="flex-1 rounded-[10px] border border-stone-200 py-2 text-[10.5px] font-medium text-stone-500 hover:bg-white transition"
                          >Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {onRemoveFromCalendar && (
                          <button
                            onClick={() => setConfirmAction("remove_calendar")}
                            className="rounded-[10px] border border-stone-200 px-3 py-2 text-[10px] font-medium text-stone-500 hover:border-stone-300 hover:bg-stone-50 transition"
                          >App calendar view</button>
                        )}
                        {isInShoots && onRemoveFromShoots && (
                          <RemoveBtn action="remove_shoots"  label="Resort / Shoots" />
                        )}
                        {isInDirect && onRemoveFromDirect && (
                          <RemoveBtn action="remove_direct"  label="Direct Income" />
                        )}
                        {isInEditing && onRemoveFromEditing && (
                          <RemoveBtn action="remove_editing" label="Editing Pipeline" />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── GOOGLE CALENDAR ── */}
                {(hasGoogleId || onSaveToGoogleCalendar) && (
                  <div>
                    <p className="text-[8.5px] font-bold uppercase tracking-[0.2em] text-stone-400 mb-2">Google Calendar</p>
                    {gcalHasWriteScope ? (
                      <div className="space-y-2">
                        {onSaveToGoogleCalendar && confirmAction !== "delete_google" && (
                          <button
                            onClick={onSaveToGoogleCalendar}
                            className="w-full rounded-[13px] border border-sky-200 bg-sky-50 py-2 md:py-3 text-[11.5px] font-semibold text-sky-600 hover:bg-sky-100 transition"
                          >
                            {hasGoogleId ? "Update Google Calendar" : "Save to Google Calendar"}
                          </button>
                        )}
                        {hasGoogleId && onDeleteFromGoogle && confirmAction !== "delete_google" && (
                          <button
                            onClick={() => setConfirmAction("delete_google")}
                            className="w-full rounded-[13px] border border-red-200 py-2 md:py-3 text-[11.5px] font-semibold text-red-500 hover:bg-red-50 transition"
                          >
                            Delete from Google Calendar
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-[13px] border border-stone-100 bg-stone-50 px-4 py-3.5 space-y-2">
                        <p className="text-[11px] text-stone-600 font-medium">Write permission required.</p>
                        <p className="text-[10px] text-stone-400 leading-relaxed">Reconnect Google Calendar with edit permission to save or delete events.</p>
                        {onRequestWriteScope && (
                          <button
                            onClick={onRequestWriteScope}
                            className="mt-1 text-[10.5px] font-semibold rounded-[10px] border border-stone-200 px-3 py-2 text-stone-600 hover:bg-white transition"
                          >
                            Reconnect with edit permission
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Debug */}
                <p className="text-[8.5px] text-stone-200 select-none" title="Parser debug">parsed: {parsedFrom}</p>
              </>
            )}

        </div>

        {/* Footer — sticky on mobile so it sits above keyboard / browser bar */}
        <div
          className="sticky bottom-0 bg-white px-4 py-2 space-y-2 border-t border-stone-100 md:px-5 md:pt-3 md:flex-shrink-0"
          style={{ paddingBottom: "calc(8px + env(safe-area-inset-bottom))" }}
        >
          {editing ? (
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 h-11 text-[15px] rounded-2xl font-semibold text-white transition disabled:opacity-50 active:scale-[0.98] md:h-auto md:py-3 md:text-[12.5px] md:rounded-[14px]"
                style={{ background: dotColor }}
              >
                {saving ? "Saving…" : "Update Event"}
              </button>
              <button
                onClick={() => setEditing(false)}
                disabled={saving}
                className="h-11 text-[15px] rounded-2xl border border-stone-200 px-4 font-medium text-stone-500 hover:border-stone-300 hover:text-stone-700 transition md:h-auto md:py-3 md:text-[12.5px] md:rounded-[14px]"
              >Cancel</button>
            </div>
          ) : (
            <button
              onClick={onClose}
              className="w-full h-11 text-[15px] rounded-2xl border border-stone-200 font-medium text-stone-500 hover:border-stone-300 hover:text-stone-700 transition md:h-auto md:py-3 md:text-[12.5px] md:rounded-[14px]"
            >Close</button>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Horizontal date strip ────────────────────────────────────────────────────

// ─── Horizontal scrolling date strip (mobile top bar) ────────────────────────

function DateStrip({
  calendarEvents, shoots, selectedDate, onSelectDate,
}: {
  calendarEvents: CalendarEvent[];
  shoots: Shoot[];
  selectedDate: string;
  onSelectDate: (dateStr: string) => void;
}) {
  const today = tahitiDateStr();
  const [ty, tm] = today.split("-").map(Number);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const monthStr = `${ty}-${String(tm).padStart(2, "0")}`;
  const daysInMonth = new Date(ty, tm, 0).getDate();

  const eventDays = React.useMemo(() => {
    const set = new Set<string>();
    for (const e of calendarEvents) if (e.date.startsWith(monthStr)) set.add(e.date);
    for (const s of shoots) if (s.date.startsWith(monthStr)) set.add(s.date);
    return set;
  }, [calendarEvents, shoots, monthStr]);

  const eventColorMap = React.useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const e of calendarEvents) {
      if (e.date.startsWith(monthStr)) {
        const hotel = guessHotelFromCalendarEvent(e);
        const color = HOTEL_DOT_COLORS[hotel] || "#a8a29e";
        if (!map[e.date]) map[e.date] = [];
        if (!map[e.date].includes(color)) map[e.date].push(color);
      }
    }
    for (const s of shoots) {
      if (s.date.startsWith(monthStr)) {
        const color = HOTEL_DOT_COLORS[s.hotel] || "#a8a29e";
        if (!map[s.date]) map[s.date] = [];
        if (!map[s.date].includes(color)) map[s.date].push(color);
      }
    }
    return map;
  }, [calendarEvents, shoots, monthStr]);

  const days: { day: number; dateStr: string; dow: string }[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${ty}-${String(tm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dow = new Date(ty, tm - 1, d).toLocaleDateString("en-US", { weekday: "short" }).slice(0, 3).toUpperCase();
    days.push({ day: d, dateStr, dow });
  }

  React.useEffect(() => {
    const target = scrollRef.current?.querySelector(`[data-date="${selectedDate}"]`) as HTMLElement | null;
    if (target) { target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }); }
    else {
      const todayEl = scrollRef.current?.querySelector(`[data-date="${today}"]`) as HTMLElement | null;
      todayEl?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [selectedDate, today]);

  return (
    <div
      ref={scrollRef}
      className="flex gap-1 overflow-x-auto"
      style={{ WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none" }}
    >
      {days.map(({ day, dateStr, dow }) => {
        const isToday = dateStr === today;
        const isSelected = dateStr === selectedDate && !isToday;
        const hasEvent = eventDays.has(dateStr);
        const isPast = dateStr < today;
        const dotColors = eventColorMap[dateStr] ?? [];
        const visibleDots = dotColors.slice(0, 3);
        return (
          <button
            key={dateStr}
            data-date={dateStr}
            onClick={() => onSelectDate(dateStr)}
            className={`flex flex-col items-center flex-shrink-0 w-9 rounded-xl py-2 transition-all duration-150 active:scale-[0.92]
              ${isToday ? "bg-stone-900 shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
                : isSelected ? "bg-stone-100 border border-stone-200"
                : "hover:bg-stone-50"}`}
          >
            <span className={`text-[8px] font-semibold tracking-wider leading-none mb-1 ${isToday ? "text-stone-400" : isPast ? "text-stone-300" : "text-stone-400"}`}>{dow}</span>
            <span className={`text-[13px] font-bold leading-none tabular-nums ${isToday ? "text-white" : isPast ? "text-stone-300" : "text-stone-700"}`}>{day}</span>
            <div className="mt-1 h-[4px] flex items-center justify-center gap-[2px]">
              {hasEvent && visibleDots.length > 0
                ? visibleDots.map((c, i) => (
                    <span key={i} className="h-[3.5px] w-[3.5px] rounded-full flex-shrink-0"
                      style={{ background: isToday ? "rgba(255,255,255,0.5)" : c }} />
                  ))
                : <span className="h-[3.5px] w-[3.5px]" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Month mini grid (7-column proper calendar) ───────────────────────────────

// Shoot-type color scheme — no hotel colors
const SHOOT_TYPE_COLORS = {
  confirmed: { pill: "#4a7c59", pillBg: "#e8f2eb", dot: "#4a7c59" }, // Forest green
  family:    { pill: "#8c6d46", pillBg: "#f5eede", dot: "#c4a96e" }, // Warm sand/beige
  personal:  { pill: "#8a8278", pillBg: "#f0ece8", dot: "#b8b0a8" }, // Neutral
};

function isFamilyShoot(event: CalendarEvent): boolean {
  const title = (event.title || "").toLowerCase();
  const desc  = (event.description || "").toLowerCase();
  const combined = title + " " + desc;

  // Hotel/resort signal always wins — use same regex engine as the title parser
  // so "FS", "Four Season", "fsbb", "cnr", etc. are all caught
  if (extractHotelFromText(combined)) return false;

  // Only Family/personal when there are zero hotel signals
  const FAMILY_PERSONAL_WORDS = [
    "family", "famille", "personal", "perso", "vacation", "vacances",
    "birthday", "anniversaire", "kids", "private", "day off", "congé",
    "trip", "travel", "voyage", "holiday",
  ];
  return FAMILY_PERSONAL_WORDS.some(k => title.includes(k));
}

function MonthMiniGrid({
  calendarEvents, shoots, selectedDate, onSelectDate, onEventClick, showDebugStats,
}: {
  calendarEvents: CalendarEvent[];
  shoots: Shoot[];
  selectedDate: string;
  onSelectDate: (dateStr: string) => void;
  onEventClick?: (event: CalendarEvent) => void;
  showDebugStats?: boolean;
}) {
  const today = tahitiDateStr();
  const [ty, tm] = today.split("-").map(Number);
  const [viewYear, setViewYear] = React.useState(ty);
  const [viewMonth, setViewMonth] = React.useState(tm);

  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth - 1, 1).getDay(); // 0=Sun
  const monthStr = `${viewYear}-${String(viewMonth).padStart(2, "0")}`;

  // Monthly booking stats — counts photo shoots per year for the viewed month.
  // Uses only calendarEvents to avoid double-counting.
  const monthStats = React.useMemo(() => {
    const mm = String(viewMonth).padStart(2, "0");
    const byYear: Record<number, CalendarEvent[]> = {};
    const seenIds = new Set<string | number>();
    for (const e of calendarEvents) {
      if (!isPhotographyEvent(e)) continue;
      const parts = e.date.split("-");
      if (parts[1] !== mm) continue;
      if (seenIds.has(e.id)) continue;
      seenIds.add(e.id);
      const yr = parseInt(parts[0]);
      if (!byYear[yr]) byYear[yr] = [];
      byYear[yr].push(e);
    }
    const counts: Record<number, number> = {};
    for (const yr of Object.keys(byYear).map(Number)) counts[yr] = byYear[yr].length;
    const current = counts[viewYear] ?? 0;
    const prevCount = counts[viewYear - 1] ?? null;
    const diff = prevCount !== null ? current - prevCount : null;
    const prevYear = viewYear - 1;
    const currentEvents = byYear[viewYear] ?? [];
    const familyCount = currentEvents.filter(e => isFamilyShoot(e)).length;
    const confirmedCount = current - familyCount;
    if (showDebugStats) {
      const label = `[Stats] ${new Date(viewYear, viewMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}`;
      console.group(label);
      console.log(`Counted ${current} photo events for ${viewYear}:`);
      currentEvents.forEach(e => console.log(`  • ${e.date} — ${e.title}`));
      if (byYear[prevYear]) {
        console.log(`Counted ${counts[prevYear]} photo events for ${prevYear}:`);
        byYear[prevYear].forEach(e => console.log(`  • ${e.date} — ${e.title}`));
      }
      console.groupEnd();
    }
    return { counts, byYear, current, prevCount, diff, prevYear, familyCount, confirmedCount };
  }, [calendarEvents, viewMonth, viewYear, showDebugStats]);

  // Per-date shoot/event rows for inline cell display
  const shootsByDate = React.useMemo(() => {
    const HOTEL_CODE: Record<string, string> = {
      "Four Seasons": "FS", "Le Bora Bora": "LBB", "Le Moana": "LMO",
      "Thalasso": "ICT", "Westin": "WST", "St. Regis": "STR",
      "Conrad": "CNR", "Mainland": "MNL",
    };
    const to24 = (t: string): string => {
      const [h, m] = t.split(":");
      return `${String(parseInt(h)).padStart(2, "0")}:${(m || "00").slice(0, 2)}`;
    };

    const map: Record<string, {
      label: string;       // "CNR • 09:00" or personal title
      time24: string | null;
      sortKey: number;
      isPersonal?: boolean;
      isFamily?: boolean;
      title?: string;
      event?: CalendarEvent; // original event for direct-click
    }[]> = {};

    for (const e of calendarEvents) {
      if (!e.date.startsWith(monthStr)) continue;
      const personal = isPersonalEvent(e);
      if (personal) {
        if (!map[e.date]) map[e.date] = [];
        const label = personalEventLabel(e);
        map[e.date].push({ label, time24: null, sortKey: 8888, isPersonal: true, title: (e.title || "").trim(), event: e });
      } else {
        const hotel = guessHotelFromCalendarEvent(e);
        const code = HOTEL_CODE[hotel] || hotel.slice(0, 4).toUpperCase();
        const family = isFamilyShoot(e);
        const { time } = getEventDisplayTime(e);
        const time24 = time ? to24(time) : null;
        const sortKey = time ? parseInt(time.replace(":", "")) : 9999;
        const label = time24 ? `${code} • ${time24}` : code;
        if (!map[e.date]) map[e.date] = [];
        map[e.date].push({ label, time24, sortKey, isFamily: family, event: e });
      }
    }
    // Shoots (accounting tab) — add only if no calendar event exists for that date
    for (const s of shoots) {
      if (!s.date.startsWith(monthStr)) continue;
      if (!map[s.date]) map[s.date] = [];
      const code = HOTEL_CODE[s.hotel] || s.hotel.slice(0, 4).toUpperCase();
      const alreadyHas = map[s.date].some(r => !r.isPersonal && r.label.startsWith(code));
      if (!alreadyHas) {
        const family = (s.eventType || "").toLowerCase() === "family";
        map[s.date].push({ label: code, time24: null, sortKey: 9999, isFamily: family });
      }
    }
    for (const date of Object.keys(map)) {
      map[date].sort((a, b) => a.sortKey - b.sortKey);
    }
    return map;
  }, [calendarEvents, shoots, monthStr]);

  const prevMonth = () => { if (viewMonth === 1) { setViewYear(y => y - 1); setViewMonth(12); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 12) { setViewYear(y => y + 1); setViewMonth(1); } else setViewMonth(m => m + 1); };

  const monthLabel = new Date(viewYear, viewMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const DOW_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const WEEKEND_COLS = new Set([5, 6]); // Sa=5, Su=6 in Mon-first grid

  // Build grid cells: empty prefix + days (Monday-first)
  const cells: (number | null)[] = [];
  const firstDowMon = (new Date(viewYear, viewMonth - 1, 1).getDay() + 6) % 7; // 0=Mon
  for (let i = 0; i < firstDowMon; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="rounded-2xl bg-white border border-stone-200/60 shadow-sm overflow-hidden">

      {/* ── Header: month nav ── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-stone-100">
        <button
          onClick={prevMonth}
          className="h-7 w-7 flex items-center justify-center rounded-full hover:bg-stone-100 transition text-stone-400 hover:text-stone-700 active:scale-90"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>

        <div className="flex flex-col items-center gap-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-stone-800 tracking-tight">{monthLabel}</span>
            {(viewMonth !== tm || viewYear !== ty) && (
              <button
                onClick={() => { setViewYear(ty); setViewMonth(tm); onSelectDate(today); }}
                className="text-[9px] font-semibold text-stone-400 hover:text-stone-700 rounded-full border border-stone-200 px-2 py-0.5 transition"
              >Today</button>
            )}
          </div>

          {/* Summary stat bar */}
          {monthStats.current > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5">
                <span className="text-[9px] font-bold text-stone-600 tabular-nums">{monthStats.current}</span>
                <span className="text-[8px] text-stone-400 font-medium">Total</span>
              </span>
              {monthStats.confirmedCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: SHOOT_TYPE_COLORS.confirmed.pillBg }}>
                  <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: SHOOT_TYPE_COLORS.confirmed.dot }} />
                  <span className="text-[9px] font-bold tabular-nums" style={{ color: SHOOT_TYPE_COLORS.confirmed.pill }}>{monthStats.confirmedCount}</span>
                  <span className="text-[8px] font-medium" style={{ color: SHOOT_TYPE_COLORS.confirmed.pill + "99" }}>Confirmed</span>
                </span>
              )}
              {monthStats.familyCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: SHOOT_TYPE_COLORS.family.pillBg }}>
                  <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: SHOOT_TYPE_COLORS.family.dot }} />
                  <span className="text-[9px] font-bold tabular-nums" style={{ color: SHOOT_TYPE_COLORS.family.pill }}>{monthStats.familyCount}</span>
                  <span className="text-[8px] font-medium" style={{ color: SHOOT_TYPE_COLORS.family.pill + "99" }}>Family</span>
                </span>
              )}
              {monthStats.diff !== null && monthStats.prevCount !== null && monthStats.prevCount > 0 && (
                <span className={`text-[8px] font-medium tabular-nums ${monthStats.diff > 0 ? "text-emerald-500" : monthStats.diff < 0 ? "text-rose-400" : "text-stone-300"}`}>
                  {monthStats.diff > 0 ? "↑" : monthStats.diff < 0 ? "↓" : "="}{Math.abs(monthStats.diff)} vs {monthStats.prevYear}
                </span>
              )}
            </div>
          )}
        </div>

        <button
          onClick={nextMonth}
          className="h-7 w-7 flex items-center justify-center rounded-full hover:bg-stone-100 transition text-stone-400 hover:text-stone-700 active:scale-90"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>

      <div className="px-2 pt-2 pb-3">
        {/* DOW labels */}
        <div className="grid grid-cols-7 mb-1.5">
          {DOW_LABELS.map((d, col) => {
            const isWknd = WEEKEND_COLS.has(col);
            return (
              <div key={d} className={`flex items-center justify-center py-1 rounded-t-md ${isWknd ? "bg-stone-50/80" : ""}`}>
                <span className={`text-[9px] uppercase tracking-widest ${isWknd ? "font-extrabold text-stone-400" : "font-bold text-stone-300"}`}>{d}</span>
              </div>
            );
          })}
        </div>

        {/* Day cells grid */}
        <div className="grid grid-cols-7 gap-[3px]">
          {cells.map((day, idx) => {
            if (!day) return <div key={idx} className={`min-h-[64px] sm:min-h-[72px] ${WEEKEND_COLS.has(idx % 7) ? "bg-amber-50/30 rounded-xl" : ""}`} />;
            const dateStr = `${viewYear}-${String(viewMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const isToday = dateStr === today;
            const isSelected = dateStr === selectedDate;
            const isPast = dateStr < today;
            const isWknd = WEEKEND_COLS.has(idx % 7);
            const dayRows = shootsByDate[dateStr] ?? [];
            const shootRows    = dayRows.filter(r => !r.isPersonal);
            const personalRows = dayRows.filter(r => r.isPersonal);
            const shootCount   = shootRows.length;
            const visibleShoots = shootRows.slice(0, 2);
            const overflow = shootCount - 2;

            return (
              <button
                key={dateStr}
                onClick={() => onSelectDate(dateStr)}
                className={`
                  flex flex-col items-stretch rounded-xl transition-all duration-100 active:scale-[0.96]
                  min-h-[64px] sm:min-h-[72px] w-full overflow-hidden
                  ${isToday
                    ? "bg-stone-900 shadow-md"
                    : isSelected
                      ? "bg-stone-100 ring-1 ring-stone-300/60"
                      : dayRows.length > 0
                        ? `hover:bg-stone-50/80 ${isWknd ? "bg-amber-50/40" : "bg-white"}`
                        : `hover:bg-stone-50/40 ${isWknd ? "bg-amber-50/30" : "bg-white/60"}`}
                `}
              >
                {/* Day number row */}
                <div className="flex items-center justify-center pt-1.5 pb-1">
                  <span className={`
                    text-[13px] sm:text-[14px] font-bold tabular-nums leading-none
                    ${isToday ? "text-white" : isPast ? "text-stone-300" : isSelected ? "text-stone-800" : "text-stone-700"}
                  `}>
                    {day}
                  </span>
                </div>

                {/* Event pills */}
                <div className="flex flex-col gap-[2px] px-[3px] pb-[4px]">
                  {visibleShoots.map((row, i) => {
                    const colors = row.isFamily ? SHOOT_TYPE_COLORS.family : SHOOT_TYPE_COLORS.confirmed;
                    return (
                      <div
                        key={i}
                        role="button"
                        onClick={e => { if (row.event && onEventClick) { e.stopPropagation(); onEventClick(row.event); } }}
                        className="rounded-[5px] px-[4px] py-[2px] w-full overflow-hidden"
                        style={{
                          background: isToday ? "rgba(255,255,255,0.12)" : colors.pillBg,
                          cursor: row.event && onEventClick ? "pointer" : "inherit",
                        }}
                      >
                        <span
                          className="block text-[7px] font-bold leading-none truncate"
                          style={{ color: isToday ? "rgba(255,255,255,0.9)" : colors.pill }}
                        >
                          {row.label}
                        </span>
                      </div>
                    );
                  })}
                  {overflow > 0 && (
                    <span
                      className="text-[6.5px] font-semibold leading-none pl-[4px]"
                      style={{ color: isToday ? "rgba(255,255,255,0.4)" : "#a8a29e" }}
                    >
                      +{overflow} more
                    </span>
                  )}
                  {/* Personal / blocked events */}
                  {personalRows.slice(0, shootCount === 0 ? 2 : 1).map((row, i) => (
                    <div
                      key={`p${i}`}
                      role="button"
                      onClick={e => { if (row.event && onEventClick) { e.stopPropagation(); onEventClick(row.event); } }}
                      className="rounded-[5px] px-[4px] py-[2px] w-full overflow-hidden"
                      style={{
                        background: isToday ? "rgba(255,255,255,0.08)" : SHOOT_TYPE_COLORS.personal.pillBg,
                        cursor: row.event && onEventClick ? "pointer" : "inherit",
                      }}
                    >
                      <span
                        className="block text-[7px] font-medium leading-none truncate"
                        style={{ color: isToday ? "rgba(255,255,255,0.6)" : SHOOT_TYPE_COLORS.personal.pill }}
                        title={row.title}
                      >
                        {row.label}
                      </span>
                    </div>
                  ))}
                  {personalRows.length > (shootCount === 0 ? 2 : 1) && (
                    <span
                      className="text-[6px] font-semibold leading-none pl-[4px]"
                      style={{ color: isToday ? "rgba(255,255,255,0.35)" : "#b8b0a8" }}
                    >
                      +{personalRows.length - (shootCount === 0 ? 2 : 1)}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center justify-center gap-4 px-4 pb-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: SHOOT_TYPE_COLORS.confirmed.dot }} />
          <span className="text-[9px] font-medium text-stone-500">Confirmed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: SHOOT_TYPE_COLORS.family.dot }} />
          <span className="text-[9px] font-medium text-stone-500">Family</span>
        </div>
      </div>

      {/* Debug panel */}
      {showDebugStats && (
        <div className="border-t border-amber-100 bg-amber-50/60 px-3 py-2">
          <p className="text-[8.5px] font-bold uppercase tracking-[0.18em] text-amber-600 mb-1.5">
            Debug · Counted shoots for {new Date(viewYear, viewMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })} ({monthStats.current})
          </p>
          {(monthStats.byYear[viewYear] ?? []).length === 0 ? (
            <p className="text-[8px] text-amber-400 italic">No photo events matched for this month.</p>
          ) : (
            <ul className="space-y-0.5">
              {(monthStats.byYear[viewYear] ?? []).map(e => (
                <li key={e.id} className="text-[8px] text-amber-700 leading-snug">
                  <span className="font-medium tabular-nums text-amber-500 mr-1">{e.date.slice(5)}</span>
                  {e.title}
                </li>
              ))}
            </ul>
          )}
          {monthStats.prevCount !== null && monthStats.prevCount > 0 && (
            <>
              <p className="text-[8.5px] font-bold uppercase tracking-[0.18em] text-amber-600 mt-2 mb-1">
                {monthStats.prevYear} · {monthStats.prevCount} shoots
              </p>
              <ul className="space-y-0.5">
                {(monthStats.byYear[monthStats.prevYear] ?? []).map(e => (
                  <li key={e.id} className="text-[8px] text-amber-700 leading-snug">
                    <span className="font-medium tabular-nums text-amber-500 mr-1">{e.date.slice(5)}</span>
                    {e.title}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Day focus cards (Today / Tomorrow / After Tomorrow) ─────────────────────

function DayFocusGroup({
  events, variant, date, onOpen, onAdd, onManage, shoots, sheetJobs,
}: {
  events: CalendarEvent[];
  variant: "today" | "tomorrow" | "aftertomorrow";
  date: string;
  onOpen: (e: CalendarEvent) => void;
  onAdd: (e: CalendarEvent) => void;
  onManage: (e: CalendarEvent) => void;
  shoots: Shoot[];
  sheetJobs?: SheetJob[];
}) {
  const LABEL: Record<string, string> = {
    today: "TODAY",
    tomorrow: "TOMORROW",
    aftertomorrow: "AFTER TOMORROW",
  };
  const BADGE: Record<string, { bg: string; text: string; border: string }> = {
    today:         { bg: "#f5efe3", text: "#7a5520", border: "#e8d4aa" },
    tomorrow:      { bg: "#eef4ee", text: "#3a6640", border: "#bcd8bc" },
    aftertomorrow: { bg: "#eeecf0", text: "#5a5270", border: "#ccc8d8" },
  };
  const badge = BADGE[variant];

  const sorted = [...events].sort((a, b) => {
    const tA = getEventDisplayTime(a).time ?? "";
    const tB = getEventDisplayTime(b).time ?? "";
    return tA.localeCompare(tB);
  });

  // Compute date display from the provided date prop
  const dateDisplay = (() => {
    const [yr, mo, dy] = date.split("-").map(Number);
    const d = new Date(yr, mo - 1, dy);
    return {
      dow: d.toLocaleDateString("en-US", { weekday: "short" }),
      day: String(dy).padStart(2, "0"),
      mon: d.toLocaleDateString("en-US", { month: "short" }),
    };
  })();

  const isEmpty = events.length === 0;

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: isEmpty ? badge.bg + "cc" : "#fff",
        border: `1px solid ${isEmpty ? badge.border : badge.border + "88"}`,
        boxShadow: isEmpty
          ? "none"
          : "0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      {/* Header row */}
      <div
        className="flex items-center justify-between px-4 pt-3.5 pb-3"
        style={{ borderBottom: isEmpty ? "none" : `1px solid ${badge.border}55` }}
      >
        <span
          className="text-[8px] font-black uppercase tracking-[0.22em] px-2.5 py-[3.5px] rounded-full"
          style={{ background: badge.bg, color: badge.text, border: `1px solid ${badge.border}` }}
        >
          {LABEL[variant]}
        </span>
        <div className="flex items-center gap-2">
          {!isEmpty && sorted.length > 1 && (
            <span
              className="text-[8px] font-bold rounded-full px-2 py-[2px] tabular-nums"
              style={{ background: badge.bg, color: badge.text, border: `1px solid ${badge.border}` }}
            >
              {sorted.length}
            </span>
          )}
          <span className="text-[10px] font-semibold tabular-nums" style={{ color: badge.text + "cc" }}>
            {dateDisplay.dow} {dateDisplay.day} {dateDisplay.mon}
          </span>
        </div>
      </div>

      {/* Free day card */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center px-5 py-7 gap-2">
          <svg className="h-7 w-7 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ color: badge.text }}>
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
          </svg>
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: badge.text }}>Free Day</p>
            <p className="text-[9px] mt-0.5 opacity-60" style={{ color: badge.text }}>No shoots scheduled</p>
          </div>
        </div>
      )}

      {/* Event cards */}
      {!isEmpty && (
        <div
          className="divide-y overflow-y-auto"
          style={{
            maxHeight: sorted.length > 4 ? "min(72vh, 520px)" : undefined,
            scrollbarWidth: "thin",
          }}
        >
          {sorted.map(ev => (
            <DayFocusCard
              key={ev.id}
              event={ev}
              onOpen={() => onOpen(ev)}
              onAdd={() => onAdd(ev)}
              onManage={() => onManage(ev)}
              shoots={shoots}
              sheetJobs={sheetJobs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DayFocusCard({
  event, onOpen, onAdd, onManage, shoots, sheetJobs,
}: {
  event: CalendarEvent;
  onOpen: () => void;
  onAdd: () => void;
  onManage: () => void;
  shoots: Shoot[];
  sheetJobs?: SheetJob[];
}) {
  const { hotel, client, pkg, eventType } = parseCalendarTitle(event);
  const isAdded = isCalendarEventAdded(event, shoots, sheetJobs);
  const accentColor = HOTEL_DOT_COLORS[hotel] || "#a8a29e";
  const { time: displayTime, endTime: displayEndTime } = getEventDisplayTime(event);
  const startLabel = displayTime ? formatTime(displayTime) : null;
  const endLabel   = displayEndTime ? formatTime(displayEndTime) : null;

  return (
    <div
      onClick={onOpen}
      className="flex items-stretch cursor-pointer transition-colors duration-150 hover:bg-stone-50/70 active:bg-stone-100/60 relative"
    >
      {/* Accent bar */}
      <div className="w-[3.5px] flex-shrink-0 self-stretch" style={{ background: accentColor }} />

      {/* Main content */}
      <div className="flex-1 px-4 py-3.5 min-w-0 pr-3">
        {/* Top row: hotel + action button */}
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className="font-bold text-stone-900 leading-tight text-[13px] truncate flex-1">{hotel}</p>
          <div className="flex-shrink-0 -mt-0.5" onClick={e => e.stopPropagation()}>
            {isAdded ? (
              <button
                onClick={onManage}
                className="text-[8px] font-semibold rounded-full px-2.5 py-[4px] border transition active:scale-[0.93] whitespace-nowrap"
                style={{ borderColor: accentColor + "60", color: accentColor, background: accentColor + "10" }}
              >
                Manage
              </button>
            ) : (
              <button
                onClick={onAdd}
                className="flex items-center gap-1 text-[8px] font-semibold rounded-full px-2.5 py-[4px] text-white transition active:scale-[0.93] whitespace-nowrap"
                style={{ background: accentColor }}
              >
                <svg className="h-2 w-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add
              </button>
            )}
          </div>
        </div>

        {/* Client */}
        {client && (
          <p className="text-stone-500 font-medium leading-tight truncate text-[11px] mb-2">{client}</p>
        )}

        {/* Bottom row: time + package */}
        <div className="flex items-center justify-between gap-2 mt-1.5">
          <div className="flex items-center gap-2">
            {startLabel ? (
              <span className="tabular-nums font-bold text-[12px] leading-none" style={{ color: TIME_COLOR }}>{startLabel}</span>
            ) : (
              <span className="text-[9px] text-stone-300 italic">All day</span>
            )}
            {endLabel && (
              <span className="tabular-nums text-[10px] leading-none text-stone-400">→ {endLabel}</span>
            )}
          </div>
          {(pkg || eventType) && (
            <span
              className="text-[8px] font-semibold rounded-full px-2 py-[2px] flex-shrink-0"
              style={{ background: accentColor + "18", color: accentColor }}
            >
              {pkg || eventType}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Timeline row ─────────────────────────────────────────────────────────────

function TimelineRow({
  event, isLast, onOpen, onAdd, isAdmin, bucket, shoots, sheetJobs,
}: {
  event: CalendarEvent;
  isLast: boolean;
  onOpen: () => void;
  onAdd: () => void;
  isAdmin?: boolean;
  bucket: "today" | "tomorrow" | "aftertomorrow" | "nextdays" | "past";
  shoots: Shoot[];
  sheetJobs?: SheetJob[];
}) {
  const { hotel, client, pkg, eventType } = parseCalendarTitle(event);
  const isAdded = isCalendarEventAdded(event, shoots, sheetJobs);
  const accentColor = HOTEL_DOT_COLORS[hotel] || "#a8a29e";
  const [yr, eventMo, dy] = event.date.split("-").map(Number);
  const dayNum    = String(dy).padStart(2, "0");
  const monthShort = new Date(yr, eventMo - 1, 1).toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  const isPast    = bucket === "past";
  const isToday   = bucket === "today";

  const { time: resolvedTime, endTime: resolvedEndTime } = getEventDisplayTime(event);
  const startLabel = resolvedTime    ? formatTime(resolvedTime)    : "";
  const endLabel   = resolvedEndTime ? formatTime(resolvedEndTime) : "";

  // Find matching sheetJob to get stage color and assigned editor
  const matchedJob = (sheetJobs ?? []).find(j =>
    j.herman.date === event.date &&
    j.herman.galleryName.toLowerCase() === client.toLowerCase()
  );
  const editor = matchedJob?.activity?.lastUpdatedBy ?? "";

  // Status-based left border color
  const STAGE_COLORS: Record<string, string> = {
    not_started:       "#22c55e",
    waiting_selection: "#f97316",
    in_progress:       "#8b5cf6",
    ready_to_send:     "#3b82f6",
    delivered:         "#15803d",
  };
  const stage = matchedJob ? groupForJob(matchedJob) : null;
  const borderColor = isPast
    ? "#d4cfc8"
    : stage
      ? (STAGE_COLORS[stage] ?? accentColor)
      : accentColor;

  return (
    <div
      className="mb-2 cursor-pointer group"
      onClick={onOpen}
    >
      <div
        className="overflow-hidden transition-all duration-150 group-hover:-translate-y-px"
        style={{
          borderRadius: "14px",
          background: isPast ? "rgba(250,249,247,0.6)" : "#fff",
          border: isPast ? "1px solid rgba(228,225,222,0.5)" : `1px solid ${accentColor}28`,
          boxShadow: isPast ? "none" : "0 2px 8px rgba(0,0,0,0.055), 0 1px 2px rgba(0,0,0,0.04)",
        }}
        onMouseEnter={e => { if (!isPast) (e.currentTarget as HTMLElement).style.boxShadow = "0 6px 16px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.06)"; }}
        onMouseLeave={e => { if (!isPast) (e.currentTarget as HTMLElement).style.boxShadow = "0 2px 8px rgba(0,0,0,0.055), 0 1px 2px rgba(0,0,0,0.04)"; }}
      >
        <div className="flex">
          {/* Status accent bar — 4px, status-based color */}
          <div
            className="w-[4px] flex-shrink-0 self-stretch rounded-l-[14px]"
            style={{ background: borderColor }}
          />

          {/* Time column — auto-width, left-aligned, no wrap */}
          <div
            className="flex-shrink-0 flex flex-col items-start justify-center py-3 border-r"
            style={{
              paddingLeft: "10px",
              paddingRight: "10px",
              borderColor: isPast ? "#ebe8e4" : accentColor + "18",
            }}
          >
            {startLabel ? (
              <span
                className="text-[12.5px] font-black tabular-nums leading-none whitespace-nowrap"
                style={{ color: isPast ? "#c0b8b0" : accentColor }}
              >{startLabel}</span>
            ) : (
              <span className="text-[9px] italic leading-none" style={{ color: "#d0cac4" }}>—</span>
            )}
            {endLabel && (
              <span
                className="text-[9px] tabular-nums leading-none mt-1 font-medium whitespace-nowrap"
                style={{ color: isPast ? "#c8c0b8" : "#a8b8b0" }}
              >{endLabel}</span>
            )}
          </div>

          {/* Centre: hotel · client · badges row */}
          <div className="flex-1 px-3 py-3 min-w-0">
            {/* Line 1: hotel name */}
            <div className="flex items-center gap-1.5 mb-0.5 min-w-0">
              <p
                className="text-[12.5px] font-bold leading-tight truncate"
                style={{ color: isPast ? "#a8a09a" : "#1c1917" }}
              >{hotel}</p>
              {isToday && (
                <span className="flex-shrink-0 text-[7px] font-black uppercase tracking-wide rounded-full px-1.5 py-[2.5px] bg-amber-50 text-amber-600 border border-amber-200/70">Now</span>
              )}
            </div>

            {/* Line 2: client name */}
            {client && (
              <p
                className="text-[10.5px] font-medium leading-snug truncate mb-1.5"
                style={{ color: isPast ? "#b8b0a8" : "#78716c" }}
              >{client}</p>
            )}

            {/* Line 3: badge row — photos · shoot type · editor */}
            {(pkg || eventType || editor) && (
              <div className="flex items-center gap-1 flex-wrap">
                {pkg && (
                  <span
                    className="text-[8px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap"
                    style={{
                      background: isPast ? "#f0ece8" : accentColor + "14",
                      color: isPast ? "#b0a8a0" : accentColor,
                    }}
                  >{pkg}</span>
                )}
                {eventType && (
                  <span
                    className="text-[8px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap"
                    style={{
                      background: isPast ? "#f0ece8" : "#f5f0e8",
                      color: isPast ? "#b0a8a0" : "#78716c",
                    }}
                  >{eventType}</span>
                )}
                {editor && (
                  <span
                    className="text-[8px] font-semibold rounded-full px-2 py-[2px] whitespace-nowrap"
                    style={{
                      background: isPast ? "#f0ece8" : borderColor + "18",
                      color: isPast ? "#b0a8a0" : borderColor,
                    }}
                  >{editor}</span>
                )}
              </div>
            )}
          </div>

          {/* Right: date badge + add button */}
          <div className="flex-shrink-0 flex flex-col items-end justify-between px-3 py-3 gap-2">
            {/* Date: "04 JUN" */}
            <div className="text-right">
              <p
                className="text-[15px] font-black tabular-nums leading-none"
                style={{ color: isPast ? "#d0c8c0" : accentColor + "dd" }}
              >{dayNum}</p>
              <p
                className="text-[8px] font-bold uppercase tracking-wide leading-none mt-0.5"
                style={{ color: isPast ? "#d8d0c8" : accentColor + "99" }}
              >{monthShort}</p>
            </div>
            {/* Add / Added indicator */}
            {!isPast && isAdmin && (
              isAdded ? (
                <span className="text-[7.5px] font-semibold text-emerald-500 flex items-center gap-0.5">
                  <svg className="h-2 w-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                  Added
                </span>
              ) : (
                <button
                  onClick={e => { e.stopPropagation(); onAdd(); }}
                  className="text-[7.5px] font-bold rounded-full px-2 py-[3.5px] transition-all active:scale-[0.9] text-white"
                  style={{ background: accentColor }}
                >
                  + Add
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Bucket section header ────────────────────────────────────────────────────

function BucketHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-2 pl-1 pt-1">
      <div className="h-px flex-1 bg-stone-100" />
      <span className="text-[8px] font-black uppercase tracking-[0.25em] text-stone-300 flex-shrink-0">{label}</span>
      {count > 1 && <span className="text-[8px] font-semibold text-stone-300 tabular-nums flex-shrink-0">{count}</span>}
      <div className="h-px flex-1 bg-stone-100" />
    </div>
  );
}

// ─── CalendarPanel ────────────────────────────────────────────────────────────

function CalendarPanel({
  calendarEvents, importCalendarFile, addCalendarEventAsShoot, clearCalendarEvents, rebuildCalendarCache,
  gcalAccessToken, gcalCalendars, gcalSelectedIds, setGcalSelectedIds,
  gcalLoading, gcalError, gapiReady, gcalHasWriteScope, connectGoogle, disconnectGoogle, syncGoogleCalendar,
  shoots, directIncome, sheetJobs = [], pricing, onQuickAddShoot, onAddToEditing,
  onRemoveFromAccounting, onRemoveFromShoots, onRemoveFromDirect, onRemoveFromEditing, onRemoveFromCalendar, onDeleteFromGoogle, onSaveToGoogleCalendar, onUpdateCalendarEvent, onAddManualCalendarEvent, isAdmin, showDebugStats,
}: CalendarPanelProps) {
  const [showAll, setShowAll] = React.useState(false);
  const [modalEvent, setModalEvent] = React.useState<CalendarEvent | null>(null);
  const [addToSheetEvent, setAddToSheetEvent] = React.useState<CalendarEvent | null>(null);
  const [addToSheetInitialType, setAddToSheetInitialType] = React.useState<"resort" | "direct" | "editing_only">("resort");
  const [showDaySheet, setShowDaySheet] = React.useState(false);
  const [showQuickAdd, setShowQuickAdd] = React.useState(false);
  const [showAddEvent, setShowAddEvent] = React.useState(false);

  const today = tahitiDateStr();
  const [selectedDay, setSelectedDay] = React.useState<string>(today);

  const tomorrowD = new Date(tahitiNow());
  tomorrowD.setUTCDate(tomorrowD.getUTCDate() + 1);
  const tomorrowStr = tahitiDateStr(tomorrowD);

  const afterTomorrowD = new Date(tahitiNow());
  afterTomorrowD.setUTCDate(afterTomorrowD.getUTCDate() + 2);
  const afterTomorrowStr = tahitiDateStr(afterTomorrowD);

  // 6 days ahead window for "next days" section
  const nearEndD = new Date(tahitiNow());
  nearEndD.setUTCDate(nearEndD.getUTCDate() + 6);
  const nearEnd = tahitiDateStr(nearEndD);

  // Dedupe first — single source of truth for ALL views (month, cards, timeline)
  const dedupedCalendarEvents = React.useMemo(() => dedupeCalendarEvents(calendarEvents), [calendarEvents]);

  // getEventsForDate: shared function used by month calendar, side cards, AND timeline.
  // Returns ALL deduplicated events for a date, sorted by time ascending.
  // No photography filter — same data the month calendar dot counts use.
  const getEventsForDate = React.useCallback((dateStr: string): CalendarEvent[] =>
    dedupedCalendarEvents
      .filter(e => e.date === dateStr)
      .sort((a, b) => {
        const tA = getEventDisplayTime(a).time ?? "";
        const tB = getEventDisplayTime(b).time ?? "";
        return tA.localeCompare(tB);
      }),
    [dedupedCalendarEvents]
  );

  // sortedEvents: photography-filtered + sorted — used only for "near/later" timeline
  // sections and past events where the showAll toggle applies.
  const sortedEvents = React.useMemo(() =>
    [...dedupedCalendarEvents]
      .filter(e => showAll || isPhotographyEvent(e))
      .sort((a, b) => {
        const cmp = a.date.localeCompare(b.date);
        if (cmp !== 0) return cmp;
        const aTime = getEventDisplayTime(a).time || "";
        const bTime = getEventDisplayTime(b).time || "";
        if (aTime && !bTime) return -1;
        if (!aTime && bTime) return 1;
        return aTime.localeCompare(bTime);
      }),
    [dedupedCalendarEvents, showAll]
  );

  const upcomingEvents = React.useMemo(() => sortedEvents.filter(e => e.date >= today), [sortedEvents, today]);
  const pastEvents = React.useMemo(() => sortedEvents.filter(e => e.date < today).reverse().slice(0, 4), [sortedEvents, today]);

  // ── 3-day focus cards: use getEventsForDate — same source as month calendar dots
  const todayCards    = getEventsForDate(today);
  const tomorrowCards = getEventsForDate(tomorrowStr);
  const afterCards    = getEventsForDate(afterTomorrowStr);

  // Timeline groups for today/tomorrow/afterTomorrow also use getEventsForDate
  // so the count always matches the month calendar.
  // Near/Later sections use sortedEvents (photography filter OK for those).
  const tlToday    = getEventsForDate(today);
  const tlTomorrow = getEventsForDate(tomorrowStr);
  const tlAfter    = getEventsForDate(afterTomorrowStr);
  const tlNear     = upcomingEvents.filter(e => e.date > afterTomorrowStr && e.date <= nearEnd);
  const tlLater    = upcomingEvents.filter(e => e.date > nearEnd).slice(0, 6);

  function handleSelectDate(dateStr: string) {
    setSelectedDay(dateStr);
    const evs = dedupedCalendarEvents.filter(e => e.date === dateStr);
    if (evs.length === 1) {
      // Single event — skip DaySheet, go straight to modal
      setModalEvent(evs[0]);
    } else if (evs.length > 1) {
      setShowDaySheet(true);
    }
  }

  function handleAdd(event: CalendarEvent) {
    if (onAddToEditing) {
      setAddToSheetEvent(event);
    } else {
      addCalendarEventAsShoot(event);
    }
  }

  function handleAddEditing(event: CalendarEvent) {
    if (!onAddToEditing) { addCalendarEventAsShoot(event); return; }
    const { hotel, client, pkg, eventType } = parseCalendarTitle(event);
    const editingJob: NewEditingJob = {
      date: event.date, galleryName: client, resort: hotel,
      photoPackage: pkg, occasion: eventType, notes: extractEmailsFromDescription(event.description || ""), actor: "Sasha",
      editingAddedAt: new Date().toISOString(),
    };
    const type: "resort" | "direct" = RESORT_HOTELS.includes(hotel) ? "resort" : "direct";
    if (type === "resort") {
      const priceRow = findPrice(pricing, hotel, pkg, "Concierge");
      const ht = priceRow?.ht ?? 0;
      const shoot: Shoot = {
        id: Date.now(), date: event.date, hotel, client,
        eventType, photoPackage: pkg, department: "Concierge", source: "Resort",
        ht, tax: calculateTax(ht), finalAmount: calculateFinalAmount(ht), status: "To invoice",
      };
      onAddToEditing(event, { type, shoot, editingJob });
    } else {
      const directRow: DirectRow = { id: Date.now(), date: event.date, client, income: pkg || "Photo Session", amount: 0 };
      onAddToEditing(event, { type, directRow, editingJob });
    }
  }

  function handleAddDirect(event: CalendarEvent) {
    if (!onAddToEditing) { addCalendarEventAsShoot(event); return; }
    const { client, pkg, eventType } = parseCalendarTitle(event);
    const editingJob: NewEditingJob = {
      date: event.date, galleryName: client, resort: parseCalendarTitle(event).hotel,
      photoPackage: pkg, occasion: eventType, notes: extractEmailsFromDescription(event.description || ""), actor: "Sasha",
      editingAddedAt: new Date().toISOString(),
    };
    const directRow: DirectRow = { id: Date.now(), date: event.date, client, income: pkg || "Photo Session", amount: 0 };
    onAddToEditing(event, { type: "direct", directRow, editingJob });
  }
  function handleAddEditingOnly(event: CalendarEvent) {
    if (!onAddToEditing) return;
    const { hotel, client, pkg, eventType } = parseCalendarTitle(event);
    const editingJob: NewEditingJob = {
      date: event.date, galleryName: client, resort: hotel,
      photoPackage: pkg, occasion: eventType, notes: extractEmailsFromDescription(event.description || ""), actor: "Sasha",
      editingAddedAt: new Date().toISOString(),
    };
    onAddToEditing(event, { type: "editing_only", editingJob });
  }
  function handleQuickAdd(data: { date: string; hotel: string; client: string; eventType: string; photoPackage: string }) {
    if (onQuickAddShoot) onQuickAddShoot(data);
  }

  const renderSection = (events: CalendarEvent[], label: string, bucket: "today" | "tomorrow" | "aftertomorrow" | "nextdays" | "past") => {
    if (!events.length) return null;
    return (
      <div className="mb-1">
        <BucketHeader label={label} count={events.length} />
        {events.map((ev, i) => (
          <TimelineRow key={ev.id} event={ev} isLast={i === events.length - 1}
            onOpen={() => setModalEvent(ev)} onAdd={() => handleAdd(ev)}
            isAdmin={isAdmin}
            bucket={bucket} shoots={shoots} sheetJobs={sheetJobs} />
        ))}
      </div>
    );
  };


  const hasAnyContent = upcomingEvents.length > 0 || pastEvents.length > 0
    || todayCards.length > 0 || tomorrowCards.length > 0 || afterCards.length > 0;

  return (
    <div className="relative pb-24">
      {/* ── DEBUG PANEL ── visible when showDebugStats is on */}
      {showDebugStats && (() => {
        const debugDate = today; // always show today's date
        const raw    = calendarEvents.filter(e => e.date === debugDate);
        const deduped = dedupedCalendarEvents.filter(e => e.date === debugDate);
        const cards  = getEventsForDate(debugDate);
        const tl     = getEventsForDate(debugDate);
        return (
          <div className="mx-2 mt-2 mb-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[8.5px] font-mono">
            <p className="font-bold text-amber-700 mb-1 uppercase tracking-wide">
              Debug — {debugDate} (today)
            </p>
            <div className="grid grid-cols-4 gap-x-3 gap-y-0.5 text-amber-800">
              <span>calendarEvents raw:</span><span className="font-bold">{raw.length}</span>
              <span>after dedup:</span><span className="font-bold">{deduped.length}</span>
              <span>side cards:</span><span className="font-bold">{cards.length}</span>
              <span>timeline today:</span><span className="font-bold">{tl.length}</span>
            </div>
            {deduped.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {deduped.map(e => (
                  <li key={e.id} className="text-amber-600">
                    <span className="text-amber-400 mr-1">{e.time ?? "--:--"}</span>
                    {e.title}
                    {e.googleEventId && <span className="ml-1 text-amber-300">[gid]</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}
      {/* Modals */}
      {modalEvent && (
        <CalendarEventModal
          event={modalEvent}
          onClose={() => setModalEvent(null)}
          shoots={shoots}
          directIncome={directIncome}
          sheetJobs={sheetJobs}
          gcalHasWriteScope={gcalHasWriteScope}
          onAddWithType={onAddToEditing ? (type) => {
            setAddToSheetInitialType(type);
            setAddToSheetEvent(modalEvent);
            setModalEvent(null);
          } : undefined}
          onAddLegacy={onAddToEditing ? undefined : () => { addCalendarEventAsShoot(modalEvent); setModalEvent(null); }}
          onRemoveFromShoots={onRemoveFromShoots ? async () => { await onRemoveFromShoots(modalEvent); setModalEvent(null); } : undefined}
          onRemoveFromDirect={onRemoveFromDirect ? async () => { await onRemoveFromDirect(modalEvent); setModalEvent(null); } : undefined}
          onRemoveFromEditing={onRemoveFromEditing ? (jobs) => { onRemoveFromEditing(modalEvent, jobs); setModalEvent(null); } : undefined}
          onRemoveFromCalendar={onRemoveFromCalendar ? () => { onRemoveFromCalendar(modalEvent); setModalEvent(null); } : undefined}
          onDeleteFromGoogle={onDeleteFromGoogle ? () => { onDeleteFromGoogle(modalEvent); setModalEvent(null); } : undefined}
          onSaveToGoogleCalendar={onSaveToGoogleCalendar ? () => onSaveToGoogleCalendar(modalEvent) : undefined}
          onUpdateEvent={onUpdateCalendarEvent ? (original, updated) => onUpdateCalendarEvent(original, updated) : undefined}
          onRequestWriteScope={() => connectGoogle(true)}
        />
      )}
      {addToSheetEvent && onAddToEditing && (
        <AddToSheetModal
          type={addToSheetInitialType}
          event={addToSheetEvent}
          pricing={pricing}
          onConfirm={async result => { await onAddToEditing(addToSheetEvent!, result); setAddToSheetEvent(null); }}
          onClose={() => setAddToSheetEvent(null)}
        />
      )}
      {showQuickAdd && (
        <QuickAddShootModal onSave={handleQuickAdd} onClose={() => setShowQuickAdd(false)} />
      )}
      {showAddEvent && (
        <AddCalendarEventModal
          gcalConnected={!!gcalAccessToken}
          gcalHasWriteScope={gcalHasWriteScope}
          onSave={async data => { if (onAddManualCalendarEvent) await onAddManualCalendarEvent(data); }}
          onClose={() => setShowAddEvent(false)}
          onRequestWriteScope={() => connectGoogle(true)}
        />
      )}

      {/* Day detail bottom sheet — derived from live dedupedCalendarEvents, never stale */}
      {showDaySheet && (() => {
        const sheetEvents = dedupedCalendarEvents.filter(e => e.date === selectedDay);
        const sheetLabel  = relativeDateLabel(selectedDay);
        if (sheetEvents.length === 0) { setShowDaySheet(false); return null; }
        return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowDaySheet(false)}>
          <div className="absolute inset-0 bg-stone-900/25 backdrop-blur-[3px]" />
          <div className="relative w-full sm:max-w-sm rounded-t-[28px] sm:rounded-[22px] border border-stone-200/50 bg-white shadow-[0_-8px_40px_rgba(0,0,0,0.14)] overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="sm:hidden flex justify-center pt-3 pb-0.5"><div className="h-1 w-10 rounded-full bg-stone-200" /></div>
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-stone-100">
              <p className="text-[13px] font-semibold text-stone-800">{sheetLabel}</p>
              <button onClick={() => setShowDaySheet(false)} className="rounded-full p-1.5 hover:bg-stone-100 text-stone-400 hover:text-stone-600 transition">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="divide-y divide-stone-100 max-h-[55vh] overflow-y-auto">
              {sheetEvents.map(ev => {
                const personal = isPersonalEvent(ev);
                if (personal) {
                  const catLabel = personalCategoryLabel(ev);
                  return (
                    <div key={ev.id} onClick={() => { setShowDaySheet(false); setModalEvent(ev); }}
                      className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-stone-50 transition-colors">
                      <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: "#c4bdb5" }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-semibold text-stone-800 truncate">{ev.title || "Personal event"}</p>
                        <p className="text-[10px] text-stone-400 mt-0.5">{catLabel}</p>
                      </div>
                      <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold flex-shrink-0" style={{ background: "#f0ece8", color: "#78716c" }}>{catLabel}</span>
                    </div>
                  );
                }
                const { hotel, client, pkg, eventType } = parseCalendarTitle(ev);
                const isFamily = isFamilyShoot(ev);
                const dotColor = isFamily ? SHOOT_TYPE_COLORS.family.dot : SHOOT_TYPE_COLORS.confirmed.dot;
                return (
                  <div key={ev.id} onClick={() => { setShowDaySheet(false); setModalEvent(ev); }}
                    className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-stone-50 transition-colors">
                    <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-semibold text-stone-900">{hotel}</p>
                      {client && <p className="text-[11px] text-stone-500">{client}</p>}
                      <p className="text-[10px] text-stone-400 mt-0.5">{pkg}{eventType ? ` · ${eventType}` : ""}{ev.time ? ` · ${formatTime(ev.time)}` : ""}</p>
                    </div>
                    {ev.imported && <span className="rounded-full bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 text-[9px] font-semibold text-emerald-600">Added</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        );
      })()}

      {/* ══ MOBILE layout: sequential stack (md:hidden) ══ */}
      <div className="md:hidden space-y-2.5">

        {/* 1. Month calendar */}
        <MonthMiniGrid
          calendarEvents={dedupedCalendarEvents}
          shoots={shoots}
          selectedDate={selectedDay}
          onSelectDate={handleSelectDate}
          onEventClick={setModalEvent}
          showDebugStats={showDebugStats}
        />

        {/* 2. Today / Tomorrow / After Tomorrow — always shown, Free Day card when empty */}
        <div className="space-y-2.5">
          <DayFocusGroup variant="today" date={today} events={todayCards}
            onOpen={setModalEvent} onAdd={handleAdd} onManage={setModalEvent} shoots={shoots} sheetJobs={sheetJobs} />
          <DayFocusGroup variant="tomorrow" date={tomorrowStr} events={tomorrowCards}
            onOpen={setModalEvent} onAdd={handleAdd} onManage={setModalEvent} shoots={shoots} sheetJobs={sheetJobs} />
          <DayFocusGroup variant="aftertomorrow" date={afterTomorrowStr} events={afterCards}
            onOpen={setModalEvent} onAdd={handleAdd} onManage={setModalEvent} shoots={shoots} sheetJobs={sheetJobs} />
        </div>

        {/* 3. Schedule timeline */}
        {hasAnyContent && (
          <div className="rounded-2xl bg-white/90 border border-stone-200/50 shadow-sm px-4 pt-4 pb-3">
            <p className="text-[8px] font-black uppercase tracking-[0.25em] text-stone-300 mb-3 pl-0.5">Schedule</p>
            {renderSection(tlToday,    "Today",          "today")}
            {renderSection(tlTomorrow, "Tomorrow",       "tomorrow")}
            {renderSection(tlAfter,    "After Tomorrow", "aftertomorrow")}
            {renderSection(tlNear,     "Next Days",      "nextdays")}
            {tlLater.length > 0 && renderSection(tlLater, "Upcoming", "nextdays")}
            {pastEvents.length > 0 && (
              <div className="mt-1 pt-1">
                {renderSection(pastEvents, "Recent", "past")}
              </div>
            )}
          </div>
        )}

        {!hasAnyContent && (
          <div className="rounded-2xl border border-stone-200/40 bg-white/60 px-5 py-10 text-center">
            <p className="text-[13px] font-medium text-stone-400">No events synced yet</p>
            <p className="text-[11px] text-stone-300 mt-1.5">Connect Google Calendar or import .ics to see your schedule</p>
          </div>
        )}

      </div>

      {/* ══ DESKTOP layout: two-column side-by-side (hidden on mobile) ══ */}
      <div className="hidden md:flex md:flex-row md:gap-5 md:items-start">

        {/* LEFT: date strip + focus cards */}
        <div className="md:w-[32%] md:flex-shrink-0 space-y-2.5">

          {/* Desktop date strip */}
          <div className="rounded-2xl bg-white/90 border border-stone-200/50 shadow-sm px-3 pt-3 pb-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] font-semibold text-stone-600">
                {new Date(parseInt(today.split("-")[0]), parseInt(today.split("-")[1]) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-stone-400 tabular-nums">{upcomingEvents.length > 0 ? `${upcomingEvents.length} upcoming` : ""}</span>
                <button onClick={() => setShowAll(v => !v)}
                  className={`text-[8.5px] font-semibold rounded-full px-2 py-0.5 border transition ${showAll ? "border-stone-300 bg-stone-100 text-stone-700" : "border-stone-200 text-stone-400 hover:text-stone-600"}`}>
                  {showAll ? "All events" : "Photo only"}
                </button>
              </div>
            </div>
            <DateStrip calendarEvents={dedupedCalendarEvents} shoots={shoots} selectedDate={selectedDay} onSelectDate={handleSelectDate} />
          </div>

          {/* Focus cards — always shown, Free Day when empty */}
          <div className="space-y-2.5">
            <DayFocusGroup variant="today" date={today} events={todayCards}
              onOpen={setModalEvent} onAdd={handleAdd} onManage={setModalEvent} shoots={shoots} sheetJobs={sheetJobs} />
            <DayFocusGroup variant="tomorrow" date={tomorrowStr} events={tomorrowCards}
              onOpen={setModalEvent} onAdd={handleAdd} onManage={setModalEvent} shoots={shoots} sheetJobs={sheetJobs} />
            <DayFocusGroup variant="aftertomorrow" date={afterTomorrowStr} events={afterCards}
              onOpen={setModalEvent} onAdd={handleAdd} onManage={setModalEvent} shoots={shoots} sheetJobs={sheetJobs} />
          </div>
        </div>

        {/* RIGHT: month grid + timeline */}
        <div className="flex-1 min-w-0 space-y-2.5">
          <MonthMiniGrid
            calendarEvents={dedupedCalendarEvents}
            shoots={shoots}
            selectedDate={selectedDay}
            onSelectDate={handleSelectDate}
            onEventClick={setModalEvent}
            showDebugStats={showDebugStats}
          />

          {hasAnyContent && (
            <div className="rounded-2xl bg-white/90 border border-stone-200/50 shadow-sm px-4 pt-4 pb-3">
              <p className="text-[8px] font-black uppercase tracking-[0.25em] text-stone-300 mb-3 pl-0.5">Schedule</p>
              {renderSection(tlToday,    "Today",          "today")}
              {renderSection(tlTomorrow, "Tomorrow",       "tomorrow")}
              {renderSection(tlAfter,    "After Tomorrow", "aftertomorrow")}
              {renderSection(tlNear,     "Next Days",      "nextdays")}
              {tlLater.length > 0 && renderSection(tlLater, "Upcoming", "nextdays")}
              {pastEvents.length > 0 && (
                <div className="mt-1 pt-1">
                  {renderSection(pastEvents, "Recent", "past")}
                </div>
              )}
            </div>
          )}

          {!hasAnyContent && (
            <div className="rounded-2xl border border-stone-200/40 bg-white/60 px-5 py-10 text-center">
              <p className="text-[13px] font-medium text-stone-400">No events synced yet</p>
              <p className="text-[11px] text-stone-300 mt-1.5">Connect Google Calendar or import .ics to see your schedule</p>
            </div>
          )}
        </div>
      </div>

      {/* Floating action buttons — always visible on mobile and desktop */}
      <div className="fixed bottom-6 right-5 z-40 flex items-center gap-2 no-print">
        {/* Add Event — visible to all users, opens AddCalendarEventModal */}
        <button
          onClick={() => setShowAddEvent(true)}
          className="flex items-center gap-2 rounded-full bg-white border border-stone-200 px-4 py-3 text-[13px] font-semibold text-stone-700 shadow-[0_4px_20px_rgba(0,0,0,0.12)] transition-all duration-200 active:scale-[0.95] hover:bg-stone-50 hover:shadow-[0_6px_28px_rgba(0,0,0,0.16)]"
        >
          <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/>
          </svg>
          Add Event
        </button>
        {/* Add Shoot — admin only */}
        {onQuickAddShoot && (
          <button
            onClick={() => setShowQuickAdd(true)}
            className="flex items-center gap-2 rounded-full px-5 py-3 text-[13px] font-semibold text-white shadow-[0_4px_20px_rgba(0,0,0,0.22)] transition-all duration-200 active:scale-[0.95] hover:shadow-[0_6px_28px_rgba(0,0,0,0.26)]"
            style={{ background: "#1c1917" }}
          >
            <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Shoot
          </button>
        )}
      </div>
    </div>
  );
}
