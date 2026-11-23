"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LockKeyhole, LogIn, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Sun, WifiOff, X } from "lucide-react";
import { useTheme } from "@/lib/ui-state";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { PROJECTS } from "@/lib/opd/config.js";
import { canOpen } from "@/lib/opd/auth-core.js";
import { cn } from "@/lib/utils";
import { PageSearch } from "@/components/opd/page-search";
import { NAV, SECTIONS, isHere, sectionOf, type NavKey, type Need } from "@/lib/opd/sitemap";

type Access = { projects: Record<string, unknown> } & Record<string, unknown>;
export type Account = { label: string; signOut: () => void; signOutLabel?: string; portal?: boolean };

/** Top menu. Plain sentence case. Scrolls sideways instead of wrapping when it runs out of room. */
export function AppNav({ active, className }: { active: NavKey | null; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" }); }, [active]);
  return (
    <nav ref={ref} aria-label="Main" className={cn("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      <ul className="flex min-w-max items-center gap-1">
        {NAV.map(n => (
          <li key={n.key}>
            <a href={n.href} data-nav={n.key} aria-current={n.key === active ? "page" : undefined}
              className={cn("tap relative inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium",
                n.key === active ? "bg-[var(--info-bg)] text-info" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              {n.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Tile({ icon: Icon, on }: { icon: React.ComponentType<{ className?: string }>; on?: boolean }) {
  return <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border transition-colors", on ? "border-transparent bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground group-hover:text-foreground")}><Icon className="size-4" /></span>;
}

function SideLink({ href, label, need, note, access, path, onGo }:
  { href: string; label: string; icon: React.ComponentType<{ className?: string }>; need?: Need; note?: string; access: Access | null; path: string; onGo?: () => void }) {
  const here = isHere(href, path);
  const locked = !!need && (!access || !canOpen(PROJECTS, access, need));
  const why = !access ? "Sign-in required" : "Your accounts can't open this page";
  return (
    <a href={href} onClick={onGo} data-side-item={href} aria-current={here ? "page" : undefined}
      className={cn("nudge relative flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm",
        here ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
      <span className={cn("absolute -left-[calc(.5rem+3.5px)] top-1/2 size-[7px] -translate-y-1/2 rounded-full border-2 border-card", here ? "bg-primary" : "bg-border")} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {note && !locked && <span className="rounded-full border px-1.5 text-[.6875rem] text-muted-foreground">{note}</span>}
      {locked && <><LockKeyhole className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="sr-only">{why}</span></>}
    </a>
  );
}

export type SideExtra = (c: { collapsed: boolean }) => React.ReactNode;

function Profile({ account, collapsed }: { account: Account | null; collapsed: boolean }) {
  const [name, role] = (account?.label ?? "Guest · Not signed in").split(" · ");
  const initials = (name.match(/\b\p{L}/gu) ?? ["G"]).slice(0, 2).join("").toUpperCase();
  const avatar = <span className="relative grid size-10 shrink-0 place-items-center rounded-full border bg-accent text-sm font-semibold text-brand" aria-hidden>{initials}<span className={cn("absolute -bottom-px -right-px size-3 rounded-full border-2 border-card", account ? "bg-[var(--success,#16a34a)]" : "bg-muted-foreground/40")} /></span>;
  if (collapsed) return <div className="mb-3 flex justify-center" title={`${name} · ${role}`}>{avatar}</div>;
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border bg-muted/40 p-2.5" data-profile>
      {avatar}
      <div className="min-w-0"><p className="truncate text-sm font-semibold leading-tight">{name}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{role}</p></div>
    </div>
  );
}

function Notice({ access }: { access: Access | null }) {
  return (
    <a href="/explo/" className="lift mt-auto block rounded-xl border bg-muted/40 p-3 text-sm" data-notice>
      <span className="flex items-center gap-2 font-medium"><WifiOff className="size-4 text-brand" aria-hidden />Works offline</span>
      <span className="mt-1 block text-xs leading-snug text-muted-foreground">{access ? "Field entry keeps saving with no signal and sends later." : "Start field entry without signing in. It sends when you do."}</span>
    </a>
  );
}

function SidebarBody({ access, path, onGo, collapsed, sideExtra }: { access: Access | null; path: string; onGo?: () => void; collapsed: boolean; sideExtra?: SideExtra }) {
  const current = sectionOf(path);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (k: string) => open[k] ?? k === current;

  if (collapsed) {
    return (
      <nav aria-label="Site pages" className="flex flex-col items-center gap-1.5">
        {SECTIONS.map(sec => {
          const here = sec.key === current;
          return (
            <a key={sec.key} href={sec.href} data-side-section={sec.key} title={sec.label} aria-label={sec.label} aria-current={here ? "page" : undefined} className="group tap grid size-10 place-items-center rounded-lg">
              <Tile icon={sec.icon} on={here} />
            </a>
          );
        })}
        {current === "explo" && sideExtra && <div className="mt-2 flex flex-col items-center gap-1 border-t pt-2">{sideExtra({ collapsed: true })}</div>}
      </nav>
    );
  }

  return (
    <nav aria-label="Site pages" className="flex flex-col gap-0.5">
      <p className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">Menu</p>
      {SECTIONS.map(sec => {
        if (!sec.items.length) {
          const here = isHere(sec.href, path);
          return (
            <a key={sec.key} href={sec.href} onClick={onGo} data-side-section={sec.key} aria-current={here ? "page" : undefined}
              className={cn("group nudge flex min-h-11 items-center gap-2.5 rounded-xl px-1.5 text-sm font-medium", here ? "bg-muted text-foreground" : "text-foreground/80 hover:bg-muted/60")}>
              <Tile icon={sec.icon} on={here} />{sec.label}
            </a>
          );
        }
        const expanded = isOpen(sec.key);
        const id = `side-${sec.key}`;
        return (
          <div key={sec.key} data-side-section={sec.key}>
            <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(o => ({ ...o, [sec.key]: !expanded }))}
              className={cn("group tap flex min-h-11 w-full items-center gap-2.5 rounded-xl px-1.5 text-left text-sm font-medium hover:bg-muted/60", sec.key === current ? "text-foreground" : "text-foreground/80")}>
              <Tile icon={sec.icon} on={sec.key === current} />
              <span className="flex-1">{sec.label}</span>
              <ChevronDown className={cn("mr-1 size-4 text-muted-foreground transition-transform duration-200", expanded && "rotate-180")} aria-hidden />
            </button>
            {expanded && (
              <ul id={id} className="relative ml-[1.55rem] mt-0.5 flex flex-col gap-0.5 border-l pb-1 pl-3.5">
                {sec.items.map(it => (
                  <li key={it.href}>
                    <SideLink {...it} access={access} path={path} onGo={onGo} />
                    {it.href === "/explo/" && sideExtra && path.startsWith("/explo") && <div className="mb-1 ml-3 mt-0.5 flex flex-col gap-0.5 border-l pl-2" data-side-extra>{sideExtra({ collapsed: false })}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function SidebarHead({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn("flex items-center pb-4 pt-1", collapsed ? "justify-center" : "gap-2 px-1")}>
      <a href="/" aria-label="One Portal Data, home" className="flex items-center gap-3"><BrandMark />{!collapsed && <span className="whitespace-nowrap font-serif text-base font-medium leading-tight">One Portal Data</span>}</a>
    </div>
  );
}

/**
 * The one page frame of OPD: collapsible sidebar (a drawer on phones), a top bar with the main menu and the account, the content, a footer.
 * Home, the hubs, the data pages, Help and the Exploration app all render inside it, so they look and behave the same.
 * The page search sits in the top bar everywhere except the Exploration app (it passes headerExtra and has its own Ctrl+K palette).
 */
export function Shell({ active, access, account, path, sideExtra, headerExtra, mobileBar, full, mainClass, children }:
  { active: NavKey | null; access: Access | null; account: Account | null; path: string; sideExtra?: SideExtra; headerExtra?: React.ReactNode; mobileBar?: React.ReactNode; full?: boolean; mainClass?: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const { theme, toggle } = useTheme();

  useEffect(() => { try { setCollapsed(localStorage.getItem("opd_side") === "1"); } catch {} }, []);
  const flip = () => setCollapsed(c => { const n = !c; try { localStorage.setItem("opd_side", n ? "1" : "0"); } catch {} return n; });

  useEffect(() => {
    if (!drawer) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", key); };
  }, [drawer]);

  return (
    <div className="shell-pad min-h-dvh lg:pl-[calc(var(--side-w)+1.5rem)]" style={{ ["--side-w" as string]: collapsed ? "4.5rem" : "15.5rem" }} data-collapsed={collapsed ? "" : undefined} data-no-motion={headerExtra || full ? "" : undefined}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[var(--z-toast)] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-md">Skip to content</a>

      <aside data-sidebar className="shell-side fixed bottom-3 left-3 top-3 z-[20] hidden w-[var(--side-w)] flex-col overflow-y-auto overscroll-contain rounded-[1.75rem] border bg-card p-3 lg:flex">
        <SidebarHead collapsed={collapsed} />
        <Profile account={account} collapsed={collapsed} />
        <SidebarBody access={access} path={path} collapsed={collapsed} sideExtra={sideExtra} />
        {collapsed ? <div className="flex-1" /> : <div className="flex flex-1 flex-col pt-6"><Notice access={access} /></div>}
        <div className={cn("mt-3 flex border-t pt-3", collapsed ? "justify-center" : "justify-start")}>
          <Button variant="ghost" size={collapsed ? "icon" : "sm"} className="shrink-0" onClick={flip} id="b-collapse" aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <PanelLeftOpen /> : <><PanelLeftClose />Collapse</>}
          </Button>
        </div>
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-[var(--z-overlay)] lg:hidden" data-drawer>
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-[var(--overlay)]" onClick={() => setDrawer(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Site pages" className="absolute bottom-2 left-2 top-2 flex w-[min(20rem,86vw)] flex-col overflow-y-auto overscroll-contain rounded-[1.75rem] border bg-card p-3 shadow-lg" style={{ marginTop: "var(--safe-t)" }}>
            <div className="flex items-start justify-between"><SidebarHead collapsed={false} />
              <Button variant="ghost" size="icon" onClick={() => setDrawer(false)} aria-label="Close menu"><X /></Button></div>
            <Profile account={account} collapsed={false} />
            <SidebarBody access={access} path={path} collapsed={false} sideExtra={sideExtra ? c => sideExtra(c) : undefined} onGo={() => setDrawer(false)} />
            <div className="flex flex-1 flex-col pt-6"><Notice access={access} /></div>
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-[20] bg-page">
        <div className="flex h-[var(--topbar-h)] w-full items-center gap-1 px-3 sm:gap-2 md:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu" aria-haspopup="dialog" id="b-menu"><Menu /></Button>
          <a href="/" aria-label="One Portal Data, home" className={cn("items-center gap-2 lg:hidden", headerExtra ? "hidden sm:flex" : "flex")}><BrandMark className="size-8" /></a>
          {account && <div className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block" id="who">{account.label}</div>}
          <div className="ml-auto flex items-center gap-1">
            {headerExtra}
            {!headerExtra && <PageSearch access={access} />}
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">{theme === "dark" ? <Sun /> : <Moon />}</Button>
            {account
              ? <>{account.portal !== false && <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex"><a href="/portal/" id="b-portal">Portal</a></Button>}
                  <Button variant="outline" size="sm" onClick={account.signOut} id="b-out" aria-label={account.signOutLabel ?? "Sign out"}><LogOut /><span className="max-sm:hidden">{account.signOutLabel ?? "Sign out"}</span></Button></>
              : <Button size="sm" asChild><a href={`/login/?next=${encodeURIComponent(path)}`} id="b-login"><LogIn />Sign in</a></Button>}
          </div>
        </div>
      </header>

      {full
        ? <main id="main">{children}</main>
        : <main id="main" className={cn("mx-auto w-full max-w-[var(--content-max)] px-4 pb-12 pt-5 md:px-8 md:pt-6", mainClass)}>{children}</main>}
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">One Portal Data · PT Central Abadi Nusantara</footer>
      {mobileBar}
    </div>
  );
}
