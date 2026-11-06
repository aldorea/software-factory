import type { ReactNode } from "react";
import type { RunDetail } from "../api.ts";
import { Section } from "./section.tsx";

type Groups<T> = Record<keyof RunDetail["criteria"], T>;

export function CriterionGroups<T>({
  criteria,
  level = 2,
  children,
}: {
  criteria: Groups<T>;
  level?: 2 | 3;
  children: (groups: ReadonlyArray<readonly [string, T]>) => ReactNode;
}) {
  return (
    <Section title="Criterios" level={level}>
      {children([
        ["Pasan", criteria.passing],
        ["Bloqueados", criteria.blocked],
        ["Human", criteria.human],
        ["Pendientes", criteria.pending],
      ])}
    </Section>
  );
}
