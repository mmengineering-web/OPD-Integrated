"use client";
import { useEffect, useMemo, useState } from "react";
import { wipeTo } from "@/lib/opd/wipe.js";
import { LockKeyhole, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { PROJECTS } from "@/lib/opd/config.js";
import { canOpen } from "@/lib/opd/auth-core.js";
import { SECTIONS, type Need } from "@/lib/opd/sitemap";

type Access = { projects: Record<string, unknown> } & Record<string, unknown>;
type Entry = { label: string; href: string; icon: React.ComponentType<{ className?: string }>; need?: Need; aka?: string; section: string };

/**
 * "Search pages": type to narrow the list, or scroll it. Opens with the button or Ctrl/Cmd + K.
 * Reads the same sitemap as the sidebar, so a new page appears here with no extra work.
 * A lock shows pages the person's accounts cannot open; choosing one still goes there and explains why.
 */
export function PageSearch({ access }: { access: Access | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(o => !o); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  const groups = useMemo(() => {
    const general: Entry[] = [];
    const out: { label: string; items: Entry[] }[] = [];
    for (const sec of SECTIONS) {
      // Home and Help have no sub-pages: they sit under one "General" heading.
      if (!sec.items.length) { general.push({ label: sec.label, href: sec.href, icon: sec.icon, aka: sec.aka, section: "General" }); continue; }
      out.push({ label: sec.label, items: sec.items.map(i => ({
        label: i.label === "Overview" ? `${sec.label} overview` : i.label, href: i.href, icon: i.icon, need: i.need,
        aka: `${i.aka ?? ""} ${i.label === "Overview" ? sec.aka ?? "" : ""}`.trim(), section: sec.label,
      })) });
    }
    return [{ label: "General", items: general }, ...out];
  }, []);

  const go = (href: string) => { setOpen(false); wipeTo(href); };

  return (
    <>
      <Button variant="ghost" size="sm" id="b-search" onClick={() => setOpen(true)} aria-label="Search pages" aria-keyshortcuts="Control+K Meta+K" className="gap-2 text-muted-foreground">
        <Search aria-hidden /><span className="max-md:hidden">Search pages</span>
        <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[.6875rem] text-muted-foreground lg:inline" aria-hidden>Ctrl K</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search pages">
        <CommandInput placeholder="Type a page name, or scroll the list" aria-label="Search pages" id="ps-input" />
        <CommandList id="ps-list">
          <CommandEmpty>No page matches that. Try a shorter word.</CommandEmpty>
          {groups.map(g => (
            <CommandGroup key={g.label} heading={g.label}>
              {g.items.map(it => {
                const Icon = it.icon;
                const locked = !!it.need && (!access || !canOpen(PROJECTS, access, it.need));
                return (
                  <CommandItem key={it.href} value={`${it.label} ${it.section} ${it.aka ?? ""}`} onSelect={() => go(it.href)} data-page-item={it.href}>
                    <Icon aria-hidden /><span className="flex-1 truncate">{it.label}</span>
                    {locked && <span className="flex items-center gap-1 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden />{access ? "No access" : "Sign in"}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}
