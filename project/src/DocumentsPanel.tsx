import React from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocFile {
  name: string;
  kind: "file";
  size: number;
  lastModified: number;
  handle: FileSystemFileHandle;
  parentHandle: FileSystemDirectoryHandle;
  path: string; // scoped to its source folder, e.g. "Accounting/Invoices/2026/May/FOU-001.pdf"
  sourceRoot: string; // display name of the source folder handle
}

export interface DocFolder {
  name: string;
  kind: "directory";
  path: string;
  handle: FileSystemDirectoryHandle;
  children: DocEntry[];
  sourceRoot: string;
}

export type DocEntry = DocFile | DocFolder;

// A linked folder entry stored in IDB alongside the handle
interface LinkedFolder {
  id: string; // stable ID for keying
  handle: FileSystemDirectoryHandle;
}

// ─── IDB helpers ─────────────────────────────────────────────────────────────

const DOCS_FOLDER_KEY = "sasha-docs-folder-handle";
const DOCS_LINKED_KEY = "sasha-docs-linked-handles";

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("sasha-fs-handles", 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("handles"))
        req.result.createObjectStore("handles");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getStoredDocsHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get(DOCS_FOLDER_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

async function storeDocsHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, DOCS_FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

async function getLinkedHandles(): Promise<LinkedFolder[]> {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get(DOCS_LINKED_KEY);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch { return []; }
}

async function storeLinkedHandles(items: LinkedFolder[]): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(items, DOCS_LINKED_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite"
): Promise<boolean> {
  try {
    // @ts-expect-error not in all TS lib versions
    let perm = await handle.queryPermission({ mode });
    if (perm === "granted") return true;
    // @ts-expect-error not in all TS lib versions
    perm = await handle.requestPermission({ mode });
    return perm === "granted";
  } catch { return false; }
}

async function getOrCreateNestedDir(
  root: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemDirectoryHandle> {
  let cur = root;
  for (const seg of segments) {
    cur = await cur.getDirectoryHandle(seg, { create: true });
  }
  return cur;
}

export async function saveFileToDocsFolder(
  filename: string,
  content: string | Blob,
  subPathSegments: string[]
): Promise<boolean> {
  const root = await getStoredDocsHandle();
  if (!root) return false;
  try {
    const ok = await verifyPermission(root, "readwrite");
    if (!ok) return false;
    const dir = await getOrCreateNestedDir(root, subPathSegments);
    const fh = await dir.getFileHandle(filename, { create: true });
    const blob =
      typeof content === "string"
        ? new Blob([content], { type: "text/html;charset=utf-8" })
        : content;
    const writable = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch { return false; }
}

// ─── Folder scanning ──────────────────────────────────────────────────────────

function isSystemFile(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (name === "desktop.ini" || name === "Thumbs.db") return true;
  if (name.endsWith(".tmp") || name.endsWith("~")) return true;
  return false;
}

async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  pathPrefix: string,
  sourceRoot: string
): Promise<DocEntry[]> {
  const entries: DocEntry[] = [];
  try {
    // @ts-expect-error values() not in all TS lib versions
    for await (const entry of handle.values()) {
      if (isSystemFile(entry.name)) continue;
      const entryPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        const dirHandle = entry as FileSystemDirectoryHandle;
        const children = await scanDirectory(dirHandle, entryPath, sourceRoot);
        entries.push({ name: entry.name, kind: "directory", path: entryPath, handle: dirHandle, children, sourceRoot });
      } else {
        const fh = entry as FileSystemFileHandle;
        let size = 0;
        let lastModified = 0;
        try {
          const f = await fh.getFile();
          size = f.size;
          lastModified = f.lastModified;
        } catch { /* unreadable */ }
        entries.push({ name: entry.name, kind: "file", size, lastModified, handle: fh, parentHandle: handle, path: entryPath, sourceRoot });
      }
    }
  } catch { /* permission error on subdirectory — skip */ }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return entries;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function flattenFiles(entries: DocEntry[]): DocFile[] {
  const out: DocFile[] = [];
  for (const e of entries) {
    if (e.kind === "file") out.push(e);
    else out.push(...flattenFiles(e.children));
  }
  return out;
}

function findEntriesAtPath(entries: DocEntry[], targetPath: string): DocEntry[] | null {
  for (const e of entries) {
    if (e.path === targetPath) return e.kind === "directory" ? e.children : null;
    if (e.kind === "directory") {
      const found = findEntriesAtPath(e.children, targetPath);
      if (found !== null) return found;
    }
  }
  return null;
}

const MONTH_FULL = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function pathMonth(path: string): string {
  const parts = path.toLowerCase().split("/");
  for (const p of parts) {
    const idx = MONTH_FULL.indexOf(p);
    if (idx >= 0) return String(idx + 1).padStart(2, "0");
  }
  return "";
}

function pathYear(path: string): string {
  const m = path.match(/\b(20\d{2})\b/);
  return m ? m[1] : "";
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function FileIcon({ name, className = "h-3.5 w-3.5" }: { name: string; className?: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return (
    <svg className={`${className} text-red-400 flex-shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>
    </svg>
  );
  if (["jpg","jpeg","png","gif","webp","heic"].includes(ext)) return (
    <svg className={`${className} text-sky-400 flex-shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  );
  if (["xls","xlsx","csv"].includes(ext)) return (
    <svg className={`${className} text-emerald-500 flex-shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>
    </svg>
  );
  if (["html","htm"].includes(ext)) return (
    <svg className={`${className} text-amber-500 flex-shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <polyline points="9 12 7 14 9 16"/><polyline points="15 12 17 14 15 16"/>
    </svg>
  );
  return (
    <svg className={`${className} text-stone-400 flex-shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

// ─── File preview modal ───────────────────────────────────────────────────────

function FilePreviewModal({ file, onClose, onDownload, onDelete }: {
  file: DocFile;
  onClose: () => void;
  onDownload: (f: DocFile) => void;
  onDelete?: (f: DocFile) => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [embedFailed, setEmbedFailed] = React.useState(false);
  const urlRef = React.useRef<string | null>(null);

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isImage = ["jpg","jpeg","png","gif","webp"].includes(ext);
  const isPdf = ext === "pdf";
  const isHtml = ext === "html" || ext === "htm";
  const canRead = isImage || isPdf || isHtml;

  React.useEffect(() => {
    setLoading(true);
    setReadError(null);
    setUrl(null);
    setEmbedFailed(false);
    if (!canRead) { setLoading(false); return; }
    (async () => {
      try {
        const f = await file.handle.getFile();
        const objUrl = URL.createObjectURL(f);
        urlRef.current = objUrl;
        setUrl(objUrl);
      } catch {
        setReadError("Cannot read file — permission may have expired.");
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
  }, [file.path]);

  function openInNewTab() {
    if (url) window.open(url, "_blank");
  }

  function HeaderActions() {
    return (
      <div className="flex items-center gap-1 flex-shrink-0 ml-1">
        {url && (
          <button onClick={openInNewTab} title="Open in new tab"
            className="flex items-center gap-1 h-6 px-2 rounded-md bg-stone-100 hover:bg-stone-200 transition text-stone-600 hover:text-stone-900 text-[9px] font-medium">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            <span className="hidden sm:inline">New tab</span>
          </button>
        )}
        <button onClick={() => onDownload(file)} title="Download"
          className="flex items-center gap-1 h-6 px-2 rounded-md bg-stone-100 hover:bg-stone-200 transition text-stone-600 hover:text-stone-900 text-[9px] font-medium">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          <span className="hidden sm:inline">Download</span>
        </button>
        {onDelete && (
          <button onClick={() => onDelete(file)} title="Delete"
            className="flex items-center gap-1 h-6 px-2 rounded-md bg-red-50 hover:bg-red-100 transition text-red-400 hover:text-red-600 text-[9px] font-medium">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
            <span className="hidden sm:inline">Delete</span>
          </button>
        )}
        <button onClick={onClose}
          className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-stone-100 transition text-stone-400 ml-0.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col w-full max-w-4xl"
        style={{ height: "min(92vh, 960px)" }}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-stone-100 flex-shrink-0 bg-white z-10">
          <FileIcon name={file.name} />
          <span className="text-[12px] font-semibold text-stone-800 truncate flex-1 min-w-0">{file.name}</span>
          <span className="text-[10px] text-stone-400 flex-shrink-0 hidden sm:block">{formatBytes(file.size)}</span>
          <HeaderActions />
        </div>
        <div className="flex-1 min-h-0 relative bg-stone-100">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-stone-400 text-[11px] bg-stone-50">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              Loading…
            </div>
          )}
          {!loading && readError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 bg-stone-50">
              <p className="text-[12px] font-semibold text-stone-700">Preview not available</p>
              <p className="text-[10px] text-red-400 text-center">{readError}</p>
              <button onClick={() => onDownload(file)}
                className="mt-1 flex items-center gap-1.5 rounded-lg bg-stone-900 text-white px-3 py-1.5 text-[11px] font-medium hover:bg-stone-800 transition">
                Download
              </button>
            </div>
          )}
          {!loading && !readError && url && isImage && (
            <div className="absolute inset-0 overflow-auto flex items-start justify-center p-4 bg-stone-100">
              <img src={url} alt={file.name} className="max-w-full h-auto shadow-md" />
            </div>
          )}
          {!loading && !readError && url && isHtml && (
            <iframe src={url} className="absolute inset-0 w-full h-full border-0" title={file.name} />
          )}
          {!loading && !readError && url && isPdf && !embedFailed && (
            <div className="absolute inset-0 flex flex-col">
              <iframe key={url} src={url} title={file.name} className="flex-1 w-full border-0 min-h-0" style={{ display: "block" }} />
              <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-stone-50 border-t border-stone-100">
                <span className="text-[9px] text-stone-400">PDF not showing?</span>
                <div className="flex gap-1.5">
                  <button onClick={openInNewTab}
                    className="flex items-center gap-1 h-5 px-2 rounded text-[9px] bg-stone-900 text-white hover:bg-stone-700 transition">
                    Open in new tab
                  </button>
                  <button onClick={() => setEmbedFailed(true)}
                    className="flex items-center gap-1 h-5 px-2 rounded text-[9px] bg-stone-100 text-stone-500 hover:bg-stone-200 transition">
                    Can't see it
                  </button>
                </div>
              </div>
            </div>
          )}
          {!loading && !readError && url && isPdf && embedFailed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-stone-50 px-6">
              <FileIcon name={file.name} className="h-10 w-10" />
              <p className="text-[12px] font-semibold text-stone-700 text-center">PDF preview unavailable in this browser</p>
              <div className="flex gap-2">
                <button onClick={openInNewTab}
                  className="flex items-center gap-1.5 rounded-lg bg-stone-900 text-white px-3 py-1.5 text-[11px] font-medium hover:bg-stone-800 transition">
                  Open in new tab
                </button>
                <button onClick={() => onDownload(file)}
                  className="flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-[11px] font-medium text-stone-700 hover:bg-stone-50 transition">
                  Download
                </button>
              </div>
            </div>
          )}
          {!loading && !readError && !canRead && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-stone-50 px-6">
              <FileIcon name={file.name} className="h-10 w-10" />
              <p className="text-[12px] font-semibold text-stone-700">Preview not supported for this file type</p>
              <button onClick={() => onDownload(file)}
                className="flex items-center gap-1.5 rounded-lg bg-stone-900 text-white px-3 py-1.5 text-[11px] font-medium hover:bg-stone-800 transition">
                Download
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar folder tree ──────────────────────────────────────────────────────

function FolderNode({
  entry, depth, activePath, onSelect,
}: {
  entry: DocFolder;
  depth: number;
  activePath: string;
  onSelect: (path: string) => void;
}) {
  const isActiveOrAncestor = activePath === entry.path || activePath.startsWith(entry.path + "/");
  const [open, setOpen] = React.useState(depth === 0 || isActiveOrAncestor);
  const subFolders = entry.children.filter(c => c.kind === "directory") as DocFolder[];
  const fileCount = flattenFiles(entry.children).length;

  React.useEffect(() => {
    if (isActiveOrAncestor) setOpen(true);
  }, [activePath]);

  return (
    <div>
      <button
        onClick={() => { setOpen(o => !o); onSelect(entry.path); }}
        className={`w-full flex items-center gap-1.5 py-[5px] pr-2 rounded-lg text-left transition-colors text-[10.5px] font-medium ${
          activePath === entry.path
            ? "bg-stone-900 text-white"
            : "text-stone-600 hover:bg-stone-100/80 hover:text-stone-800"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {subFolders.length > 0 ? (
          <svg className={`h-2.5 w-2.5 flex-shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        ) : (
          <span className="h-2.5 w-2.5 flex-shrink-0" />
        )}
        <svg className="h-3 w-3 flex-shrink-0 opacity-60" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
        </svg>
        <span className="truncate flex-1">{entry.name}</span>
        {fileCount > 0 && (
          <span className={`text-[9px] tabular-nums flex-shrink-0 ml-1 ${
            activePath === entry.path ? "text-white/50" : "text-stone-300"
          }`}>{fileCount}</span>
        )}
      </button>
      {open && subFolders.map(sub => (
        <FolderNode key={sub.path} entry={sub} depth={depth + 1} activePath={activePath} onSelect={onSelect} />
      ))}
    </div>
  );
}

// ─── Props & exports ──────────────────────────────────────────────────────────

export type OnDeleteFileCallback = (file: DocFile, invoiceNumber: string | null) => Promise<"proceed" | "cancel">;

export interface DocumentsPanelProps {
  onClose: () => void;
  onToast?: (msg: string, type: "success" | "error") => void;
  refreshTrigger?: number;
  onDeleteFile?: OnDeleteFileCallback;
}

function parseInvoiceNumber(filename: string): string | null {
  const m = filename.match(/^([A-Z]{2,4}-\d{3,})/);
  return m ? m[1] : null;
}

// ─── Source: a handle + its scanned entries ───────────────────────────────────

interface DocSource {
  id: string; // "root" | linked folder id
  label: string; // display name
  handle: FileSystemDirectoryHandle;
  entries: DocEntry[];
  isRoot: boolean;
}

// ─── Main DocumentsPanel ──────────────────────────────────────────────────────

export default function DocumentsPanel({ onClose, onToast, refreshTrigger, onDeleteFile }: DocumentsPanelProps) {
  const [rootHandle, setRootHandle] = React.useState<FileSystemDirectoryHandle | null>(null);
  const [linkedFolders, setLinkedFolders] = React.useState<LinkedFolder[]>([]);
  // sources: one per handle (root + linked)
  const [sources, setSources] = React.useState<DocSource[]>([]);

  const [activePath, setActivePath] = React.useState<string>("");
  const [activeSourceId, setActiveSourceId] = React.useState<string>("root");

  const [search, setSearch] = React.useState("");
  const [filterYear, setFilterYear] = React.useState("");
  const [filterMonth, setFilterMonth] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const [previewFile, setPreviewFile] = React.useState<DocFile | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<DocFile | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmChangeRoot, setConfirmChangeRoot] = React.useState(false);

  const fsSupported = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

  // ── Initial load ────────────────────────────────────────────────────────────

  React.useEffect(() => {
    (async () => {
      const [root, linked] = await Promise.all([getStoredDocsHandle(), getLinkedHandles()]);
      const validLinked: LinkedFolder[] = [];
      for (const lf of linked) {
        const ok = await verifyPermission(lf.handle, "readwrite").catch(() => false);
        if (ok) validLinked.push(lf);
      }
      if (root) {
        const ok = await verifyPermission(root, "readwrite");
        if (ok) {
          setRootHandle(root);
          setLinkedFolders(validLinked);
          await doScanAll(root, validLinked);
        }
      }
    })();
  }, []);

  React.useEffect(() => {
    if (refreshTrigger && rootHandle) doScanAll(rootHandle, linkedFolders);
  }, [refreshTrigger]);

  // ── Scan helpers ────────────────────────────────────────────────────────────

  async function scanSource(id: string, handle: FileSystemDirectoryHandle, isRoot: boolean): Promise<DocSource> {
    const entries = await scanDirectory(handle, handle.name, handle.name);
    return { id, label: handle.name, handle, entries, isRoot };
  }

  async function doScanAll(root: FileSystemDirectoryHandle, linked: LinkedFolder[]) {
    setLoading(true);
    try {
      const rootSource = await scanSource("root", root, true);
      const linkedSources = await Promise.all(linked.map(lf => scanSource(lf.id, lf.handle, false)));
      const allSources = [rootSource, ...linkedSources];
      setSources(allSources);
      // Reset active path to root "All files" view if nothing is selected
      setActivePath(prev => prev || root.name);
      setActiveSourceId(prev => prev || "root");
    } catch {
      onToast?.("Could not read folder contents. Try reconnecting.", "error");
    } finally {
      setLoading(false);
    }
  }

  // ── Folder management ───────────────────────────────────────────────────────

  async function pickRootFolder() {
    if (!fsSupported) return;
    try {
      const handle = await window.showDirectoryPicker!({ mode: "readwrite" });
      await storeDocsHandle(handle);
      setRootHandle(handle);
      setActivePath(handle.name);
      setActiveSourceId("root");
      setSearch(""); setFilterYear(""); setFilterMonth("");
      await doScanAll(handle, linkedFolders);
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError")
        onToast?.("Could not access folder. Permission denied.", "error");
    }
  }

  async function addLinkedFolder() {
    if (!fsSupported || !rootHandle) return;
    try {
      const handle = await window.showDirectoryPicker!({ mode: "readwrite" });
      const id = `linked-${Date.now()}`;
      const newLinked: LinkedFolder = { id, handle };
      const updated = [...linkedFolders, newLinked];
      setLinkedFolders(updated);
      await storeLinkedHandles(updated);
      await doScanAll(rootHandle, updated);
      setActivePath(handle.name);
      setActiveSourceId(id);
      onToast?.(`"${handle.name}" added to Documents`, "success");
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError")
        onToast?.("Could not access folder. Permission denied.", "error");
    }
  }

  async function removeLinkedFolder(id: string) {
    const updated = linkedFolders.filter(lf => lf.id !== id);
    setLinkedFolders(updated);
    await storeLinkedHandles(updated);
    if (activeSourceId === id) {
      setActiveSourceId("root");
      setActivePath(rootHandle?.name ?? "");
    }
    setSources(prev => prev.filter(s => s.id !== id));
    onToast?.("Folder removed from Documents (not deleted from disk)", "success");
  }

  // ── File operations ─────────────────────────────────────────────────────────

  async function downloadFile(f: DocFile) {
    try {
      const file = await f.handle.getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url; a.download = f.name; a.click();
      URL.revokeObjectURL(url);
    } catch {
      onToast?.("Could not download file.", "error");
    }
  }

  async function deleteFile(f: DocFile) {
    setDeleting(true);
    try {
      if (onDeleteFile) {
        const invoiceNum = parseInvoiceNumber(f.name);
        const decision = await onDeleteFile(f, invoiceNum);
        if (decision === "cancel") { setDeleting(false); setConfirmDelete(null); return; }
      }
      await (f.parentHandle as FileSystemDirectoryHandle & { removeEntry(name: string): Promise<void> }).removeEntry(f.name);
      setConfirmDelete(null);
      if (previewFile?.path === f.path) setPreviewFile(null);
      onToast?.(`Deleted ${f.name}`, "success");
      if (rootHandle) await doScanAll(rootHandle, linkedFolders);
    } catch (e: unknown) {
      const msg = e instanceof Error && e.name === "NotAllowedError"
        ? "Cannot delete — folder permission missing."
        : "Could not delete file.";
      onToast?.(msg, "error");
    } finally {
      setDeleting(false);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    // Drop target: use the active source's handle; fall back to root
    const activeSrc = sources.find(s => s.id === activeSourceId);
    const baseHandle = activeSrc?.handle ?? rootHandle;
    if (!baseHandle) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;

    let targetHandle: FileSystemDirectoryHandle = baseHandle;
    if (activePath && activePath !== baseHandle.name) {
      const rel = activePath.startsWith(baseHandle.name + "/")
        ? activePath.slice(baseHandle.name.length + 1)
        : activePath;
      for (const seg of rel.split("/")) {
        try { targetHandle = await targetHandle.getDirectoryHandle(seg); } catch { break; }
      }
    }
    let count = 0;
    for (const file of files) {
      try {
        const fh = await targetHandle.getFileHandle(file.name, { create: true });
        const writable = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        await writable.write(file); await writable.close();
        count++;
      } catch { /* skip */ }
    }
    if (count > 0) {
      onToast?.(`${count} file${count > 1 ? "s" : ""} uploaded`, "success");
      if (rootHandle) await doScanAll(rootHandle, linkedFolders);
    }
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  // All files across all sources
  const allFiles = React.useMemo(() => sources.flatMap(s => flattenFiles(s.entries)), [sources]);

  // Active source object
  const activeSrc = React.useMemo(() => sources.find(s => s.id === activeSourceId), [sources, activeSourceId]);

  // Files/entries visible for the current activePath within the active source
  const activeEntries = React.useMemo((): DocEntry[] => {
    if (!activeSrc) return [];
    if (activePath === activeSrc.handle.name) return activeSrc.entries;
    const found = findEntriesAtPath(activeSrc.entries, activePath);
    return found ?? activeSrc.entries;
  }, [activeSrc, activePath]);

  const activeFiles = React.useMemo(() => flattenFiles(activeEntries), [activeEntries]);

  const availableYears = React.useMemo(() => {
    const set = new Set<string>();
    for (const f of allFiles) { const y = pathYear(f.path); if (y) set.add(y); }
    return Array.from(set).sort().reverse();
  }, [allFiles]);

  const filteredFiles = React.useMemo(() => {
    const q = search.toLowerCase();
    // When search/filter active, search across ALL sources; otherwise show active path
    const pool = (search || filterYear || filterMonth) ? allFiles : activeFiles;
    return pool.filter(f => {
      if (q && !f.name.toLowerCase().includes(q) && !f.path.toLowerCase().includes(q)) return false;
      if (filterYear && pathYear(f.path) !== filterYear) return false;
      if (filterMonth && pathMonth(f.path) !== filterMonth) return false;
      return true;
    });
  }, [activeFiles, allFiles, search, filterYear, filterMonth]);

  const hasAnyFolder = rootHandle !== null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          onDownload={downloadFile}
          onDelete={f => { setPreviewFile(null); setConfirmDelete(f); }}
        />
      )}

      {/* Change root confirmation */}
      {confirmChangeRoot && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setConfirmChangeRoot(false)} />
          <div className="relative z-10 bg-white rounded-2xl shadow-2xl p-5 max-w-sm w-full mx-4">
            <p className="text-[13px] font-semibold text-stone-800 mb-2">Change main Documents folder?</p>
            <p className="text-[11px] text-stone-500 mb-4">
              Your linked folders will stay connected. Only the root folder will change.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmChangeRoot(false)}
                className="flex-1 rounded-xl border border-stone-200 py-2 text-[11px] font-medium text-stone-600 hover:bg-stone-50 transition">
                Cancel
              </button>
              <button onClick={() => { setConfirmChangeRoot(false); pickRootFolder(); }}
                className="flex-1 rounded-xl bg-stone-900 py-2 text-[11px] font-medium text-white hover:bg-stone-800 transition">
                Choose folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (() => {
        const invNum = parseInvoiceNumber(confirmDelete.name);
        return (
          <div className="fixed inset-0 z-[80] flex items-center justify-center">
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setConfirmDelete(null)} />
            <div className="relative z-10 bg-white rounded-2xl shadow-2xl p-5 max-w-sm w-full mx-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="h-9 w-9 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                  <svg className="h-4 w-4 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6"/><path d="M14 11v6"/>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-stone-800">Delete file?</p>
                  <p className="text-[10px] text-stone-500 truncate mt-0.5">{confirmDelete.name}</p>
                </div>
              </div>
              {invNum ? (
                <p className="text-[11px] text-stone-500 mb-4">
                  This PDF is linked to invoice <strong>{invNum}</strong>. The invoice record in Invoice History will also be removed.
                </p>
              ) : (
                <p className="text-[11px] text-stone-500 mb-4">This will permanently delete the file. This cannot be undone.</p>
              )}
              <div className="flex gap-2">
                <button onClick={() => setConfirmDelete(null)}
                  className="flex-1 rounded-xl border border-stone-200 py-2 text-[11px] font-medium text-stone-600 hover:bg-stone-50 transition">
                  Cancel
                </button>
                <button onClick={() => deleteFile(confirmDelete)} disabled={deleting}
                  className="flex-1 rounded-xl bg-red-600 py-2 text-[11px] font-medium text-white hover:bg-red-700 transition disabled:opacity-60">
                  {deleting ? "Deleting…" : invNum ? "Delete PDF + Invoice" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="fixed inset-0 z-50 flex">
        <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" onClick={onClose} />

        <div className="relative ml-auto h-full flex flex-col bg-[#faf8f5] border-l border-stone-200/60 shadow-2xl"
          style={{ width: "min(780px, 100vw)" }}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100/80 bg-white/80 backdrop-blur-sm flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <svg className="h-4 w-4 text-stone-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span className="text-[13px] font-semibold text-stone-800 tracking-tight">Documents</span>
              {rootHandle && (
                <span className="text-[10px] text-stone-400 truncate max-w-[120px]">{rootHandle.name}</span>
              )}
              {linkedFolders.length > 0 && (
                <span className="text-[9px] text-stone-300">+{linkedFolders.length} linked</span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {hasAnyFolder && fsSupported && (
                <>
                  {/* Refresh */}
                  <button onClick={() => rootHandle && doScanAll(rootHandle, linkedFolders)} disabled={loading} title="Refresh"
                    className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-stone-100 transition text-stone-400 disabled:opacity-40">
                    <svg className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                  </button>
                  {/* Add folder */}
                  <button onClick={addLinkedFolder} title="Add folder"
                    className="flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-medium text-stone-500 hover:bg-stone-100 transition border border-stone-200/60">
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Folder
                  </button>
                  {/* Change root */}
                  <button onClick={() => setConfirmChangeRoot(true)} title="Change root folder"
                    className="flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-medium text-stone-500 hover:bg-stone-100 transition border border-stone-200/60">
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span className="hidden sm:inline">Change Root</span>
                  </button>
                </>
              )}
              <button onClick={onClose} className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-stone-100 transition text-stone-400">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Empty state */}
          {!hasAnyFolder && (
            <div className="flex-1 flex flex-col items-center justify-center gap-5 px-8">
              <div className="h-16 w-16 rounded-2xl bg-stone-100 flex items-center justify-center">
                <svg className="h-8 w-8 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <div className="text-center space-y-1.5 max-w-xs">
                <p className="text-[13px] font-semibold text-stone-700">Connect your Documents folder</p>
                <p className="text-[11px] text-stone-400 leading-relaxed">
                  Select your main folder (e.g. iCloud Drive / Accounting). You can add more folders later without replacing it.
                </p>
              </div>
              {!fsSupported ? (
                <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-3 text-center max-w-xs">
                  <p className="text-[11px] font-semibold text-amber-700">Browser not supported</p>
                  <p className="text-[10px] text-amber-600 mt-0.5">Use Chrome or Edge on desktop for local file access.</p>
                </div>
              ) : (
                <button onClick={pickRootFolder}
                  className="flex items-center gap-2 rounded-xl bg-stone-900 text-white px-5 py-2.5 text-[12px] font-medium hover:bg-stone-800 transition active:scale-[0.97]">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  Choose Documents Folder
                </button>
              )}
            </div>
          )}

          {/* Connected state */}
          {hasAnyFolder && (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Search / filter toolbar */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-stone-100/60 bg-white/50 flex-shrink-0">
                <div className="flex-1 flex items-center gap-1.5 bg-stone-100/80 rounded-lg px-2.5 py-1.5 min-w-0">
                  <svg className="h-3 w-3 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all files…"
                    className="flex-1 bg-transparent text-[11px] text-stone-700 placeholder:text-stone-400 outline-none min-w-0" />
                  {search && (
                    <button onClick={() => setSearch("")} className="text-stone-400 hover:text-stone-600 flex-shrink-0">
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  )}
                </div>
                <select value={filterYear} onChange={e => setFilterYear(e.target.value)}
                  className="text-[10px] text-stone-600 bg-stone-100/80 rounded-lg px-2 py-1.5 outline-none cursor-pointer border-0 flex-shrink-0">
                  <option value="">All years</option>
                  {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)}
                  className="text-[10px] text-stone-600 bg-stone-100/80 rounded-lg px-2 py-1.5 outline-none cursor-pointer border-0 flex-shrink-0 hidden sm:block">
                  <option value="">All months</option>
                  {MONTH_SHORT.map((m, i) => (
                    <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>
                  ))}
                </select>
              </div>

              {/* Body: sidebar + file list */}
              <div className="flex-1 min-h-0 flex overflow-hidden">

                {/* Sidebar */}
                <div className="w-48 flex-shrink-0 border-r border-stone-100/60 overflow-y-auto py-2 px-1.5 bg-white/30 hidden sm:flex sm:flex-col"
                  style={{ scrollbarWidth: "thin" }}>

                  {sources.map(src => (
                    <div key={src.id} className="mb-3">
                      {/* Source header */}
                      <div className="flex items-center justify-between px-2 mb-0.5 group">
                        <span className="text-[8.5px] font-bold uppercase tracking-[0.18em] text-stone-300 truncate">
                          {src.isRoot ? "Root" : "Linked"}
                        </span>
                        {!src.isRoot && (
                          <button
                            onClick={() => removeLinkedFolder(src.id)}
                            title="Remove from Documents"
                            className="opacity-0 group-hover:opacity-100 text-[8px] text-stone-400 hover:text-red-500 transition flex items-center gap-0.5 flex-shrink-0"
                          >
                            <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                            Remove
                          </button>
                        )}
                      </div>
                      {/* "All files" button for this source */}
                      <button
                        onClick={() => { setActiveSourceId(src.id); setActivePath(src.handle.name); }}
                        className={`w-full flex items-center gap-1.5 px-2 py-[5px] rounded-lg text-left text-[10.5px] font-medium mb-0.5 transition-colors ${
                          activeSourceId === src.id && activePath === src.handle.name
                            ? "bg-stone-900 text-white"
                            : "text-stone-600 hover:bg-stone-100/80"
                        }`}
                      >
                        <svg className="h-3 w-3 flex-shrink-0 opacity-60" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                        </svg>
                        <span className="truncate flex-1">{src.label}</span>
                        <span className={`text-[9px] tabular-nums flex-shrink-0 ${
                          activeSourceId === src.id && activePath === src.handle.name ? "text-white/50" : "text-stone-300"
                        }`}>{flattenFiles(src.entries).length}</span>
                      </button>
                      {/* Sub-folders */}
                      {(src.entries.filter(e => e.kind === "directory") as DocFolder[]).map(folder => (
                        <FolderNode
                          key={folder.path}
                          entry={folder}
                          depth={0}
                          activePath={activeSourceId === src.id ? activePath : ""}
                          onSelect={path => { setActiveSourceId(src.id); setActivePath(path); }}
                        />
                      ))}
                    </div>
                  ))}

                  {/* Add folder shortcut */}
                  {fsSupported && (
                    <button onClick={addLinkedFolder}
                      className="mt-auto mx-2 mb-1 flex items-center gap-1.5 text-[9px] font-medium text-stone-400 hover:text-stone-600 transition py-1">
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                      </svg>
                      Add folder…
                    </button>
                  )}
                </div>

                {/* File list */}
                <div
                  className={`flex-1 min-w-0 overflow-y-auto relative transition-colors ${dragOver ? "bg-amber-50/60" : ""}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
                  onDrop={handleDrop}
                  style={{ scrollbarWidth: "thin" }}
                >
                  {dragOver && (
                    <div className="absolute inset-2 z-10 flex items-center justify-center border-2 border-dashed border-amber-300 rounded-xl pointer-events-none">
                      <div className="text-center">
                        <p className="text-[12px] font-semibold text-amber-600">Drop to upload</p>
                        <p className="text-[10px] text-amber-500 mt-0.5">into {activePath}</p>
                      </div>
                    </div>
                  )}

                  {loading ? (
                    <div className="h-32 flex items-center justify-center gap-2 text-stone-400 text-[11px]">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                      </svg>
                      Scanning files…
                    </div>
                  ) : filteredFiles.length === 0 ? (
                    <div className="h-32 flex flex-col items-center justify-center gap-2 text-stone-400">
                      <svg className="h-6 w-6 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                      </svg>
                      <p className="text-[11px]">
                        {search || filterYear || filterMonth ? "No files match filters" : "No files here"}
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-stone-100/80">
                      {filteredFiles.map(f => (
                        <div key={f.path + f.sourceRoot} className="flex items-center gap-2 px-3 py-2.5 hover:bg-white/80 transition-colors">
                          <button onClick={() => setPreviewFile(f)}
                            className="flex items-center gap-2 flex-1 min-w-0 text-left">
                            <FileIcon name={f.name} className="h-4 w-4 flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="truncate text-[11px] text-stone-800 font-medium leading-snug">{f.name}</p>
                              <p className="text-[9px] text-stone-400 truncate leading-snug mt-0.5">
                                {/* Show source root if searching across all */}
                                {(search || filterYear || filterMonth) && sources.length > 1
                                  ? <span className="text-stone-300 mr-1">{f.sourceRoot} /</span>
                                  : null}
                                {f.path.startsWith(activePath + "/")
                                  ? f.path.slice(activePath.length + 1).split("/").slice(0, -1).join(" / ")
                                  : f.path.split("/").slice(1, -1).join(" / ")}
                                {f.size > 0 && <span className="ml-1.5">{formatBytes(f.size)}</span>}
                              </p>
                            </div>
                          </button>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button onClick={() => setPreviewFile(f)} title="Preview"
                              className="flex items-center gap-1 h-6 px-2 rounded-md bg-stone-100 hover:bg-stone-200 transition text-stone-500 hover:text-stone-800 text-[9px] font-medium">
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                <circle cx="12" cy="12" r="3"/>
                              </svg>
                              <span className="hidden sm:inline">View</span>
                            </button>
                            <button onClick={() => downloadFile(f)} title="Download"
                              className="flex items-center gap-1 h-6 px-2 rounded-md bg-stone-100 hover:bg-stone-200 transition text-stone-500 hover:text-stone-800 text-[9px] font-medium">
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                              </svg>
                              <span className="hidden sm:inline">Save</span>
                            </button>
                            <button onClick={() => setConfirmDelete(f)} title="Delete"
                              className="flex items-center gap-1 h-6 px-2 rounded-md bg-red-50 hover:bg-red-100 transition text-red-400 hover:text-red-600 text-[9px] font-medium">
                              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                                <path d="M10 11v6"/><path d="M14 11v6"/>
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {!loading && filteredFiles.length > 0 && (
                    <div className="flex items-center justify-center gap-1.5 py-3 text-stone-300 text-[9px]">
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                        <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
                      </svg>
                      Drag files here to upload
                    </div>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-3 py-2 border-t border-stone-100/60 bg-white/50 flex-shrink-0">
                <span className="text-[9px] text-stone-400 tabular-nums">
                  {filteredFiles.length} file{filteredFiles.length !== 1 ? "s" : ""}
                  {(search || filterYear || filterMonth) && ` · filtered`}
                </span>
                <span className="text-[9px] text-stone-300 tabular-nums">{allFiles.length} total · {sources.length} source{sources.length !== 1 ? "s" : ""}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
