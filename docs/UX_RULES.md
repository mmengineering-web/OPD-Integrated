# OPD UX Rules

Six rules that every page follows. Keep them when you add a page or a site.

## 1. Colour carries one meaning each

Tokens live in `src/app/globals.css`. Never pick a raw colour for a status.

| Colour | Token | Means | Use it for |
|---|---|---|---|
| Orange | `--primary` | The one action on the page | The main button only. One per view. |
| Blue | `--info`, `--link` | Information, trust, links | Info notes, links, the viewer role |
| Green | `--success` | Ready, live, connected | "Live" and "Connected" pills, saved |
| Ochre | `--warning` | In progress, take care | "In progress" pills (`land-state-wip`), cautions |
| Crimson | `--danger` | Stop, delete, error | Delete, failed sync, errors |
| Grey | `--muted` | Not started, secondary | "Planned" pills, hints |

Role scale (calm to powerful): viewer (blue), data entry (green), site admin (ochre), super admin (orange).

## 2. Search by typing and by scrolling

`PageSearch` (`src/components/opd/page-search.tsx`) opens from the top bar or with Ctrl/Cmd+K. The list is always scrollable, grouped by section, and typing filters it. Words match every label plus the aliases (`aka`) in `src/lib/opd/sitemap.tsx`, so "daily report" finds Uploads. Names that start with the typed text rank first. Locked pages show "Sign in" or "No access" instead of disappearing.

The Exploration app does not show it: it has its own Ctrl+K palette.

## 3. Input masks guide the typing

Masks are plain functions in `src/lib/opd/masks.js`, wrapped by `MaskedInput` (`src/components/ui/masked-input.tsx`). The field cleans text as it is typed or pasted, and the caret stays after the characters the person just typed.

| Mask | Rule |
|---|---|
| `maskEmail` | lower case, no spaces |
| `maskName` | letters, space, dot, apostrophe, hyphen |
| `maskHoleId` | capitals, digits, hyphen; space or underscore becomes a hyphen; 30 characters |
| `maskZone`, `maskEasting`, `maskNorthing` | UTM zone 1 to 60; easting and northing digits with one decimal point |
| `maskLat`, `maskLon` | signed decimals within -90..90 and -180..180 |
| `maskDecimal`, `maskPercent`, `maskInt` | digits, one decimal point, comma accepted as a point |

Every masked field also gets a placeholder that shows the format (`WKM-DD-0004`, `name@company.com`) and the right `inputMode` for a phone keyboard. A new mask needs a unit test in `tests/masks.test.mjs`.

## 4. Button text says what happens

Verb plus object, no "Submit" or "OK": Create user, Save changes, Edit access, Generate password, Copy password, Refresh list, Download PDF, Sign in, Pick a site to continue. The one-per-view orange button gets the most specific wording.

## 5. Spacing shows what belongs together

`FormStack`, `FormGroup` and `Field` live in `src/components/ui/form-group.tsx`.

- 12 px (`gap-3`) between fields inside one group.
- 24 px (`gap-6`) between groups.
- A group has a short legend, and an optional one-line hint.

## 6. Navigation labels are short

One or two words, defined once in `src/lib/opd/sitemap.tsx`: Users, Uploads, Guides, Data Entry, Maps, Requests, Tools. The longer old name goes into `aka` so search still finds it. Page titles and breadcrumbs reuse the same label.

## Tests

`node tests/ux_e2e.mjs` checks label length, page search, every mask (including typing key by key and the caret), the login page, the Exploration hole ID, the admin page and a phone viewport. `npm run test:unit` covers the mask functions.

## 7. Motion: scroll reveal and page wipe

Code: `src/components/opd/motion-layer.tsx` (mounted once in `src/app/layout.tsx`), `src/lib/opd/wipe.js`, CSS at the end of `src/app/globals.css`.

**Scroll reveal.** The blocks of a page (the children of `#main`, or of its single wrapper) rise 24 px and fade in as they enter the screen, 70 ms apart (at most 8 steps). Blocks that load later are picked up automatically. Content is only hidden after JavaScript has tagged it, so nothing is lost without JavaScript.

**Page wipe.** Following an internal link (or choosing a page in the search) sweeps a laterite panel up over the screen in 0.32 s, then navigates; the next page starts under the panel and it lifts off in 0.5 s. A `sessionStorage` flag and an early script in the layout head (`WIPE_PRE`) carry the state across the page load. Same-page anchor links scroll smoothly instead. The skip link is left alone.

**Opt-outs.**
- Reduced motion: no reveal, no wipe, no smooth scroll.
- Automated browsers (`navigator.webdriver`) skip the wipe so test suites stay fast. Tests turn it on with `window.__forceWipe = true`.
- App-like pages add `data-no-motion` (the Shell does it when it has `headerExtra` or `full`: the Exploration data entry and full-bleed dashboards).
- Modified clicks (Ctrl, Shift, Cmd), `target="_blank"`, downloads, other origins and links to the same page are never wiped.
- If a navigation never happens, the panel removes itself after 4 s. Pages restored from the back-forward cache are reset.

**Tuning.** Change the stagger in `MAX_STAGGER` and `animation-delay` (CSS), the distance in `@keyframes m-up`, the wipe speed in `COVER_MS` (wipe.js) and the `#wipe` transitions, and the panel colour in the `#wipe` gradient (strata tokens).

Tests: section 9 of `tests/ux_e2e.mjs`.
