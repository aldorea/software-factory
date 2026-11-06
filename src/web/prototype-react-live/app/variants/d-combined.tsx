import { useSearchParams } from "react-router";
import { X } from "lucide-react";
import type { LiveRun } from "../api";
import { Card } from "../components/ui/card";
import { cn } from "../lib/utils";
import { LiveIndicator, VLink, useLiveData } from "../shared";
import { AgentTile, FinishedRow, Shell } from "./a-console";
import { Detail } from "./c-focus";

export const name = "A + C: tarjetas y detalle";
export { Shell };

export function Live({ runs, scope }: { runs: LiveRun[]; scope: "global" | "run" }) {
  const { data } = useLiveData();
  const [params, setParams] = useSearchParams();
  const all = runs.flatMap((run) => run.cards.map((card) => ({ card, run })));
  const selectedId = params.get("agent");
  const selected = all.find((item) => item.card.id === selectedId);
  const setAgent = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id === null) next.delete("agent");
    else next.set("agent", id);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-6">
      {scope === "global" && (
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold">Live</h1>
            <p className="text-sm text-muted-foreground">Cada agente que trabaja ahora, en todos los runs. Haz clic en una tarjeta para ver su detalle.</p>
          </div>
          <LiveIndicator />
        </div>
      )}
      {data !== null && runs.length === 0 && <p className="text-sm text-muted-foreground">Ningún agente trabaja ahora.</p>}
      <div className={cn("grid gap-6", selected && "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]")}>
        <div className="min-w-0 space-y-6">
          {runs.map((run) => {
            const active = run.cards.filter((card) => card.state !== "finished");
            const finished = run.cards.filter((card) => card.state === "finished");
            return (
              <section key={run.runId} className="space-y-3">
                {scope === "global" && (
                  <div className="flex items-baseline gap-3">
                    <VLink to={`/runs/${run.runId}?tab=activity`} className="font-semibold hover:underline">
                      #{run.issue} {run.title}
                    </VLink>
                    <span className="truncate text-sm text-muted-foreground">{run.step}</span>
                  </div>
                )}
                <div className={cn("grid gap-3", selected ? "grid-cols-1 2xl:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3")}>
                  {active.map((card) => (
                    <AgentTile key={card.id} card={card} selected={card.id === selected?.card.id} onSelect={() => setAgent(card.id === selected?.card.id ? null : card.id)} />
                  ))}
                </div>
                {finished.length > 0 && (
                  <Card className="divide-y">
                    {finished.map((card) => (
                      <button key={card.id} className={cn("block w-full cursor-pointer text-left hover:bg-accent/50", card.id === selected?.card.id && "bg-accent")} onClick={() => setAgent(card.id)}>
                        <FinishedRow card={card} />
                      </button>
                    ))}
                  </Card>
                )}
              </section>
            );
          })}
        </div>
        {selected && (
          <aside className="min-w-0 xl:sticky xl:top-6 xl:self-start">
            <Card className="relative max-h-[calc(100vh-3rem)] overflow-auto p-5">
              <button className="absolute right-3 top-3 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-accent" onClick={() => setAgent(null)} aria-label="Cerrar detalle">
                <X className="size-4" />
              </button>
              <Detail card={selected.card} run={selected.run} />
            </Card>
          </aside>
        )}
      </div>
    </div>
  );
}
