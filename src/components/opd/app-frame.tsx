"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PROJECTS } from "@/lib/opd/config.js";
import { ROLE_LABEL, canOpen, topRole } from "@/lib/opd/auth-core.js";
import { loadAccess, legacyExplo, logoutAll } from "@/lib/opd/session.js";
import { NAV, type NavKey, type Need } from "@/lib/opd/sitemap";
import { AppNav, Shell } from "@/components/opd/shell";
export { NAV, AppNav };
export type { NavKey, Need };

export type Access = NonNullable<ReturnType<typeof loadAccess>>;

/** Shown when the person is signed in but has no account that can open the page. */
export function AccessDenied({ access, need, backHref, backLabel }: { access: Access; need: Need; backHref: string; backLabel: string }) {
  const what = need === "production" ? "a production account" : need === "exploration" ? "an exploration account" : need === "ho-production" ? "a Head Office production (Hub) account" : need === "super_admin" ? "a super admin account" : "an account";
  const other = async () => { await logoutAll(); location.assign(`/login/?next=${encodeURIComponent(location.pathname)}`); };
  return (
    <Card className="mx-auto mt-8 max-w-[34rem] items-center gap-3 p-8 text-center" id="denied" role="alert">
      <span className="grid size-12 place-items-center rounded-full bg-[var(--danger-bg)] text-danger"><LockKeyhole className="size-6" /></span>
      <h1 className="font-serif text-2xl font-medium">You don&apos;t have access to this page</h1>
      <p className="text-sm text-muted-foreground">{access.name} is signed in, but this page needs {what} and none of your accounts qualifies. If you think this is a mistake, ask your site admin or a super admin to add you.</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline"><a href={backHref}>{backLabel}</a></Button>
        <Button asChild variant="outline"><a href="/portal/">Open portal</a></Button>
        <Button variant="ghost" onClick={other} id="b-other">Sign in with another account</Button>
      </div>
    </Card>
  );
}

/** Loading placeholder shaped like a page, so nothing jumps when the content arrives. */
export function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[var(--content-max)] p-6" aria-busy aria-label="Loading">
      <Skeleton className="mb-4 h-4 w-40" /><Skeleton className="mb-5 h-40 w-full rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
    </div>
  );
}

/**
 * A page inside the OPD shell. Public pages leave `gate` out and open for everyone. A page that shows data sets `gate`:
 * signed out it goes to the OPD login (/login/?next=<this page>), and once signed in it checks the person's accounts
 * and shows "You don't have access to this page" when none qualifies.
 * `legacyRedirect` keeps the Phase 1 rule for the portal: phones with the old Exploration login go straight to /explo/.
 * `full` drops the content container, for pages that lay out their own full-width sections (Home).
 */
export function AppFrame({ active, gate, backHref = "/", backLabel = "Back to Home", legacyRedirect = false, full = false, children }:
  { active: NavKey | null; gate?: Need; backHref?: string; backLabel?: string; legacyRedirect?: boolean; full?: boolean; children: (access: Access | null) => React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<Access | null>(null);
  const path = usePathname() || "/";

  useEffect(() => {
    const a = loadAccess();
    const acc = a?.ok ? a : null;
    if (gate && !acc) {
      if (legacyRedirect && legacyExplo()) location.replace("/explo/");
      else location.replace(`/login/?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (!gate && !acc && path === "/" && legacyExplo()) { location.replace("/explo/"); return; }   // phones with the old standalone login keep going straight to Exploration
    setAccess(acc); setReady(true);
  }, [gate, legacyRedirect, path]);

  if (!ready) return <PageSkeleton />;
  const role = access ? topRole(access) : null;
  const out = async () => { await logoutAll(); location.replace("/"); };
  const allowed = !gate || canOpen(PROJECTS, access, gate);
  const account = access ? { label: `${access.name} · ${role ? ROLE_LABEL[role as keyof typeof ROLE_LABEL] : "no role"}`, signOut: out } : null;

  return (
    <Shell active={active} access={access} account={account} path={path} full={full && allowed}>
      {allowed ? children(access) : <div className="mx-auto w-full max-w-[var(--content-max)] px-4 pb-12 pt-5 md:px-8"><AccessDenied access={access!} need={gate!} backHref={backHref} backLabel={backLabel} /></div>}
    </Shell>
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
