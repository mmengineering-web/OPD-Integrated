"use client";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, PageHead } from "@/components/opd/app-frame";
import { cn } from "@/lib/utils";

/** The two Looker Studio reports of the old portal (all sites). Embed URL for the frame, live URL for "Open in a new tab". */
export const REPORTS = [
  { id: "production", title: "Production Dashboard", embed: "https://datastudio.google.com/embed/reporting/0063a62c-4550-4b4d-aaeb-b2e59c6c3914/page/p_ihuqif9p2d", live: "https://lookerstudio.google.com/reporting/0063a62c-4550-4b4d-aaeb-b2e59c6c3914/page/p_ihuqif9p2d" },
  { id: "management", title: "Management Dashboard", embed: "https://datastudio.google.com/embed/reporting/0fc8101a-d0f7-40ed-86fa-7ad0115343d9/page/p_yxr55ck54d", live: "https://lookerstudio.google.com/reporting/0fc8101a-d0f7-40ed-86fa-7ad0115343d9/page/p_yxr55ck54d" },
];

/** All-sites production dashboard. Opens only for accounts with a usable Hub production project (prod.hub). */
export function ProductionDashboardPage() {
  const [id, setId] = useState(REPORTS[0].id);
  const cur = REPORTS.find(r => r.id === id)!;
  return (
    <AppFrame active="production" gate="ho-production" backHref="/production/" backLabel="Back to Production">{() => (
      <>
        <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Production", href: "/production/" }, { label: "Dashboard" }]} />
        <PageHead title="Dashboard" lead="Production and management reports for all sites, for head office accounts." tag="All sites" />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Report" className="inline-flex rounded-lg border bg-muted/50 p-0.5">
            {REPORTS.map(r => (
              <button key={r.id} type="button" aria-pressed={id === r.id} data-report={r.id} onClick={() => setId(r.id)}
                className={cn("tap h-8 rounded-md px-4 text-sm font-medium", id === r.id ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>{r.title}</button>
            ))}
          </div>
          <Button asChild variant="outline" size="sm" className="ml-auto"><a id="open-live" href={cur.live} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" aria-hidden />Open in a new tab</a></Button>
        </div>
        <Card className="overflow-hidden p-0">
          <iframe key={cur.id} id="dash-frame" title={cur.title} src={cur.embed} allowFullScreen loading="lazy" referrerPolicy="no-referrer"
            className="block h-[calc(100dvh-14rem)] min-h-[28rem] w-full border-0" />
        </Card>
        <p className="mt-3 max-w-[70ch] text-xs text-muted-foreground">The reports are served by Looker Studio and refresh on its schedule. If the frame stays blank, sign in to your Google account in this browser or open the report in a new tab.</p>
      </>
    )}</AppFrame>
  );
}
