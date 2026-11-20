"use client";
import { useEffect, useState } from "react";
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

          <div className="land-fan">
            <a href="/explo/" className="land-card land-card-l">
              <svg className="land-mound" viewBox="0 0 140 70" aria-hidden>
                <path d="M0 70a70 70 0 0 1 140 0z" fill="var(--strata-5)" />
                <path d="M16 70a54 54 0 0 1 108 0z" fill="var(--strata-4)" />
                <path d="M32 70a38 38 0 0 1 76 0z" fill="var(--strata-3)" />
                <path d="M48 70a22 22 0 0 1 44 0z" fill="var(--strata-2)" />
              </svg>
              <span className="land-ico"><Pickaxe className="size-4" /></span>
              <span className="land-card-t">Log drilling progress and samples, even without signal</span>
              <span className="land-card-m">Exploration <i /> 2 sites live</span>
            </a>
            <a href="/portal/" className="land-card land-card-c">
              <span className="land-ico land-ico-on"><Building2 className="size-4" /></span>
              <span className="land-card-t">See every site in one place</span>
              <span className="land-card-m">Head office <i /> all roles</span>
            </a>
            <div className="land-card land-card-r" aria-disabled>
              <span className="land-ico"><Factory className="size-4" /></span>
              <span className="land-card-t">Upload daily production reports</span>
              <span className="land-card-m">Production <i /> coming soon</span>
            </div>
          </div>
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
