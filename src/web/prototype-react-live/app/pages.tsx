import { useState, type ComponentType } from "react";
import { useParams, useSearchParams } from "react-router";
import * as Collapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, CheckCircle2, ChevronRight, Circle, CircleDashed, CircleX, ExternalLink, GitPullRequest, Loader2, Terminal } from "lucide-react";
import { useRun, useRuns, type LiveRun, type RunRow } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { duration, RUN_LABEL, runTone, since, tokens } from "./format";
import { VLink, useLiveData, filterRun } from "./shared";
import { cn } from "./lib/utils";

export type LiveView = ComponentType<{ runs: LiveRun[]; scope: "global" | "run" }>;

export function RunStatus({ status }: { status: string }) {
  return (
    <Badge tone={runTone(status)}>
      {status === "running" && <Loader2 className="animate-spin" />}
      {RUN_LABEL[status] ?? status}
    </Badge>
  );
}

type Filter = "all" | "running" | "attention" | "ready";
const needsAttention = (row: RunRow) => row.status === "draft" || row.status === "paused" || row.status === "abandoned";

export function RunsPage({ dense = false }: { dense?: boolean }) {
  const { data } = useRuns();
  const [filter, setFilter] = useState<Filter>("all");
  if (data === null) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  const rows = data.rows.filter((row) => filter === "all" || (filter === "running" ? row.status === "running" : filter === "ready" ? row.status === "ready" : needsAttention(row)));
  const counters: { key: Filter; label: string; count: number; tone: string }[] = [
    { key: "running", label: "En curso", count: data.rows.filter((row) => row.status === "running").length, tone: "text-info" },
    { key: "attention", label: "Necesitan atención", count: data.rows.filter(needsAttention).length, tone: "text-warn" },
    { key: "ready", label: "Ready", count: data.rows.filter((row) => row.status === "ready").length, tone: "text-ok" },
  ];
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Runs</h1>
          <p className="text-sm text-muted-foreground">
            {data.stats.runs} runs · {tokens(data.stats.cost.countedTokens)} tokens contados · {data.stats.cost.attempts} intentos
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {counters.map((counter) => (
          <button
            key={counter.key}
            onClick={() => setFilter(filter === counter.key ? "all" : counter.key)}
            className={cn("cursor-pointer rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent", filter === counter.key && "ring-2 ring-ring")}
          >
            <div className={cn("text-2xl font-semibold tabular-nums", counter.tone)}>{counter.count}</div>
            <div className="text-xs text-muted-foreground">{counter.label}</div>
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Estado</th>
              <th className="px-4 py-2 font-medium">Issue</th>
              <th className="px-4 py-2 font-medium">Causa o paso actual</th>
              <th className="px-4 py-2 font-medium">Último cambio</th>
              <th className="px-4 py-2 font-medium">PR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.runId} className="border-t hover:bg-accent/50">
                <td className={cn("px-4", dense ? "py-1.5" : "py-3")}>
                  <RunStatus status={row.status} />
                </td>
                <td className={cn("px-4", dense ? "py-1.5" : "py-3")}>
                  <VLink to={`/runs/${row.runId}`} className="font-medium hover:underline">
                    #{row.issue} {row.title}
                  </VLink>
                  <div className="font-mono text-[11px] text-muted-foreground">{row.runId}</div>
                </td>
                <td className={cn("px-4 text-muted-foreground", dense ? "py-1.5" : "py-3")}>
                  {row.live > 0 && <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-info align-middle" />}
                  {row.line}
                </td>
                <td className="px-4 text-muted-foreground">{since(row.lastChange)}</td>
                <td className="px-4">
                  {row.pullRequest ? (
                    <a href={row.pullRequest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <GitPullRequest className="size-3.5" />#{row.pullRequest.number}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

const STEP_ICON = {
  passed: <CheckCircle2 className="size-4 text-ok" />,
  failed: <CircleX className="size-4 text-bad" />,
  running: <Loader2 className="size-4 animate-spin text-info" />,
  pending: <Circle className="size-4 text-muted-foreground" />,
  "not-run": <CircleDashed className="size-4 text-muted-foreground/60" />,
};

export function RunPage({ Live }: { Live: LiveView }) {
  const { runId = "" } = useParams();
  const { data } = useRun(runId);
  const live = useLiveData();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "summary";
  if (data === null) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  const { row, log, causes, steps } = data;
  const liveRuns = filterRun(live.data?.runs ?? [], runId);
  const activeCount = liveRuns.flatMap((run) => run.cards).filter((card) => card.state !== "finished").length;
  const failedSteps = steps.filter((step) => step.state === "failed").length;
  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", value);
    setParams(next, { replace: true });
  };
  const commands = row.status === "running" ? [] : row.status === "ready" ? [`factory approve ${row.issue}`] : [`factory run ${row.issue}`, `factory publish ${row.issue}`];
  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        <VLink to="/" className="hover:underline">
          Runs
        </VLink>{" "}
        / <span className="font-mono">{row.runId}</span>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">
              #{row.issue} {row.title}
            </h1>
            <RunStatus status={row.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {row.line} · empezó {since(row.startedAt)} · {duration(log.cost.wallClockMs)} de reloj · {tokens(row.tokens)} tokens
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {row.status === "running" && (
            <Button variant="outline" size="sm" disabled title="Stop: SIGINT al grupo de procesos de la web action">
              Stop
            </Button>
          )}
          {commands.map((command) => (
            <Button key={command} variant="outline" size="sm" className="font-mono" disabled title="Web action (fuera del prototipo)">
              <Terminal />
              {command}
            </Button>
          ))}
          {row.pullRequest && (
            <Button asChild size="sm">
              <a href={row.pullRequest.url} target="_blank" rel="noreferrer">
                <GitPullRequest /> PR #{row.pullRequest.number} <ExternalLink />
              </a>
            </Button>
          )}
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="summary">Resumen</TabsTrigger>
          <TabsTrigger value="steps">
            Pasos {failedSteps > 0 && <Badge tone="bad">{failedSteps}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="subtasks">Subtasks</TabsTrigger>
          <TabsTrigger value="activity">
            Activity {activeCount > 0 && <Badge tone="info">{activeCount}</Badge>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Causas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {causes.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {row.status === "running" ? (
                    <>
                      El run trabaja: {row.line}. Mira la pestaña{" "}
                      <button className="cursor-pointer text-primary hover:underline" onClick={() => setTab("activity")}>
                        Activity
                      </button>
                      .
                    </>
                  ) : (
                    "Ninguna: todos los criterios pasan."
                  )}
                </p>
              )}
              {causes.map((cause, index) => (
                <div key={index} className={cn("rounded-md border-l-4 bg-muted/40 p-3", cause.tone === "bad" ? "border-l-bad" : cause.tone === "warn" ? "border-l-warn" : "border-l-info")}>
                  <div className="flex items-center gap-2 text-sm">
                    <AlertTriangle className={cn("size-4", cause.tone === "bad" ? "text-bad" : cause.tone === "warn" ? "text-warn" : "text-info")} />
                    <b>{cause.where}</b> <span>{cause.what}</span>
                  </div>
                  {cause.detail && <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{cause.detail}</p>}
                  {cause.next && (
                    <p className="mt-2 text-xs">
                      Siguiente paso: <code className="rounded bg-muted px-1.5 py-0.5">{cause.next}</code>
                    </p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Criterios</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {log.criteria.passing.map((id) => (
                  <Badge key={id} tone="ok">{id}</Badge>
                ))}
                {log.criteria.blocked.map((id) => (
                  <Badge key={id} tone="bad">{id}</Badge>
                ))}
                {log.criteria.pending.map((id) => (
                  <Badge key={id}>{id}</Badge>
                ))}
                {log.criteria.human.map((id) => (
                  <Badge key={id} tone="outline">{id} · humano</Badge>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Agentes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {(["workers", "verifier", "tester"] as const).map((role) => (
                  <div key={role} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{role}</span>
                    <span className="truncate font-mono text-xs">
                      {log.agents[role]?.agent ?? "—"} · {log.agents[role]?.model ?? ""}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="steps">
          <Card>
            <ol className="divide-y">
              {steps.map((step) => (
                <li key={step.name} className="flex items-center gap-3 px-4 py-3 text-sm">
                  {STEP_ICON[step.state]}
                  <span className="w-56 font-medium">{step.name}</span>
                  <span className="text-muted-foreground">{step.detail}</span>
                </li>
              ))}
            </ol>
          </Card>
        </TabsContent>
        <TabsContent value="subtasks" className="space-y-2">
          {log.subtasks.map((subtask) => (
            <Collapsible.Root key={subtask.id} defaultOpen={subtask.state !== "merged"} className="rounded-lg border bg-card">
              <Collapsible.Trigger className="group flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm">
                <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
                <b>{subtask.id}</b>
                <Badge tone={subtask.state === "merged" ? "ok" : subtask.state === "blocked" ? "bad" : "neutral"}>{subtask.state}</Badge>
                <span className="text-muted-foreground">criterios {subtask.criteria.join(", ")}</span>
              </Collapsible.Trigger>
              <Collapsible.Content className="border-t px-4 py-3 text-sm">
                {subtask.reason && <p className="mb-2 text-muted-foreground">{subtask.reason}</p>}
                <table className="w-full text-xs">
                  <tbody>
                    {subtask.attempts.map((attempt) => (
                      <tr key={attempt.number} className="border-t first:border-0">
                        <td className="py-1.5 pr-3">intento {attempt.number}</td>
                        <td className="pr-3 font-mono">
                          {attempt.agent.agent} · {attempt.agent.model}
                        </td>
                        <td className="pr-3">
                          <Badge tone={attempt.outcome === "completed" ? "ok" : "bad"}>{attempt.outcome}</Badge>
                        </td>
                        <td className="text-muted-foreground">{attempt.endedAt ? duration(Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt)) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {subtask.gate && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Gate {subtask.gate.accepted ? "aceptada" : "rechazada"}: {subtask.gate.checks.map((check) => `${check.name} ${check.passed ? "✓" : "✗"}`).join(" · ")}
                  </p>
                )}
              </Collapsible.Content>
            </Collapsible.Root>
          ))}
        </TabsContent>
        <TabsContent value="activity">
          {liveRuns.length === 0 ? <p className="text-sm text-muted-foreground">Ningún agente trabaja ahora en este run.</p> : <Live runs={liveRuns} scope="run" />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
