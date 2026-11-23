"use client";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { caretAfter } from "@/lib/opd/masks.js";

type Props = Omit<React.ComponentProps<"input">, "onChange" | "value"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Text in, cleaned text out. See src/lib/opd/masks.js. */
  mask: (value: string) => string;
};

/**
 * An input that cleans what the person types (and pastes) with a mask, so the rule is visible while typing.
 * The caret stays after the characters the person just typed when the mask removes or changes some.
 * Pair it with a placeholder that shows the format and `inputMode` for the right phone keyboard.
 */
export function MaskedInput({ value, onValueChange, mask, ...rest }: Props) {
  const ref = React.useRef<HTMLInputElement>(null);
  const caret = React.useRef<number | null>(null);
  const [, bump] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current != null && el && document.activeElement === el) { try { el.setSelectionRange(caret.current, caret.current); } catch { /* some input types have no caret */ } }
    caret.current = null;
  });
  return (
    <Input
      ref={ref}
      {...rest}
      value={value}
      onChange={e => {
        const raw = e.target.value;
        const masked = mask(raw);
        if (masked !== raw) {
          caret.current = caretAfter(raw, e.target.selectionStart, mask);
          // A dropped character leaves the value as it was, so React would not render again and the
          // caret would stay where the browser put it. Force one render to put it back.
          if (masked === value) bump(n => n + 1);
        }
        onValueChange(masked);
      }}
    />
  );
}
