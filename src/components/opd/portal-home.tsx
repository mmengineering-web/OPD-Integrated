"use client";
import { useMemo } from "react";
import { AlertTriangle, ArrowUpRight, Building2, CalendarDays, MapPin, Pickaxe, Factory, Layers, Users, FileText, Calculator } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { PROJECTS } from "@/lib/opd/config.js";
import { buildPortalModel, unreachableProjects, canOpen, ROLE_LABEL } from "@/lib/opd/auth-core.js";
import { AppFrame, type Access } from "@/components/opd/app-frame";

type Mod = { projectId: string; usable: boolean; state: string; role: string | null } | null;
const STATE_TEXT: Record<string, string> = {
  none: "Not set up", unconfigured: "Not connected yet", invalid: "No account here", noprofile: "No profile", inactive: "Disabled", unreachable: "Unreachable",
};

function ModuleLink({ icon: Icon, label, mod, href }: { icon: React.ComponentType<{ className?: string }>; label: string; mod: Mod; href: string | null }) {
  const usable = !!mod?.usable;
  const body = (
    <>
      <Icon className="size-4 shrink-0" />
      <span className="font-medium">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">{usable ? (mod?.role ? ROLE_LABEL[mod.role as keyof typeof ROLE_LABEL] : "") : STATE_TEXT[mod?.state ?? "none"]}</span>
      {usable && href && <ArrowUpRight className="size-4 text-muted-foreground" />}
    </>
  );
  const cls = "flex h-11 items-center gap-2 rounded-md border px-3 text-sm";
  return usable && href
    ? <a href={href} className={`${cls} nudge bg-card hover:bg-accent`} data-module={mod?.projectId}>{body}</a>
    : <div className={`${cls} bg-muted/40 text-muted-foreground`} aria-disabled data-module={mod?.projectId ?? "none"}>{body}</div>;
}

function Ring({ value, total }: { value: number; total: number }) {
  const r = 52, c = 2 * Math.PI * r, f = total ? value / total : 0;
  return (
    <svg viewBox="0 0 130 130" className="size-32 shrink-0 -rotate-90" role="img" aria-label={`${value} of ${total} sites open`}>
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--border)" strokeWidth="9" />
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--primary)" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - f)} style={{ transition: "stroke-dashoffset var(--dur-4) var(--ease-out)" }} />
      <text x="65" y="65" textAnchor="middle" dominantBaseline="central" className="rotate-90 origin-center fill-foreground font-serif text-[1.6rem]" style={{ transformBox: "fill-box" }}>{value}/{total}</text>
    </svg>
  );
}

function Stat({ icon: Icon, value, label, hint }: { icon: React.ComponentType<{ className?: string }>; value: string | number; label: string; hint: string }) {
  return (
    <Card className="lift flex flex-col gap-4 p-4" data-stat={label}>
      <span className="grid size-9 place-items-center rounded-full border bg-muted/60 text-muted-foreground"><Icon className="size-4" /></span>
      <div><p className="font-serif text-3xl leading-none">{value}</p><p className="mt-2 text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{hint}</p></div>
    </Card>
  );
}

function Home({ access }: { access: Access }) {
  const model = useMemo(() => buildPortalModel(PROJECTS, access), [access]);
  const down = unreachableProjects(access).map((id: string) => PROJECTS.find(p => p.id === id)?.name ?? id);
  const total = model.sites.length;
  const goto = [
    { icon: Factory, label: "Production", desc: "Dashboard and daily report upload", href: "/production/" },
    { icon: Pickaxe, label: "Exploration", desc: "Field data entry, QC, maps", href: "/exploration/" },
    { icon: FileText, label: "Documents", desc: "Reports, SOPs, templates", href: "/documents/" },
    { icon: Calculator, label: "Tools", desc: "Calculators and HPM nickel", href: "/tools/" },
    ...(canOpen(PROJECTS, access, "super_admin") ? [{ icon: Users, label: "Users", desc: "Add people, set roles and sites", href: "/portal/admin/" }] : []),
  ];
  const open = model.sites.filter((s: any) => s.any).length;
  const nExplo = model.sites.filter((s: any) => s.exploration?.usable).length;
  const nProd = model.sites.filter((s: any) => s.production?.usable).length;
  const now = new Date();
  const hr = now.getHours();
  const greet = hr < 11 ? "Good morning" : hr < 15 ? "Good afternoon" : hr < 19 ? "Good evening" : "Good night";
  const first = String((access as { name?: string }).name ?? "").split(" ")[0];
  return (
    <>
        <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Portal" }]} />
        <h1 className="mb-5 font-serif text-3xl font-medium tracking-tight" data-greeting>{greet}{first ? `, ${first}` : ""}</h1>
        <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]" data-dash>
          <Card className="flex flex-col items-start justify-between gap-6 bg-accent/60 p-6 sm:flex-row sm:items-center">
            <div className="min-w-0 max-w-[28rem] flex-1">
              <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium text-muted-foreground"><span className="size-1.5 rounded-full bg-primary" />{open === total ? "All sites open" : `${total - open} sites not open to you`}</span>
              <h2 className="mt-3 font-serif text-2xl font-medium leading-snug">{open ? `You can open ${open} of ${total} sites.` : "No site is open to you yet."}</h2>
              <p className="mt-2 text-sm text-muted-foreground">Exploration field entry works at {nExplo} {nExplo === 1 ? "site" : "sites"}. Production upload is open for the sites you have access to.</p>
              <a href="/explo/" className="nudge mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3.5 text-sm font-medium text-background">Open field data entry <ArrowUpRight className="size-4" /></a>
            </div>
            <Ring value={open} total={total} />
          </Card>
          <Card className="flex flex-col justify-between p-5" data-date>
            <div className="flex items-start justify-between"><div><p className="font-serif text-5xl leading-none text-brand">{now.getDate()}</p><p className="mt-2 text-sm font-medium">{now.toLocaleDateString("en-GB", { weekday: "long" })}</p><p className="text-xs text-muted-foreground">{now.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</p></div>
              <span className="grid size-9 place-items-center rounded-full border bg-muted/60 text-muted-foreground"><CalendarDays className="size-4" /></span></div>
            <p className="mt-6 text-xs text-muted-foreground">Sync status and reports appear here as modules go live.</p>
          </Card>
        </div>
        <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat icon={MapPin} value={open} label="Sites open" hint={`out of ${total}`} />
          <Stat icon={Pickaxe} value={nExplo} label="Exploration" hint="sites you can enter data for" />
          <Stat icon={Factory} value={nProd} label="Production" hint="sites you can upload for" />
          <Stat icon={Layers} value={(model.ho.production?.usable || model.ho.exploration?.usable) ? "Yes" : "No"} label="Head office" hint="all-sites view" />
        </div>
        {down.length > 0 && (
          <div role="status" id="down-banner" className="mb-4 flex items-start gap-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>Could not reach: {down.join(", ")}. Other modules still work. Sign in again later to refresh.</span>
          </div>
        )}
        <h2 className="mb-3 text-base font-semibold">Go to</h2>
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" data-goto>
          {goto.map(g => (
            <a key={g.href} href={g.href} className="lift nudge group flex items-start gap-3 rounded-xl border bg-card p-4 hover:bg-accent/60" data-goto-link={g.label}>
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-brand"><g.icon className="size-4" /></span>
              <span className="min-w-0"><span className="flex items-center gap-1 text-sm font-semibold">{g.label}<ArrowUpRight className="size-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></span><span className="block text-xs text-muted-foreground">{g.desc}</span></span>
            </a>
          ))}
        </div>
        <h1 className="mb-3 text-base font-semibold">Head office</h1>
        <Card className="mb-6 grid gap-2 p-3 sm:grid-cols-2" data-tile="HO">
          <ModuleLink icon={Building2} label="Production (all sites)" mod={model.ho.production} href={null} />
          <ModuleLink icon={Pickaxe} label="Exploration (all sites)" mod={model.ho.exploration} href={null} />
        </Card>
        <h2 className="mb-3 text-base font-semibold">Sites</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {model.sites.map((s: any) => (
            <Card key={s.code} className={`flex flex-col gap-2 p-3 ${s.any ? "" : "opacity-70"}`} data-tile={s.code}>
              <div className="flex items-center gap-2 text-sm font-semibold"><MapPin className="size-4 text-brand" />{s.code}</div>
              <ModuleLink icon={Factory} label="Production" mod={s.production} href={null} />
              <ModuleLink icon={Pickaxe} label="Exploration" mod={s.exploration} href={`/explo/?site=${s.code}`} />
            </Card>
          ))}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">Production upload is open at WKM and BM. Other site tiles stay greyed until their project is connected.</p>
    </>
  );
}

export function PortalHome() {
  return <AppFrame active="home" gate="any" legacyRedirect>{access => <Home access={access!} />}</AppFrame>;
}
