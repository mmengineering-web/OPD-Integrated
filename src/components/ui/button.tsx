import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[transform,background,box-shadow,color] duration-[160ms] ease-[var(--ease-out-strong)] outline-none select-none disabled:pointer-events-none disabled:opacity-50 active:scale-[.97] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground [box-shadow:var(--neu-out-sm)] hover:[box-shadow:var(--neu-out)] active:[box-shadow:var(--neu-in-sm)] active:brightness-95",
        outline: "bg-card text-foreground [box-shadow:var(--neu-out-sm)] hover:[box-shadow:var(--neu-out)] active:[box-shadow:var(--neu-in-sm)]",
        secondary: "bg-card text-secondary-foreground [box-shadow:var(--neu-out-xs)] hover:[box-shadow:var(--neu-out-sm)] active:[box-shadow:var(--neu-in-sm)]",
        ghost: "text-foreground hover:[box-shadow:var(--neu-out-xs)] active:[box-shadow:var(--neu-in-sm)]",
        destructive: "bg-destructive text-destructive-foreground [box-shadow:var(--neu-out-sm)] active:[box-shadow:var(--neu-in-sm)]",
      },
      size: {
        default: "h-[var(--control-h)] px-4",
        sm: "h-[var(--control-h-sm)] px-3",
        lg: "h-[var(--control-h-lg)] px-6 text-base",
        icon: "size-[var(--control-h)]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className, variant, size, asChild = false, ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
