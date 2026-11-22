"use client";
import { useMemo } from "react";
import { AlertTriangle, ArrowUpRight, Building2, MapPin, Pickaxe, Factory } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { PROJECTS } from "@/lib/opd/config.js";
import { buildPortalModel, unreachableProjects, ROLE_LABEL } from "@/lib/opd/auth-core.js";
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
    ? <a href={href} className={`${cls} bg-card transition-colors hover:bg-accent`} data-module={mod?.projectId}>{body}</a>
    : <div className={`${cls} bg-muted/40 text-muted-foreground`} aria-disabled data-module={mod?.projectId ?? "none"}>{body}</div>;
}

function Home({ access }: { access: Access }) {
  const model = useMemo(() => buildPortalModel(PROJECTS, access), [access]);
  const down = unreachableProjects(access).map((id: string) => PROJECTS.find(p => p.id === id)?.name ?? id);
  return (
    <>
        <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Portal" }]} />
        {down.length > 0 && (
          <div role="status" id="down-banner" className="mb-4 flex items-start gap-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>Could not reach: {down.join(", ")}. Other modules still work. Sign in again later to refresh.</span>
          </div>
        )}
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
        <p className="mt-6 text-xs text-muted-foreground">Production upload arrives in a later release; those tiles stay greyed until then.</p>
    </>
  );
}

export function PortalHome() {
  return <AppFrame active="home" legacyRedirect>{access => <Home access={access} />}</AppFrame>;
}
