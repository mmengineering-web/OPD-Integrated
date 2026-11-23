"use client";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Breadcrumb } from "@/components/opd/breadcrumb";
import { AppFrame, type Access, type NavKey, type Need } from "@/components/opd/app-frame";
import { PROJECTS } from "@/lib/opd/config.js";
import { ROLE_LABEL, usableProjects } from "@/lib/opd/auth-core.js";
import { SECTIONS } from "@/lib/opd/sitemap";
import { Contours, Strata } from "@/components/opd/strata";
import { cn } from "@/lib/utils";

export type HubCard = {
  icon: React.ComponentType<{ className?: string }>; title: string; desc: string;
  href?: string;                 // missing = not built yet (shown as Planned, not clickable)
  needs?: boolean;               // opening it asks for sign-in and an account
  badge?: string;
};

/** A public landing page for one menu item: a hero on the strata, three facts, and the destinations as a bento grid. */
export function HubLanding({ active, tag, title, accent, lead, inside, cards, note }:
  { active: NavKey; tag: string; title: string; accent: string; lead: string; inside: { label: string; value: string }[]; cards: HubCard[]; note?: string }) {
  const sec = SECTIONS.find(x => x.key === active)!;
  const SecIcon = sec.icon;
  return (
    <AppFrame active={active}>{() => (
      <>
        <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: sec.label }]} />
        <section className="relative isolate overflow-hidden rounded-2xl border bg-card" data-hub={active}>
          <Contours className="absolute -right-10 -top-6 -z-10 hidden w-[28rem] opacity-80 md:block" />
          <Strata className="absolute inset-x-0 bottom-0 -z-10 h-24 w-full md:h-32" />
          <div className="px-6 pb-28 pt-8 md:px-10 md:pb-32 md:pt-12">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand"><SecIcon className="size-4" aria-hidden />{tag}</div>
            <h1 className="mt-3 font-serif text-4xl font-medium tracking-tight md:text-6xl">{title}{accent && <span className="text-brand"> {accent}</span>}</h1>
            <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-muted-foreground md:text-lg">{lead}</p>
          </div>
        </section>
        <dl className="relative z-[1] mx-3 -mt-12 grid divide-y rounded-xl border bg-card shadow-md sm:grid-cols-3 sm:divide-x sm:divide-y-0 md:mx-8" aria-label="At a glance">
          {inside.map(r => (
            <div key={r.label} className="flex flex-col gap-0.5 px-5 py-3">
              <dt className="text-xs text-muted-foreground">{r.label}</dt><dd className="text-sm font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>

        <section className="mt-10" aria-labelledby="h-find">
          <h2 id="h-find" className="mb-4 font-serif text-2xl font-medium">What are you looking for?</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {cards.map((c, i) => {
              const Icon = c.icon;
              const n = cards.length;
              const first = n === 3 && i === 0;   // three cards: one tall card beside two
              const span = n === 3 ? (first ? "lg:col-span-3 lg:row-span-2" : "lg:col-span-3") : n === 5 ? (i < 3 ? "lg:col-span-2" : "lg:col-span-3") : "lg:col-span-2";
              const body = (
                <>
                  <div className="flex items-start justify-between">
                    <span className={cn("lift-ico grid place-items-center rounded-lg bg-accent text-brand", first ? "size-12" : "size-10")}><Icon className={first ? "size-6" : "size-5"} /></span>
                    <span className={cn("rounded-full border px-2 py-0.5 text-xs text-muted-foreground", !c.href && "border-dashed")}>
                      {c.href ? (c.badge ?? (c.needs ? "Sign-in required" : "Open")) : "Planned"}
                    </span>
                  </div>
                  <h3 className={cn("font-semibold", first ? "mt-6 font-serif text-2xl font-medium" : "mt-3 text-base")}>{c.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{c.desc}</p>
                  {c.href && <span className="mt-auto inline-flex items-center gap-1.5 pt-3 text-sm font-medium text-link">{c.needs && <LockKeyhole className="size-3.5" aria-hidden />}Open<ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>}
                </>
              );
              return c.href
                ? <a key={c.title} href={c.href} className={cn("lift group flex flex-col gap-1.5 rounded-xl border bg-card p-5 shadow-sm hover:border-[var(--info-border)]", span)} data-card={c.title}>{body}</a>
                : <div key={c.title} className={cn("flex flex-col gap-1.5 rounded-xl border border-dashed bg-muted/40 p-5", span)} aria-disabled data-card={c.title}>{body}</div>;
            })}
          </div>
          {note && <p className="mt-6 max-w-[62ch] text-xs text-muted-foreground">{note}</p>}
        </section>
      </>
    )}</AppFrame>
  );
}

function AccessRows({ access, need }: { access: Access; need: Need }) {
  const list = usableProjects(PROJECTS, access, need);
  return (
    <Card className="gap-2 p-4" data-access>
      <h2 className="text-base font-semibold">Your access</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {list.map((p: { id: string; name: string; role: string | null }) => (
          <li key={p.id} className="flex h-10 items-center gap-2 rounded-md border bg-card px-3 text-sm" data-project={p.id}>
            <span className="font-medium">{p.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{p.role ? ROLE_LABEL[p.role as keyof typeof ROLE_LABEL] : "Connected"}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * A page behind the login. Signed out it goes to /login/?next=…; signed in without a qualifying account it says
 * "You don't have access to this page"; otherwise it shows the person's access and what the page will contain.
 */
export function GatedPage({ active, parent, title, lead, need, tag = "Planned", will, action }:
  { active: NavKey; parent: { label: string; href: string }; title: string; lead: string; need: Need; tag?: string; will: string[]; action?: { label: string; href: string } }) {
  const sec = SECTIONS.find(x => x.key === active)!;
  const Icon = sec.items.find(i => i.label === title)?.icon ?? sec.icon;
  return (
    <AppFrame active={active} gate={need} backHref={parent.href} backLabel={`Back to ${parent.label}`}>{access => (
      <>
        <Breadcrumb className="mb-4" items={[{ label: "Home", href: "/" }, { label: parent.label, href: parent.href }, { label: title }]} />
        <header className="relative isolate mb-6 overflow-hidden rounded-2xl border bg-card px-6 pb-14 pt-6 md:px-8">
          <Strata className="absolute inset-x-0 bottom-0 -z-10 h-12 w-full" />
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-brand"><Icon className="size-6" aria-hidden /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><h1 className="font-serif text-3xl font-medium tracking-tight">{title}</h1>
                <span className="rounded-full border border-[var(--info-border)] bg-[var(--info-bg)] px-2.5 py-0.5 text-xs font-medium text-info">{tag}</span></div>
              <p className="mt-1 max-w-[56ch] text-sm text-muted-foreground">{lead}</p>
            </div>
          </div>
        </header>
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <AccessRows access={access!} need={need} />
          <Card className="gap-3 p-5" data-will>
            <h2 className="text-base font-semibold">What this page will show</h2>
            <ol className="flex flex-col gap-2.5">{will.map((w, i) => (
              <li key={w} className="flex gap-3 text-sm"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent font-mono text-xs text-brand">{i + 1}</span><span className="pt-0.5 text-muted-foreground">{w}</span></li>
            ))}</ol>
            {action && <a href={action.href} className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-link">{action.label}<ArrowRight className="size-4" aria-hidden /></a>}
          </Card>
        </div>
      </>
    )}</AppFrame>
  );
}
