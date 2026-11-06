import { Link, useSearchParams } from "react-router";
import { AlertTriangle, Bot, Clock, Coins, Flag, MessageSquare, Wrench, X } from "lucide-react";
import { Badge, type Tone } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import type { AgentState, LiveAgent, LiveEvent, LiveRole, LiveRun } from "../api.ts";
import { cn } from "../cn.ts";
import { duration } from "../format.ts";
import { useLive } from "../live-data.tsx";

const ROLE_LABEL: Record<LiveRole, string> = {
  worker: "Worker",
  "independent-verifier": "Independent verifier",
  "acceptance-tester": "Acceptance tester",
};

const STATE_TONE: Record<AgentState, Tone> = {
  working: "info",
  silent: "warn",
  abandoned: "bad",
  ended: "neutral",
};

const EDGE: Record<AgentState, string> = {
  working: "border-t-info",
  silent: "border-t-warn",
  abandoned: "border-t-bad",
  ended: "border-t-border",
};

function who(agent: LiveAgent): string {
  const target = agent.criterion ?? agent.subtask;
  return `${ROLE_LABEL[agent.role]}${target === null ? "" : ` ${target}`}`;
}

function name(agent: LiveAgent): string {
  return `${who(agent)} · attempt ${agent.attempt}`;
}

function heading(agent: LiveAgent): string {
  if (agent.criterion !== null) return `Criterion ${agent.criterion}${agent.subtask === null ? "" : ` · Subtask ${agent.subtask}`}`;
  return agent.subtask === null ? agent.step : `Subtask ${agent.subtask} · ${agent.step}`;
}

const GOOD_OUTCOMES = new Set(["completed", "accept", "passed"]);

function tokens(agent: LiveAgent): string {
  return agent.tokens === null ? "—" : `${agent.tokens.input} in · ${agent.tokens.output} out`;
}

function silence(agent: LiveAgent): string {
  const left = agent.abandonAfterMs - agent.silentMs;
  return `Sin actividad ${duration(agent.silentMs)} · ${left > 0 ? `abandonado en ${duration(left)}` : "abandonado"}`;
}

function AgentCard({ agent, selected, onSelect }: { agent: LiveAgent; selected: boolean; onSelect: () => void }) {
  return (
    <Card
      role="article"
      aria-label={name(agent)}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn("flex cursor-pointer flex-col border-t-4 hover:bg-accent/40", EDGE[agent.state], selected && "ring-2 ring-primary")}
    >
      <div className="flex items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Bot className="size-3.5 text-muted-foreground" />
            {ROLE_LABEL[agent.role]}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {agent.agent} · {agent.model}
          </div>
          <div className="mt-1.5 truncate text-sm font-semibold">
            {heading(agent)}
          </div>
        </div>
        <Badge tone={STATE_TONE[agent.state]}>{agent.state}</Badge>
      </div>
      <div className="space-y-1 px-4 py-3">
        <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate" title={agent.lastTool ?? undefined}>
            {agent.lastTool ?? "ningún tool todavía"}
          </span>
        </div>
        {agent.lastMessage !== null && (
          <div className="flex items-center gap-2 px-2 text-xs italic text-muted-foreground">
            <MessageSquare className="size-3.5 shrink-0" />
            <span className="truncate" title={agent.lastMessage}>
              {agent.lastMessage}
            </span>
          </div>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3.5" />
          Tiempo {duration(agent.elapsedMs)}
        </span>
        <span>Attempt {agent.attempt}</span>
        <span className="inline-flex items-center gap-1">
          <Coins className="size-3.5" />
          Tokens {tokens(agent)}
        </span>
        <span className={cn("inline-flex items-center gap-1", agent.state === "abandoned" ? "text-bad" : agent.state === "silent" && "text-warn")}>
          <AlertTriangle className="size-3.5" />
          {silence(agent)}
        </span>
      </div>
    </Card>
  );
}

function EndedRow({ agent, selected, onSelect }: { agent: LiveAgent; selected: boolean; onSelect: () => void }) {
  return (
    <li
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn("flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm hover:bg-accent/50", selected && "bg-accent")}
    >
      <span className="font-medium">{name(agent)}</span>
      <span className="font-mono text-[11px] text-muted-foreground">
        {agent.agent} · {agent.model}
      </span>
      <Badge tone={agent.outcome !== null && GOOD_OUTCOMES.has(agent.outcome) ? "ok" : "bad"}>{agent.outcome}</Badge>
      <span className="ml-auto text-xs text-muted-foreground">
        {duration(agent.elapsedMs)} · {tokens(agent)}
      </span>
    </li>
  );
}

interface Selection {
  selected: string | null;
  toggle: (id: string) => void;
}

function RunAgents({ run, selection }: { run: LiveRun; selection: Selection }) {
  const active = run.agents.filter((agent) => agent.state !== "ended");
  const ended = run.agents.filter((agent) => agent.state === "ended");
  return (
    <section aria-label={`Run #${run.issue}`} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-semibold">
          #{run.issue} {run.title}
        </h2>
        <span className="text-sm text-muted-foreground">{run.step}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{run.runId}</span>
      </div>
      {active.length > 0 && (
        <div className={cn("grid gap-3", selection.selected === null ? "md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1")}>
          {active.map((agent) => (
            <AgentCard key={agent.id} agent={agent} selected={agent.id === selection.selected} onSelect={() => selection.toggle(agent.id)} />
          ))}
        </div>
      )}
      {ended.length > 0 && (
        <Card>
          <ul aria-label="Agentes que terminaron" className="divide-y">
            {ended.map((agent) => (
              <EndedRow key={agent.id} agent={agent} selected={agent.id === selection.selected} onSelect={() => selection.toggle(agent.id)} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

const EVENT_ICON: Record<LiveEvent["kind"], typeof Wrench> = { tool: Wrench, message: MessageSquare, end: Flag };

function clock(at: string): string {
  return new Date(at).toLocaleTimeString("es-ES", { hour12: false });
}

function SilenceBar({ agent }: { agent: LiveAgent }) {
  const ratio = Math.min(1, agent.silentMs / agent.abandonAfterMs);
  return (
    <div>
      <div className="mb-1 flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{silence(agent)}</span>
        <span>umbral de abandono {duration(agent.abandonAfterMs)}</span>
      </div>
      <div
        role="meter"
        aria-label="Silencio hacia el abandono"
        aria-valuemin={0}
        aria-valuenow={agent.silentMs}
        aria-valuemax={agent.abandonAfterMs}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full", ratio >= 1 ? "bg-bad" : agent.state === "silent" ? "bg-warn" : "bg-ok")} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
      </div>
    </div>
  );
}

function AgentDetail({ agent, run, onClose }: { agent: LiveAgent; run: LiveRun; onClose: () => void }) {
  const ended = agent.state === "ended";
  return (
    <aside aria-label="Detalle del agente" className="min-w-0 xl:sticky xl:top-6 xl:self-start">
      <Card className="relative max-h-[calc(100vh-3rem)] space-y-5 overflow-auto p-5">
        <button type="button" onClick={onClose} aria-label="Cerrar detalle" className="absolute right-3 top-3 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-accent">
          <X className="size-4" />
        </button>
        <div className="pr-8">
          <div className="text-sm text-muted-foreground">
            #{run.issue} {run.title} › {who(agent)}
          </div>
          <div className="mt-1 flex items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">{agent.step}</h2>
            <Badge tone={ended ? (agent.outcome !== null && GOOD_OUTCOMES.has(agent.outcome) ? "ok" : "bad") : STATE_TONE[agent.state]}>{ended ? agent.outcome : agent.state}</Badge>
          </div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {agent.agent} · {agent.model} · attempt {agent.attempt}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Figure label="Tiempo" value={duration(agent.elapsedMs)} />
          <Figure label="Tokens entrada" value={agent.tokens === null ? "—" : String(agent.tokens.input)} />
          <Figure label="Tokens salida" value={agent.tokens === null ? "—" : String(agent.tokens.output)} />
          <Figure label="Silencio" value={ended ? "—" : duration(agent.silentMs)} tone={agent.state === "abandoned" ? "text-bad" : agent.state === "silent" ? "text-warn" : ""} />
        </div>
        {!ended && <SilenceBar agent={agent} />}
        <div className="rounded-lg border">
          <div className="border-b px-4 py-2 text-sm font-medium">Últimos {agent.events.length} eventos</div>
          {agent.events.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Ningún evento todavía.</p>
          ) : (
            <ol aria-label="Últimos eventos" className="space-y-2 px-4 py-3">
              {agent.events.toReversed().map((event, index) => {
                const Icon = EVENT_ICON[event.kind];
                return (
                  <li key={`${event.at}-${agent.events.length - index}`} className="flex items-start gap-3">
                    <time dateTime={event.at} className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">
                      {clock(event.at)}
                    </time>{" "}
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className={cn("min-w-0 break-words text-sm", event.kind === "tool" ? "font-mono text-xs" : "italic text-muted-foreground")}>{event.text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </Card>
    </aside>
  );
}

function useSelection(): Selection {
  const [params, setParams] = useSearchParams();
  const selected = params.get("agent");
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id === null) next.delete("agent");
    else next.set("agent", id);
    setParams(next, { replace: true });
  };
  return { selected, toggle: (id) => select(id === selected ? null : id) };
}

export function LiveAgents({ runs }: { runs: readonly LiveRun[] }) {
  const selection = useSelection();
  const found = runs.flatMap((run) => run.agents.map((agent) => ({ agent, run }))).find(({ agent }) => agent.id === selection.selected);
  const shown: Selection = { selected: found === undefined ? null : found.agent.id, toggle: selection.toggle };
  return (
    <div className={cn("grid gap-6", found !== undefined && "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]")}>
      <div className="min-w-0 space-y-6">
        {runs.map((run) => (
          <RunAgents key={run.runId} run={run} selection={shown} />
        ))}
      </div>
      {found !== undefined && <AgentDetail agent={found.agent} run={found.run} onClose={() => selection.toggle(found.agent.id)} />}
    </div>
  );
}

export function LivePage() {
  const { data, failed } = useLive();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Live</h1>
        <p className="text-sm text-muted-foreground">Cada agente que trabaja ahora, en todos los runs.</p>
      </div>
      {failed && (
        <p role="status" className="rounded-md border border-warn/40 bg-warn/15 px-3 py-2 text-sm text-warn">
          Sin conexión con factory web; se vuelve a intentar cada 2 s.
        </p>
      )}
      {data === null ? (
        !failed && <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <span>Ningún agente trabaja ahora.</span>{" "}
          <Link to="/" className="text-primary hover:underline">
            Ver los runs
          </Link>
        </p>
      ) : (
        <LiveAgents runs={data.runs} />
      )}
    </div>
  );
}
