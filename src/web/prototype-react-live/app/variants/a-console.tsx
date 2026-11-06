import { useState, type ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Bot, ChevronRight, Clock, Coins, Factory, Moon, Sun, Wrench, MessageSquare, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { AgentCard, LiveRun } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { clock, duration, ROLE_LABEL, silence, STATE_LABEL, stateTone, target, tokens, totalTokens } from "../format";
import { cn } from "../lib/utils";
import { LiveIndicator, NAV, VLink, useActiveAgents, useLiveData, useNavActive, useTheme } from "../shared";

export const name = "Consola con tarjetas";

export function Shell({ children }: { children: ReactNode }) {
  const [theme, toggle] = useTheme("light", "A");
  const active = useNavActive();
  const agents = useActiveAgents();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Factory className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">factory web</div>
            <div className="text-[11px] text-muted-foreground">askwell</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) =>
            item.path === null ? (
              <span key={item.label} className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground/50" title="Fuera del prototipo">
                <item.icon className="size-4" />
                {item.label}
              </span>
            ) : (
              <VLink
                key={item.label}
                to={item.path}
                className={cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-accent", active(item) && "bg-accent font-medium text-foreground")}
              >
                <item.icon className="size-4" />
                {item.label}
                {item.label === "Live" && agents > 0 && <Badge tone="info" className="ml-auto">{agents}</Badge>}
              </VLink>
            ),
          )}
        </nav>
        <div className="mt-auto flex items-center justify-between border-t px-4 py-3">
          <LiveIndicator />
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="Tema">
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-6 pb-24">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

function Events({ card }: { card: AgentCard }) {
  return (
    <ol className="max-h-64 space-y-0.5 overflow-auto font-mono text-[11px]">
      {card.events.map((event, index) => (
        <li key={index} className="flex gap-2">
          <span className="shrink-0 text-muted-foreground">{clock(event.at)}</span>
          <span className={cn("truncate", event.kind === "message" && "italic text-muted-foreground")}>{event.text}</span>
        </li>
      ))}
    </ol>
  );
}

function AgentTile({ card }: { card: AgentCard }) {
  const [open, setOpen] = useState(false);
  const tone = stateTone(card);
  const quiet = silence(card);
  return (
    <Card className={cn("flex flex-col border-t-4", tone === "bad" ? "border-t-bad" : tone === "warn" ? "border-t-warn" : "border-t-info")}>
      <div className="flex items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Bot className="size-3.5 text-muted-foreground" />
            {ROLE_LABEL[card.role]}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {card.agent} · {card.model}
          </div>
          <div className="mt-1.5 truncate text-sm font-semibold" title={card.step}>
            {card.step}
          </div>
        </div>
        <Badge tone={tone}>{STATE_LABEL[card.state]}</Badge>
      </div>
      <div className="space-y-1 px-4 py-3">
        <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{card.lastTool ?? "sin herramientas todavía"}</span>
        </div>
        {card.lastMessage && (
          <div className="flex items-center gap-2 px-2 text-xs italic text-muted-foreground">
            <MessageSquare className="size-3.5 shrink-0" />
            <span className="truncate">{card.lastMessage}</span>
          </div>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3.5" />
          {duration(card.elapsedMs)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Coins className="size-3.5" />
          {tokens(totalTokens(card))} tok
        </span>
        <span>intento {card.attempt}</span>
        {quiet && (
          <span className={cn("inline-flex items-center gap-1 font-medium", card.state === "abandoned" ? "text-bad" : "text-warn")}>
            <AlertTriangle className="size-3.5" />
            {quiet}
          </span>
        )}
        <button className="ml-auto cursor-pointer text-primary hover:underline" onClick={() => setOpen((v) => !v)}>
          {open ? "ocultar" : `últimos ${card.events.length} eventos`}
        </button>
      </div>
      {open && (
        <div className="border-t px-4 py-2">
          <Events card={card} />
        </div>
      )}
    </Card>
  );
}

function FinishedRow({ card }: { card: AgentCard }) {
  const ok = card.outcome === "completed";
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm">
      {ok ? <CheckCircle2 className="size-4 text-ok" /> : <XCircle className="size-4 text-bad" />}
      <span className="w-40 text-muted-foreground">{ROLE_LABEL[card.role]}</span>
      <span className="font-medium">{target(card)}</span>
      <span className="text-muted-foreground">intento {card.attempt}</span>
      <Badge tone={ok ? "ok" : "bad"}>{card.outcome}</Badge>
      <span className="ml-auto text-xs text-muted-foreground">
        {duration(card.elapsedMs)} · {tokens(totalTokens(card))} tok
      </span>
    </div>
  );
}

export function Live({ runs, scope }: { runs: LiveRun[]; scope: "global" | "run" }) {
  const { data } = useLiveData();
  return (
    <div className="space-y-6">
      {scope === "global" && (
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold">Live</h1>
            <p className="text-sm text-muted-foreground">Cada agente que trabaja ahora, en todos los runs.</p>
          </div>
          <LiveIndicator />
        </div>
      )}
      {data !== null && runs.length === 0 && <p className="text-sm text-muted-foreground">Ningún agente trabaja ahora.</p>}
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
                <span className="text-sm text-muted-foreground">{run.step}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{run.runId}</span>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {active.map((card) => (
                <AgentTile key={card.id} card={card} />
              ))}
            </div>
            {finished.length > 0 && (
              <Collapsible.Root defaultOpen>
                <Card className="divide-y">
                  {finished.map((card) => (
                    <FinishedRow key={card.id} card={card} />
                  ))}
                </Card>
              </Collapsible.Root>
            )}
          </section>
        );
      })}
    </div>
  );
}
