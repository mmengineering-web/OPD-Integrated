"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Building2, Factory, MapPin, Moon, Pickaxe, Sun, WifiOff } from "lucide-react";
import { useTheme } from "@/lib/ui-state";
import { BrandMark } from "@/components/brand-mark";
import { exploProject, PROJECTS } from "@/lib/opd/config.js";
import { loadAccess, legacyExplo } from "@/lib/opd/session.js";

const NAV = [
  { href: "#modules", label: "Modules" },
  { href: "#sites", label: "Sites" },
  { href: "#how", label: "How it works" },
];

const MODULES = [
  { icon: Pickaxe, name: "Exploration", state: "Live", text: "Drilling progress, collars, hours and samples, with QC, maps and 3D. Entry works offline and syncs when the signal returns.", href: "/explo/", cta: "Open exploration" },
  { icon: Building2, name: "Head office", state: "Live", text: "One view across every site. Role-based access follows your account in each project.", href: "/portal/", cta: "Open portal" },
  { icon: Factory, name: "Production", state: "Coming soon", text: "Upload daily reports from WKM, BM and TMS. Files are parsed in the browser before anything is sent.", href: null, cta: "" },
];

const SITE_CODES = ["WKM", "CDSM", "BM", "TMS", "IBN", "TPB", "AJB", "CDS"];
const siteStatus = (code: string) => ({
  explo: !!exploProject(code)?.url,
  prod: PROJECTS.some((p: any) => p.module === "production" && p.site === code && p.url),
});

const STEPS = [
  { n: "1", t: "Sign in once", d: "Use the email and password your super admin gave you. The same account works in every project." },
  { n: "2", t: "We check each site", d: "The portal signs in to every project in parallel. If one is unreachable, the others still open." },
  { n: "3", t: "Open what you can use", d: "Your role decides which modules and forms you see. No account yet? Ask a super admin." },
];

function Pill({ href, children, dark = true }: { href: string; children: React.ReactNode; dark?: boolean }) {
  return (
    <a href={href} className={dark
      ? "inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-foreground px-5 text-sm font-medium text-background shadow-sm transition-[transform,opacity] duration-200 hover:-translate-y-px hover:opacity-90 active:scale-[.985]"
      : "inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--foreground)_6%,var(--card))] px-5 text-sm font-medium text-foreground transition-[transform,background] duration-200 hover:-translate-y-px hover:bg-[color-mix(in_srgb,var(--foreground)_10%,var(--card))] active:scale-[.985]"}>
      {children}
    </a>
  );
}

const CARDS = [
  { id: "explo", icon: Pickaxe, title: "Log drilling progress and samples, even without signal", tag: "Exploration", note: "2 sites live", href: "/explo/", cta: "Open exploration" },
  { id: "hq", icon: Building2, title: "See every site in one place", tag: "Head office", note: "all roles", href: "/portal/", cta: "Open portal" },
  { id: "prod", icon: Factory, title: "Upload daily production reports", tag: "Production", note: "coming soon", href: null, cta: "Coming soon" },
];

/** Interactive card deck: drag or swipe, tap a side card, use the dots or the arrow keys. */
function Deck() {
  const [active, setActive] = useState(1);
  const [drag, setDrag] = useState(0);
  const s = useRef({ x: 0, down: false, moved: false, end: 0 });
  const go = (n: number) => setActive(Math.max(0, Math.min(CARDS.length - 1, n)));

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = s.current;
    if (!t.down) return;
    t.down = false;
    if (t.moved) {
      const dx = e.clientX - t.x;
      go(active + (dx < -48 ? 1 : dx > 48 ? -1 : 0));
      t.end = performance.now();
    }
    t.moved = false;
    setDrag(0);
  };

  return (
    <div
      className="land-deck"
      role="group"
      aria-roledescription="carousel"
      aria-label="Modules"
      data-drag={drag !== 0 ? "" : undefined}
      tabIndex={0}
      onKeyDown={e => { if (e.key === "ArrowLeft") { e.preventDefault(); go(active - 1); } if (e.key === "ArrowRight") { e.preventDefault(); go(active + 1); } }}
      onPointerDown={e => { if (e.button > 0) return; s.current = { ...s.current, x: e.clientX, down: true, moved: false }; }}
      onPointerMove={e => {
        const t = s.current;
        if (!t.down) return;
        const dx = e.clientX - t.x;
        if (!t.moved && Math.abs(dx) > 6) { t.moved = true; e.currentTarget.setPointerCapture(e.pointerId); }
        if (t.moved) setDrag(dx);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {CARDS.map((c, i) => {
        const k = i - active;
        const Icon = c.icon;
        const on = k === 0;
        const body = (
          <>
            <span className={on ? "land-ico land-ico-on" : "land-ico"}><Icon className="size-4" /></span>
            <span className="land-card-t">{c.title}</span>
            <span className="land-card-m">{c.tag} <i /> {c.note}</span>
            <span className="land-card-cta" aria-hidden={!on}>{c.cta}{c.href && <ArrowRight className="size-3.5" />}</span>
          </>
        );
        const style = { ["--k" as string]: k, ["--ak" as string]: Math.abs(k), ["--d" as string]: `${drag}px`, zIndex: 10 - Math.abs(k) } as React.CSSProperties;
        const common = {
          className: "land-card",
          style,
          "data-on": on ? "" : undefined,
          "data-id": c.id,
          onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
            e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
          },
        };
        const pick = (e: React.MouseEvent) => {
          if (performance.now() - s.current.end < 300) { e.preventDefault(); return; }
          if (!on) { e.preventDefault(); go(i); }
        };
        return c.href && on
          ? <a key={c.id} href={c.href} {...common} onClick={pick} draggable={false}>{body}</a>
          : <div key={c.id} role="button" tabIndex={on ? -1 : 0} aria-label={on ? undefined : `Show ${c.tag}`} aria-disabled={!c.href && on ? true : undefined} {...common} onClick={pick} onKeyDown={e => { if (!on && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(i); } }}>{body}</div>;
      })}
      <div className="land-dots">
        {CARDS.map((c, i) => (
          <button key={c.id} type="button" aria-label={`Show ${c.tag}`} aria-current={i === active ? "true" : undefined} onClick={() => go(i)}><span /></button>
        ))}
      </div>
    </div>
  );
}

export function Landing() {
  const [access, setAccess] = useState<ReturnType<typeof loadAccess>>(null);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const a = loadAccess();
    if (a?.ok) { setAccess(a); return; }
    // Phones that were signed in to the standalone Exploration app (or use guest mode) keep going straight there.
    if (legacyExplo()) location.replace("/explo/");
  }, []);

  const signedIn = !!access?.ok;

  return (
    <div className="relative min-h-dvh">
      <header className="land-nav absolute inset-x-0 top-0 z-[20]">
        <div className="mx-auto flex h-[4.5rem] w-full max-w-[72rem] items-center gap-4 px-5">
          <a href="/" className="flex items-center gap-2.5" aria-label="One Portal Data, home">
            <BrandMark className="size-8" />
            <span className="hidden font-serif text-xl font-medium tracking-tight sm:inline">One Portal Data</span>
          </a>
          <nav aria-label="Primary" className="mx-auto hidden items-center gap-1 md:flex">
            {NAV.map(n => <a key={n.href} href={n.href} className="inline-flex h-10 items-center rounded-full px-3 text-sm text-muted-foreground transition-colors hover:text-foreground">{n.label}</a>)}
          </nav>
          <div className="ml-auto flex items-center gap-1.5 md:ml-0">
            <button type="button" onClick={toggle} aria-label="Toggle theme" className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
            {signedIn
              ? <><span className="hidden max-w-[10rem] truncate text-sm text-muted-foreground sm:inline" id="who-home">{access?.name}</span><Pill href="/portal/">Open portal</Pill></>
              : <><a href="/login/" className="inline-flex h-10 items-center whitespace-nowrap rounded-full px-3 text-sm text-muted-foreground transition-colors hover:text-foreground" id="n-login">Log in</a><Pill href="#how">Get started</Pill></>}
          </div>
        </div>
      </header>

      <main>
        <section className="land-hero" aria-labelledby="h1">
          <div className="land-grid" aria-hidden />
          <div className="land-copy enter">
            <h1 id="h1" style={{ ["--i" as string]: 0 }}>One login for every site and module</h1>
            <p style={{ ["--i" as string]: 1 }}>Production, exploration and head office data from every site, behind a single sign-in. Field entry keeps working with no signal.</p>
            <div className="flex flex-wrap items-center justify-center gap-3" style={{ ["--i" as string]: 2 }}>
              <Pill href={signedIn ? "/portal/" : "/login/"}>{signedIn ? "Open portal" : "Start here"}</Pill>
              <Pill href="#modules" dark={false}>Explore</Pill>
            </div>
          </div>

          <span className="land-chip land-chip-a" aria-hidden><MapPin className="size-5" /></span>
          <span className="land-chip land-chip-b" aria-hidden><WifiOff className="size-5" /></span>

          <Deck />
        </section>

        <section id="modules" className="land-sec" aria-labelledby="h-mod">
          <div className="land-wrap">
            <h2 id="h-mod">Three modules, one sign-in</h2>
            <div className="grid gap-4 md:grid-cols-3">
              {MODULES.map(m => {
                const Icon = m.icon;
                const body = (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="land-ico"><Icon className="size-4" /></span>
                      <span className={m.href ? "land-state land-state-on" : "land-state"}>{m.state}</span>
                    </div>
                    <h3 className="font-serif text-2xl font-medium tracking-tight">{m.name}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{m.text}</p>
                    {m.href && <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-medium text-link">{m.cta}<ArrowRight className="size-4" /></span>}
                  </>
                );
                return m.href
                  ? <a key={m.name} href={m.href} className="land-mod">{body}</a>
                  : <div key={m.name} className="land-mod land-mod-off" aria-disabled>{body}</div>;
              })}
            </div>
          </div>
        </section>

        <section id="sites" className="land-sec land-sec-alt" aria-labelledby="h-sites">
          <div className="land-wrap">
            <h2 id="h-sites">Sites</h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {SITE_CODES.map(code => {
                const s = siteStatus(code);
                return (
                  <li key={code} className="land-site" data-site={code}>
                    <div className="flex items-center gap-2 font-semibold"><MapPin className="size-4 text-brand" aria-hidden />{code}</div>
                    <div className="text-xs text-muted-foreground">Exploration: <b className={s.explo ? "font-medium text-success" : "font-medium"}>{s.explo ? "Live" : "Planned"}</b></div>
                    <div className="text-xs text-muted-foreground">Production: <b className="font-medium">{s.prod ? "Connected" : "Planned"}</b></div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        <section id="how" className="land-sec" aria-labelledby="h-how">
          <div className="land-wrap">
            <h2 id="h-how">How it works</h2>
            <ol className="grid gap-4 md:grid-cols-3">
              {STEPS.map(s => (
                <li key={s.n} className="land-step">
                  <span className="font-serif text-4xl font-medium text-[var(--strata-3)]" aria-hidden>{s.n}</span>
                  <h3 className="text-base font-semibold">{s.t}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{s.d}</p>
                </li>
              ))}
            </ol>
            <div className="mt-8 flex flex-wrap gap-3">
              <Pill href={signedIn ? "/portal/" : "/login/"}>{signedIn ? "Open portal" : "Log in"}</Pill>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t py-6 text-center text-xs text-muted-foreground">One Portal Data · PT Central Abadi Nusantara</footer>
    </div>
  );
}
