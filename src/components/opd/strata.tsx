import { cn } from "@/lib/utils";

/**
 * The laterite profile drawn as a landscape: five soil bands under a few contour lines.
 * Decorative only. Colours come from the --strata-* tokens, so it follows light and dark.
 */
export function Strata({ className }: { className?: string }) {
  const bands = [
    { d: "M0 70 C150 40 260 100 420 72 S720 30 880 66 1070 96 1200 60 V160 H0Z", c: "var(--strata-5)", o: 0.55 },
    { d: "M0 92 C170 66 290 120 450 96 S740 62 900 92 1080 118 1200 88 V160 H0Z", c: "var(--strata-4)", o: 0.5 },
    { d: "M0 114 C160 94 300 138 470 118 S760 94 920 116 1090 138 1200 112 V160 H0Z", c: "var(--strata-3)", o: 0.5 },
    { d: "M0 134 C180 120 320 152 500 138 S780 120 940 138 1100 154 1200 134 V160 H0Z", c: "var(--strata-2)", o: 0.55 },
    { d: "M0 150 C200 142 340 160 520 152 S800 142 960 152 1110 160 1200 150 V160 H0Z", c: "var(--strata-1)", o: 0.7 },
  ];
  return (
    <svg viewBox="0 0 1200 160" preserveAspectRatio="none" aria-hidden focusable="false" className={cn("pointer-events-none", className)}>
      {bands.map((b, i) => <path key={i} d={b.d} fill={b.c} fillOpacity={b.o} />)}
    </svg>
  );
}

/** Thin topographic lines for the corner of a hero. */
export function Contours({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 300" aria-hidden focusable="false" className={cn("pointer-events-none text-[var(--border)]", className)} fill="none" stroke="currentColor" strokeWidth="1.25">
      {[0, 1, 2, 3, 4, 5, 6].map(i => (
        <path key={i} d={`M${40 + i * 22} 300 C${60 + i * 20} ${230 - i * 12} ${150 + i * 14} ${210 - i * 18} ${220 + i * 12} ${150 - i * 14} S${330 + i * 6} ${90 - i * 10} 400 ${40 - i * 6}`} />
      ))}
    </svg>
  );
}
