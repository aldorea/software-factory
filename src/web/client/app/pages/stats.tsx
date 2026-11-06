import type { ReactNode } from "react";
import { Card } from "../components/ui/card.tsx";
import type { RunStats } from "../api.ts";
import { duration } from "../format.ts";

type Rows = ReadonlyArray<readonly [string, ReactNode]>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card aria-label={title} role="region" className="p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {children}
    </Card>
  );
}

function Definitions({ rows }: { rows: Rows }) {
  return (
    <dl className="grid grid-cols-[max-content_auto] gap-x-6 gap-y-1 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function counts(entries: ReadonlyArray<[string, number | undefined]>): string {
  const present = entries.filter(([, count]) => (count ?? 0) > 0).map(([kind, count]) => `${kind} ${count}`);
  return present.length > 0 ? present.join(", ") : "ninguno";
}

function Results({ stats }: { stats: RunStats }) {
  const { results } = stats;
  return (
    <Section title="Resultados">
      <Definitions
        rows={[
          ["Runs", stats.runs],
          ["Ready", results.ready],
          ["Draft", results.draft],
          ["Paused", results.paused],
          ["Running", results.running],
          ["Abandoned", results.abandoned],
          ["Sin publicar", stats.unpublished],
        ]}
      />
    </Section>
  );
}

function Criteria({ stats: { criteria } }: { stats: RunStats }) {
  return (
    <Section title="Criterios">
      <Definitions
        rows={[
          ["Pasan", criteria.passing],
          ["Bloqueados", criteria.blocked],
          ["Human", criteria.human],
          ["Pendientes", criteria.pending],
        ]}
      />
    </Section>
  );
}

function Cost({ stats: { cost } }: { stats: RunStats }) {
  const { perRun, perSubtask } = cost;
  return (
    <Section title="Coste">
      <Definitions
        rows={[
          [
            "Tokens",
            `${cost.countedTokens} (${Math.round(perRun.countedTokens)} por run, ${Math.round(perSubtask.countedTokens)} por subtask, como máximo ${perSubtask.maxCountedTokens} en un subtask)`,
          ],
          ["Attempts", `${cost.attempts} (${perRun.attempts.toFixed(1)} por run, ${perSubtask.attempts.toFixed(1)} por subtask)`],
          ["Wall clock sin pausas", `${duration(cost.wallClockMs)} (${duration(perRun.wallClockMs)} por run)`],
          ["Pausa", duration(cost.pausedMs)],
        ]}
      />
    </Section>
  );
}

function Agents({ stats: { perAgent } }: { stats: RunStats }) {
  return (
    <Section title="Por agente">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Agente</th>
            <th className="py-1 font-medium">Runs</th>
            <th className="py-1 font-medium">Attempts</th>
            <th className="py-1 font-medium">Tokens</th>
            <th className="py-1 font-medium">Pausas</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {Object.entries(perAgent).map(([kind, agent]) => (
            <tr key={kind} className="border-t">
              <td className="py-1 font-mono text-xs">{kind}</td>
              <td className="py-1">{agent.runs}</td>
              <td className="py-1">{agent.attempts}</td>
              <td className="py-1">{agent.countedTokens}</td>
              <td className="py-1">{agent.pauses}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Friction({ stats: { friction } }: { stats: RunStats }) {
  return (
    <Section title="Fricción">
      <Definitions
        rows={[
          ["Bloqueos", counts(Object.entries(friction.blocks))],
          ["Scope extensions", friction.scopeExtensions],
          ["Rechazos del gate", friction.gateRejections],
          ["Rechazos del independent verifier", friction.verifierRejections],
          ["Rechazos del acceptance tester", friction.testerRejections],
          ["Conflictos de integración", friction.integrationConflicts],
        ]}
      />
    </Section>
  );
}

function WorkerLayer({ stats: { workerLayerFailures } }: { stats: RunStats }) {
  return (
    <Section title="Worker layer">
      <Definitions rows={[["Fallos de la worker layer", counts(Object.entries(workerLayerFailures))]]} />
    </Section>
  );
}

export function Statistics({ stats }: { stats: RunStats }) {
  return (
    <section aria-label="Estadísticas" className="space-y-3">
      <h2 className="text-lg font-semibold">Estadísticas</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Results stats={stats} />
        <Criteria stats={stats} />
        <Cost stats={stats} />
        <Agents stats={stats} />
        <Friction stats={stats} />
        <WorkerLayer stats={stats} />
      </div>
    </section>
  );
}
