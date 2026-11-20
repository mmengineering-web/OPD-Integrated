import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; href?: string };

/** Home > Portal > Exploration. The last item is the current page and is not a link. */
export function Breadcrumb({ items, tone = "default", className }: { items: Crumb[]; tone?: "default" | "light"; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className={cn("flex flex-wrap items-center gap-1 text-sm", tone === "light" ? "text-[#fff6ee]/80" : "text-muted-foreground")}>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={c.label} className="flex items-center gap-1">
              {c.href && !last
                ? <a href={c.href} className={cn("inline-flex min-h-8 items-center rounded-sm px-1 underline-offset-4 hover:underline", tone === "light" ? "hover:text-white" : "hover:text-foreground")}>{c.label}</a>
                : <span aria-current={last ? "page" : undefined} className={cn("px-1 font-medium", tone === "light" ? "text-white" : "text-foreground")}>{c.label}</span>}
              {!last && <ChevronRight className="size-3.5 opacity-60" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
