// Page wipe: a laterite-coloured panel rises over the page, the browser navigates, and the panel lifts off the next page.
// Pure DOM, no React state, so it works for links, the page search and plain location changes.
// It is skipped for reduced motion, for automated browsers (so test suites stay fast) and when #wipe is missing.
const KEY = "opd_wipe";
const COVER_MS = 320;

export function wipeAllowed() {
  if (typeof window === "undefined") return false;
  if (window.__forceWipe) return true;
  if (navigator.webdriver) return false;
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Go to href with the wipe. Falls back to a plain navigation whenever the wipe cannot run. */
export function wipeTo(href) {
  const el = typeof document !== "undefined" ? document.getElementById("wipe") : null;
  if (!el || !wipeAllowed()) { location.assign(href); return; }
  try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode: the next page just has no lift-off */ }
  el.classList.remove("leave");
  el.classList.add("cover");
  setTimeout(() => location.assign(href), COVER_MS);
  // If the navigation never happens (blocked, offline), do not leave the page covered.
  setTimeout(() => { if (document.visibilityState === "visible") el.classList.remove("cover"); }, 4000);
}

/** Run on every page load: lift the panel off when the previous page covered the screen. */
export function wipeArrive() {
  const el = document.getElementById("wipe");
  const root = document.documentElement;
  let came = false;
  try { came = sessionStorage.getItem(KEY) === "1"; sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  if (!el) { delete root.dataset.wipe; return; }
  if (came && wipeAllowed()) {
    el.classList.add("leave");
    requestAnimationFrame(() => requestAnimationFrame(() => { delete root.dataset.wipe; }));
    setTimeout(() => el.classList.remove("leave"), 700);
  } else {
    delete root.dataset.wipe;
  }
}

/** Browsers restore pages from the back-forward cache with the panel still covering them. */
export function wipeReset() {
  const el = document.getElementById("wipe");
  if (el) el.classList.remove("cover", "leave");
  delete document.documentElement.dataset.wipe;
}

/** Early script (inline in the layout head): keep the panel closed over the new page until it is ready. */
export const WIPE_PRE = `try{if(sessionStorage.getItem('${KEY}')==='1'&&!matchMedia('(prefers-reduced-motion:reduce)').matches&&!navigator.webdriver)document.documentElement.dataset.wipe='in'}catch(e){}`;
