import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Factory, Moon, Sun, Wrench, MessageSquare, Flag } from "lucide-react";
import type { AgentCard, LiveRun } from "../api";
import { Badge } from "../components/ui/badge";
import { Tip } from "../components/ui/tooltip";
import { clock, duration, minutes, ROLE_LABEL, ROLE_SHORT, silence, STATE_LABEL, stateTone, target, tokens } from "../format";
import { cn } from "../lib/utils";
import { LiveIndicator, NAV, VLink, useActiveAgents, useNavActive, useTheme } from "../shared";

export const name = "Foco: lista + detalle";

export function Shell({ children }: { children: ReactNode }) {
  const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const [theme, toggle] = useTheme(prefersDark ? "dark" : "light", "C");
  const active = useNavActive();
  const agents = useActiveAgents();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-3">
        <div className="mb-3 grid size-9 place-items-center rounded-lg bg-foreground text-background">
          <Factory className="size-4" />
        </div>
        {NAV.map((item) => (
          <Tip key={item.label} label={item.path === null ? `${item.label} (fuera del prototipo)` : item.label}>
            {item.path === null ? (
              <span className="relative grid size-10 place-items-center rounded-lg text-muted-foreground/40">
                <item.icon className="size-5" />
              </span>
            ) : (
              <VLink to={item.path} className={cn("relative grid size-10 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground", active(item) && "bg-accent text-foreground")}>
                <item.icon className="size-5" />
                {item.label === "Live" && agents > 0 && <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-info text-[9px] font-bold text-white">{agents}</span>}
              </VLink>
            )}
          </Tip>
        ))}
        <button className="mt-auto grid size-10 cursor-pointer place-items-center rounded-lg text-muted-foreground hover:bg-accent" onClick={toggle} aria-label="Tema">
          {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
        </button>
      </aside>
      <main className="min-w-0 flex-1 px-6 py-5 pb-24">{children}</main>
    </div>
  );
}

const DOT: Record<AgentCard["state"], string> = { working: "bg-info", silent: "bg-warn", abandoned: "bg-bad", finished: "bg-ok" };

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

export function Detail({ card, run }: { card: AgentCard; run: LiveRun }) {
  const quiet = silence(card);
  const ratio = Math.min(1, card.silentMs / card.abandonAfterMs);
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <VLink to={`/runs/${run.runId}?tab=activity`} className="hover:underline">
            #{run.issue} {run.title}
          </VLink>
          <span>›</span>
          <span>{ROLE_LABEL[card.role]}</span>
        </div>
        <div className="mt-1 flex items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">{card.step}</h2>
          <Badge tone={stateTone(card)}>{card.state === "finished" ? card.outcome : STATE_LABEL[card.state]}</Badge>
        </div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">
          {card.agent} · {card.model} · intento {card.attempt}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Tiempo" value={duration(card.elapsedMs)} />
        <Kpi label="Tokens entrada" value={tokens(card.tokens.input)} />
        <Kpi label="Tokens salida" value={tokens(card.tokens.output)} />
        <Kpi label="Silencio" value={card.state === "finished" ? "—" : card.silentMs < 60_000 ? `${Math.round(card.silentMs / 1000)}s` : minutes(card.silentMs)} tone={card.state === "abandoned" ? "text-bad" : card.state === "silent" ? "text-warn" : ""} />
      </div>
      {card.state !== "finished" && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{quiet ?? "activo"}</span>
            <span>umbral de abandono {minutes(card.abandonAfterMs)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full", ratio >= 1 ? "bg-bad" : ratio > 0.1 ? "bg-warn" : "bg-ok")} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
          </div>
        </div>
      )}
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-2 text-sm font-medium">Activity · últimos {card.events.length} eventos</div>
        <ol className="relative px-4 py-3">
          {[...card.events].reverse().map((event, index) => (
            <li key={index} className={cn("relative flex gap-3 pb-2.5 pl-6", index === 0 && "font-medium")}>
              <span className="absolute left-[7px] top-4 bottom-0 w-px bg-border" />
              <span className="absolute left-0 top-0.5 grid size-4 place-items-center rounded-full border bg-card">
                {event.kind === "tool" ? <Wrench className="size-2.5" /> : event.kind === "message" ? <MessageSquare className="size-2.5" /> : <Flag className="size-2.5" />}
              </span>
              <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">{clock(event.at)}</span>
              <span className={cn("min-w-0 truncate text-sm", event.kind === "tool" ? "font-mono text-xs" : "italic text-muted-foreground")}>{event.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function Live({ runs, scope }: { runs: LiveRun[]; scope: "global" | "run" }) {
  const [params, setParams] = useSearchParams();
  const all = runs.flatMap((run) => run.cards.map((card) => ({ card, run })));
  const selectedId = params.get("agent");
  const selected = all.find((item) => item.card.id === selectedId) ?? all.find((item) => item.card.state !== "finished") ?? all[0];
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("agent", id);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-3">
      {scope === "global" && (
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">Live</h1>
          <LiveIndicator />
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4 lg:sticky lg:top-5 lg:self-start">
          {runs.map((run) => (
            <div key={run.runId}>
              {scope === "global" && (
                <div className="mb-1 px-2">
                  <div className="truncate text-xs font-semibold">
                    #{run.issue} {run.title}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">{run.step}</div>
                </div>
              )}
              <div className="space-y-0.5">
                {run.cards.map((card) => (
                  <button
                    key={card.id}
                    onClick={() => select(card.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      selected?.card.id === card.id && "bg-accent ring-1 ring-border",
                      card.state === "finished" && "opacity-60",
                    )}
                  >
                    <span className={cn("size-2 shrink-0 rounded-full", DOT[card.state], card.state === "working" && "animate-pulse")} />
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">{ROLE_SHORT[card.role]}</span>
                    <span className="min-w-0 flex-1 truncate">{target(card)}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{card.state === "finished" ? card.outcome : duration(card.elapsedMs)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="min-w-0">{selected ? <Detail card={selected.card} run={selected.run} /> : <p className="text-sm text-muted-foreground">Ningún agente trabaja ahora.</p>}</div>
      </div>
    </div>
  );
}
