import { cn } from "@/lib/utils";

/** Loading placeholder with a soft shimmer. Stops under reduced motion. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden data-slot="skeleton" className={cn("skeleton rounded-md", className)} {...props} />;
}
