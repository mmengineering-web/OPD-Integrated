"use client";
import { useEffect, useLayoutEffect } from "react";
import { wipeAllowed, wipeArrive, wipeReset, wipeTo } from "@/lib/opd/wipe.js";

/**
 * Two small motions that make moving through OPD feel connected:
 *  1. Scroll reveal: the blocks of a page rise and fade in as they enter the screen, staggered.
 *  2. Page wipe: a panel sweeps over the page when you follow a link, then lifts off the next page.
 * Both respect reduced motion. Pages that behave like an app (the Exploration data entry, full-bleed dashboards)
 * opt out with data-no-motion. Rules and tuning: docs/UX_RULES.md, section 7.
 */
const MAX_STAGGER = 8;

function candidates(main: Element): Element[] {
  const kids = Array.from(main.children).filter(e => !(e as HTMLElement).hidden);
  // A page usually has one wrapper; its children are the real blocks.
  const list = kids.length === 1 ? Array.from(kids[0].children) : kids;
  return list.filter(e => e.tagName !== "SCRIPT" && e.tagName !== "STYLE");
}

export function MotionLayer() {
  // Scroll reveal. The page frame may render a moment after this layer mounts, so wait for #main when it is not there yet.
  useLayoutEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let stop = () => {};
    const begin = (main: HTMLElement) => {
      if (main.closest("[data-no-motion]")) return;
      document.documentElement.classList.add("js-motion");
      const io = new IntersectionObserver(entries => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          en.target.classList.add("is-in");
          io.unobserve(en.target);
        }
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
      let n = 0;
      const tag = () => {
        for (const el of candidates(main)) {
          if (el.hasAttribute("data-reveal")) continue;
          el.setAttribute("data-reveal", "");
          (el as HTMLElement).style.setProperty("--i", String(Math.min(n++, MAX_STAGGER)));
          io.observe(el);
        }
      };
      tag();
      // Pages fill in after data loads: tag new blocks as they arrive.
      let raf = 0;
      const mo = new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { n = 0; tag(); }); });
      mo.observe(main, { childList: true, subtree: true });
      // Safety: never leave content hidden if the observer is slow.
      const safety = setTimeout(() => main.querySelectorAll("[data-reveal]:not(.is-in)").forEach(e => { if (e.getBoundingClientRect().top < innerHeight) e.classList.add("is-in"); }), 1200);
      stop = () => { io.disconnect(); mo.disconnect(); cancelAnimationFrame(raf); clearTimeout(safety); document.documentElement.classList.remove("js-motion"); };
    };
    const now = document.getElementById("main");
    if (now) begin(now);
    else {
      const wait = new MutationObserver(() => {
        const m = document.getElementById("main");
        if (m) { wait.disconnect(); begin(m); }
      });
      wait.observe(document.body, { childList: true, subtree: true });
      stop = () => wait.disconnect();
    }
    return () => stop();
  }, []);

  // Page wipe and smooth in-page anchors.
  useEffect(() => {
    wipeArrive();
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) wipeReset(); };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      // Same page, different place: scroll there smoothly.
      if (url.pathname === location.pathname && url.search === location.search && url.hash) {
        if (url.hash === "#main") return; // the skip link moves focus; leave it to the browser
        const t = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        if (t && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
          e.preventDefault();
          t.scrollIntoView({ behavior: "smooth", block: "start" });
          history.replaceState(null, "", url.hash);
        }
        return;
      }
      if (url.pathname === location.pathname && url.search === location.search) return;
      if (!wipeAllowed()) return;
      e.preventDefault();
      wipeTo(url.href);
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("pageshow", onShow); document.removeEventListener("click", onClick); };
  }, []);

  return <div id="wipe" aria-hidden="true" />;
}
