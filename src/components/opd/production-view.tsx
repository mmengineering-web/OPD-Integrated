"use client";
import { useMemo } from "react";
import { Building2, Factory } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead, type Access } from "@/components/opd/app-frame";
import { PROJECTS } from "@/lib/opd/config.js";
import { buildPortalModel, ROLE_LABEL } from "@/lib/opd/auth-core.js";

type Mod = { projectId: string; usable: boolean; state: string; role: string | null } | null;
const STATE_TEXT: Record<string, string> = { none: "Not set up", unconfigured: "Not connected yet", invalid: "No account here", noprofile: "No profile", inactive: "Disabled", unreachable: "Unreachable" };

function Row({ icon: Icon, label, mod }: { icon: React.ComponentType<{ className?: string }>; label: string; mod: Mod }) {
  const usable = !!mod?.usable;
  return (
    <div className={`flex h-11 items-center gap-2 rounded-md border px-3 text-sm ${usable ? "bg-card" : "bg-muted/40 text-muted-foreground"}`} data-module={mod?.projectId ?? "none"}>
      <Icon className="size-4 shrink-0" /><span className="font-medium">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">{usable ? (mod?.role ? ROLE_LABEL[mod.role as keyof typeof ROLE_LABEL] : "Connected") : STATE_TEXT[mod?.state ?? "none"]}</span>
    </div>
  );
}

function View({ access }: { access: Access }) {
  const model = useMemo(() => buildPortalModel(PROJECTS, access), [access]);
  return (
    <>
      <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/portal/" }, { label: "Production" }]} />
      <PageHead title="Production" tag="Phase 4 · planned" lead="Daily production reports for WKM, BM and TMS, uploaded in the browser and stored per site. Your access per site is shown below." />
      <Card className="mb-6 gap-2 p-3" data-tile="HO"><Row icon={Building2} label="Head office (all sites)" mod={model.ho.production} /></Card>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {model.sites.filter((s: any) => s.production?.state !== "none").map((s: any) => (
          <Card key={s.code} className="gap-2 p-3" data-tile={s.code}>
            <div className="text-sm font-semibold">{s.code}</div>
            <Row icon={Factory} label="Production" mod={s.production} />
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <h2 className="text-base font-semibold">What arrives with this module</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Upload the daily report (Excel or PDF); the file is read in your browser and checked before anything is saved.</li>
          <li>Preview with warnings and rejected rows, then load into the site database. A load can be undone.</li>
          <li>Per-site history of uploads and a 20-day shadow run next to the current process.</li>
        </ul>
        <p className="text-xs text-muted-foreground">Needs the production project keys and sample daily reports for WKM, BM and TMS.</p>
      </Card>
    </>
  );
}

export const ProductionView = () => <AppFrame active="production">{a => <View access={a} />}</AppFrame>;
