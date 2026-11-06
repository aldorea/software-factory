import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight, Moon, Sun } from "lucide-react";
import type { AgentCard, LiveRun } from "../api";
import { clock, duration, minutes, ROLE_SHORT, target, tokens, totalTokens } from "../format";
import { cn } from "../lib/utils";
import { LiveIndicator, NAV, VLink, useLiveData, useNavActive, useTheme } from "../shared";

export const name = "Terminal densa";

export function Shell({ children }: { children: ReactNode }) {
  const [theme, toggle] = useTheme("dark", "B");
  const active = useNavActive();
  const { data } = useLiveData();
  const cards = data?.runs.flatMap((run) => run.cards) ?? [];
  const count = (state: AgentCard["state"]) => cards.filter((card) => card.state === state).length;
  return (
    <div className="min-h-screen font-mono text-[13px]">
      <header className="sticky top-0 z-40 flex h-10 items-center gap-6 border-b bg-background/95 px-4 backdrop-blur">
        <span className="font-bold tracking-tight">
          factory<span className="text-primary">:web</span>
        </span>
        <nav className="flex h-full items-stretch gap-1">
          {NAV.map((item) =>
            item.path === null ? (
              <span key={item.label} className="flex items-center px-2 text-muted-foreground/40">
                {item.label.toLowerCase()}
              </span>
            ) : (
              <VLink key={item.label} to={item.path} className={cn("flex items-center border-b-2 border-transparent px-2 hover:text-foreground", active(item) ? "border-primary text-foreground" : "text-muted-foreground")}>
                {item.label.toLowerCase()}
              </VLink>
            ),
          )}
        </nav>
        <div className="ml-auto flex items-center gap-4 text-xs">
          <span className="text-info">{count("working")} working</span>
          <span className="text-warn">{count("silent")} silent</span>
          <span className="text-bad">{count("abandoned")} abandoned</span>
          <span className="text-muted-foreground">{count("finished")} done</span>
          <LiveIndicator />
          <button className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={toggle} aria-label="Tema">
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>
      <main className="px-4 py-4 pb-24 font-sans text-sm">{children}</main>
    </div>
  );
}

const DOT: Record<AgentCard["state"], string> = { working: "bg-info animate-pulse", silent: "bg-warn", abandoned: "bg-bad", finished: "bg-muted-foreground/40" };

function SilenceCell({ card }: { card: AgentCard }) {
  if (card.state === "finished") return <span className={card.outcome === "completed" ? "text-ok" : "text-bad"}>{card.outcome}</span>;
  const ratio = Math.min(1, card.silentMs / card.abandonAfterMs);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className={cn("absolute inset-y-0 left-0", ratio >= 1 ? "bg-bad" : ratio > 0.1 ? "bg-warn" : "bg-ok")} style={{ width: `${Math.max(4, ratio * 100)}%` }} />
      </span>
      <span className={cn(card.state === "abandoned" ? "text-bad" : card.state === "silent" ? "text-warn" : "text-muted-foreground")}>
        {card.silentMs < 60_000 ? `${Math.round(card.silentMs / 1000)}s` : minutes(card.silentMs)}
      </span>
    </span>
  );
}

export function Live({ runs, scope }: { runs: LiveRun[]; scope: "global" | "run" }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="space-y-2">
      {scope === "global" && (
        <div className="flex items-baseline gap-3 font-mono">
          <h1 className="text-base font-semibold">live</h1>
          <span className="text-xs text-muted-foreground">un agente por fila · clic para ver sus últimos 20 eventos · el silencio se mide contra el umbral de abandono</span>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full font-mono text-xs">
          <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-6 px-2 py-1.5" />
              <th className="px-2 py-1.5">rol</th>
              <th className="px-2 py-1.5">agente / modelo</th>
              <th className="px-2 py-1.5">subtask</th>
              <th className="px-2 py-1.5">#</th>
              <th className="px-2 py-1.5">paso</th>
              <th className="px-2 py-1.5">última herramienta</th>
              <th className="px-2 py-1.5 text-right">tiempo</th>
              <th className="px-2 py-1.5 text-right">tokens</th>
              <th className="px-2 py-1.5">silencio</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <Fragment key={run.runId}>
                {scope === "global" && (
                  <tr className="border-t bg-accent/40">
                    <td colSpan={10} className="px-2 py-1">
                      <VLink to={`/runs/${run.runId}?tab=activity`} className="font-semibold hover:underline">
                        #{run.issue} {run.title}
                      </VLink>
                      <span className="ml-3 text-muted-foreground">{run.step}</span>
                      <span className="float-right text-muted-foreground/70">{run.runId}</span>
                    </td>
                  </tr>
                )}
                {run.cards.map((card) => {
                  const done = card.state === "finished";
                  const expanded = open.has(card.id);
                  return (
                    <Fragment key={card.id}>
                      <tr onClick={() => toggle(card.id)} className={cn("cursor-pointer border-t hover:bg-accent/60", done && "text-muted-foreground")}>
                        <td className="px-2 py-1">
                          <span className={cn("inline-block size-2 rounded-full", DOT[card.state])} />
                        </td>
                        <td className="px-2 py-1">{ROLE_SHORT[card.role]}</td>
                        <td className="max-w-48 truncate px-2 py-1">
                          {card.agent}/{card.model.replace("opencode-go/", "")}
                        </td>
                        <td className="px-2 py-1">{target(card)}</td>
                        <td className="px-2 py-1">{card.attempt}</td>
                        <td className="px-2 py-1">{done ? "—" : card.step.split(" · ").at(-1)}</td>
                        <td className="max-w-80 truncate px-2 py-1">
                          {!done && <ChevronRight className={cn("mr-1 inline size-3 transition-transform", expanded && "rotate-90")} />}
                          {done ? "" : (card.lastTool ?? "…")}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{duration(card.elapsedMs)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{tokens(totalTokens(card))}</td>
                        <td className="px-2 py-1">
                          <SilenceCell card={card} />
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-zinc-950 text-zinc-300">
                          <td />
                          <td colSpan={9} className="px-2 py-2">
                            {card.events.map((event, index) => (
                              <div key={index} className="flex gap-3 leading-5">
                                <span className="text-zinc-500">{clock(event.at)}</span>
                                <span className={event.kind === "message" ? "text-zinc-400 italic" : event.kind === "end" ? "text-emerald-400" : ""}>{event.text}</span>
                              </div>
                            ))}
                            <div className="mt-1 text-[10px] text-zinc-600">replay ×{card.replay.speed} de {card.replay.source}</div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
