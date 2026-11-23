"use client";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Site choice as big cards, not a dropdown: a wrong site means data lands in the wrong database,
 * so the choice has to be seen. Native radios underneath, so arrow keys and screen readers work.
 */
export function SitePicker({ sites, value, onChange, legend, hint, name = "site", disabled, connected, id = "l-site", cols = 4 }:
  { sites: string[]; value: string; onChange: (s: string) => void; legend: string; hint?: string; name?: string; disabled?: boolean; connected?: (s: string) => boolean; id?: string; cols?: number }) {
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2" id={id} data-site-picker>
      <legend className="text-sm font-semibold">{legend}</legend>
      {hint && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, maxWidth: `${cols * 7}rem` }}>
        {sites.map(s => {
          const on = s === value;
          const live = connected ? connected(s) : true;
          return (
            <label key={s} className={cn("relative flex min-h-12 cursor-pointer flex-col items-center justify-center rounded-lg border-2 px-1 py-2 text-center transition-colors",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--ring)]",
              on ? "border-primary bg-accent text-foreground" : "border-border bg-card text-muted-foreground hover:border-[var(--input)]",
              disabled && "cursor-not-allowed opacity-60")}>
              <input type="radio" name={name} value={s} checked={on} onChange={() => onChange(s)} className="sr-only" data-site={s} />
              <span className="font-mono text-sm font-semibold">{s}</span>
              {!live && <span className="text-[.625rem] leading-none">no server</span>}
              {on && <Check className="absolute right-1 top-1 size-3.5 text-brand" aria-hidden />}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
