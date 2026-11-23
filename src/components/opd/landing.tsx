"use client";
import { useRef, useState } from "react";
import { ArrowRight, Building2, FileText, Factory, MapPin, Pickaxe, Wrench, WifiOff } from "lucide-react";
import { exploProject, PROJECTS } from "@/lib/opd/config.js";
import { AppFrame } from "@/components/opd/app-frame";

const MODULES = [
  { icon: Pickaxe, name: "Exploration", state: "Live", text: "Field data entry that works offline, plus dashboard, QC, map and 3D for each site.", href: "/exploration/", cta: "Open Exploration" },
  { icon: Factory, name: "Production", state: "In progress", text: "Daily reports from WKM, BM and TMS, and the dashboard that reads them.", href: "/production/", cta: "Open Production" },
  { icon: FileText, name: "Documents", state: "In progress", text: "Reports, procedures and templates, shown by your role and site.", href: "/documents/", cta: "Open Documents" },
  { icon: Wrench, name: "Tools", state: "Calculators live", text: "UTM and tonnage calculators today. Pricing and drillhole tools next.", href: "/tools/", cta: "Open Tools" },
  { icon: Building2, name: "Portal", state: "Live", text: "One view of every site and module your account can open.", href: "/portal/", cta: "Open Portal" },
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
  { id: "explo", icon: Pickaxe, title: "Log drilling progress and samples, even without signal", tag: "Exploration", note: "2 sites live", href: "/exploration/", cta: "Open Exploration" },
  { id: "hq", icon: Building2, title: "See every site in one place", tag: "Portal", note: "all roles", href: "/portal/", cta: "Open Portal" },
  { id: "prod", icon: Factory, title: "Send daily production reports", tag: "Production", note: "in progress", href: "/production/", cta: "Open Production" },
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
      aria-label="Destinations"
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
  return (
    <AppFrame active="home" full>{access => {
      const signedIn = !!access?.ok;
      return (
      <>
        <section className="land-hero" aria-labelledby="h1">
          <div className="land-grid" aria-hidden />
          <div className="land-copy enter">
            <h1 id="h1" style={{ ["--i" as string]: 0 }}>One login for every site and module</h1>
            <p style={{ ["--i" as string]: 1 }}>Production, exploration and head office data from every site, behind a single sign-in. Field entry keeps working with no signal.</p>
            <div className="flex flex-wrap items-center justify-center gap-3" style={{ ["--i" as string]: 2 }}>
              <Pill href={signedIn ? "/portal/" : "/login/"}>{signedIn ? "Open portal" : "Sign in"}</Pill>
              <Pill href="#modules" dark={false}>See the modules</Pill>
            </div>
          </div>

          <span className="land-chip land-chip-a" aria-hidden><MapPin className="size-5" /></span>
          <span className="land-chip land-chip-b" aria-hidden><WifiOff className="size-5" /></span>

          <Deck />
        </section>

        <section id="modules" className="land-sec" aria-labelledby="h-mod">
          <div className="land-wrap">
            <h2 id="h-mod">Where do you want to go?</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
              {MODULES.map((m, i) => {
                const Icon = m.icon;
                const body = (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="land-ico lift-ico"><Icon className="size-4" /></span>
                      <span className={/live/i.test(m.state) ? "land-state land-state-on" : "land-state land-state-wip"}>{m.state}</span>
                    </div>
                    <h3 className="font-serif text-2xl font-medium tracking-tight">{m.name}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{m.text}</p>
                    {m.href && <span className="mt-auto inline-flex items-center gap-1.5 text-sm font-medium text-link">{m.cta}<ArrowRight className="size-4" /></span>}
                  </>
                );
                const span = i < 3 ? "lg:col-span-2" : "lg:col-span-3";
                return <a key={m.name} href={m.href} className={"land-mod lift " + span} data-module-card={m.name}>{body}</a>;
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
                    <div className="text-xs text-muted-foreground">Production: <b className={s.prod ? "font-medium text-success" : "font-medium"}>{s.prod ? "Connected" : "Planned"}</b></div>
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
              <Pill href={signedIn ? "/portal/" : "/login/"}>{signedIn ? "Open portal" : "Sign in"}</Pill>
            </div>
          </div>
        </section>
      </>
      );
    }}</AppFrame>
  );
}
