import type { ComponentProps } from "react";
import { cn } from "../../cn.ts";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border bg-card text-card-foreground shadow-xs", className)} {...props} />;
}
