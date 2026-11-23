"use client";
import { useEffect, useState } from "react";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { MountainSnow, PenLine } from "lucide-react";
import { core, openSite, type Info } from "@/lib/boot";
import { Button } from "@/components/ui/button";
import { SitePicker } from "@/components/site-picker";
import { Card } from "@/components/ui/card";

export function Login({ onDone, lockedSite, initialSite }: { onDone: (i: Info) => void; lockedSite?: string | null; initialSite?: string | null }) {
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState(lockedSite || initialSite || (typeof localStorage !== "undefined" && localStorage.getItem("exp_last_site")) || "WKM");
  const [live, setLive] = useState<Record<string, boolean>>({});
  const [online, setOnline] = useState(true);

  useEffect(() => {
    core().then(c => { setSites(Object.keys(c.conf.SITES)); setLive(Object.fromEntries(Object.entries(c.conf.SITES).map(([k, v]) => [k, !!(v as { url: string }).url])));  });
    setOnline(navigator.onLine);
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  async function guest() {
    const { S } = await core();
    const info = S.enterGuest(site);
    try { localStorage.setItem("exp_last_site", site); } catch {}
    await openSite(site);
    onDone(info);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5" id="lf">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Exploration", href: "/exploration/" }, { label: "Data Entry" }]} />
      <Card className="flex flex-col gap-5 p-5 md:p-7">
        <div className="flex items-center gap-3">
          <span className="grid size-[2.6rem] place-items-center rounded-[.7rem] bg-gradient-to-br from-[color-mix(in_srgb,var(--primary)_82%,#fff)] to-primary text-primary-foreground shadow-sm">
            <MountainSnow className="size-[22px]" aria-hidden />
          </span>
          <div><h1 className="font-serif text-2xl font-medium leading-tight">Data Entry</h1><p className="text-sm text-muted-foreground">Works offline. Data is saved on this device and sent when you sign in.</p></div>
        </div>
        {!online && <div className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-warning">You are offline. You can still enter data.</div>}
        <SitePicker sites={sites.length ? sites : [site]} value={site} onChange={setSite} disabled={!!lockedSite} connected={k => live[k] ?? true}
          legend="Which site is this data for?" hint="Pick the site you work at today. Everything you enter is saved to this site." />
        <p className="rounded-md border border-[var(--info-border)] bg-[var(--info-bg)] px-3 py-2 text-sm text-info" aria-live="polite" id="site-banner">You will record data for site <b className="font-mono">{site}</b>.</p>
        <Button type="button" size="lg" className="w-full" onClick={guest} id="l-guest"><PenLine />Start offline data entry</Button>
        <p className="text-sm text-muted-foreground">Have an account? <a id="l-portal" className="font-medium text-info underline-offset-2 hover:underline" href={`/login/?next=${encodeURIComponent(`/explo/?site=${site}`)}`} onClick={() => { try { localStorage.removeItem("opd_access"); } catch {} }}>Log in with One Portal</a> to sync data now and see the dashboard, QC, maps and 3D hole.</p>
      </Card>
    </div>
  );
}
