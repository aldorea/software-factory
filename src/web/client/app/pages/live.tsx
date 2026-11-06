import { Link } from "react-router";
import { AlertTriangle, Bot, Clock, Coins, MessageSquare, Wrench } from "lucide-react";
import { Badge, type Tone } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import type { AgentState, LiveAgent, LiveRole, LiveRun } from "../api.ts";
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

function name(agent: LiveAgent): string {
  const target = agent.criterion ?? agent.subtask;
  return `${ROLE_LABEL[agent.role]}${target === null ? "" : ` ${target}`} · attempt ${agent.attempt}`;
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

function AgentCard({ agent }: { agent: LiveAgent }) {
  return (
    <Card role="article" aria-label={name(agent)} className={cn("flex flex-col border-t-4", EDGE[agent.state])}>
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

function EndedRow({ agent }: { agent: LiveAgent }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
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

function RunAgents({ run }: { run: LiveRun }) {
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
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {active.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
      {ended.length > 0 && (
        <Card>
          <ul aria-label="Agentes que terminaron" className="divide-y">
            {ended.map((agent) => (
              <EndedRow key={agent.id} agent={agent} />
            ))}
          </ul>
        </Card>
      )}
    </section>
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
        data.runs.map((run) => <RunAgents key={run.runId} run={run} />)
      )}
    </div>
  );
}
