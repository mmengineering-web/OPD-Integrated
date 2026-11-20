"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, Building2, LogOut, MapPin, Moon, Pickaxe, Factory, Sun } from "lucide-react";
import { useTheme } from "@/lib/ui-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BrandMark } from "@/components/brand-mark";
import { PROJECTS } from "@/lib/opd/config.js";
import { buildPortalModel, unreachableProjects, topRole, ROLE_LABEL } from "@/lib/opd/auth-core.js";
import { loadAccess, legacyExplo, logoutAll } from "@/lib/opd/session.js";

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

export function PortalHome() {
  const [access, setAccess] = useState<ReturnType<typeof loadAccess> | undefined>(undefined);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const a = loadAccess();
    if (a?.ok) { setAccess(a); return; }
    // Phones that were signed in to the standalone Exploration app (or use guest mode) keep working: go straight there.
    if (legacyExplo()) { location.replace("/explo/"); return; }
    location.replace("/login/?next=/");
  }, []);

  const model = useMemo(() => (access ? buildPortalModel(PROJECTS, access) : null), [access]);
  if (!access || !model) return <div className="grid min-h-dvh place-items-center text-sm text-muted-foreground" aria-busy>Loading…</div>;

  const down = unreachableProjects(access).map((id: string) => PROJECTS.find(p => p.id === id)?.name ?? id);
  const role = topRole(access);
  const out = async () => { await logoutAll(); location.replace("/login/"); };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-[20] flex h-[var(--topbar-h)] items-center gap-3 border-b bg-[color-mix(in_srgb,var(--card)_92%,transparent)] px-4 backdrop-blur">
        <BrandMark className="size-8" />
        <div className="min-w-0 flex-1 text-sm leading-tight"><div className="font-semibold">One Portal Data</div>
          <div className="truncate text-xs text-muted-foreground" id="who">{access.name} · {role ? ROLE_LABEL[role as keyof typeof ROLE_LABEL] : "no role"}</div></div>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">{theme === "dark" ? <Sun /> : <Moon />}</Button>
        <Button variant="outline" size="sm" onClick={out} id="b-out"><LogOut />Sign out</Button>
      </header>
      <main className="mx-auto w-full max-w-[var(--content-max)] px-4 pb-10 pt-5">
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
      </main>
    </div>
  );
}
