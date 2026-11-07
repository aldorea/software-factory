import type { ReactNode } from "react";
import { Card } from "./ui/card.tsx";

export function Section({ title, id, level = 2, children }: { title: string; id?: string; level?: 2 | 3; children: ReactNode }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <Card role="region" id={id} aria-label={title} className="space-y-2 p-4 text-sm">
      <Heading className="text-base font-semibold">{title}</Heading>
      {children}
    </Card>
  );
}
