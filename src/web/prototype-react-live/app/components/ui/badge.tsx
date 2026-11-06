import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3", {
  variants: {
    tone: {
      neutral: "border-border bg-muted text-muted-foreground",
      ok: "border-ok/30 bg-ok/10 text-ok",
      warn: "border-warn/40 bg-warn/15 text-warn",
      bad: "border-bad/30 bg-bad/10 text-bad",
      info: "border-info/30 bg-info/10 text-info",
      outline: "border-border text-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
