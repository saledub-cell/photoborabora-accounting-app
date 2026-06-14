import React, { useMemo, useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Shoot {
  id: number; date: string; hotel: string; client: string;
  eventType: string; photoPackage: string; department: string;
  source: string; ht: number; tax: number; finalAmount: number;
}
interface DirectRow { id: number; date: string; client: string; income: string; amount: number; }
interface CalendarEvent {
  id: number | string; date: string; time?: string;
  title: string; description?: string; location?: string;
}
interface SavedInvoice {
  id: string; invoiceNumber: string; invoiceDate: string;
  hotel: { name: string }; month: string; year: string;
  totalHT: number; totalTTC: number; status: string;
}
interface EditingJobRow { id: string; sasha_stage: string; data: Record<string, unknown>; }

export interface DashboardV2Props {
  shoots: Shoot[];
  directIncome: DirectRow[];
  savedInvoices: SavedInvoice[];
  calendarEvents: CalendarEvent[];
  onTabChange: (tab: string) => void;
}

// ─── Supabase client ──────────────────────────────────────────────────────────
const _sb = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);

// ─── Formatters ───────────────────────────────────────────────────────────────
function toN(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmtDE(v: unknown): string {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(toN(v));
}
function xpf(v: unknown): string { return fmtDE(v) + ' XPF'; }
function usdFmt(v: unknown): string {
  return '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(toN(v));
}
function compact(v: unknown): string {
  const n = toN(v);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return Math.round(n / 1_000) + 'K';
  return fmtDE(n);
}
function pctChange(curr: number, prev: number): number | null {
  if (prev === 0) return curr > 0 ? 100 : null;
  return Math.round((curr - prev) / prev * 100);
}
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Stage config ─────────────────────────────────────────────────────────────
const STAGE_GROUPS = [
  { keys: ['', 'not_started'],       label: 'Not Started',            color: '#94a3b8' },
  { keys: ['waiting_selection'],     label: 'Waiting for Selection',  color: '#f97316' },
  { keys: ['in_progress'],           label: 'In Progress / Editing',  color: '#8b5cf6' },
  { keys: ['ready_to_send'],         label: 'Ready to Send',          color: '#3b82f6' },
  { keys: ['delivered'],             label: 'Delivered Archive',      color: '#22c55e' },
];

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KPICard({ icon, label, value, unit, change, subText }: {
  icon: React.ReactNode; label: string; value: string; unit?: string;
  change?: number | null; subText?: string;
}) {
  return (
    <div className="rounded-[18px] bg-white border border-stone-200/60 px-4 py-3.5 flex gap-3 items-start shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center bg-stone-50 border border-stone-100">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[9px] uppercase tracking-[0.18em] text-stone-400 font-semibold mb-0.5">{label}</p>
        <p className="text-[21px] font-bold text-stone-900 leading-none tabular-nums">{value}</p>
        {unit && <p className="text-[9px] text-stone-400 mt-0.5">{unit}</p>}
        <div className="flex items-center gap-1.5 mt-1.5 min-h-[14px]">
          {change !== undefined && change !== null && (
            <span className={`text-[10px] font-bold ${change >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
              {change >= 0 ? '↑' : '↓'} {Math.abs(change)}%
            </span>
          )}
          {subText && <span className="text-[9px] text-stone-400">{subText}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Donut Chart ──────────────────────────────────────────────────────────────
interface DonutSeg { label: string; value: number; color: string; pct: number; }
function DonutChart({ segments, total }: { segments: DonutSeg[]; total: number }) {
  const r = 60, cx = 76, cy = 76;
  const circ = 2 * Math.PI * r;
  const startOff = circ / 4;
  let acc = 0;
  const active = segments.filter(s => s.value > 0);
  return (
    <svg viewBox="0 0 152 152" className="w-full max-w-[152px] flex-shrink-0">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1ede4" strokeWidth="22" />
      {active.map((seg, i) => {
        const len = (seg.value / total) * circ;
        const off = startOff - acc;
        acc += len;
        return (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none"
            stroke={seg.color} strokeWidth="22"
            strokeDasharray={`${len} ${circ}`}
            strokeDashoffset={off}
          />
        );
      })}
      <text x={cx} y={cy - 5} textAnchor="middle" fontSize="11" fontWeight="700" fill="#1c1917">{compact(total)}</text>
      <text x={cx} y={cy + 9} textAnchor="middle" fontSize="7" fill="#a8a29e">XPF Total</text>
    </svg>
  );
}

// ─── Line Chart ───────────────────────────────────────────────────────────────
function LineChart({ months, data, color = '#E5B93C' }: {
  months: string[]; data: number[]; color?: string;
}) {
  const W = 560, H = 180;
  const pl = 44, pr = 16, pt = 28, pb = 30;
  const cW = W - pl - pr, cH = H - pt - pb;
  const maxV = Math.max(...data, 1);

  // Round max up to a clean number for the y-axis
  const rawMax = maxV;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const niceMax = Math.ceil(rawMax / magnitude) * magnitude;

  const gradId = `rovg_${color.replace(/[^a-f0-9]/gi, '')}`;

  const pts = data.map((v, i) => ({
    x: pl + (data.length > 1 ? i / (data.length - 1) : 0.5) * cW,
    y: pt + (1 - v / niceMax) * cH,
    v,
  }));

  // Sharp polyline path (matches screenshot — not bezier)
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const baseY = (pt + cH).toFixed(2);
  const fillD = pts.length > 1
    ? `${pathD} L${pts[pts.length - 1].x.toFixed(2)},${baseY} L${pl},${baseY} Z`
    : '';

  // Y axis: 0, midpoint, max
  const yTicks = [0, niceMax / 2, niceMax].map(t => ({
    v: t,
    y: pt + (1 - t / niceMax) * cH,
  }));

  // Determine which points get a label (non-zero + not too crowded)
  const hasAnyData = data.some(v => v > 0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {/* Horizontal grid lines + Y labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={pl} y1={t.y.toFixed(2)} x2={W - pr} y2={t.y.toFixed(2)}
            stroke="#f0ece6" strokeWidth={i === 0 ? "0.6" : "0.8"} />
          <text x={pl - 5} y={(t.y + 3.5).toFixed(2)} textAnchor="end"
            fontSize="8" fill="#c2b89a" fontFamily="system-ui, sans-serif">
            {compact(t.v)}
          </text>
        </g>
      ))}

      {/* Fill area */}
      {fillD && hasAnyData && (
        <path d={fillD} fill={`url(#${gradId})`} />
      )}

      {/* Line */}
      {pts.length > 1 && hasAnyData && (
        <path d={pathD} fill="none" stroke={color} strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" />
      )}

      {/* Data points + value labels */}
      {pts.map((p, i) => (
        <g key={i}>
          {p.v > 0 && (
            <>
              <text x={p.x.toFixed(2)} y={(p.y - 8).toFixed(2)} textAnchor="middle"
                fontSize="7.5" fill="#7c6f5b" fontWeight="600" fontFamily="system-ui, sans-serif">
                {compact(p.v)}
              </text>
              <circle cx={p.x.toFixed(2)} cy={p.y.toFixed(2)} r="4"
                fill="white" stroke={color} strokeWidth="2" />
            </>
          )}
          {/* Month labels */}
          <text x={p.x.toFixed(2)} y={(H - 6).toFixed(2)} textAnchor="middle"
            fontSize="8" fill="#b5a898" fontFamily="system-ui, sans-serif">
            {months[i]}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ─── Bar row helper ───────────────────────────────────────────────────────────
function BarRow({ label, value, max, color, right }: {
  label: string; value: number; max: number; color: string; right?: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-stone-700 truncate min-w-0">{label}</span>
        <div className="flex-shrink-0">{right}</div>
      </div>
      <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${max > 0 ? Math.round((value / max) * 100) : 0}%`, background: color }} />
      </div>
    </div>
  );
}

// ─── Widget wrapper ───────────────────────────────────────────────────────────
function Widget({ title, badge, footer, footerTab, onTabChange, children }: {
  title: string; badge?: string; footer?: string; footerTab?: string;
  onTabChange?: (tab: string) => void; children: React.ReactNode;
}) {
  return (
    <div className="rounded-[20px] bg-white border border-stone-200/60 p-5 shadow-[0_1px_8px_rgba(0,0,0,0.04)] flex flex-col">
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <p className="text-[9.5px] uppercase tracking-[0.18em] text-stone-400 font-semibold">{title}</p>
        {badge && (
          <span className="text-[9px] bg-stone-100 text-stone-500 rounded-full px-2.5 py-0.5 font-medium">{badge}</span>
        )}
      </div>
      <div className="flex-1">{children}</div>
      {footer && footerTab && onTabChange && (
        <button
          onClick={() => onTabChange(footerTab)}
          className="mt-4 flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-700 transition flex-shrink-0"
        >
          {footer} <span>→</span>
        </button>
      )}
    </div>
  );
}

// ─── Icon helpers ─────────────────────────────────────────────────────────────
function Icon({ d, className = 'h-4 w-4' }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// ─── Main DashboardV2 ─────────────────────────────────────────────────────────
export default function DashboardV2({ shoots, directIncome, savedInvoices, calendarEvents, onTabChange }: DashboardV2Props) {
  const [editingJobs, setEditingJobs] = useState<EditingJobRow[]>([]);
  const [metricMode, setMetricMode] = useState<'ht' | 'ttc' | 'direct'>('ht');

  useEffect(() => {
    _sb.from('editing_jobs_cache').select('id, sasha_stage, data')
      .then(({ data }) => { if (data) setEditingJobs(data as EditingJobRow[]); });
  }, []);

  const c = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayStr = localDateStr(today);
    const tomorrowStr = localDateStr(new Date(today.getTime() + 86400000));
    const in7Str = localDateStr(new Date(today.getTime() + 7 * 86400000));

    const thisYear = now.getFullYear();
    const thisMo = now.getMonth() + 1;
    const lastMo = thisMo === 1 ? 12 : thisMo - 1;
    const lastMoYear = thisMo === 1 ? thisYear - 1 : thisYear;

    const inMo = (d: string, yr: number, mo: number) => {
      const dt = new Date(d); return dt.getFullYear() === yr && dt.getMonth() + 1 === mo;
    };

    // KPI data
    const shtTM = shoots.filter(s => inMo(s.date, thisYear, thisMo));
    const shtLM = shoots.filter(s => inMo(s.date, lastMoYear, lastMo));
    const htTM = shtTM.reduce((s, r) => s + r.ht, 0);
    const htLM = shtLM.reduce((s, r) => s + r.ht, 0);
    const ttcTM = shtTM.reduce((s, r) => s + r.finalAmount, 0);
    const ttcLM = shtLM.reduce((s, r) => s + r.finalAmount, 0);
    const dirTM = directIncome.filter(r => inMo(r.date, thisYear, thisMo)).reduce((s, r) => s + r.amount, 0);
    const dirLM = directIncome.filter(r => inMo(r.date, lastMoYear, lastMo)).reduce((s, r) => s + r.amount, 0);

    // Donut: all-time HT breakdown
    const allHT = shoots.reduce((s, r) => s + r.ht, 0);
    const catMap: Record<string, number> = {};
    directIncome.forEach(r => {
      const k = (r.income || 'Direct').trim();
      catMap[k] = (catMap[k] ?? 0) + r.amount;
    });
    const donutTotal = allHT + Object.values(catMap).reduce((s, v) => s + v, 0);
    const donutSegs: DonutSeg[] = [
      { label: 'Shoots', value: allHT, color: '#f5c84a', pct: donutTotal > 0 ? allHT / donutTotal * 100 : 0 },
      ...Object.entries(catMap).map(([k, v]) => ({
        label: k, value: v,
        color: /tip/i.test(k) ? '#94a3b8' : /print/i.test(k) ? '#3b82f6' : /extra/i.test(k) ? '#a78bfa' : '#22c55e',
        pct: donutTotal > 0 ? v / donutTotal * 100 : 0,
      })),
    ].sort((a, b) => b.value - a.value);

    // Hotel ranking (all-time)
    const hotelMap: Record<string, number> = {};
    shoots.forEach(s => { if (s.hotel) hotelMap[s.hotel] = (hotelMap[s.hotel] ?? 0) + s.ht; });
    const hotels = Object.entries(hotelMap).map(([hotel, total]) => ({ hotel, total }))
      .sort((a, b) => b.total - a.total).slice(0, 5);
    const maxHotel = hotels[0]?.total ?? 1;

    // Cash flow (this year)
    const ytdShoots = shoots.filter(s => new Date(s.date).getFullYear() === thisYear);
    const ytdDirect = directIncome.filter(r => new Date(r.date).getFullYear() === thisYear);
    const ytdShootsHT = ytdShoots.reduce((s, r) => s + r.ht, 0);
    const ytdDirectMap: Record<string, number> = {};
    ytdDirect.forEach(r => {
      const k = (r.income || 'Direct').trim();
      ytdDirectMap[k] = (ytdDirectMap[k] ?? 0) + r.amount;
    });
    const cashRows = [
      { label: 'From Hotels (Shoots)', value: ytdShootsHT, color: '#f5c84a' },
      ...Object.entries(ytdDirectMap).map(([k, v]) => ({
        label: k, value: v,
        color: /tip/i.test(k) ? '#94a3b8' : /print/i.test(k) ? '#3b82f6' : /extra/i.test(k) ? '#a78bfa' : '#22c55e',
      })),
    ].sort((a, b) => b.value - a.value);
    const cashTotal = cashRows.reduce((s, r) => s + r.value, 0);
    const maxCash = cashRows[0]?.value ?? 1;

    // Revenue timeline (this year, monthly)
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mHT = Array(12).fill(0), mTTC = Array(12).fill(0), mDirect = Array(12).fill(0);
    shoots.forEach(s => {
      const d = new Date(s.date);
      if (d.getFullYear() === thisYear) {
        mHT[d.getMonth()] += s.ht;
        mTTC[d.getMonth()] += s.finalAmount;
      }
    });
    directIncome.forEach(r => {
      const d = new Date(r.date);
      if (d.getFullYear() === thisYear) mDirect[d.getMonth()] += r.amount;
    });

    // Upcoming shoots (calendar events, next 7 days)
    const upcoming = calendarEvents
      .filter(e => e.date >= todayStr && e.date <= in7Str)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
    const upToday = upcoming.filter(e => e.date === todayStr);
    const upTomorrow = upcoming.filter(e => e.date === tomorrowStr);

    // Editing pipeline
    const stageCounts: Record<string, number> = {};
    editingJobs.forEach(j => { const k = j.sasha_stage ?? ''; stageCounts[k] = (stageCounts[k] ?? 0) + 1; });
    const totalJobs = editingJobs.length;
    const pending = editingJobs.filter(j => j.sasha_stage !== 'delivered').length;
    const stageRows = STAGE_GROUPS.map(g => {
      const count = g.keys.reduce((acc, k) => acc + (stageCounts[k] ?? 0), 0);
      return { ...g, count, pct: totalJobs > 0 ? (count / totalJobs) * 100 : 0 };
    });

    return {
      htTM, htLM, ttcTM, ttcLM, dirTM, dirLM,
      shootsTM: shtTM.length, shootsLM: shtLM.length,
      pending, totalJobs,
      donutSegs, donutTotal,
      hotels, maxHotel,
      cashRows, cashTotal, maxCash,
      MONTHS, mHT, mTTC, mDirect,
      upcoming, upToday, upTomorrow,
      stageRows,
    };
  }, [shoots, directIncome, calendarEvents, editingJobs]);

  const chartData = metricMode === 'ht' ? c.mHT : metricMode === 'ttc' ? c.mTTC : c.mDirect;
  const chartColor = metricMode === 'direct' ? '#22c55e' : '#E5B93C';

  function fmtDate(dateStr: string) {
    const d = new Date(dateStr + 'T12:00:00');
    return { day: d.getDate(), weekday: d.toLocaleDateString('en-US', { weekday: 'short' }), month: d.toLocaleDateString('en-US', { month: 'short' }) };
  }
  function fmtTime(t?: string) {
    if (!t) return '';
    if (/AM|PM/i.test(t)) return t.replace(/^0/, '');
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
  }

  return (
    <div className="space-y-4">

      {/* ── KPI Row ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard
          icon={<svg className="h-[18px] w-[18px] text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg>}
          label="HT Revenue" value={compact(c.htTM)} unit="XPF"
          change={pctChange(c.htTM, c.htLM)} subText="vs last month"
        />
        <KPICard
          icon={<svg className="h-[18px] w-[18px] text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>}
          label="TTC Revenue" value={compact(c.ttcTM)} unit="XPF"
          change={pctChange(c.ttcTM, c.ttcLM)} subText="vs last month"
        />
        <KPICard
          icon={<svg className="h-[18px] w-[18px] text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>}
          label="Direct Revenue" value={usdFmt(c.dirTM)}
          change={pctChange(c.dirTM, c.dirLM)} subText="vs last month"
        />
        <KPICard
          icon={<svg className="h-[18px] w-[18px] text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>}
          label="Shoots" value={String(c.shootsTM)} unit="This month"
          change={pctChange(c.shootsTM, c.shootsLM)} subText="vs last month"
        />
        <KPICard
          icon={<svg className="h-[18px] w-[18px] text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
          label="Pending Editing" value={String(c.pending)} unit="Active jobs"
          subText={`of ${c.totalJobs} total`}
        />
      </div>

      {/* ── Row 2: Breakdown · Upcoming · Editing ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] gap-4">

        {/* Revenue Breakdown */}
        <Widget title="Revenue Breakdown (HT)" footer="View full report" footerTab="Dashboard" onTabChange={onTabChange}>
          <div className="flex items-start gap-3">
            <DonutChart segments={c.donutSegs} total={c.donutTotal} />
            <div className="flex flex-col gap-2 min-w-0 flex-1 pt-1">
              {c.donutSegs.slice(0, 6).map((seg, i) => (
                <div key={i} className="flex items-center gap-2 min-w-0">
                  <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: seg.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] text-stone-600 truncate">{seg.label}</span>
                      <span className="text-[10px] font-bold text-stone-500 whitespace-nowrap">{seg.pct.toFixed(1)}%</span>
                    </div>
                    <p className="text-[9px] text-stone-400 tabular-nums">{fmtDE(seg.value)} XPF</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Widget>

        {/* Upcoming Shoots */}
        <Widget title="Upcoming Shoots" badge="Next 7 Days" footer="View full calendar" footerTab="Calendar" onTabChange={onTabChange}>
          {/* Summary pills */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            {[
              { label: 'TODAY',       count: c.upToday.length },
              { label: 'TOMORROW',    count: c.upTomorrow.length },
              { label: 'NEXT 7 DAYS', count: c.upcoming.length },
            ].map((g, i) => (
              <div key={i} className="bg-stone-50 rounded-[10px] px-2 py-2 text-center">
                <p className="text-[7.5px] uppercase tracking-[0.12em] text-stone-400 font-semibold">{g.label}</p>
                <p className="text-[20px] font-bold text-stone-900 leading-tight">{g.count}</p>
                <p className="text-[8.5px] text-stone-400">Shoots</p>
              </div>
            ))}
          </div>
          {/* Event list */}
          <div className="space-y-0.5 max-h-[196px] overflow-y-auto">
            {c.upcoming.length === 0 && (
              <p className="py-5 text-center text-[12px] text-stone-400">No upcoming shoots in the next 7 days.</p>
            )}
            {c.upcoming.map(evt => {
              const { day, weekday, month } = fmtDate(evt.date);
              const hotel = evt.location || '';
              return (
                <div key={evt.id} className="flex items-center gap-2.5 py-2 px-2 rounded-[10px] hover:bg-stone-50/80 transition">
                  <div className="flex-shrink-0 w-[42px] text-center bg-stone-100/60 rounded-lg py-1">
                    <p className="text-[7.5px] text-stone-400 uppercase">{month} {weekday}</p>
                    <p className="text-[13px] font-bold text-stone-800 leading-none">{day}</p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-semibold text-stone-900 truncate leading-tight">{evt.title}</p>
                    {hotel && <p className="text-[10px] text-stone-400 truncate">{hotel}</p>}
                  </div>
                  {evt.time && (
                    <span className="text-[10px] font-semibold text-stone-500 whitespace-nowrap flex-shrink-0 bg-stone-100/60 rounded-md px-1.5 py-0.5">
                      {fmtTime(evt.time)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Widget>

        {/* Editing Pipeline */}
        <Widget title="Editing Pipeline" badge={`Total ${c.totalJobs}`} footer="Open Editing Pipeline" footerTab="Editing" onTabChange={onTabChange}>
          <div className="space-y-4">
            {c.stageRows.map((stage, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: stage.color }} />
                    <span className="text-[11px] text-stone-700">{stage.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-bold text-stone-900 tabular-nums leading-none">{stage.count}</span>
                    <span className="text-[9px] text-stone-400 tabular-nums w-[30px] text-right">{stage.pct.toFixed(1)}%</span>
                  </div>
                </div>
                <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${stage.pct}%`, background: stage.color }} />
                </div>
              </div>
            ))}
          </div>
        </Widget>
      </div>

      {/* ── Row 3: Hotels · Cash Flow · Revenue Timeline ────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] gap-4">

        {/* Hotels Performance */}
        <Widget title="Hotels Performance (HT)" badge="All Time" footer="View all hotels" footerTab="Dashboard" onTabChange={onTabChange}>
          {c.hotels.length === 0 && <p className="text-[12px] text-stone-400 text-center py-6">No shoot data yet.</p>}
          <div className="space-y-3.5">
            {c.hotels.map((h, i) => (
              <BarRow key={h.hotel} label={h.hotel} value={h.total} max={c.maxHotel} color="#f5c84a"
                right={
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-semibold text-stone-400 w-3">{i + 1}</span>
                    <span className="text-[10.5px] font-semibold text-stone-700 tabular-nums whitespace-nowrap">
                      {compact(h.total)} XPF
                    </span>
                  </div>
                }
              />
            ))}
          </div>
        </Widget>

        {/* Cash Flow Summary */}
        <Widget title="Cash Flow Summary (HT)" badge="This Year" footer="View full cash flow" footerTab="Dashboard" onTabChange={onTabChange}>
          {c.cashRows.length === 0 && <p className="text-[12px] text-stone-400 text-center py-6">No data yet.</p>}
          <div className="space-y-3">
            {c.cashRows.map((row, i) => {
              const pct = c.cashTotal > 0 ? (row.value / c.cashTotal * 100).toFixed(1) : '0.0';
              return (
                <BarRow key={i} label={row.label} value={row.value} max={c.maxCash} color={row.color}
                  right={
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10.5px] font-semibold text-stone-700 tabular-nums whitespace-nowrap">
                        {fmtDE(row.value)} XPF
                      </span>
                      <span className="text-[9px] text-stone-400 tabular-nums w-[28px] text-right">{pct}%</span>
                    </div>
                  }
                />
              );
            })}
          </div>
          {c.cashRows.length > 0 && (
            <div className="mt-3 pt-3 border-t border-stone-100 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-stone-500">Total</span>
              <span className="text-[13px] font-bold text-stone-900 tabular-nums">{fmtDE(c.cashTotal)} XPF</span>
            </div>
          )}
        </Widget>

        {/* Revenue Overview */}
        <div className="rounded-[20px] bg-white border border-stone-200/60 p-5 shadow-[0_1px_8px_rgba(0,0,0,0.04)] flex flex-col">
          <div className="flex items-center justify-between mb-4 flex-shrink-0 gap-3 flex-wrap">
            <p className="text-[9.5px] uppercase tracking-[0.18em] text-stone-400 font-semibold">
              Revenue Overview ({metricMode.toUpperCase()})
            </p>
            <div className="flex items-center gap-0.5">
              {(['ht', 'ttc', 'direct'] as const).map(m => (
                <button key={m} onClick={() => setMetricMode(m)}
                  className={`text-[9px] font-bold px-2.5 py-1 rounded-full transition ${
                    metricMode === m
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-400 hover:text-stone-600'
                  }`}>
                  {m.toUpperCase()}
                </button>
              ))}
              <span className="text-[9px] text-stone-300 ml-1.5 mr-0.5">|</span>
              <span className="text-[9px] text-stone-400 font-medium">{new Date().getFullYear()}</span>
            </div>
          </div>
          <div className="flex-1 min-h-[160px]">
            <LineChart months={c.MONTHS} data={chartData} color={chartColor} />
          </div>
          <button onClick={() => onTabChange('Dashboard')}
            className="mt-3 flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-700 transition flex-shrink-0">
            View full analytics →
          </button>
        </div>
      </div>

      {/* ── Quick Actions ────────────────────────────────────────────────────── */}
      <div className="rounded-[20px] bg-white border border-stone-200/60 p-5 shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        <p className="text-[9.5px] uppercase tracking-[0.18em] text-stone-400 font-semibold mb-3">Quick Actions</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {[
            {
              label: 'New Shoot', tab: 'Shoots', color: '#f5c84a',
              icon: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>,
            },
            {
              label: 'New Invoice', tab: 'Invoices', color: '#3b82f6',
              icon: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
            },
            {
              label: 'Add Direct', tab: 'Direct', color: '#22c55e',
              icon: <><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>,
            },
            {
              label: 'Open Calendar', tab: 'Calendar', color: '#f97316',
              icon: <><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
            },
            {
              label: 'Open Editing', tab: 'Editing', color: '#8b5cf6',
              icon: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
            },
            {
              label: 'Price List', tab: 'Prices', color: '#94a3b8',
              icon: <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="3" cy="6" r="0.5" fill="currentColor" /><circle cx="3" cy="12" r="0.5" fill="currentColor" /><circle cx="3" cy="18" r="0.5" fill="currentColor" /></>,
            },
          ].map((action, i) => (
            <button key={i} onClick={() => onTabChange(action.tab)}
              className="flex items-center gap-2.5 rounded-[12px] px-3 py-2.5 border border-stone-200/60 bg-stone-50/40 hover:bg-stone-50 hover:border-stone-300 transition text-left">
              <div className="flex-shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center"
                style={{ background: action.color + '22' }}>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke={action.color}
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {action.icon}
                </svg>
              </div>
              <span className="text-[11px] font-medium text-stone-700 leading-tight">{action.label}</span>
            </button>
          ))}
        </div>
      </div>

    </div>
  );
}
