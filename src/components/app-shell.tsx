"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Box, Clock, Database, Ellipsis, FileSpreadsheet, FileText, FlaskConical, Layers, LayoutDashboard, LogOut, Map as MapIcon, MapPin, Moon,
  Pickaxe, RefreshCw, Search, Settings, ShieldCheck, Sun, Wifi, WifiOff,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { core, openSite, tabsFor, TABS, type Info, type SyncStatus } from "@/lib/boot";
import { useTheme } from "@/lib/ui-state";
import { Login } from "./login";
import { BrandMark } from "./brand-mark";
import { ToastProvider, useToast } from "./toast";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Button } from "./ui/button";
import { ProgressForm } from "./progress-form";
import { Soon } from "./soon";
import { CollarForm } from "./collar-form";
import { HoursForm } from "./hours-form";
import { SampleForm } from "./sample-form";
import { ConfirmProvider } from "./confirm";
import { ReportView } from "./report-view";
import { DataRecords } from "./data-records";
import { ImportView } from "./import-view";
import { AdminView } from "./admin-view";
import { Breadcrumb } from "./opd/breadcrumb";
import { Shell, type SideExtra } from "./opd/shell";
import { PageSkeleton } from "./opd/app-frame";
import { PROJECTS } from "@/lib/opd/config.js";
import { exploSites, pickExploSite } from "@/lib/opd/auth-core.js";
import { loadAccess, logoutAll } from "@/lib/opd/session.js";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  AlertTriangle, Box, Clock, Database, FileSpreadsheet, FileText, FlaskConical, Layers, LayoutDashboard, Map: MapIcon, MapPin, Pickaxe, RefreshCw, Settings, ShieldCheck, Wifi, WifiOff,
};
const Ico = ({ name, className }: { name: string; className?: string }) => {
  const C = ICONS[name] ?? Layers;
  return <C className={className} />;
};

// A new service worker takes over right after a release. The open page still runs the old code, so ask for a reload.
function UpdateWatcher() {
  const toast = useToast();
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;   // first install: nothing to replace
    const on = () => toast("A new version is ready. Close and reopen the app (or reload) to use it.");
    navigator.serviceWorker.addEventListener("controllerchange", on);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", on);
  }, [toast]);
  return null;
}

export function AppShell() {
  const [info, setInfo] = useState<Info | null | undefined>(undefined);
  const [sites, setSites] = useState<string[]>([]);       // sites the portal login allows; empty = not on the portal session
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(console.warn);
  }, []);
  useEffect(() => {
    (async () => {
      const { S } = await core();
      let i: Info | null = null;
      const access = loadAccess();
      if (access?.ok) {
        // 1. portal session: no second login
        const list = exploSites(PROJECTS, access);
        let cached: string | null = null;
        try { cached = JSON.parse(localStorage.getItem("exp_session") || "null")?.site ?? null; } catch {}
        const site = pickExploSite(list, { wanted: new URLSearchParams(location.search).get("site"), cached, guest: localStorage.getItem("exp_guest_site") });
        if (site) i = await S.attachSession(site, access.projects[`${site.toLowerCase()}-explo`]);
        if (i) setSites(list.map((s: { site: string }) => s.site));
      }
      // 2. otherwise the old Exploration login or guest mode (kept as is)
      if (!i) i = await S.restore();
      if (i) await openSite(i.site);
      setInfo(i || null);
    })().catch(() => setInfo(null));
  }, []);

  // Site switcher: attach the other site's portal session, then open its local database.
  const switchSite = useCallback(async (site: string) => {
    const access = loadAccess();
    if (!access?.ok) return false;
    const { S } = await core();
    const i = await S.attachSession(site, access.projects[`${site.toLowerCase()}-explo`]);
    if (!i) return false;
    await openSite(i.site);
    history.replaceState(null, "", `/explo/?site=${i.site}`);
    setInfo(i);
    return true;
  }, []);

  // One login, one logout: leaving Exploration on the portal session signs out of every project and clears server data on this phone.
  const portalLogout = useCallback(async () => { await logoutAll(); location.replace("/"); }, []);

  if (info === undefined) return <PageSkeleton />;
  return (
    <ToastProvider><ConfirmProvider>
      <UpdateWatcher />
      {info ? <Main key={info.site} info={info} sites={sites} onSwitch={switchSite} onPortalLogout={portalLogout} onLogout={() => setInfo(null)} />
        : <Shell active="explo" access={loadAccess()} account={null} path="/explo/">
            <Login onDone={setInfo} initialSite={typeof location !== "undefined" ? new URLSearchParams(location.search).get("site")?.toUpperCase() : null} />
          </Shell>}
    </ConfirmProvider></ToastProvider>
  );
}

function Main({ info, sites, onSwitch, onPortalLogout, onLogout }: { info: Info; sites: string[]; onSwitch: (site: string) => Promise<boolean>; onPortalLogout: () => Promise<void>; onLogout: () => void }) {
  const toast = useToast();
  const onPortal = sites.length > 0 && !info.guest;
  const tabs = useMemo(() => tabsFor(info), [info]);
  const [tab, setTab] = useState(tabs[0]?.key ?? "report");
  const [pal, setPal] = useState(false);
  const [st, setSt] = useState<SyncStatus>({ pending: 0, online: true, syncing: false, error: null, last: null });
  const { theme, toggle: toggleTheme } = useTheme();
  const chipKey = `${st.online}-${st.syncing}-${st.pending}-${!!st.error}`;

  useEffect(() => {
    let off = () => {};
    core().then(({ S }) => {
      off = S.onStatus(setSt);
      S.startAutoSync();
      S.refreshStatus();
      if (!info.guest) S.syncNow();
    });
    return () => off();
  }, [info.guest]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPal(p => !p); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const logout = useCallback(async () => {
    if (onPortal) { await onPortalLogout(); return; }
    const { S, D } = await core();
    await S.logout();
    try { await D.purgeServerData(); } catch {}
    onLogout();
  }, [onLogout, onPortal, onPortalLogout]);

  const go = (k: string) => { setTab(k); setPal(false); window.scrollTo({ top: 0 }); };
  const groups = useMemo(() => {
    const m = new Map<string, typeof tabs>();
    tabs.forEach(t => m.set(t.group, [...(m.get(t.group) ?? []), t]));
    return [...m.entries()];
  }, [tabs]);
  const cur = TABS.find(t => t.key === tab);

  const chip = st.error ? { t: "error sync", s: "error", c: "text-danger border-[var(--danger-border)] bg-[var(--danger-bg)]", i: "AlertTriangle" }
    : !st.online ? { t: `offline · ${st.pending} menunggu`, s: st.pending ? `${st.pending} menunggu` : "offline", c: "text-warning border-[var(--warning-border)] bg-[var(--warning-bg)]", i: "WifiOff" }
    : st.syncing ? { t: "mengirim…", s: "kirim…", c: "text-info border-[var(--info-border)] bg-[var(--info-bg)]", i: "RefreshCw" }
    : { t: `online · ${st.pending} pending`, s: st.pending ? `${st.pending} pending` : "online", c: "text-success border-[var(--success-border)] bg-[var(--success-bg)]", i: "Wifi" };

  const access = useMemo(() => { const a = loadAccess(); return a?.ok ? a : null; }, []);
  const account = {
    label: `${info.name} · ${info.role_label}`, signOut: logout, portal: onPortal,
    signOutLabel: info.guest ? "Login" : onPortal ? "Sign out" : "Keluar",
  };
  const sideExtra: SideExtra = ({ collapsed }) => groups.map(([g, items]) => (
    <div key={g} className="flex flex-col gap-0.5">
      {!collapsed && <div className="px-2 pb-0.5 pt-2 text-[.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">{g}</div>}
      {items.map(t => (
        <button key={t.key} data-t={t.key} aria-current={t.key === tab ? "page" : undefined} onClick={() => go(t.key)} title={t.label} aria-label={t.label}
          className={cn("nudge relative flex items-center rounded-md text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground", collapsed ? "size-10 justify-center" : "min-h-9 gap-2.5 px-2.5", t.key === tab && "bg-accent font-medium text-foreground")}>
          <Ico name={t.icon} className={cn("size-4 shrink-0", t.key === tab && "text-brand")} />{!collapsed && t.label}
        </button>
      ))}
    </div>
  ));

  return (
    <>
      <Shell active="explo" access={access} account={account} path="/explo/" sideExtra={sideExtra}
        mainClass="pb-[calc(var(--tabbar-h)+var(--safe-b)+1.5rem)] lg:pb-10"
        mobileBar={
      <nav className="fixed inset-x-0 bottom-0 z-[20] flex w-full max-w-full h-[calc(var(--tabbar-h)+var(--safe-b))] items-stretch border-t bg-card pb-[var(--safe-b)] lg:hidden" aria-label="Tab">
        {tabs.slice(0, 4).map(t => (
          <button key={t.key} onClick={() => go(t.key)} aria-current={t.key === tab ? "page" : undefined} aria-label={t.label}
            className={cn("flex min-w-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden text-[.6875rem] font-medium text-muted-foreground", t.key === tab && "text-foreground")}>
            <span className={cn("grid h-7 w-12 place-items-center rounded-full transition-colors", t.key === tab && "bg-[color-mix(in_srgb,var(--primary)_16%,var(--card))] text-brand")}><Ico name={t.icon} className="size-5" /></span>
            {t.label.split(" ")[0]}
          </button>
        ))}
        <button onClick={() => setPal(true)} className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden text-[.6875rem] font-medium text-muted-foreground" aria-label="Lainnya">
          <span className="grid h-7 w-12 place-items-center rounded-full"><Ellipsis className="size-5" /></span>Lainnya
        </button>
      </nav>
        }
        headerExtra={<>
          {!(onPortal && sites.length > 1) && <span id="site-chip" className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 font-mono text-xs font-semibold text-primary-foreground" title="Site tujuan data"><MapPin className="size-3" aria-hidden />{info.site}</span>}
          {onPortal && sites.length > 1 && (
            <select id="site-switch" value={info.site} aria-label="Ganti site" className="h-8 rounded-md border bg-card px-2 text-xs font-medium"
              onChange={async e => { const ok = await onSwitch(e.target.value); if (!ok) toast("Tidak bisa membuka site itu. Masuk ulang lewat One Portal."); }}>
              {sites.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <motion.span key={chipKey} initial={{ scale: 0.92, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 500, damping: 22 }}
            className={cn("mr-1 inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium", chip.c)} id="sync-chip"><Ico name={chip.i} className={cn("size-3", st.syncing && "animate-spin")} /><span className="sm:hidden">{chip.s}</span><span className="hidden sm:inline">{chip.t}</span></motion.span>
          <Button variant="ghost" size="sm" onClick={() => setPal(true)} aria-label="Cari atau buka perintah" id="b-pal"><Search /><kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[.6875rem] text-muted-foreground sm:inline">Ctrl K</kbd></Button>
          {!info.guest && <Button variant="ghost" size="icon" onClick={() => core().then(c => c.S.syncNow())} aria-label="Sync sekarang"><RefreshCw /></Button>}
        </>}>
        <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: "Exploration", href: "/exploration/" }, { label: "Data Entry", href: undefined }, { label: cur?.label ?? info.site }]} />
        {info.guest && (
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-warning" id="guest-strip" role="status">
            <span>Mode offline. Data ini disimpan untuk site <b className="font-mono">{info.site}</b> dan terkirim setelah Anda login.</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={logout} id="b-change-site">Salah site? Ganti site</Button>
          </div>
        )}
        <div className="mb-4 flex flex-wrap items-baseline gap-x-3"><h1 className="font-serif text-2xl font-medium tracking-tight">{cur?.label}</h1><span className="font-mono text-xs text-muted-foreground">{info.site}</span></div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }} data-tab={tab} id="view">
            {tab === "progress" ? <ProgressForm info={info} tick={`${st.last}-${st.pending}`} />
              : tab === "collars" ? <CollarForm info={info} tick={`${st.last}-${st.pending}`} />
              : tab === "hours" ? <HoursForm info={info} tick={`${st.last}-${st.pending}`} />
              : tab === "samples" ? <SampleForm info={info} tick={`${st.last}-${st.pending}`} />
              : tab === "import" ? <ImportView info={info} tick={`${st.last}-${st.pending}`} />
              : tab === "admin" ? <AdminView info={info} />
              : tab === "report" ? <ReportView info={info} tick={`${st.last}-${st.pending}`} />
              : tab === "list" ? <DataRecords info={info} tick={`${st.last}-${st.pending}`} go={go} />
              : <Soon label={cur?.label ?? ""} />}
          </motion.div>
        </AnimatePresence>
      </Shell>


      <CommandDialog open={pal} onOpenChange={setPal}>
        <CommandInput placeholder="Cari tab atau perintah…" />
        <CommandList>
          <CommandEmpty>Tidak ada hasil.</CommandEmpty>
          {groups.map(([g, items]) => (
            <CommandGroup key={g} heading={g}>
              {items.map(t => <CommandItem key={t.key} value={`${t.label} ${g}`} onSelect={() => go(t.key)}><Ico name={t.icon} />{t.label}{t.key === tab && <span className="ml-auto text-xs text-muted-foreground">dibuka</span>}</CommandItem>)}
            </CommandGroup>
          ))}
          <CommandGroup heading="Aksi">
            {!info.guest && <CommandItem value="sync sekarang" onSelect={() => { core().then(c => c.S.syncNow()); setPal(false); }}><RefreshCw />Sync sekarang</CommandItem>}
            <CommandItem value="ganti tema gelap terang" onSelect={() => { toggleTheme(); setPal(false); }}><Moon />Ganti tema</CommandItem>
            <CommandItem value="keluar logout" onSelect={() => { setPal(false); logout(); }}><LogOut />Keluar</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
