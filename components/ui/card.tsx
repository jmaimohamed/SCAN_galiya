import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border-2 border-border bg-card text-card-foreground", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-lg font-bold leading-tight", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-2", className)} {...props} />;
}

export function Badge({ className, tone = "neutral", ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "ok" | "nok" | "warn" | "neutral" | "info" }) {
  const tones = {
    ok: "bg-ok text-white",
    nok: "bg-nok text-white",
    warn: "bg-warn text-black",
    info: "bg-primary text-primary-foreground",
    neutral: "bg-muted text-foreground border border-border",
  } as const;
  return <span className={cn("inline-flex items-center rounded px-2 py-0.5 text-sm font-bold", tones[tone], className)} {...props} />;
}
