"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type DateSpan = { from: string; to: string };
type Preset = { id: string; label: string };

const DAY = 864e5;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);
const iso = (n: number) => new Date(n).toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(ms(s) + n * DAY);
const span = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY) + 1;
const addMonths = (ym: string, n: number) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const short = (s: string) => `${+s.slice(8)} ${MON[+s.slice(5, 7) - 1]}`;

/** "21 Oct – 19 Nov 2026"; both years are shown when the range crosses a year. */
export function fmtSpan(r: DateSpan) {
  const same = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${short(r.from)}${same ? "" : " " + r.from.slice(0, 4)} – ${short(r.to)} ${r.to.slice(0, 4)}`;
}

function Month({ ym, lo, hi, max, onNav, nav }: { ym: string; lo: string; hi: string; max: string; onNav: (n: number) => void; nav: "prev" | "next" | "none" }) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`)];
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 flex h-8 items-center justify-between">
        {nav === "prev" ? <button type="button" onClick={() => onNav(-1)} aria-label="Previous month" className="tap grid size-8 place-items-center rounded-lg [box-shadow:var(--neu-out-xs)] active:[box-shadow:var(--neu-in-sm)]"><ChevronLeft className="size-4" aria-hidden /></button> : <span className="size-8" />}
        <span className="text-sm font-semibold">{MONTH[m - 1]} {y}</span>
        {nav === "next" ? <button type="button" onClick={() => onNav(1)} aria-label="Next month" className="tap grid size-8 place-items-center rounded-lg [box-shadow:var(--neu-out-xs)] active:[box-shadow:var(--neu-in-sm)]"><ChevronRight className="size-4" aria-hidden /></button> : <span className="size-8" />}
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-muted-foreground">{WEEK.map((w) => <span key={w} className="py-1">{w}</span>)}</div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          if (!d) return <span key={`b${i}`} />;
          const off = d > max, inside = d >= lo && d <= hi, start = d === lo, end = d === hi;
          return (
            <button key={d} type="button" data-d={d} disabled={off} aria-pressed={inside} aria-label={`${+d.slice(8)} ${MONTH[m - 1]} ${y}`}
              className={cn("relative h-9 select-none text-sm tabular-nums outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring",
                off && "cursor-not-allowed text-muted-foreground/40",
                inside && !start && !end && "bg-primary/15",
                start && "rounded-l-full", end && "rounded-r-full", start && end && "rounded-full",
                (start || end) && "bg-primary font-semibold text-primary-foreground [box-shadow:var(--neu-out-xs)]",
                !inside && !off && "rounded-full hover:[box-shadow:var(--neu-out-xs)]")}>
              {+d.slice(8)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One button that shows the range and opens a two-month calendar. Press on a day and slide to another day to pick a range (mouse or finger),
 * or click a start day and then an end day. Quick ranges sit above the calendar.
 */
export function DateRange({ value, presets, preset, onPreset, onRange, max, maxDays = 400 }: {
  value: DateSpan; presets: Preset[]; preset: string; onPreset: (id: string) => void; onRange: (r: DateSpan) => void; max: string; maxDays?: number;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(value.from.slice(0, 7));
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const moved = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  const close = (back = true) => { setOpen(false); setAnchor(null); setHover(null); setDragFrom(null); if (back) btn.current?.focus(); };
  const openIt = () => { setView(addMonths(value.to.slice(0, 7), -1)); setNote(""); setOpen(true); };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) close(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const dayAt = (e: React.PointerEvent) => (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-d]")?.dataset.d ?? null;

  const commit = (a: string, b: string) => {
    const from = a < b ? a : b;
    let to = a < b ? b : a;
    let cut = "";
    if (span(from, to) > maxDays) { to = addDays(from, maxDays - 1); cut = `Limited to ${maxDays} days.`; }
    setNote(cut); onRange({ from, to }); close();
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const d = dayAt(e); if (!d || d > max) return;
    moved.current = false; setDragFrom(d); setHover(d);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dayAt(e);
    if (dragFrom) { if (d && d <= max && d !== hover) { setHover(d); if (d !== dragFrom) moved.current = true; } }
    else if (anchor && d && d <= max && d !== hover) setHover(d);
  };
  const onUp = (e: React.PointerEvent) => {
    const g = dragFrom; setDragFrom(null); if (!g) return;
    const d = dayAt(e) ?? hover ?? g;
    if (moved.current && d !== g) return commit(g, d <= max ? d : max);
    if (anchor) return commit(anchor, g);
    setAnchor(g); setHover(g);
  };
  const onKey = (e: React.MouseEvent) => {
    if (e.detail !== 0) return; // a real click was handled by the pointer events
    const d = (e.target as HTMLElement).closest<HTMLElement>("[data-d]")?.dataset.d; if (!d) return;
    if (anchor) commit(anchor, d); else { setAnchor(d); setHover(d); }
  };

  const base = dragFrom ?? anchor, other = hover ?? base;
  const shown: DateSpan = base && other ? { from: base < other ? base : other, to: base < other ? other : base } : value;
  const n = span(shown.from, shown.to);
  const tail = presets.find((p) => p.id === preset)?.label;

  return (
    <div ref={root} className="sm:relative">
      <button ref={btn} type="button" onClick={() => (open ? close() : openIt())} aria-haspopup="dialog" aria-expanded={open}
        className="tap inline-flex h-10 items-center gap-2 rounded-xl bg-card px-3 text-sm font-medium [box-shadow:var(--neu-out-xs)] hover:[box-shadow:var(--neu-out-sm)] active:[box-shadow:var(--neu-in-sm)]">
        <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
        <span className="tabular-nums">{fmtSpan(value)}</span>
        {tail && <span className="hidden text-xs font-normal text-muted-foreground sm:inline">· {tail}</span>}
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label="Pick a date range"
          className="pop z-40 rounded-2xl bg-card p-3 [box-shadow:var(--shadow-lg)] max-sm:absolute max-sm:inset-x-0 max-sm:top-full max-sm:mt-2 sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-[40rem]">
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Quick ranges">
            {presets.map((p) => (
              <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => { onPreset(p.id); close(); }}
                className={cn("tap h-8 rounded-full px-3 text-xs font-medium", preset === p.id ? "bg-primary text-primary-foreground [box-shadow:var(--neu-in-sm)]" : "bg-card [box-shadow:var(--neu-out-xs)] active:[box-shadow:var(--neu-in-sm)]")}>{p.label}</button>
            ))}
          </div>
          <div className="flex gap-6 touch-none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDragFrom(null)} onClick={onKey}>
            <Month ym={view} lo={shown.from} hi={shown.to} max={max} onNav={(k) => setView(addMonths(view, k))} nav="prev" />
            <div className="hidden min-w-0 flex-1 sm:block"><Month ym={addMonths(view, 1)} lo={shown.from} hi={shown.to} max={max} onNav={(k) => setView(addMonths(view, k))} nav="next" /></div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs [box-shadow:var(--neu-in-sm)]" aria-live="polite">
            <span className="font-medium tabular-nums">{fmtSpan(shown)} · {n} day{n === 1 ? "" : "s"}</span>
            <span className="text-muted-foreground">{note || (anchor ? "Now pick the end day." : "Slide across the days, or click a start day and an end day.")}</span>
          </div>
          <div className="mt-2 flex justify-end gap-2 sm:hidden">
            <button type="button" onClick={() => setView(addMonths(view, 1))} className="tap h-8 rounded-lg px-3 text-xs [box-shadow:var(--neu-out-xs)]">Next month</button>
          </div>
        </div>
      )}
    </div>
  );
}
