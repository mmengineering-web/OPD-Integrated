import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Spacing that shows what belongs together (proximity): 12px between fields of one group, 24px between groups.
 * A FormStack holds FormGroups; a FormGroup holds the fields that answer one question ("Who is this person?").
 */
export function FormStack({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-6", className)} {...props} />;
}

export function FormGroup({ legend, hint, className, children, ...props }: Omit<React.ComponentProps<"fieldset">, "title"> & { legend?: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-3", className)} {...props}>
      {legend && <legend className="mb-1 text-sm font-semibold">{legend}</legend>}
      {hint && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  );
}

/** A label above a control, with an optional hint under it. The label and its hint stay 6px from the control. */
export function Field({ label, hint, className, children }: { label: React.ReactNode; hint?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5 text-sm font-medium", className)}>
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}
