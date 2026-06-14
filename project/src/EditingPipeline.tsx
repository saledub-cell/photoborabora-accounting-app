import React from "react";
import type {
  SheetJob,
  SyncState,
  SashaData,
  SashaReviewStatus,
  CardGroup,
  CardGroupDef,
} from "./sheetsSync";
import {
  CARD_GROUPS,
  groupForJob,
  DEFAULT_SASHA,
  DEFAULT_ACTIVITY,
  writeHermanCheckbox,
  writePhotosToEdit,
} from "./sheetsSync";

// ─── Re-export types App.tsx depends on ──────────────────────────────────────

export interface EditingJob {
  id: number;
  date: string;
  galleryName: string;
  resort: string;
  package: string;
  occasion: string;
  emails: string;
  saved: boolean;
  selectedAndPreedited: boolean;
  imported: boolean;
  metadata: boolean;
  backup: boolean;
  uploaded: boolean;
  beginSelectionMailSent: boolean;
  status: EditingStatus;
  photosToEdit: number | null;
  selectionReceived: boolean;
  edited: boolean;
  editionUploaded: boolean;
  stored: boolean;
  aiImproved: boolean;
  remarks: string;
  price: number | null;
  upgrade: string;
}

export type EditingStatus =
  | "Not started"
  | "In progress"
  | "Waiting for selection"
  | "Editing"
  | "Done"
  | "Delivered"
  | "Archived";

export const initialEditingJobs: EditingJob[] = [];

// ─── Date utilities ───────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, oct: 9, nov: 10, dec: 11,
};
const SHORT_MONTH = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const LONG_MONTH  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function formatDate(d: string): string {
  if (!d) return "";
  const iso = new Date(d + (d.includes("T") ? "" : "T00:00:00"));
  if (!isNaN(iso.getTime()) && d.includes("-")) {
    return `${SHORT_MONTH[iso.getMonth()]} ${iso.getDate()}`;
  }
  const parts = d.trim().split(/[\s,/]+/);
  if (parts.length >= 2) {
    for (const p of parts) {
      const monthIdx = MONTH_NAMES[p.toLowerCase()];
      if (monthIdx !== undefined) {
        const dayPart = parts.find(x => /^\d{1,2}$/.test(x));
        if (dayPart) return `${SHORT_MONTH[monthIdx]} ${dayPart}`;
      }
    }
  }
  return d;
}

// Parse a shoot date string into a timestamp for sorting (newest = highest number).
// Returns 0 if unparseable (sorts to bottom).
function parseDateMs(d: string): number {
  if (!d) return 0;
  // ISO format: "2026-05-29"
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
    return new Date(d + "T00:00:00").getTime();
  }
  // "May 29" or "May 29, 2026" etc.
  const parts = d.trim().split(/[\s,/]+/);
  let monthIdx = -1;
  let day = 0;
  let year = new Date().getFullYear();
  for (const p of parts) {
    const mi = MONTH_NAMES[p.toLowerCase()];
    if (mi !== undefined) monthIdx = mi;
    else if (/^\d{1,2}$/.test(p)) day = parseInt(p, 10);
    else if (/^\d{4}$/.test(p)) year = parseInt(p, 10);
  }
  if (monthIdx >= 0 && day > 0) return new Date(year, monthIdx, day).getTime();
  return 0;
}

// Sort newest shoot-date first. Stable tie-break by sheetRow ascending.
function sortByDateDesc(jobs: SheetJob[]): SheetJob[] {
  return [...jobs].sort((a, b) => {
    const da = parseDateMs(a.herman.date);
    const db = parseDateMs(b.herman.date);
    if (db !== da) return db - da;
    return a.sheetRow - b.sheetRow;
  });
}

function formatPackage(pkg: string, photosToEdit: number | null): string {
  if (!pkg && photosToEdit == null) return "";
  const pkgNum = pkg.trim();
  if (/^\d+$/.test(pkgNum)) return `${pkgNum} photos`;
  if (pkg.toLowerCase().includes("photo")) return pkg;
  if (photosToEdit != null) return `${photosToEdit} photos`;
  return pkg;
}

function timeAgo(iso: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function activityLabel(iso: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (h < 48) return "Yesterday";
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ─── Sync banner ──────────────────────────────────────────────────────────────

function SyncBanner({ state, onSyncNow }: { state: SyncState; onSyncNow?: () => void }) {
  if (state.status === "idle") return null;
  const cfgs = {
    syncing: { bg: "#eff6ff", border: "#bfdbfe", dot: "#3b82f6", text: "#1d4ed8", msg: "Syncing…", spin: true },
    ok:      { bg: "#f0fdf4", border: "#bbf7d0", dot: "#22c55e", text: "#15803d",
               msg: `Synced${state.lastSynced ? " · " + state.lastSynced.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`,
               spin: false },
    offline: { bg: "#fffbeb", border: "#fde68a", dot: "#f59e0b", text: "#92400e", msg: "Offline — showing cached data", spin: false },
    error:   { bg: "#fef2f2", border: "#fecaca", dot: "#ef4444", text: "#b91c1c", msg: state.error ?? "Sync error", spin: false },
    idle:    { bg: "#f9fafb", border: "#e5e7eb", dot: "#9ca3af", text: "#6b7280", msg: "Not synced", spin: false },
  };
  const c = cfgs[state.status];
  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-1.5 border-b flex-shrink-0 text-[10px]"
      style={{ background: c.bg, borderColor: c.border, color: c.text }}
    >
      <div className="flex items-center gap-2">
        {c.spin ? (
          <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        ) : (
          <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} />
        )}
        <span className="font-medium">{c.msg}</span>
        {state.fromCache && state.status === "ok" && <span className="opacity-60">(cached)</span>}
      </div>
      <div className="flex items-center gap-2">
        {onSyncNow && state.status !== "syncing" && (
          <button
            onClick={onSyncNow}
            className="rounded border px-2 py-0.5 font-semibold transition hover:opacity-70 text-[9.5px]"
            style={{ borderColor: c.border, color: c.text }}
          >
            Sync now
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Checkbox row ─────────────────────────────────────────────────────────────

type CheckState = "idle" | "saving" | "ok" | "fail";

function CheckRow({
  value, label, field, job, onUpdate,
}: {
  value: boolean;
  label: string;
  field: string;
  job: SheetJob;
  onUpdate: (field: string, value: boolean) => void;
}) {
  const [state, setState] = React.useState<CheckState>("idle");
  const [localValue, setLocalValue] = React.useState(value);

  // Sync external value when card refreshes (but not while a save is in flight)
  React.useEffect(() => {
    if (state === "idle") setLocalValue(value);
  }, [value, state]);

  async function handleClick() {
    if (state === "saving") return;
    const next = !localValue;
    setLocalValue(next);
    setState("saving");
    const result = await writeHermanCheckbox(job, field, next);
    if (result.ok) {
      setState("ok");
      onUpdate(field, next);
      setTimeout(() => setState("idle"), 1800);
    } else {
      setLocalValue(!next); // revert
      setState("fail");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  const checked = localValue;
  return (
    <button
      onClick={handleClick}
      disabled={state === "saving"}
      className={`flex items-center gap-1.5 w-full text-left rounded transition-colors px-1 py-0.5 -mx-1
        ${state === "saving" ? "opacity-60" : "hover:bg-black/5 active:bg-black/8"}
        ${checked ? "text-stone-700" : "text-stone-400"}`}
    >
      {state === "saving" ? (
        <svg className="h-3 w-3 flex-shrink-0 text-stone-300 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      ) : checked ? (
        <svg className="h-3 w-3 flex-shrink-0 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <div className="h-2.5 w-2.5 rounded border border-stone-200 flex-shrink-0" />
      )}
      <span className="text-[9.5px] leading-tight flex-1">{label}</span>
      {state === "ok"   && <span className="text-[7.5px] text-emerald-500 font-medium flex-shrink-0">Saved</span>}
      {state === "fail" && <span className="text-[7.5px] text-red-400 font-medium flex-shrink-0">Failed</span>}
    </button>
  );
}

// ─── Mobile card detail drawer ────────────────────────────────────────────────

interface MobileCardDrawerProps {
  job: SheetJob;
  group: CardGroupDef;
  onSave: (job: SheetJob, sasha: SashaData) => Promise<void>;
  onSaveEmail: (job: SheetJob, emails: string) => Promise<void>;
  onMoveStage?: (job: SheetJob, toGroup: CardGroup) => Promise<void>;
  onMarkReviewed?: (job: SheetJob, sasha?: SashaData) => Promise<void>;
  onPhotosSaved?: (job: SheetJob, photosToEdit: number | null) => Promise<void>;
  saving: boolean;
  currentUserName?: string;
  onClose: () => void;
}

function MobileCardDrawer({
  job, group, onSave, onSaveEmail, onMoveStage, onMarkReviewed, onPhotosSaved,
  saving, currentUserName, onClose,
}: MobileCardDrawerProps) {
  const stripe   = group.sheetColor;
  const h        = job.herman ?? {};
  const activity = job.activity ?? DEFAULT_ACTIVITY;

  const [sashaEdits,   setSashaEdits]   = React.useState<Partial<SashaData>>({});
  const [sashaSaving,  setSashaSaving]  = React.useState(false);
  const [sashaResult,  setSashaResult]  = React.useState<"ok" | "fail" | null>(null);
  const [emailEdit,    setEmailEdit]    = React.useState<string | null>(null);
  const [emailSaving,  setEmailSaving]  = React.useState(false);
  const [emailResult,  setEmailResult]  = React.useState<"ok" | "fail" | null>(null);
  const [photosEdit,   setPhotosEdit]   = React.useState<string | null>(null);
  const [photosSaving, setPhotosSaving] = React.useState(false);
  const [photosResult, setPhotosResult] = React.useState<"ok" | "fail" | null>(null);
  const [localHerman,  setLocalHerman]  = React.useState(job.herman ?? {});
  const [movingSaving, setMovingSaving] = React.useState(false);

  function handleCheckboxUpdate(field: string, value: boolean) {
    setLocalHerman(prev => ({ ...prev, [field]: value }));
  }

  async function handleSashaSave() {
    setSashaSaving(true);
    try {
      const updated: SashaData = { ...DEFAULT_SASHA, ...job.sasha, ...sashaEdits };
      await onSave(job, updated);
      setSashaEdits({});
      setSashaResult("ok");
      setTimeout(() => setSashaResult(null), 2500);
    } catch {
      setSashaResult("fail");
    } finally {
      setSashaSaving(false);
    }
  }

  async function handleEmailSave() {
    if (emailEdit === null) return;
    setEmailSaving(true);
    try {
      await onSaveEmail(job, emailEdit.trim());
      setEmailEdit(null);
      setEmailResult("ok");
      setTimeout(() => setEmailResult(null), 2500);
    } catch {
      setEmailResult("fail");
    } finally {
      setEmailSaving(false);
    }
  }

  async function handlePhotosSave() {
    if (photosEdit === null) return;
    const parsed = photosEdit.trim() === "" ? null : parseInt(photosEdit, 10);
    setPhotosSaving(true);
    try {
      const result = await writePhotosToEdit(job, parsed);
      if (result.ok) {
        setLocalHerman(prev => ({ ...prev, photosToEdit: parsed }));
        setPhotosEdit(null);
        setPhotosResult("ok");
        onPhotosSaved?.(job, parsed);
        setTimeout(() => setPhotosResult(null), 2500);
      } else {
        setPhotosResult("fail");
        setTimeout(() => setPhotosResult(null), 3000);
      }
    } catch {
      setPhotosResult("fail");
    } finally {
      setPhotosSaving(false);
    }
  }

  async function handleMoveStage(toGroup: CardGroup) {
    if (!onMoveStage) return;
    setMovingSaving(true);
    try { await onMoveStage(job, toGroup); } finally { setMovingSaving(false); }
  }

  const rs               = job.sasha?.reviewStatus;
  const uname            = (currentUserName ?? "").toLowerCase();
  const isSasha          = uname.includes("sasha");
  const isGerman         = uname.includes("german") || uname.includes("hermann");
  const canMarkReviewed  = (rs === "waiting_sasha" && isSasha) || (rs === "waiting_german" && isGerman);
  const canSendForReview = (isSasha || isGerman) && rs !== "waiting_german" && rs !== "waiting_sasha";
  const targetName: string             = isSasha ? "German" : isGerman ? "Sasha" : "";
  const targetStatus: SashaReviewStatus = isSasha ? "waiting_german" : "waiting_sasha";

  const inputCls  = "w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-[9px] text-[16px] text-stone-800 placeholder:text-stone-300 outline-none focus:border-stone-400 focus:bg-white transition";
  const labelCls  = "text-[9px] font-bold uppercase tracking-[0.12em] text-stone-400";

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60] bg-stone-900/40 backdrop-blur-[2px]" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed inset-x-0 bottom-0 z-[61] flex flex-col rounded-t-[24px] bg-[#faf9f7] shadow-[0_-8px_40px_rgba(0,0,0,0.18)]" style={{ maxHeight: "88dvh" }}>

        {/* Drag handle */}
        <div className="flex justify-center pt-2.5 pb-0.5 flex-shrink-0">
          <div className="h-1 w-10 rounded-full bg-stone-300" />
        </div>

        {/* Header */}
        <div className="flex-shrink-0 px-4 pt-1 pb-2.5 border-b border-stone-100">
          <div className="h-[3px] w-full rounded-full mb-2" style={{ background: stripe }} />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[16px] font-bold text-stone-900 leading-tight truncate">
                {h.galleryName || "No name"}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                {h.date && <span className="text-[11px] text-stone-500">{formatDate(h.date as string)}</span>}
                {h.resort && (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: stripe + "22", color: stripe }}>
                    {h.resort as string}
                  </span>
                )}
                {!!(h as unknown as Record<string, unknown>).photoPackage && <span className="text-[10px] text-stone-400">{String((h as unknown as Record<string, unknown>).photoPackage)}</span>}
              </div>
            </div>
            <button onClick={onClose} className="rounded-full p-1.5 text-stone-300 hover:bg-stone-100 hover:text-stone-600 transition flex-shrink-0 -mt-0.5 -mr-1">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-2.5 space-y-3" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}>

          {/* Stage picker */}
          <div className="space-y-0.5">
            <p className={labelCls}>Stage</p>
            <div className="flex flex-wrap gap-1.5">
              {CARD_GROUPS.map(g => (
                <button
                  key={g.id}
                  onClick={() => handleMoveStage(g.id)}
                  disabled={movingSaving}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium border transition active:scale-[0.97] disabled:opacity-50"
                  style={group.id === g.id
                    ? { background: g.sheetColor, color: "#fff", borderColor: g.sheetColor }
                    : { background: "#fff", color: "#57534e", borderColor: g.sheetColor + "60" }
                  }
                >
                  <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: group.id === g.id ? "#fff" : g.sheetColor }} />
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          {/* Workflow checklist */}
          <div className="space-y-0.5">
            <p className={labelCls}>Workflow</p>
            <div className="rounded-xl p-3 grid grid-cols-2 gap-x-3 gap-y-0.5" style={{ background: stripe + "0c", border: `1px solid ${stripe}20` }}>
              {([
                { value: localHerman.saved,                  label: "Saved",              field: "saved"                  },
                { value: localHerman.selectedAndPreedited,   label: "Sel. & Preedited",   field: "selectedAndPreedited"   },
                { value: localHerman.imported,               label: "Imported",            field: "imported"               },
                { value: localHerman.beginSelectionMailSent, label: "Sel. mail sent",      field: "beginSelectionMailSent" },
                { value: localHerman.selectionReceived,      label: "Selection received",  field: "selectionReceived"      },
                { value: localHerman.edited,                 label: "Edited",              field: "edited"                 },
                { value: localHerman.editionUploaded,        label: "Edition uploaded",    field: "editionUploaded"        },
                { value: localHerman.delivered,              label: "Delivered",           field: "delivered"              },
              ] as const).map(item => (
                <CheckRow key={item.field} value={item.value ?? false} label={item.label} field={item.field} job={job} onUpdate={handleCheckboxUpdate} />
              ))}
            </div>
          </div>

          {/* Photos to edit */}
          <div className="space-y-0.5">
            <div className="flex items-center justify-between">
              <p className={labelCls}>Photos to edit</p>
              {photosResult === "ok"   && <span className="text-[10px] font-semibold text-emerald-600">Saved</span>}
              {photosResult === "fail" && <span className="text-[10px] font-semibold text-red-500">Failed</span>}
              {photosSaving           && <span className="text-[10px] text-stone-400">Saving…</span>}
            </div>
            <input
              type="number"
              inputMode="numeric"
              pattern="[0-9]*"
              min={0}
              value={photosEdit ?? (localHerman.photosToEdit != null ? String(localHerman.photosToEdit) : "")}
              onChange={e => setPhotosEdit(e.target.value)}
              onBlur={handlePhotosSave}
              onKeyDown={e => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
              placeholder="Number of photos…"
              className={inputCls}
              style={{ appearance: "textfield" } as React.CSSProperties}
            />
          </div>

          {/* Remarks */}
          {h.remarks && (
            <div className="space-y-0.5">
              <p className={labelCls}>Remarks</p>
              <p className="rounded-xl bg-stone-100 px-3 py-2 text-[12px] text-stone-600 leading-relaxed">{h.remarks as string}</p>
            </div>
          )}

          {/* Email */}
          <div className="space-y-0.5">
            <p className={labelCls}>Email</p>
            <input
              type="email"
              inputMode="email"
              value={emailEdit ?? localHerman.emails ?? ""}
              onChange={e => setEmailEdit(e.target.value)}
              placeholder="Add email…"
              className={inputCls}
            />
            {emailEdit !== null && emailEdit.trim() !== (localHerman.emails ?? "").trim() && (
              <button onClick={handleEmailSave} disabled={emailSaving} className="w-full rounded-xl py-2 text-[12px] font-semibold text-white transition disabled:opacity-50 active:scale-[0.98]" style={{ background: "#292524" }}>
                {emailSaving ? "Saving…" : "Save Email"}
              </button>
            )}
            {emailResult === "ok"   && <p className="text-center text-[10px] font-semibold text-emerald-500">Saved</p>}
            {emailResult === "fail" && <p className="text-center text-[10px] font-semibold text-red-400">Failed</p>}
          </div>

          {/* Comment / note */}
          <div className="space-y-0.5">
            <p className={labelCls}>Due priority / note</p>
            <textarea
              value={sashaEdits.comment ?? job.sasha?.comment ?? ""}
              onChange={e => setSashaEdits(p => ({ ...p, comment: e.target.value }))}
              rows={2}
              placeholder="Add a note or priority…"
              className={`${inputCls} resize-none`}
            />
          </div>

          {/* Activity */}
          {(activity.lastUpdatedBy || activity.lastUpdatedAt) && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 items-center">
              {activity.lastUpdatedBy && activity.lastUpdatedAt && (
                <span className="text-[11px] text-stone-500">
                  <span className="font-semibold">{activity.lastUpdatedBy}</span>
                  {activity.lastAction ? ` · ${activity.lastAction}` : ""}
                  <span className="text-stone-300 ml-1">{activityLabel(activity.lastUpdatedAt)}</span>
                </span>
              )}
              <span className="text-[10px] text-stone-300 font-mono">
                Row {job.sheetRow}{job.blockEndRow > job.sheetRow ? `–${job.blockEndRow}` : ""}
              </span>
            </div>
          )}

          {/* Review actions */}
          {(canMarkReviewed || canSendForReview || rs === "reviewed") && (
            <div className="flex flex-wrap gap-2">
              {canMarkReviewed && onMarkReviewed && (
                <button
                  onClick={async () => { await onMarkReviewed(job); onClose(); }}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100 active:scale-[0.98] transition"
                >
                  <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  Mark Reviewed
                </button>
              )}
              {canSendForReview && targetName && (
                <button
                  onClick={async () => {
                    const updated: SashaData = { ...DEFAULT_SASHA, ...job.sasha, ...sashaEdits, reviewStatus: targetStatus, actionReason: "new_comment" };
                    await onSave(job, updated);
                    setSashaEdits({});
                  }}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12px] font-semibold active:scale-[0.98] transition"
                  style={isSasha ? { background: "#fff7ed", borderColor: "#fed7aa", color: "#b45309" } : { background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8" }}
                >
                  <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Needs {targetName}
                </button>
              )}
              {rs === "reviewed" && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-600">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  Reviewed
                </span>
              )}
            </div>
          )}

          <div className="h-1" />
        </div>

        {/* Sticky footer */}
        <div className="flex-shrink-0 border-t border-stone-100 bg-[#faf9f7] px-4 py-3 space-y-1.5" style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}>
          {Object.keys(sashaEdits).length > 0 ? (
            <button
              onClick={handleSashaSave}
              disabled={sashaSaving || saving}
              className="w-full rounded-xl py-3 text-[13px] font-bold text-white transition disabled:opacity-50 active:scale-[0.98]"
              style={{ background: "#1c1917" }}
            >
              {(sashaSaving || saving) ? "Saving…" : "Save to Sheet"}
            </button>
          ) : (
            <button
              onClick={onClose}
              className="w-full rounded-xl py-3 text-[13px] font-semibold text-stone-600 bg-stone-100 hover:bg-stone-200 transition active:scale-[0.98]"
            >
              Close
            </button>
          )}
          {sashaResult === "ok"   && <p className="text-center text-[10px] font-semibold text-emerald-500">Saved successfully</p>}
          {sashaResult === "fail" && <p className="text-center text-[10px] font-semibold text-red-400">Save failed — try again</p>}
        </div>
      </div>
    </>
  );
}

// ─── Mobile quick-status selector ────────────────────────────────────────────

interface MobileStatusPickerProps {
  currentGroup: CardGroup;
  onSelect: (group: CardGroup) => void;
  onClose: () => void;
  saving: boolean;
}

const ACTIVE_GROUPS = CARD_GROUPS.filter(g => g.id !== "delivered");
const DELIVERED_GROUP = CARD_GROUPS.find(g => g.id === "delivered")!;

function MobileStatusPicker({ currentGroup, onSelect, onClose, saving }: MobileStatusPickerProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-t-2xl bg-white pb-6 pt-3 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-200" />
        <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 px-4 pb-2">Move to</p>
        <div className="flex flex-col divide-y divide-stone-100">
          {CARD_GROUPS.map(g => (
            <button
              key={g.id}
              disabled={saving || g.id === currentGroup}
              onClick={() => onSelect(g.id)}
              className="flex items-center gap-3 px-4 py-3 text-left transition disabled:opacity-40"
              style={{ background: g.id === currentGroup ? g.bgColor : undefined }}
            >
              <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: g.sheetColor }} />
              <span className="flex-1 text-[12px] font-medium text-stone-800">{g.label}</span>
              {g.id === currentGroup && (
                <svg className="h-3.5 w-3.5 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
              {saving && g.id !== currentGroup && (
                <svg className="h-3 w-3 text-stone-300 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Editor avatar + age badge helpers ───────────────────────────────────────

function EditorAvatar({ name }: { name: string }) {
  if (!name) {
    return <div className="h-5 w-5 rounded-full bg-stone-100 flex-shrink-0" />;
  }
  const initials = name.split(/\s+/).map(w => w[0]?.toUpperCase() ?? "").join("").slice(0, 2);
  const hue = [...name].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <div
      className="h-5 w-5 rounded-full flex items-center justify-center flex-shrink-0 text-[8px] font-bold text-white leading-none"
      style={{ background: `hsl(${hue},55%,50%)` }}
    >
      {initials}
    </div>
  );
}

function editingBadge(job: SheetJob): { label: string; bg: string; text: string } {
  const dateMs = parseDateMs(job.herman.date);
  if (!dateMs) return { label: "–", bg: "#f5f5f4", text: "#a8a29e" };
  const days = Math.floor((Date.now() - dateMs) / 86400000);
  if (days <= 3)  return { label: `${days}d`,  bg: "#f0fdf4", text: "#15803d" };
  if (days <= 7)  return { label: `${days}d`,  bg: "#fffbeb", text: "#b45309" };
  if (days <= 14) return { label: `${days}d`,  bg: "#fef3c7", text: "#d97706" };
  if (days <= 30) return { label: `${days}d`,  bg: "#fff7ed", text: "#c2410c" };
  return { label: `${days}d`, bg: "#fef2f2", text: "#b91c1c" };
}

// ─── Job card ─────────────────────────────────────────────────────────────────

interface CardProps {
  job: SheetJob;
  group: CardGroupDef;
  onSave: (job: SheetJob, sasha: SashaData) => Promise<void>;
  onSaveEmail: (job: SheetJob, emails: string) => Promise<void>;
  saving: boolean;
  onDragStart: (jobId: string) => void;
  onMoveStage?: (job: SheetJob, toGroup: CardGroup) => Promise<void>;
  onMarkReviewed?: (job: SheetJob) => Promise<void>;
  onPhotosSaved?: (job: SheetJob, photosToEdit: number | null) => Promise<void>;
  currentUserName?: string;
  isMobile?: boolean;
}

function JobCard({ job, group, onSave, onSaveEmail, saving, onDragStart, onMoveStage, onMarkReviewed, onPhotosSaved, currentUserName, isMobile }: CardProps) {
  const [expanded,          setExpanded]          = React.useState(false);
  const [showStatusPick,    setShowStatusPick]    = React.useState(false);
  const [showMobileDetail,  setShowMobileDetail]  = React.useState(false);
  const [movingSaving,   setMovingSaving]   = React.useState(false);
  const [sashaEdits,     setSashaEdits]     = React.useState<Partial<SashaData>>({});
  const [sashaSaving,    setSashaSaving]    = React.useState(false);
  const [sashaResult,    setSashaResult]    = React.useState<"ok" | "fail" | null>(null);
  const [emailEdit,      setEmailEdit]      = React.useState<string | null>(null);
  const [emailSaving,    setEmailSaving]    = React.useState(false);
  const [emailResult,    setEmailResult]    = React.useState<"ok" | "fail" | null>(null);
  const [photosEdit,     setPhotosEdit]     = React.useState<string | null>(null);
  const [photosSaving,   setPhotosSaving]   = React.useState(false);
  const [photosResult,   setPhotosResult]   = React.useState<"ok" | "fail" | null>(null);
  // Local copy of herman so checkbox clicks reflect instantly without waiting for a full sync
  const [localHerman, setLocalHerman] = React.useState(job.herman);
  React.useEffect(() => { setLocalHerman(job.herman); }, [job.herman]);

  function handleCheckboxUpdate(field: string, value: boolean) {
    setLocalHerman(h => ({ ...h, [field]: value }));
  }

  async function handleMobileMove(toGroup: CardGroup) {
    setShowStatusPick(false);
    if (!onMoveStage) return;
    setMovingSaving(true);
    try {
      await onMoveStage(job, toGroup);
    } finally {
      setMovingSaving(false);
    }
  }

  async function handleSashaSave() {
    setSashaSaving(true);
    try {
      const updated: SashaData = { ...DEFAULT_SASHA, ...job.sasha, ...sashaEdits };
      await onSave(job, updated);
      setSashaEdits({});
      setSashaResult("ok");
      setTimeout(() => setSashaResult(null), 2500);
    } catch {
      setSashaResult("fail");
    } finally {
      setSashaSaving(false);
    }
  }

  async function handleEmailSave() {
    if (emailEdit === null) return;
    setEmailSaving(true);
    try {
      await onSaveEmail(job, emailEdit.trim());
      setEmailEdit(null);
      setEmailResult("ok");
      setTimeout(() => setEmailResult(null), 2500);
    } catch {
      setEmailResult("fail");
    } finally {
      setEmailSaving(false);
    }
  }

  async function handlePhotosSave() {
    if (photosEdit === null) return;
    const parsed = photosEdit.trim() === "" ? null : parseInt(photosEdit.trim(), 10);
    if (photosEdit.trim() !== "" && (isNaN(parsed!) || parsed! < 0)) return;
    setPhotosSaving(true);
    try {
      const { ok } = await writePhotosToEdit(job, parsed);
      if (ok) {
        setLocalHerman(h => ({ ...h, photosToEdit: parsed }));
        setPhotosEdit(null);
        setPhotosResult("ok");
        setTimeout(() => setPhotosResult(null), 2500);
        if (onPhotosSaved) await onPhotosSaved(job, parsed).catch(() => {});
      } else {
        setPhotosResult("fail");
      }
    } catch {
      setPhotosResult("fail");
    } finally {
      setPhotosSaving(false);
    }
  }

  const h        = localHerman;
  const stripe   = group.sheetColor;
  const pkg      = formatPackage(h.package, h.photosToEdit);
  const activity = job.activity ?? DEFAULT_ACTIVITY;

  return (
    <>
      {showStatusPick && (
        <MobileStatusPicker
          currentGroup={group.id}
          onSelect={handleMobileMove}
          onClose={() => setShowStatusPick(false)}
          saving={movingSaving}
        />
      )}
      {showMobileDetail && (
        <MobileCardDrawer
          job={job}
          group={group}
          onSave={onSave}
          onSaveEmail={onSaveEmail}
          onMoveStage={onMoveStage}
          onMarkReviewed={onMarkReviewed}
          onPhotosSaved={onPhotosSaved}
          saving={saving}
          currentUserName={currentUserName}
          onClose={() => setShowMobileDetail(false)}
        />
      )}
      {(() => {
        const rs = job.sasha?.reviewStatus;
        const isAmber = rs === "waiting_german";
        const isBlue  = rs === "waiting_sasha";
        const cardClassName = [
          "rounded-xl select-none transition-all duration-150 hover:-translate-y-px",
          isAmber ? "card-action-amber" : isBlue ? "card-action-blue" : "bg-white",
        ].join(" ");
        const cardStyle: React.CSSProperties = {
          border: isAmber ? "1.5px solid #fbbf24" : isBlue ? "1.5px solid #93c5fd" : "1px solid #e8e3dc",
          boxShadow: isAmber
            ? "0 2px 12px rgba(251,191,36,0.18), 0 1px 4px rgba(0,0,0,0.04)"
            : isBlue
            ? "0 2px 12px rgba(59,130,246,0.15), 0 1px 4px rgba(0,0,0,0.04)"
            : "0 1px 4px rgba(0,0,0,0.04)",
          cursor: isMobile ? "default" : "grab",
        };
        return (
      <div
        draggable={!isMobile}
        onDragStart={!isMobile ? (e => { e.dataTransfer.setData("jobId", job.id); onDragStart(job.id); }) : undefined}
        className={cardClassName}
        style={cardStyle}
        onMouseEnter={e => {
          const shadow = isAmber
            ? "0 4px 18px rgba(251,191,36,0.28), 0 2px 8px rgba(0,0,0,0.08)"
            : isBlue
            ? "0 4px 18px rgba(59,130,246,0.22), 0 2px 8px rgba(0,0,0,0.08)"
            : "0 4px 14px rgba(0,0,0,0.09)";
          (e.currentTarget as HTMLElement).style.boxShadow = shadow;
        }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = cardStyle.boxShadow as string; }}
      >
        {/* ── Collapsed header ── */}
        <button
          className="w-full text-left px-4 pt-4 pb-3 active:bg-stone-50/50 rounded-xl"
          onClick={() => isMobile ? setShowMobileDetail(true) : setExpanded(e => !e)}
        >
          {/* Row 1: client name · date + chevron */}
          <div className="flex items-start justify-between gap-2">
            <span className="text-[15px] font-bold text-stone-900 leading-snug truncate flex-1">
              {h.galleryName || <em className="text-stone-300 font-normal text-[12px]">No name</em>}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
              {h.date && (
                <span className="text-[11px] font-medium text-stone-400 whitespace-nowrap">
                  {formatDate(h.date)}
                </span>
              )}
              {!isMobile && (
                <svg
                  className={`h-3 w-3 text-stone-300 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              )}
            </div>
          </div>

          {/* Row 2: hotel pill */}
          {h.resort && (
            <div className="mt-2">
              <span
                className="inline-block text-[10px] font-semibold rounded-full px-2.5 py-[3px] leading-tight"
                style={{ background: stripe + "22", color: stripe, border: `1px solid ${stripe}40` }}
              >
                {h.resort}
              </span>
            </div>
          )}

          {/* Row 3: review status chip (large) + action badges */}
          {(() => {
            const rs = job.sasha?.reviewStatus;
            const ar = job.sasha?.actionReason;
            const photosToEdit = localHerman.photosToEdit;
            const hasNewComment  = ar === "new_comment";
            const hasPhotosAdded = ar === "photos_added";
            const isActionNeeded = rs === "waiting_german" || rs === "waiting_sasha";

            const reviewCfg =
              rs === "waiting_german"
                ? { label: "Waiting for German", bg: "#fff7ed", border: "#fed7aa", text: "#b45309" }
                : rs === "waiting_sasha"
                ? { label: "Waiting for Sasha",  bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8" }
                : rs === "reviewed"
                ? { label: "Reviewed",           bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d" }
                : null;

            if (!reviewCfg && !hasNewComment && !hasPhotosAdded) return null;

            return (
              <div className="mt-2.5 flex flex-col gap-1.5">
                {reviewCfg && (
                  <span
                    className={`inline-flex items-center gap-2 text-[11px] font-bold rounded-xl px-3 py-1.5 leading-tight${isActionNeeded ? " badge-pulse" : ""}`}
                    style={{ background: reviewCfg.bg, color: reviewCfg.text, border: `1.5px solid ${reviewCfg.border}` }}
                  >
                    {isActionNeeded ? (
                      <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                    ) : (
                      <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                    {reviewCfg.label}
                  </span>
                )}
                {(hasNewComment || hasPhotosAdded) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {hasNewComment && (
                      <span
                        className="inline-flex items-center gap-1.5 text-[10px] font-bold rounded-full px-2.5 py-[3px] leading-tight"
                        style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" }}
                      >
                        <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        New Comment
                      </span>
                    )}
                    {hasPhotosAdded && (
                      <span
                        className="inline-flex items-center gap-1.5 text-[10px] font-bold rounded-full px-2.5 py-[3px] leading-tight badge-pulse"
                        style={{ background: "#f0fdf4", color: "#065f46", border: "1px solid #6ee7b7" }}
                      >
                        <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                        </svg>
                        {photosToEdit != null ? `+${photosToEdit} Photos Requested` : "Photos Requested"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Divider */}
          <div className="mt-3 border-t border-stone-100" />

          {/* Bottom row: editor · package · age badge */}
          {(() => {
            const isNumericPkg = /^\d+$/.test((h.package ?? "").trim());
            const packageLabel = h.package
              ? (isNumericPkg ? `${h.package} Photos` : h.package)
              : (h.photosToEdit != null ? `${h.photosToEdit} Photos` : "");
            const editorName = activity.lastUpdatedBy || "";
            const badge = editingBadge(job);
            return (
              <div className="mt-3 flex items-center gap-2">
                <EditorAvatar name={editorName} />
                <span className="text-[11px] text-stone-500 flex-1 truncate">{editorName || "Unassigned"}</span>
                {packageLabel && (
                  <span className="text-[11px] text-stone-400 whitespace-nowrap flex-shrink-0">{packageLabel}</span>
                )}
                <span
                  className="flex-shrink-0 text-[11px] font-bold rounded-full px-2.5 py-[3px] leading-tight whitespace-nowrap"
                  style={{ background: badge.bg, color: badge.text }}
                >
                  {badge.label}
                </span>
              </div>
            );
          })()}
        </button>

        {/* ── Expanded panel (desktop only) ── */}
        {!isMobile && expanded && (
          <div
            className="border-t border-stone-100 overflow-y-auto"
            style={{ maxHeight: "min(65vh, 560px)", scrollbarWidth: "thin" }}
          >
            <div className="px-3 pt-3 pb-3 space-y-2.5">
              {/* Herman workflow checklist */}
              <div
                className="rounded-lg p-2.5 space-y-1.5"
                style={{ background: stripe + "0c", border: `1px solid ${stripe}20` }}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: stripe }} />
                  <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: stripe }}>
                    Workflow
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  <CheckRow value={h.saved}                  label="Saved"              field="saved"                  job={job} onUpdate={handleCheckboxUpdate} />
                  <CheckRow value={h.selectedAndPreedited}   label="Sel. & Preedited"   field="selectedAndPreedited"   job={job} onUpdate={handleCheckboxUpdate} />
                  <CheckRow value={h.imported}               label="Imported"            field="imported"               job={job} onUpdate={handleCheckboxUpdate} />
                  <CheckRow value={h.beginSelectionMailSent} label="Sel. mail sent"      field="beginSelectionMailSent" job={job} onUpdate={handleCheckboxUpdate} />
                  <CheckRow value={h.selectionReceived}      label="Selection received"  field="selectionReceived"      job={job} onUpdate={handleCheckboxUpdate} />
                  <CheckRow value={h.edited}                 label="Edited"              field="edited"                 job={job} onUpdate={handleCheckboxUpdate} />
                  <CheckRow value={h.editionUploaded}        label="Edition uploaded"    field="editionUploaded"        job={job} onUpdate={handleCheckboxUpdate} />
                  <CheckRow value={h.delivered}              label="Delivered"           field="delivered"              job={job} onUpdate={handleCheckboxUpdate} />
                </div>

                {/* Photos to edit (column Q) — editable */}
                <div className="pt-1.5 border-t" style={{ borderColor: stripe + "20" }}>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[8px] font-bold uppercase tracking-wider text-stone-400">Photos to edit</p>
                    {photosResult === "ok" && (
                      <span className="text-[8px] font-semibold text-emerald-600">Saved</span>
                    )}
                    {photosResult === "fail" && (
                      <span className="text-[8px] font-semibold text-red-500">Failed</span>
                    )}
                    {photosSaving && (
                      <span className="text-[8px] text-stone-400">Saving…</span>
                    )}
                  </div>
                  <input
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min={0}
                    value={photosEdit ?? (localHerman.photosToEdit != null ? String(localHerman.photosToEdit) : "")}
                    onChange={e => setPhotosEdit(e.target.value)}
                    onBlur={handlePhotosSave}
                    onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
                    placeholder="Photos to edit…"
                    className="w-full rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-[9.5px] text-stone-800 placeholder:text-stone-300 outline-none focus:border-stone-400 focus:bg-white transition"
                    style={{ appearance: "textfield" }}
                  />
                </div>

                {h.remarks && (
                  <div className="pt-1.5 border-t" style={{ borderColor: stripe + "20" }}>
                    <p className="text-[8px] font-bold uppercase tracking-wider text-stone-400 mb-0.5">Remarks</p>
                    <p className="text-[9.5px] text-stone-600 leading-relaxed">{h.remarks}</p>
                  </div>
                )}
              </div>

              {/* Email (column G) */}
              <div className="space-y-1">
                <p className="text-[8px] font-bold uppercase tracking-wider text-stone-400">Email</p>
                <input
                  type="text"
                  value={emailEdit ?? localHerman.emails ?? ""}
                  onChange={e => setEmailEdit(e.target.value)}
                  placeholder="Add email…"
                  className="w-full rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-[9.5px] text-stone-800 placeholder:text-stone-300 outline-none focus:border-stone-400 focus:bg-white transition"
                />
                {emailEdit !== null && emailEdit.trim() !== (localHerman.emails ?? "").trim() && (
                  <button
                    onClick={handleEmailSave}
                    disabled={emailSaving}
                    className="w-full rounded-lg py-1.5 text-[9.5px] font-semibold text-white transition disabled:opacity-50 active:scale-[0.98]"
                    style={{ background: "#292524" }}
                  >
                    {emailSaving ? "Saving…" : "Save Email"}
                  </button>
                )}
                {emailResult === "ok"   && <span className="block text-center text-[8px] font-semibold text-emerald-500">Saved</span>}
                {emailResult === "fail" && <span className="block text-center text-[8px] font-semibold text-red-400">Failed</span>}
              </div>

              {/* Due priority / note (column W) */}
              <div className="space-y-1.5">
                <textarea
                  value={sashaEdits.comment ?? job.sasha.comment ?? ""}
                  onChange={e => setSashaEdits(p => ({ ...p, comment: e.target.value }))}
                  rows={2}
                  placeholder="Due priority / note…"
                  className="w-full rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-[9.5px] text-stone-800 placeholder:text-stone-300 outline-none focus:border-stone-400 focus:bg-white transition resize-none"
                />
                {Object.keys(sashaEdits).length > 0 && (
                  <button
                    onClick={handleSashaSave}
                    disabled={sashaSaving || saving}
                    className="w-full rounded-lg py-1.5 text-[9.5px] font-semibold text-white transition disabled:opacity-50 active:scale-[0.98]"
                    style={{ background: "#292524" }}
                  >
                    {(sashaSaving || saving) ? "Saving…" : "Save to Sheet"}
                  </button>
                )}
                {sashaResult === "ok"   && <span className="block text-center text-[8px] font-semibold text-emerald-500">Saved</span>}
                {sashaResult === "fail" && <span className="block text-center text-[8px] font-semibold text-red-400">Failed</span>}
              </div>

              {/* Activity + row ref */}
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 items-center">
                {activity.lastUpdatedBy && activity.lastUpdatedAt && (
                  <span className="text-[8px] text-stone-500">
                    <span className="font-semibold">{activity.lastUpdatedBy}</span>
                    {activity.lastAction ? ` · ${activity.lastAction}` : ""}
                    <span className="text-stone-300 ml-1">{activityLabel(activity.lastUpdatedAt)}</span>
                  </span>
                )}
                <span className="text-[7.5px] text-stone-300 font-mono">
                  Row {job.sheetRow}{job.blockEndRow > job.sheetRow ? `–${job.blockEndRow}` : ""}
                </span>
              </div>

              {/* Close row */}
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-stone-100">
                {/* Send for Review / Mark Reviewed buttons */}
                {(() => {
                  const rs = job.sasha?.reviewStatus;
                  const name = (currentUserName ?? "").toLowerCase();
                  const isSasha  = name.includes("sasha");
                  const isGerman = name.includes("german") || name.includes("hermann");

                  const canMarkReviewed = (rs === "waiting_sasha" && isSasha) || (rs === "waiting_german" && isGerman);
                  const canSendForReview = (isSasha || isGerman) && rs !== "waiting_german" && rs !== "waiting_sasha";
                  const targetName = isSasha ? "German" : isGerman ? "Sasha" : "";
                  const targetStatus: SashaReviewStatus = isSasha ? "waiting_german" : "waiting_sasha";

                  return (
                    <>
                      {canMarkReviewed && onMarkReviewed && (
                        <button
                          onClick={async () => { await onMarkReviewed(job); }}
                          className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[9.5px] font-semibold text-emerald-700 hover:bg-emerald-100 transition"
                        >
                          <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                          Mark Reviewed
                        </button>
                      )}
                      {canSendForReview && targetName && (
                        <button
                          onClick={async () => {
                            const updated: SashaData = { ...DEFAULT_SASHA, ...job.sasha, ...sashaEdits, reviewStatus: targetStatus, actionReason: "new_comment" };
                            await onSave(job, updated);
                          }}
                          className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[9.5px] font-semibold transition"
                          style={isSasha
                            ? { background: "#fff7ed", borderColor: "#fed7aa", color: "#b45309" }
                            : { background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8" }
                          }
                        >
                          <svg className="h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                          </svg>
                          Needs {targetName}
                        </button>
                      )}
                      {rs === "reviewed" && (
                        <span className="inline-flex items-center gap-1.5 text-[9px] font-medium text-emerald-600">
                          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                          Reviewed
                        </span>
                      )}
                    </>
                  );
                })()}
                <div className="flex-1" />
                <button
                  onClick={() => { setSashaEdits({}); setSashaResult(null); setExpanded(false); }}
                  className="rounded-lg border border-stone-200 px-3 py-1.5 text-[9.5px] font-medium text-stone-500 hover:bg-stone-50 transition"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
        );
      })()}
    </>
  );
}

// ─── Drop zone indicator ──────────────────────────────────────────────────────

function DropIndicator({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="h-1 rounded-full mx-1 transition-all" style={{ background: "#94a3b8" }} />
  );
}

// ─── Group column (desktop) ───────────────────────────────────────────────────

interface GroupColumnProps {
  group: CardGroupDef;
  jobs: SheetJob[];
  onSave: (job: SheetJob, sasha: SashaData) => Promise<void>;
  onSaveEmail: (job: SheetJob, emails: string) => Promise<void>;
  savingId: string | null;
  draggingId: string | null;
  onDragStart: (jobId: string) => void;
  onDrop: (groupId: CardGroup) => void;
  onMoveStage?: (job: SheetJob, toGroup: CardGroup) => Promise<void>;
  onMarkReviewed?: (job: SheetJob) => Promise<void>;
  onPhotosSaved?: (job: SheetJob, photosToEdit: number | null) => Promise<void>;
  currentUserName?: string;
}

function GroupColumnSafe(props: GroupColumnProps) {
  try {
    return <GroupColumn {...props} />;
  } catch (err) {
    console.error("[GroupColumn] render error for group", props.group.id, err);
    return (
      <div
        className="flex flex-col flex-shrink-0 rounded-xl border border-red-100 bg-red-50 items-center justify-center p-4"
        style={{ width: 272, minHeight: 120 }}
      >
        <p className="text-[9px] text-red-400 text-center">{props.group.label} — render error</p>
      </div>
    );
  }
}

function GroupColumn({ group, jobs, onSave, onSaveEmail, savingId, draggingId, onDragStart, onDrop, onMoveStage, onMarkReviewed, onPhotosSaved, currentUserName }: GroupColumnProps) {
  const [dragOver, setDragOver] = React.useState(false);

  return (
    <div className="flex flex-col flex-shrink-0" style={{ width: 272 }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-xl border mb-2 flex-shrink-0"
        style={{ background: group.bgColor, borderColor: group.sheetColor + "40" }}
      >
        <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: group.sheetColor }} />
        <span className="text-[10px] font-bold text-stone-700 flex-1 truncate">{group.label}</span>
        <span
          className="text-[9px] font-bold rounded-full px-2 py-0.5 flex-shrink-0 tabular-nums"
          style={{ background: group.sheetColor, color: "#fff" }}
        >
          {jobs.length}
        </span>
      </div>

      {/* Cards lane */}
      <div
        className="flex flex-col gap-2 rounded-xl p-2 flex-1 overflow-y-auto transition-colors"
        style={{
          background: dragOver ? group.sheetColor + "12" : group.bgColor + "60",
          border: `1px solid ${dragOver ? group.sheetColor + "60" : group.sheetColor + "18"}`,
          scrollbarWidth: "thin",
          minHeight: 64,
          paddingBottom: "5rem",
        }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          onDrop(group.id);
        }}
      >
        <DropIndicator active={dragOver && !!draggingId} />
        {jobs.length === 0 && !dragOver ? (
          <div className="flex items-center justify-center py-6">
            <span className="text-[9px] text-stone-300">No jobs</span>
          </div>
        ) : (
          jobs.map(job => {
            try {
              return (
                <JobCard
                  key={job.id}
                  job={job}
                  group={group}
                  onSave={onSave}
                  onSaveEmail={onSaveEmail}
                  saving={savingId === job.id}
                  onDragStart={onDragStart}
                  onMoveStage={onMoveStage}
                  onMarkReviewed={onMarkReviewed}
                  onPhotosSaved={onPhotosSaved}
                  currentUserName={currentUserName}
                  isMobile={false}
                />
              );
            } catch (err) {
              console.error("[JobCard] render error for job", job?.id, err);
              return (
                <div key={job?.id ?? Math.random()} className="rounded-lg bg-red-50 border border-red-100 p-2">
                  <p className="text-[9px] text-red-400">{job?.herman?.galleryName ?? "Card error"}</p>
                </div>
              );
            }
          })
        )}
      </div>
    </div>
  );
}

// ─── Delivered Archive ────────────────────────────────────────────────────────

interface DeliveredArchiveProps {
  jobs: SheetJob[];
  onSave: (job: SheetJob, sasha: SashaData) => Promise<void>;
  onSaveEmail: (job: SheetJob, emails: string) => Promise<void>;
  savingId: string | null;
  draggingId: string | null;
  onDragStart: (jobId: string) => void;
  onDrop: (groupId: CardGroup) => void;
  onMoveStage?: (job: SheetJob, toGroup: CardGroup) => Promise<void>;
  onMarkReviewed?: (job: SheetJob) => Promise<void>;
  onPhotosSaved?: (job: SheetJob, photosToEdit: number | null) => Promise<void>;
  currentUserName?: string;
  searchQuery?: string;
  isMobile?: boolean;
}

interface MonthBucket {
  key:   string; // "2026-05"
  label: string; // "May 2026"
  jobs:  SheetJob[];
}

function getMonthKey(dateStr: string): string {
  if (!dateStr) return "0000-00";
  if (/^\d{4}-\d{2}/.test(dateStr)) return dateStr.slice(0, 7);
  const ms = parseDateMs(dateStr);
  if (!ms) return "0000-00";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  if (key === "0000-00") return "Unknown date";
  const [y, m] = key.split("-").map(Number);
  return `${LONG_MONTH[m - 1]} ${y}`;
}

function groupByMonth(jobs: SheetJob[]): MonthBucket[] {
  const map = new Map<string, SheetJob[]>();
  for (const job of jobs) {
    const key = getMonthKey(job.herman.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(job);
  }
  // Sort buckets newest-month first
  const sorted = [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  return sorted.map(([key, js]) => ({
    key,
    label: monthLabel(key),
    jobs: sortByDateDesc(js),
  }));
}

function DeliveredArchive({
  jobs, onSave, onSaveEmail, savingId, draggingId, onDragStart, onDrop, onMoveStage, onMarkReviewed, onPhotosSaved, currentUserName, searchQuery, isMobile,
}: DeliveredArchiveProps) {
  const group = CARD_GROUPS.find(g => g.id === "delivered")!;
  const [dragOver, setDragOver] = React.useState(false);
  // Track which month buckets are open. Default: open the most recent only.
  const [openMonths, setOpenMonths] = React.useState<Set<string>>(new Set());

  const filtered = React.useMemo(() => {
    if (!searchQuery) return jobs;
    const q = searchQuery.toLowerCase();
    return jobs.filter(job => {
      const h = job.herman;
      return [h.galleryName, h.resort, h.occasion, h.remarks, job.sasha.comment]
        .some(s => (s ?? "").toLowerCase().includes(q));
    });
  }, [jobs, searchQuery]);

  const buckets = React.useMemo(() => groupByMonth(filtered), [filtered]);

  // Auto-open newest month when buckets first load
  React.useEffect(() => {
    if (buckets.length > 0 && openMonths.size === 0) {
      setOpenMonths(new Set([buckets[0].key]));
    }
  }, [buckets.length]);

  function toggleMonth(key: string) {
    setOpenMonths(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const containerStyle: React.CSSProperties = isMobile
    ? {}
    : {
        background: dragOver ? group.sheetColor + "12" : group.bgColor + "60",
        border: `1px solid ${dragOver ? group.sheetColor + "60" : group.sheetColor + "18"}`,
        borderRadius: "0.75rem",
        padding: "0.5rem",
        flex: 1,
        overflowY: "auto",
        scrollbarWidth: "thin" as const,
        minHeight: 64,
        paddingBottom: "5rem",
      };

  const content = (
    <div
      style={containerStyle}
      onDragOver={!isMobile ? (e => { e.preventDefault(); setDragOver(true); }) : undefined}
      onDragLeave={!isMobile ? (() => setDragOver(false)) : undefined}
      onDrop={!isMobile ? (e => { e.preventDefault(); setDragOver(false); onDrop("delivered"); }) : undefined}
    >
      {!isMobile && <DropIndicator active={dragOver && !!draggingId} />}

      {buckets.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <span className="text-[9px] text-stone-300">{searchQuery ? "No results" : "No delivered jobs"}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {buckets.map(bucket => {
            const isOpen = openMonths.has(bucket.key);
            return (
              <div key={bucket.key} className="rounded-lg overflow-hidden border border-stone-100">
                {/* Month header */}
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-left transition hover:bg-stone-50"
                  style={{ background: isOpen ? group.bgColor : "#fff" }}
                  onClick={() => toggleMonth(bucket.key)}
                >
                  <svg
                    className={`h-3 w-3 text-stone-400 transition-transform flex-shrink-0 ${isOpen ? "rotate-90" : ""}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span className="flex-1 text-[10px] font-semibold text-stone-700">{bucket.label}</span>
                  <span
                    className="text-[8.5px] font-bold rounded-full px-2 py-0.5 tabular-nums"
                    style={{ background: group.sheetColor + "20", color: group.sheetColor }}
                  >
                    {bucket.jobs.length}
                  </span>
                </button>

                {/* Cards — only render when open (lazy) */}
                {isOpen && (
                  <div className="flex flex-col gap-1.5 p-2 border-t border-stone-100" style={{ background: group.bgColor + "60" }}>
                    {bucket.jobs.map(job => {
                      try {
                        return (
                          <JobCard
                            key={job.id}
                            job={job}
                            group={group}
                            onSave={onSave}
                            onSaveEmail={onSaveEmail}
                            saving={savingId === job.id}
                            onDragStart={onDragStart}
                            onMoveStage={onMoveStage}
                            onMarkReviewed={onMarkReviewed}
                            onPhotosSaved={onPhotosSaved}
                            currentUserName={currentUserName}
                            isMobile={isMobile}
                          />
                        );
                      } catch (err) {
                        console.error("[DeliveredArchive] render error for job", job?.id, err);
                        return (
                          <div key={job?.id ?? Math.random()} className="rounded-lg bg-red-50 border border-red-100 p-2">
                            <p className="text-[9px] text-red-400">{job?.herman?.galleryName ?? "Card error"}</p>
                          </div>
                        );
                      }
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  if (isMobile) return content;

  return (
    <div className="flex flex-col flex-shrink-0" style={{ width: 272 }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-xl border mb-2 flex-shrink-0"
        style={{ background: group.bgColor, borderColor: group.sheetColor + "40" }}
      >
        <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: group.sheetColor }} />
        <span className="text-[10px] font-bold text-stone-700 flex-1 truncate">Delivered Archive</span>
        <span
          className="text-[9px] font-bold rounded-full px-2 py-0.5 flex-shrink-0 tabular-nums"
          style={{ background: group.sheetColor, color: "#fff" }}
        >
          {jobs.length}
        </span>
      </div>
      {content}
    </div>
  );
}

// ─── Mobile group (accordion) ─────────────────────────────────────────────────

interface MobileGroupProps {
  group: CardGroupDef;
  jobs: SheetJob[];
  onSave: (job: SheetJob, sasha: SashaData) => Promise<void>;
  onSaveEmail: (job: SheetJob, emails: string) => Promise<void>;
  savingId: string | null;
  onMoveStage?: (job: SheetJob, toGroup: CardGroup) => Promise<void>;
  onMarkReviewed?: (job: SheetJob) => Promise<void>;
  onPhotosSaved?: (job: SheetJob, photosToEdit: number | null) => Promise<void>;
  currentUserName?: string;
}

function MobileGroup({ group, jobs, onSave, onSaveEmail, savingId, onMoveStage, onMarkReviewed, onPhotosSaved, currentUserName }: MobileGroupProps) {
  const [open, setOpen] = React.useState(jobs.length > 0 && jobs.length <= 8);

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: group.sheetColor + "30" }}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        style={{ background: group.bgColor }}
        onClick={() => setOpen(o => !o)}
      >
        <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: group.sheetColor }} />
        <span className="text-[11px] font-bold text-stone-700 flex-1">{group.label}</span>
        <span
          className="text-[9px] font-bold rounded-full px-2 py-0.5 flex-shrink-0"
          style={{ background: group.sheetColor, color: "#fff" }}
        >
          {jobs.length}
        </span>
        <svg
          className={`h-4 w-4 text-stone-400 transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="p-2 flex flex-col gap-2" style={{ background: group.bgColor + "40" }}>
          {jobs.length === 0 ? (
            <p className="text-[9px] text-stone-300 text-center py-4">No jobs</p>
          ) : (
            jobs.map(job => {
              try {
                return (
                  <JobCard
                    key={job.id}
                    job={job}
                    group={group}
                    onSave={onSave}
                    onSaveEmail={onSaveEmail}
                    saving={savingId === job.id}
                    onDragStart={() => {}}
                    onMoveStage={onMoveStage}
                    onMarkReviewed={onMarkReviewed}
                    onPhotosSaved={onPhotosSaved}
                    currentUserName={currentUserName}
                    isMobile={true}
                  />
                );
              } catch (err) {
                console.error("[JobCard/mobile] render error for job", job?.id, err);
                return (
                  <div key={job?.id ?? Math.random()} className="rounded-lg bg-red-50 border border-red-100 p-2">
                    <p className="text-[9px] text-red-400">{job?.herman?.galleryName ?? "Card error"}</p>
                  </div>
                );
              }
            })
          )}
        </div>
      )}
    </div>
  );
}

// ─── Loading / error placeholders ────────────────────────────────────────────

function SyncingPlaceholder() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
      <svg className="h-7 w-7 text-stone-300 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <p className="text-[12px] text-stone-400">Loading from Google Sheets…</p>
    </div>
  );
}

function SyncErrorPlaceholder({ error, onRetry }: { error: string; onRetry: () => void }) {
  const isSecrets = /GOOGLE_SERVICE_ACCOUNT_JSON|GOOGLE_SHEET_ID|secret not configured/i.test(error);
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 py-16 px-8">
      <div className="h-12 w-12 rounded-xl bg-red-50 flex items-center justify-center">
        <svg className="h-6 w-6 text-red-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <div className="text-center max-w-xs">
        {isSecrets ? (
          <p className="text-[12px] font-semibold text-stone-700 mb-2">Google Sheets secrets not configured</p>
        ) : (
          <>
            <p className="text-[12px] font-semibold text-stone-700 mb-1">Sync failed</p>
            <p className="text-[11px] text-red-500 mb-3 leading-relaxed">{error}</p>
          </>
        )}
        <button
          onClick={onRetry}
          className="mx-auto flex items-center gap-1.5 rounded-xl border border-stone-200 bg-white px-4 py-2 text-[11px] font-medium text-stone-700 hover:bg-stone-50 transition"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.51" />
          </svg>
          Try again
        </button>
      </div>
    </div>
  );
}

// ─── Error boundary ───────────────────────────────────────────────────────────

interface EBState { error: Error | null }
class EditingErrorBoundary extends React.Component<{ children: React.ReactNode }, EBState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[EditingPipeline] render crash:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 py-16 px-8 flex-1">
          <div className="h-12 w-12 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
            <svg className="h-6 w-6 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div className="text-center max-w-sm">
            <p className="text-[13px] font-semibold text-stone-800 mb-1">Editing Pipeline crashed</p>
            <p className="text-[11px] text-red-500 mb-4 leading-relaxed font-mono break-all">
              {this.state.error.message}
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="flex items-center gap-1.5 mx-auto rounded-xl border border-stone-200 bg-white px-4 py-2 text-[11px] font-medium text-stone-700 hover:bg-stone-50 transition"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
              </svg>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Main panel props ─────────────────────────────────────────────────────────

export interface EditingPipelinePanelProps {
  sheetJobs: SheetJob[];
  syncState: SyncState;
  onSyncNow: () => void;
  onSaveSasha: (job: SheetJob, sasha: SashaData) => Promise<void>;
  onSaveEmail: (job: SheetJob, emails: string) => Promise<void>;
  onMoveStage?: (job: SheetJob, toGroup: CardGroup) => Promise<void>;
  onRemoveJob?: (job: SheetJob) => Promise<void>;
  onMarkReviewed?: (job: SheetJob) => Promise<void>;
  onPhotosSaved?: (job: SheetJob, photosToEdit: number | null) => Promise<void>;
  currentUserName?: string;
}

type FilterGroup = "all" | CardGroup | "new_comments" | "photo_requests" | "action_needed";

// ─── Sorting logic ────────────────────────────────────────────────────────────

// Active groups (not delivered): sort by shoot date descending — newest first.
// ready_to_send: preserve movedToReadyAt order when set; fall back to date desc.
// ready_to_send manual drag order is handled externally via localOrder state.

function sortActiveGroup(id: CardGroup, jobs: SheetJob[]): SheetJob[] {
  if (id === "ready_to_send") {
    return [...jobs].sort((a, b) => {
      const tA = a.sasha.movedToReadyAt ?? "";
      const tB = b.sasha.movedToReadyAt ?? "";
      // Both have timestamp — newest moved-to-ready first
      if (tA && tB) return tB.localeCompare(tA);
      // One has timestamp, the other doesn't — timestamped goes first
      if (tA && !tB) return -1;
      if (!tA && tB) return 1;
      // Neither has timestamp — fall back to shoot date desc
      return parseDateMs(b.herman.date) - parseDateMs(a.herman.date);
    });
  }
  return sortByDateDesc(jobs);
}

// ─── Inner panel ─────────────────────────────────────────────────────────────

function EditingPipelinePanelInner({
  sheetJobs, syncState, onSyncNow, onSaveSasha, onSaveEmail, onMoveStage, onMarkReviewed, onPhotosSaved, currentUserName,
}: EditingPipelinePanelProps) {
  const [savingId,    setSavingId]    = React.useState<string | null>(null);
  const [filterGroup, setFilterGroup] = React.useState<FilterGroup>("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [draggingId,  setDraggingId]  = React.useState<string | null>(null);
  const [expanded,    setExpanded]    = React.useState(false);

  // Optimistic local overrides for instant drag feedback.
  // Cleared whenever the sheet syncs and sheetJobs changes (to avoid stale ghost states).
  const [localOverrides, setLocalOverrides] = React.useState<Map<string, Partial<SashaData>>>(new Map());
  const prevSheetJobsRef = React.useRef<SheetJob[]>([]);

  React.useEffect(() => {
    const prev = prevSheetJobsRef.current;
    const curr = sheetJobs ?? [];
    // If the set of job IDs changed (sync returned new/removed jobs), purge overrides
    // for IDs that no longer exist in the current sheet.
    if (prev !== curr) {
      const currIds = new Set(curr.map(j => j.id));
      const hasOrphans = [...localOverrides.keys()].some(id => !currIds.has(id));
      if (hasOrphans) {
        setLocalOverrides(prev => {
          const next = new Map(prev);
          for (const id of [...next.keys()]) {
            if (!currIds.has(id)) next.delete(id);
          }
          return next;
        });
      }
      prevSheetJobsRef.current = curr;
    }
  }, [sheetJobs]);

  const mergedJobs = React.useMemo(() => (sheetJobs ?? []).map(job => {
    if (!job) return null;
    try {
      const ov = localOverrides.get(job.id);
      return ov ? { ...job, sasha: { ...DEFAULT_SASHA, ...job.sasha, ...ov } } : job;
    } catch {
      return job;
    }
  }).filter((j): j is SheetJob => j !== null), [sheetJobs, localOverrides]);

  const validJobs = React.useMemo(() =>
    mergedJobs.filter(j => {
      try { return (j.herman?.galleryName ?? "").trim() !== ""; }
      catch { return false; }
    }),
    [mergedJobs]
  );

  // Search applies to all groups including delivered
  const filtered = React.useMemo(() => validJobs.filter(job => {
    try {
      if (filterGroup === "action_needed") {
        const rs = job.sasha?.reviewStatus;
        if (rs !== "waiting_german" && rs !== "waiting_sasha") return false;
      } else if (filterGroup === "new_comments") {
        if (job.sasha?.actionReason !== "new_comment") return false;
      } else if (filterGroup === "photo_requests") {
        if (job.sasha?.actionReason !== "photos_added") return false;
      } else if (filterGroup !== "all") {
        if (groupForJob(job) !== filterGroup) return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const h = job.herman;
        if (![h?.galleryName, h?.resort, h?.occasion, h?.remarks, job.sasha?.comment]
          .some(s => (s ?? "").toLowerCase().includes(q))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }), [validJobs, filterGroup, searchQuery]);

  // Debug: log rendered counts whenever data changes
  React.useEffect(() => {
    if (!validJobs.length && !sheetJobs?.length) return;
    const counts: Record<string, number> = {};
    for (const job of validJobs) {
      const g = groupForJob(job);
      counts[g] = (counts[g] ?? 0) + 1;
    }
    const sheetRows = (sheetJobs ?? []).length;
    const rendered  = validJobs.length;
    const idSet = new Set(validJobs.map(j => j.id));
    const dupeIds = validJobs.length - idSet.size;
    console.log(
      `[EditingPipeline] sheetJobs=${sheetRows} → rendered=${rendered} dupeIds=${dupeIds}`,
      `counts=${JSON.stringify(counts)}`
    );
    if (dupeIds > 0) {
      console.warn("[EditingPipeline] DUPLICATE IDs detected in rendered jobs:", dupeIds);
    }
  }, [validJobs, sheetJobs]);

  const activeGrouped = React.useMemo(() => {
    const map = new Map<CardGroup, SheetJob[]>();
    const activeIds: CardGroup[] = ["not_started", "waiting_selection", "in_progress", "ready_to_send"];
    for (const id of activeIds) map.set(id, []);
    for (const job of filtered) {
      const g = groupForJob(job);
      if (g !== "delivered") map.get(g)?.push(job);
    }
    // Sort each active group
    for (const [id, jobs] of map) map.set(id, sortActiveGroup(id, jobs));
    return map;
  }, [filtered]);

  // Delivered jobs for archive
  const deliveredJobs = React.useMemo(() =>
    filtered.filter(j => groupForJob(j) === "delivered"),
    [filtered]
  );

  const total = validJobs.length;
  // Google Sheet rows loaded = sheetJobs prop length; rendered = validJobs (after dedup/filter)
  const sheetRowCount = (sheetJobs ?? []).length;

  async function handleSave(job: SheetJob, sasha: SashaData) {
    setSavingId(job.id);
    setLocalOverrides(prev => new Map(prev).set(job.id, { ...sasha, syncStatus: "pending" }));
    try {
      await onSaveSasha(job, sasha);
      setLocalOverrides(prev => new Map(prev).set(job.id, { ...sasha, syncStatus: "synced" }));
      setTimeout(() => setLocalOverrides(prev => { const n = new Map(prev); n.delete(job.id); return n; }), 5000);
    } catch {
      setLocalOverrides(prev => new Map(prev).set(job.id, { ...sasha, syncStatus: "failed" }));
    } finally {
      setSavingId(null);
    }
  }

  async function handleDrop(toGroup: CardGroup) {
    if (!draggingId) return;
    const job = mergedJobs.find(j => j.id === draggingId);
    if (!job) { setDraggingId(null); return; }
    const currentGroup = groupForJob(job);
    if (currentGroup === toGroup) { setDraggingId(null); return; }

    const now = new Date().toISOString();
    const updatedSasha: SashaData = {
      ...job.sasha,
      stage: toGroup,
      syncStatus: "pending",
      movedToReadyAt: toGroup === "ready_to_send" ? now : (job.sasha.movedToReadyAt ?? ""),
    };
    setLocalOverrides(prev => new Map(prev).set(job.id, updatedSasha));
    setDraggingId(null);

    try {
      if (onMoveStage) {
        await onMoveStage(job, toGroup);
      } else {
        await onSaveSasha(job, updatedSasha);
      }
      setLocalOverrides(prev => new Map(prev).set(job.id, { ...updatedSasha, syncStatus: "synced" }));
      setTimeout(() => setLocalOverrides(prev => { const n = new Map(prev); n.delete(job.id); return n; }), 5000);
    } catch {
      setLocalOverrides(prev => new Map(prev).set(job.id, { ...job.sasha, syncStatus: "failed" }));
    }
  }

  const activeGroupDefs = CARD_GROUPS.filter(g => g.id !== "delivered");
  const showJobs  = validJobs.length > 0;
  const isSyncing = syncState.status === "syncing" || syncState.status === "idle";
  const hasError  = syncState.status === "error" && !showJobs;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* SyncBanner hidden — sync status visible via toolbar dot; Sync Now in dropdown */}
      {!showJobs && isSyncing && <SyncingPlaceholder />}
      {hasError && <SyncErrorPlaceholder error={syncState.error ?? "Sync failed"} onRetry={onSyncNow} />}

      {showJobs && (
        <>
          {/* Toolbar — hidden in expanded mode */}
          {!expanded && (
            <div className="flex flex-col gap-2 px-3 pt-2 pb-2 flex-shrink-0 border-b border-stone-100 md:flex-row md:flex-wrap md:items-center">
              {/* Top row: stage filter pills + (on desktop) spacer + search + expand */}
              <div className="flex items-center gap-2 w-full md:contents">
                {/* Stage filter pills */}
                <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
                  <button
                    onClick={() => setFilterGroup("all")}
                    className="flex-shrink-0 text-[9px] font-semibold rounded-full px-2.5 py-1 border transition-all"
                    style={filterGroup === "all"
                      ? { background: "#1c1917", color: "#fff", borderColor: "#1c1917" }
                      : { background: "#fff", color: "#78716c", borderColor: "#e7e5e4" }
                    }
                  >
                    All · {total}
                  </button>
                  {CARD_GROUPS.map(g => {
                    const count = g.id === "delivered"
                      ? deliveredJobs.length
                      : (activeGrouped.get(g.id) ?? []).length;
                    return (
                      <button
                        key={g.id}
                        onClick={() => setFilterGroup(filterGroup === g.id ? "all" : g.id)}
                        className="flex-shrink-0 flex items-center gap-1 text-[9px] font-medium rounded-full px-2.5 py-1 border transition-all"
                        style={filterGroup === g.id
                          ? { background: g.sheetColor, color: "#fff", borderColor: g.sheetColor }
                          : { background: "#fff", color: "#57534e", borderColor: g.sheetColor + "60" }
                        }
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                          style={{ background: filterGroup === g.id ? "#fff" : g.sheetColor }}
                        />
                        <span className="hidden sm:inline">{g.id === "delivered" ? "Delivered" : g.label}</span>
                        <span className="sm:hidden">{g.label.split(" ")[0]}</span>
                        <span className="font-bold tabular-nums">{count}</span>
                      </button>
                    );
                  })}

                  {/* New Comments chip */}
                  {(() => {
                    const commentCount = validJobs.filter(j => j.sasha?.actionReason === "new_comment").length;
                    return commentCount > 0 ? (
                      <button
                        onClick={() => setFilterGroup(filterGroup === "new_comments" ? "all" : "new_comments")}
                        className="flex-shrink-0 flex items-center gap-1.5 text-[9px] font-medium rounded-full px-3 py-1 border transition-all whitespace-nowrap"
                        style={filterGroup === "new_comments"
                          ? { background: "#d97706", color: "#fff", borderColor: "#d97706" }
                          : { background: "#fef3c7", color: "#92400e", borderColor: "#fcd34d" }
                        }
                      >
                        <svg className="h-2.5 w-2.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        New Comments <span className="font-bold tabular-nums">{commentCount}</span>
                      </button>
                    ) : null;
                  })()}

                  {/* Photo Requests chip */}
                  {(() => {
                    const photosCount = validJobs.filter(j => j.sasha?.actionReason === "photos_added").length;
                    return photosCount > 0 ? (
                      <button
                        onClick={() => setFilterGroup(filterGroup === "photo_requests" ? "all" : "photo_requests")}
                        className="flex-shrink-0 flex items-center gap-1.5 text-[9px] font-medium rounded-full px-3 py-1 border transition-all whitespace-nowrap"
                        style={filterGroup === "photo_requests"
                          ? { background: "#059669", color: "#fff", borderColor: "#059669" }
                          : { background: "#f0fdf4", color: "#065f46", borderColor: "#6ee7b7" }
                        }
                      >
                        <svg className="h-2.5 w-2.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                        </svg>
                        Photo Requests <span className="font-bold tabular-nums">{photosCount}</span>
                      </button>
                    ) : null;
                  })()}
                </div>

                <div className="hidden md:block flex-1" />

                {/* Search */}
                <div className="flex items-center gap-1.5 bg-white border border-stone-200 rounded-xl px-2.5 py-1.5 w-full md:w-36 flex-shrink-0">
                  <svg className="h-3 w-3 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search…"
                    className="flex-1 bg-transparent text-[10.5px] text-stone-700 placeholder:text-stone-400 outline-none min-w-0"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery("")} className="text-stone-300 hover:text-stone-500">
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Expand board toggle */}
                <button
                  onClick={() => setExpanded(true)}
                  className="hidden md:flex items-center gap-1.5 rounded-xl border border-stone-200 bg-white px-2.5 py-1.5 text-[9px] font-medium text-stone-500 hover:bg-stone-50 transition flex-shrink-0"
                  title="Expand board to full height"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
                    <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                  </svg>
                  Expand
                </button>
              </div>
            </div>
          )}

          {/* Expanded-mode mini toolbar */}
          {expanded && (
            <div className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0 border-b border-stone-100 bg-white/80">
              <span className="text-[9px] text-stone-400 font-medium">{filtered.length} of {total} jobs</span>
              <div className="flex-1" />
              <button
                onClick={() => setExpanded(false)}
                className="flex items-center gap-1.5 rounded-xl border border-stone-200 bg-white px-2.5 py-1 text-[9px] font-medium text-stone-500 hover:bg-stone-50 transition"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
                  <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>
                </svg>
                Exit full view
              </button>
            </div>
          )}

          {/* ── Desktop board ── */}
          <div className="hidden md:flex flex-1 min-h-0 overflow-x-auto overflow-y-hidden" style={{ scrollbarWidth: "thin" }}>
            <div
              className="flex items-stretch gap-3 px-3 pt-2"
              style={{ minWidth: "max-content", height: "100%" }}
            >
              {/* Active columns */}
              {activeGroupDefs.map(group => (
                <GroupColumnSafe
                  key={group.id}
                  group={group}
                  jobs={activeGrouped.get(group.id) ?? []}
                  onSave={handleSave}
                  onSaveEmail={onSaveEmail}
                  savingId={savingId}
                  draggingId={draggingId}
                  onDragStart={id => setDraggingId(id)}
                  onDrop={handleDrop}
                  onMoveStage={onMoveStage}
                  onMarkReviewed={onMarkReviewed}
                  onPhotosSaved={onPhotosSaved}
                  currentUserName={currentUserName}
                />
              ))}

              {/* Delivered archive column */}
              <DeliveredArchive
                jobs={deliveredJobs}
                onSave={handleSave}
                onSaveEmail={onSaveEmail}
                savingId={savingId}
                draggingId={draggingId}
                onDragStart={id => setDraggingId(id)}
                onDrop={handleDrop}
                onMoveStage={onMoveStage}
                onMarkReviewed={onMarkReviewed}
                onPhotosSaved={onPhotosSaved}
                currentUserName={currentUserName}
                searchQuery={searchQuery}
                isMobile={false}
              />

              {/* Trailing spacer */}
              <div className="w-3 flex-shrink-0" />
            </div>
          </div>

          {/* ── Mobile board ── */}
          <div className="md:hidden flex-1 overflow-y-auto px-3 py-2 space-y-2" style={{ scrollbarWidth: "thin" }}>
            {activeGroupDefs.map(group => (
              <MobileGroup
                key={group.id}
                group={group}
                jobs={activeGrouped.get(group.id) ?? []}
                onSave={handleSave}
                onSaveEmail={onSaveEmail}
                savingId={savingId}
                onMoveStage={onMoveStage}
                onMarkReviewed={onMarkReviewed}
                onPhotosSaved={onPhotosSaved}
                currentUserName={currentUserName}
              />
            ))}

            {/* Delivered archive (mobile) */}
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: DELIVERED_GROUP.sheetColor + "30" }}>
              <div
                className="flex items-center gap-2 px-3 py-2.5"
                style={{ background: DELIVERED_GROUP.bgColor }}
              >
                <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: DELIVERED_GROUP.sheetColor }} />
                <span className="text-[11px] font-bold text-stone-700 flex-1">Delivered Archive</span>
                <span
                  className="text-[9px] font-bold rounded-full px-2 py-0.5 flex-shrink-0"
                  style={{ background: DELIVERED_GROUP.sheetColor, color: "#fff" }}
                >
                  {deliveredJobs.length}
                </span>
              </div>
              <div className="p-2" style={{ background: DELIVERED_GROUP.bgColor + "40" }}>
                <DeliveredArchive
                  jobs={deliveredJobs}
                  onSave={handleSave}
                  onSaveEmail={onSaveEmail}
                  savingId={savingId}
                  draggingId={draggingId}
                  onDragStart={() => {}}
                  onDrop={() => {}}
                  onMoveStage={onMoveStage}
                  onMarkReviewed={onMarkReviewed}
                  onPhotosSaved={onPhotosSaved}
                  currentUserName={currentUserName}
                  searchQuery={searchQuery}
                  isMobile={true}
                />
              </div>
            </div>

            <div className="h-8" />
          </div>

          {/* Footer — only in normal mode */}
          {!expanded && (
            <div className="hidden md:flex items-center justify-between px-4 py-1 border-t border-stone-100 flex-shrink-0 text-[9px] text-stone-400">
              <span>
                {filtered.length} of {total} job{total !== 1 ? "s" : ""}
                {(filterGroup !== "all" || searchQuery) ? " · filtered" : ""}
              </span>
              <span>Sasha writes U–AA only · Herman A–T read-only</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function EditingPipelinePanel(props: EditingPipelinePanelProps) {
  return (
    <EditingErrorBoundary>
      <EditingPipelinePanelInner {...props} />
    </EditingErrorBoundary>
  );
}
