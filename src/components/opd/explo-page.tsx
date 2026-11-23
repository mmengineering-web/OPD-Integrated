"use client";
import { useEffect, useState } from "react";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, type Access } from "@/components/opd/app-frame";
import { Strata } from "@/components/opd/strata";
import { Skeleton } from "@/components/ui/skeleton";
import { SitePicker } from "@/components/site-picker";
import { ToastProvider } from "@/components/toast";
import { ConfirmProvider } from "@/components/confirm";
import { core, openSite, type Info } from "@/lib/boot";
import { PROJECTS } from "@/lib/opd/config.js";
import { ROLE_LABEL, exploSites, pickExploSite } from "@/lib/opd/auth-core.js";
import { SECTIONS } from "@/lib/opd/sitemap";

type Sites = { site: string }[];

/** Picks the site, opens its session from the portal login, then renders the view for that site. Re-attaches when the site changes. */
function SiteView({ access, sites, render }: { access: Access; sites: Sites; render: (info: Info) => React.ReactNode }) {
  const codes = sites.map(s => s.site);
  const [site, setSite] = useState<string>(() => {
    let cached: string | null = null;
    try { cached = localStorage.getItem("exp_last_site"); } catch {}
    return pickExploSite(sites, { wanted: new URLSearchParams(location.search).get("site"), cached, guest: null }) ?? codes[0];
  });
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setInfo(null); setFailed(false);
    (async () => {
      const { S } = await core();
      const i = await S.attachSession(site, access.projects[`${site.toLowerCase()}-explo`]);
      if (!live) return;
      if (!i) { setFailed(true); return; }
      await openSite(site);
      S.startAutoSync(); S.syncNow();
      if (live) setInfo(i);
    })().catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [site, access]);

  const choose = (s: string) => {
    setSite(s);
    try { localStorage.setItem("exp_last_site", s); } catch {}
    history.replaceState(null, "", `?site=${s}`);
  };

  return (
    <>
      <section className="mb-5 rounded-xl border bg-card p-4" data-site-bar>
        <SitePicker id="site-pick" name="view-site" sites={codes} value={site} onChange={choose} cols={Math.min(codes.length, 4)}
          legend="Site" hint={codes.length > 1 ? "Showing the sites your accounts can open." : "Your account opens this site."} />
        <p className="mt-3 text-sm text-muted-foreground" aria-live="polite" id="site-now">
          Showing data for <b className="font-mono text-foreground">{site}</b>{info ? <> · {info.role_label || ROLE_LABEL[info.role as keyof typeof ROLE_LABEL]}</> : null}
        </p>
      </section>
      {failed
        ? <div role="alert" className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-danger" id="site-failed">Could not open {site}. Sign out and sign in again, or pick another site.</div>
        : !info ? <div className="flex flex-col gap-3" aria-busy aria-label={`Opening ${site}`}><Skeleton className="h-10 w-64" /><div className="grid gap-3 sm:grid-cols-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div><Skeleton className="h-64 w-full" /></div>
        : <div key={info.site} id="explo-view">{render(info)}</div>}
    </>
  );
}

/** An analysis page in the OPD Exploration section: gated by an exploration account, with a site picker. */
export function ExploPage({ title, lead, render }: { title: string; lead: string; render: (info: Info) => React.ReactNode }) {
  const sec = SECTIONS.find(x => x.key === "explo")!;
  const Icon = sec.items.find(i => i.label === title)?.icon ?? sec.icon;
  return (
    <AppFrame active="explo" gate="exploration" backHref="/exploration/" backLabel="Back to Exploration">{access => {
      const sites = exploSites(PROJECTS, access!) as Sites;
      return (
        <>
          <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Exploration", href: "/exploration/" }, { label: title }]} />
          <header className="relative isolate mb-5 overflow-hidden rounded-2xl border bg-card px-6 pb-12 pt-6 md:px-8">
            <Strata className="absolute inset-x-0 bottom-0 -z-10 h-10 w-full" />
            <div className="flex items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-brand"><Icon className="size-6" aria-hidden /></span>
              <div className="min-w-0"><h1 className="font-serif text-3xl font-medium tracking-tight">{title}</h1><p className="mt-1 max-w-[56ch] text-sm text-muted-foreground">{lead}</p></div>
            </div>
          </header>
          <ToastProvider><ConfirmProvider><SiteView access={access!} sites={sites} render={render} /></ConfirmProvider></ToastProvider>
        </>
      );
    }}</AppFrame>
  );
}
