"use client";
import { useEffect, useRef, useState } from "react";
import { LogOut, Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/ui-state";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { ROLE_LABEL, topRole } from "@/lib/opd/auth-core.js";
import { loadAccess, legacyExplo, logoutAll } from "@/lib/opd/session.js";
import { cn } from "@/lib/utils";

export type Access = NonNullable<ReturnType<typeof loadAccess>>;
export type NavKey = "home" | "production" | "explo" | "documents" | "tools" | "help";

/** The six top-level pages of OPD, in menu order. */
export const NAV: { key: NavKey; label: string; href: string }[] = [
  { key: "home", label: "Home", href: "/portal/" },
  { key: "production", label: "Production", href: "/production/" },
  { key: "explo", label: "Exploration", href: "/explo/" },
  { key: "documents", label: "Documents", href: "/documents/" },
  { key: "tools", label: "Mining Tools", href: "/tools/" },
  { key: "help", label: "Help", href: "/help/" },
];

/** Horizontal menu. Scrolls sideways on a phone instead of wrapping. */
export function AppNav({ active, className }: { active: NavKey; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" }); }, [active]);   // phone: bring the current item into view
  return (
    <nav ref={ref} aria-label="Main" className={cn("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      <ul className="flex min-w-max items-center gap-1">
        {NAV.map(n => (
          <li key={n.key}>
            <a href={n.href} data-nav={n.key} aria-current={n.key === active ? "page" : undefined}
              className={cn("inline-flex h-9 items-center rounded-md px-4 text-[.8125rem] font-medium uppercase tracking-wide transition-colors",
                n.key === active ? "bg-[var(--info-bg)] text-info" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              {n.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Signed-in page frame: header (brand, who, theme, sign out) + the main menu + content.
 * Signed out, it redirects to /login/?next=<this page>. `legacyRedirect` keeps the Phase 1 rule for the portal home:
 * phones with the old Exploration login go straight to /explo/.
 */
export function AppFrame({ active, legacyRedirect = false, children }: { active: NavKey; legacyRedirect?: boolean; children: (access: Access) => React.ReactNode }) {
  const [access, setAccess] = useState<Access | undefined>(undefined);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const a = loadAccess();
    if (a?.ok) { setAccess(a); return; }
    if (legacyRedirect && legacyExplo()) { location.replace("/explo/"); return; }
    location.replace(`/login/?next=${encodeURIComponent(location.pathname)}`);
  }, [legacyRedirect]);

  if (!access) return <div className="grid min-h-dvh place-items-center text-sm text-muted-foreground" aria-busy>Loading…</div>;
  const role = topRole(access);
  const out = async () => { await logoutAll(); location.replace("/"); };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-[20] border-b bg-[color-mix(in_srgb,var(--card)_92%,transparent)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-[var(--content-max)] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 md:h-[var(--topbar-h)] md:flex-nowrap md:py-0">
          <a href="/" aria-label="One Portal Data, home"><BrandMark className="size-8" /></a>
          <div className="min-w-0 text-sm leading-tight"><div className="font-serif text-base font-medium">One Portal Data</div>
            <div className="truncate text-xs text-muted-foreground" id="who">{access.name} · {role ? ROLE_LABEL[role as keyof typeof ROLE_LABEL] : "no role"}</div></div>
          <AppNav active={active} className="order-last w-full md:order-none md:ml-4 md:w-auto md:min-w-0 md:flex-1" />
          <div className="ml-auto flex items-center gap-1 md:ml-0">
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">{theme === "dark" ? <Sun /> : <Moon />}</Button>
            <Button variant="outline" size="sm" onClick={out} id="b-out"><LogOut />Sign out</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[var(--content-max)] px-4 pb-10 pt-4">{children(access)}</main>
    </div>
  );
}

export function PageHead({ title, lead, tag }: { title: string; lead: string; tag?: string }) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-2"><h1 className="font-serif text-2xl font-medium">{title}</h1>
        {tag && <span className="rounded-full border border-[var(--info-border)] bg-[var(--info-bg)] px-2.5 py-0.5 text-xs font-medium text-info">{tag}</span>}</div>
      <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">{lead}</p>
    </div>
  );
}
