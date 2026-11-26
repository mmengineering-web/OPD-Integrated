"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A row that scrolls sideways, with a custom bar instead of the browser's.
 * - A soft track with an orange thumb. The thumb glows and shimmers while the row moves, grows when you reach for it, and can be dragged.
 * - The edges fade out when there is more to see, and round arrows appear on that side.
 * - The mouse wheel scrolls the row sideways while the pointer is over it.
 * - The selected tab (aria-selected="true") glides to the centre when it changes.
 * The scroller keeps the role and aria props, so a tablist stays a tablist.
 */
export function ScrollStrip({ className, children, ...aria }: React.HTMLAttributes<HTMLDivElement>) {
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const idle = useRef<number | undefined>(undefined);
  const [edge, setEdge] = useState({ start: true, end: true, can: false });

  const sync = useCallback(() => {
    const el = box.current, tr = track.current, th = thumb.current; if (!el || !tr || !th) return;
    const max = el.scrollWidth - el.clientWidth, can = max > 2;
    const w = Math.max(40, (el.clientWidth / el.scrollWidth) * tr.clientWidth);
    th.style.width = `${w}px`;
    th.style.transform = `translateX(${can ? (el.scrollLeft / max) * (tr.clientWidth - w) : 0}px)`;
    setEdge((o) => { const n = { start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2, can }; return o.start === n.start && o.end === n.end && o.can === n.can ? o : n; });
  }, []);

  useEffect(() => {
    const el = box.current; if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf); raf = requestAnimationFrame(sync);
      thumb.current?.setAttribute("data-moving", "");
      window.clearTimeout(idle.current); idle.current = window.setTimeout(() => thumb.current?.removeAttribute("data-moving"), 260);
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max)) return; // at the end: let the page scroll
      e.preventDefault(); el.scrollLeft += e.deltaY;
    };
    const ro = new ResizeObserver(sync); ro.observe(el); if (el.firstElementChild) ro.observe(el.firstElementChild);
    const mo = new MutationObserver(() => {
      el.querySelector('[aria-selected="true"], [aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      sync();
    });
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "aria-current"] });
    el.addEventListener("scroll", onScroll, { passive: true }); el.addEventListener("wheel", onWheel, { passive: false });
    sync();
    return () => { cancelAnimationFrame(raf); window.clearTimeout(idle.current); ro.disconnect(); mo.disconnect(); el.removeEventListener("scroll", onScroll); el.removeEventListener("wheel", onWheel); };
  }, [sync]);

  const by = (dir: 1 | -1) => box.current?.scrollBy({ left: dir * box.current.clientWidth * 0.6, behavior: "smooth" });

  // dragging the thumb, or pressing the track, moves the row
  const grab = (e: React.PointerEvent) => {
    const el = box.current, tr = track.current, th = thumb.current; if (!el || !tr || !th) return;
    const room = tr.clientWidth - th.offsetWidth, max = el.scrollWidth - el.clientWidth;
    const onThumb = th.contains(e.target as Node);
    const startX = e.clientX, startLeft = el.scrollLeft;
    if (!onThumb) { const r = tr.getBoundingClientRect(); el.scrollTo({ left: ((e.clientX - r.left - th.offsetWidth / 2) / room) * max, behavior: "smooth" }); return; }
    th.setPointerCapture(e.pointerId); th.setAttribute("data-drag", "");
    const move = (m: PointerEvent) => { el.scrollLeft = startLeft + ((m.clientX - startX) / room) * max; };
    const up = () => { th.removeAttribute("data-drag"); th.removeEventListener("pointermove", move); th.removeEventListener("pointerup", up); th.removeEventListener("pointercancel", up); };
    th.addEventListener("pointermove", move); th.addEventListener("pointerup", up); th.addEventListener("pointercancel", up);
  };

  return (
    <div className={cn("strip-wrap relative", className)}>
      <div ref={box} className="flex items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" {...aria}>{children}</div>
      <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-10 rounded-l-xl bg-gradient-to-r from-[var(--card)] to-transparent transition-opacity duration-200", edge.start || !edge.can ? "opacity-0" : "opacity-100")} />
      <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-xl bg-gradient-to-l from-[var(--card)] to-transparent transition-opacity duration-200", edge.end || !edge.can ? "opacity-0" : "opacity-100")} />
      <button type="button" tabIndex={-1} aria-label="Scroll left" onClick={() => by(-1)}
        className={cn("absolute left-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-card transition-[opacity,transform] duration-200 ease-[var(--ease-out-strong)] [box-shadow:var(--neu-out-xs)] active:[box-shadow:var(--neu-in-sm)]", edge.start || !edge.can ? "pointer-events-none scale-90 opacity-0" : "scale-100 opacity-100")}><ChevronLeft className="size-4" aria-hidden /></button>
      <button type="button" tabIndex={-1} aria-label="Scroll right" onClick={() => by(1)}
        className={cn("absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-card transition-[opacity,transform] duration-200 ease-[var(--ease-out-strong)] [box-shadow:var(--neu-out-xs)] active:[box-shadow:var(--neu-in-sm)]", edge.end || !edge.can ? "pointer-events-none scale-90 opacity-0" : "scale-100 opacity-100")}><ChevronRight className="size-4" aria-hidden /></button>
      <div ref={track} onPointerDown={grab} aria-hidden
        className={cn("strip-track relative mx-1 mt-1.5 mb-0.5 h-1.5 cursor-pointer touch-none rounded-full [box-shadow:var(--neu-in-sm)]", edge.can ? "opacity-100" : "pointer-events-none h-0 opacity-0")}>
        <div ref={thumb} className="strip-thumb absolute inset-y-0 left-0 rounded-full bg-primary" />
      </div>
    </div>
  );
}
