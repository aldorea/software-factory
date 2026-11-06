import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border bg-card text-card-foreground shadow-xs", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 px-4 pt-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("font-semibold leading-tight", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center border-t px-4 py-2", className)} {...props} />;
}
