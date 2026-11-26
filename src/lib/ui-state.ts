"use client";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useState } from "react";

type Theme = "light" | "dark";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- read the theme the inline boot script set before first paint
  useEffect(() => { setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"); }, []);
  /**
   * Switch theme, with motion in every case.
   * - Normal: the new theme spreads from the button as a growing circle until it covers the screen (View Transitions API).
   * - Browser without that API: a circle in the new page colour spreads the same way, then the theme is applied under it and it fades out.
   * - Reduced motion (an OS setting): no movement, only a short cross-fade.
   * Pass the click event (onClick={toggle}) so the circle knows where the button is.
   */
  const toggle = useCallback((ev?: { currentTarget?: unknown }) => {
    const root = document.documentElement;
    const next: Theme = root.dataset.theme === "dark" ? "light" : "dark";
    const apply = () => { root.dataset.theme = next; try { localStorage.setItem("exp_theme", next); } catch {} flushSync(() => setTheme(next)); };
    const el = ev?.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } };
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const r = el?.getBoundingClientRect();
    const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : 0;
    const reach = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const grow = [`circle(0px at ${x}px ${y}px)`, `circle(${reach}px at ${x}px ${y}px)`];
    const ease = "cubic-bezier(.77,0,.175,1)";

    if (doc.startViewTransition) {
      const t = doc.startViewTransition(apply);
      t.ready.then(() => {
        if (calm) root.animate({ opacity: [0, 1] }, { duration: 300, easing: "ease-out", pseudoElement: "::view-transition-new(root)" });
        else root.animate({ clipPath: grow }, { duration: 600, easing: ease, pseudoElement: "::view-transition-new(root)" });
      }).catch(() => {});
      return;
    }
    // no View Transitions: draw the circle ourselves in the colour the page is about to have
    const cover = document.createElement("div");
    Object.assign(cover.style, { position: "fixed", inset: "0", zIndex: "2147483000", pointerEvents: "none", background: next === "dark" ? "#1e1b18" : "#e7e2dc" });
    document.body.appendChild(cover);
    const done = () => { apply(); cover.animate({ opacity: [1, 0] }, { duration: 220, easing: "ease-out" }).finished.finally(() => cover.remove()); };
    if (calm) { cover.style.opacity = "0"; cover.animate({ opacity: [0, 1] }, { duration: 200, fill: "forwards" }).finished.then(done).catch(() => { apply(); cover.remove(); }); return; }
    cover.style.clipPath = grow[0];
    cover.animate({ clipPath: grow }, { duration: 600, easing: ease, fill: "forwards" }).finished.then(done).catch(() => { apply(); cover.remove(); });
  }, []);
  return { theme, toggle };
}
