import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[var(--control-h)] w-full min-w-0 rounded-xl border border-[color:var(--neu-edge)] bg-card [box-shadow:var(--neu-in-sm)] px-3 text-base text-foreground transition-[box-shadow,border-color] outline-none placeholder:text-muted-foreground read-only:border-dashed read-only:bg-muted read-only:tabular-nums focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-[var(--control-h)] w-full min-w-0 rounded-xl border border-[color:var(--neu-edge)] bg-card [box-shadow:var(--neu-in-sm)] px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
        className,
      )}
      {...props}
    />
  );
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-16 w-full rounded-xl border border-[color:var(--neu-edge)] bg-card [box-shadow:var(--neu-in-sm)] px-3 py-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
        className,
      )}
      {...props}
    />
  );
}

export { Input, Select, Textarea };
