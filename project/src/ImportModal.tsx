import React, { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Upload, X, CheckCircle, AlertCircle, Loader } from "lucide-react";

export interface ImportedShoot {
  id: number;
  date: string;
  hotel: string;
  client: string;
  eventType: string;
  photoPackage: string;
  source: string;
  ht: number;
  tax: number;
  finalAmount: number;
  status: string;
}

interface ImportResult {
  imported: ImportedShoot[];
  skipped: number;
  total: number;
}

type ImportStatus = "idle" | "loading" | "success" | "error";

const COLUMN_ALIASES: Record<string, keyof ImportedShoot> = {
  date: "date",
  hotel: "hotel",
  client: "client",
  "event type": "eventType",
  eventtype: "eventType",
  package: "photoPackage",
  photopackage: "photoPackage",
  source: "source",
  ht: "ht",
  tva: "tax",
  tax: "tax",
  "final ttc": "finalAmount",
  finalttc: "finalAmount",
  ttc: "finalAmount",
  status: "status",
};

function normalizeKey(raw: string): string {
  return String(raw).toLowerCase().replace(/[^a-z\s]/g, "").trim();
}

function parseDate(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";

  // Excel serial number
  if (typeof raw === "number") {
    const date = XLSX.SSF.parse_date_code(raw);
    if (date) {
      const d = String(date.d).padStart(2, "0");
      const m = String(date.m).padStart(2, "0");
      return `${d}/${m}/${date.y}`;
    }
  }

  const str = String(raw).trim();

  // Already DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) return str;

  // YYYY-MM-DD
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;

  // MM/DD/YYYY (US)
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const month = us[1].padStart(2, "0");
    const day = us[2].padStart(2, "0");
    // Heuristic: if first part > 12 it must be a day
    if (Number(us[1]) > 12) return `${month}/${day}/${us[3]}`;
    return `${day}/${month}/${us[3]}`;
  }

  return str;
}

function toSafeNumber(value: unknown): number {
  // XPF uses "." as a thousands separator (47.124 = 47,124 XPF — no decimal component).
  // Strip all dots before parsing so they are never treated as decimal points.
  const s = String(value ?? "").trim().replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function dedupeKey(shoot: ImportedShoot): string {
  return `${shoot.date}|${String(shoot.client).toLowerCase().trim()}|${String(shoot.hotel).toLowerCase().trim()}`;
}

function parseSheet(workbook: XLSX.WorkBook): ImportedShoot[] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  if (rows.length === 0) return [];

  // Map header keys once using first row
  const firstRow = rows[0];
  const keyMap: Record<string, keyof ImportedShoot> = {};
  for (const rawKey of Object.keys(firstRow)) {
    const normalized = normalizeKey(rawKey);
    const mapped = COLUMN_ALIASES[normalized];
    if (mapped) keyMap[rawKey] = mapped;
  }

  return rows.map((row, idx) => {
    const shoot: Partial<ImportedShoot> = {};
    for (const [rawKey, field] of Object.entries(keyMap)) {
      const value = row[rawKey];
      if (field === "date") {
        shoot.date = parseDate(value);
      } else if (field === "ht" || field === "tax" || field === "finalAmount") {
        shoot[field] = toSafeNumber(value);
      } else {
        (shoot as Record<string, unknown>)[field] = String(value ?? "").trim();
      }
    }
    return {
      id: Date.now() + idx,
      date: shoot.date ?? "",
      hotel: shoot.hotel ?? "",
      client: shoot.client ?? "",
      eventType: shoot.eventType ?? "",
      photoPackage: shoot.photoPackage ?? "",
      source: shoot.source ?? "",
      ht: shoot.ht ?? 0,
      tax: shoot.tax ?? 0,
      finalAmount: shoot.finalAmount ?? 0,
      status: shoot.status ?? "To invoice",
    } as ImportedShoot;
  });
}

interface ImportModalProps {
  existingShoots: ImportedShoot[];
  onImport: (shoots: ImportedShoot[]) => void;
  onClose: () => void;
}

export default function ImportModal({ existingShoots, onImport, onClose }: ImportModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const existingKeys = new Set(existingShoots.map(dedupeKey));

  async function processFile(file: File) {
    if (!file) return;

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "xlsx" && ext !== "csv" && ext !== "xls") {
      setErrorMessage("Unsupported file type. Please upload a .xlsx, .xls, or .csv file.");
      setStatus("error");
      return;
    }

    setStatus("loading");
    setResult(null);
    setErrorMessage("");

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", cellDates: false });

      const parsed = parseSheet(workbook);

      if (parsed.length === 0) {
        setErrorMessage("No data rows found in the file. Check that the first sheet has the correct column headers.");
        setStatus("error");
        return;
      }

      const newShoots: ImportedShoot[] = [];
      let skipped = 0;

      for (const shoot of parsed) {
        if (!shoot.client && !shoot.date) {
          skipped++;
          continue;
        }
        const key = dedupeKey(shoot);
        if (existingKeys.has(key)) {
          skipped++;
        } else {
          existingKeys.add(key);
          newShoots.push({ ...shoot, id: Date.now() + Math.random() });
        }
      }

      setResult({ imported: newShoots, skipped, total: parsed.length });
      setStatus("success");

      if (newShoots.length > 0) {
        onImport(newShoots);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to parse file. Make sure it is a valid Excel or CSV file."
      );
      setStatus("error");
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }

  function reset() {
    setStatus("idle");
    setResult(null);
    setErrorMessage("");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 backdrop-blur-sm sm:items-center">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Import Shoots</h2>
            <p className="text-xs text-slate-500">Accepts .xlsx, .xls, .csv</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Drop zone */}
          {status !== "success" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => status !== "loading" && inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 transition ${
                dragOver
                  ? "border-slate-500 bg-slate-50"
                  : "border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100"
              } ${status === "loading" ? "pointer-events-none opacity-60" : ""}`}
            >
              {status === "loading" ? (
                <Loader size={32} className="animate-spin text-slate-400" />
              ) : (
                <Upload size={32} className="text-slate-400" />
              )}
              <div className="text-center">
                <p className="text-sm font-medium text-slate-700">
                  {status === "loading" ? "Parsing file…" : "Drop file here or click to browse"}
                </p>
                <p className="mt-0.5 text-xs text-slate-400">.xlsx, .xls, .csv supported</p>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          )}

          {/* Success state */}
          {status === "success" && result && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex items-start gap-3">
                <CheckCircle size={20} className="mt-0.5 shrink-0 text-emerald-600" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-emerald-800">Import complete</p>
                  <ul className="mt-1 space-y-0.5 text-xs text-emerald-700">
                    <li>
                      <strong>{result.imported.length}</strong> row{result.imported.length !== 1 ? "s" : ""} imported
                    </li>
                    <li>
                      <strong>{result.skipped}</strong> duplicate{result.skipped !== 1 ? "s" : ""} skipped
                    </li>
                    <li>
                      <strong>{result.total}</strong> total rows in file
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Error state */}
          {status === "error" && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle size={20} className="mt-0.5 shrink-0 text-red-600" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-red-800">Import failed</p>
                  <p className="mt-1 text-xs text-red-700">{errorMessage}</p>
                </div>
              </div>
            </div>
          )}

          {/* Column reference */}
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Expected columns
            </p>
            <div className="flex flex-wrap gap-1.5">
              {["Date", "Hotel", "Client", "Event Type", "Package", "Source", "HT", "TVA", "Final TTC", "Status"].map(
                (col) => (
                  <span
                    key={col}
                    className="rounded-lg bg-white border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600"
                  >
                    {col}
                  </span>
                )
              )}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Column names are case-insensitive. Extra columns are ignored.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          {status === "success" || status === "error" ? (
            <>
              <button
                onClick={reset}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
              >
                Import another
              </button>
              <button
                onClick={onClose}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Done
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
