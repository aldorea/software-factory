import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Badge } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import { ActionLink, ActionStateBadge } from "../components/action-panel.tsx";
import { CriterionGroups } from "../components/criterion-groups.tsx";
import { OfflineNotice } from "../components/offline-notice.tsx";
import { Section } from "../components/section.tsx";
import { cn } from "../cn.ts";
import {
  usePoll,
  type AttemptView,
  type CheckView,
  type CriterionView,
  type EvidenceFileView,
  type GateView,
  type NextStep,
  type RunCause,
  type RunStep,
  type LiveResponse,
  type Polled,
  type RunDetail,
  type SubtaskView,
  type TesterView,
  type VerificationView,
  type WebActionsList,
} from "../api.ts";
import { relativeTime } from "../format.ts";
import { runStatusTone, stepStateTone, subtaskStateTone, succeededTone } from "../tones.ts";
import { LiveAgents } from "./live.tsx";
import { NotFound } from "./notices.tsx";

const TABS = [
  { id: "summary", label: "Resumen" },
  { id: "steps", label: "Pasos" },
  { id: "verification", label: "Verificación y evidencia" },
  { id: "subtasks", label: "Subtareas" },
  { id: "activity", label: "Actividad" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const FULL_OUTPUT = "Salida completa";

function ResultBadge({ succeeded, children }: { succeeded: boolean | null; children: ReactNode }) {
  return <Badge tone={succeededTone(succeeded)}>{children}</Badge>;
}

function Verdict({ passed }: { passed: boolean }) {
  return <ResultBadge succeeded={passed}>{passed ? "pasa" : "falla"}</ResultBadge>;
}

function FileLink({ url, label }: { url: string | null; label: string }) {
  if (url === null) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {label}
    </a>
  );
}

function ExternalLink({ url, text }: { url: string | null; text: string }) {
  if (url === null) return <>{text}</>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {text}
    </a>
  );
}

function Group({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <div id={id} className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function Items({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="list-disc space-y-1 pl-5">
      {children}
    </ul>
  );
}

function names(values: readonly string[]): string {
  return values.length === 0 ? "ninguno" : values.join(", ");
}

function Output({ output }: { output: string | null }) {
  if (output === null) return null;
  return <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{output}</pre>;
}

function EvidenceFiles({ files }: { files: readonly EvidenceFileView[] }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-3">
      {files.map((file) => {
        if (file.media === "image") return <img key={file.url} src={file.url} alt={file.name} className="max-h-96 max-w-full rounded-md border" />;
        if (file.media === "video") return <video key={file.url} src={file.url} controls aria-label={file.name} className="max-h-96 max-w-full rounded-md border" />;
        return <FileLink key={file.url} url={file.url} label={file.name} />;
      })}
    </div>
  );
}

function Checks({ checks, anchor }: { checks: readonly CheckView[]; anchor?: string }) {
  if (checks.length === 0) return null;
  return (
    <Group title="Checks">
      <Items>
        {checks.map((check, index) => (
          <li key={index} id={anchor === undefined ? undefined : `${anchor}-${check.name}`}>
            {check.name}: <Verdict passed={check.passed} />
            {check.firstError === null ? "" : ` (${check.firstError})`} <FileLink url={check.outputUrl} label={FULL_OUTPUT} />
            {!check.passed && (
              <p className="text-xs text-muted-foreground">
                <code>{check.command}</code> · exit code {check.exitCode}
              </p>
            )}
            <Output output={check.output} />
          </li>
        ))}
      </Items>
    </Group>
  );
}

function Criteria({ criteria, anchor }: { criteria: readonly CriterionView[]; anchor?: string }) {
  if (criteria.length === 0) return null;
  return (
    <Group title="Criterios con evidencia">
      <Items>
        {criteria.map((criterion, index) => (
          <li key={index} id={anchor === undefined ? undefined : `${anchor}-${criterion.id}`}>
            {criterion.id}: <Verdict passed={criterion.passed} /> <FileLink url={criterion.outputUrl} label={FULL_OUTPUT} />
            <Output output={criterion.output} />
            <EvidenceFiles files={criterion.files} />
          </li>
        ))}
      </Items>
    </Group>
  );
}

function Header({ run }: { run: RunDetail }) {
  return (
    <section aria-label="Run" className="space-y-2">
      <h1 className="text-xl font-semibold">
        #{run.issue} <span className="font-mono">{run.runId}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          Resultado:{" "}
          <Badge tone={runStatusTone(run.status)}>
            {run.status === "running" && <Loader2 className="animate-spin" />}
            {run.status}
          </Badge>
        </span>
        <span>Último cambio: {relativeTime(run.modifiedAt, run.now)}</span>
      </div>
    </section>
  );
}

function Links({ run }: { run: RunDetail }) {
  if (run.pullRequest === null && run.evidenceBranch === null) return null;
  return (
    <div className="space-y-1 text-sm">
      {run.pullRequest !== null && (
        <p>
          Pull request: <ExternalLink url={run.pullRequest.url} text={`#${run.pullRequest.number}`} />
          {run.pullRequest.draft ? " (draft)" : ""}
        </p>
      )}
      {run.evidenceBranch !== null && (
        <p>
          Evidence branch: <ExternalLink url={run.evidenceBranch.url} text={run.evidenceBranch.branch} />
        </p>
      )}
    </div>
  );
}

function useRunActivity(runId: string): Polled<LiveResponse> {
  return usePoll<LiveResponse>(`/api/runs/${encodeURIComponent(runId)}/activity`);
}

function CurrentStep({ runId }: { runId: string }) {
  const { data } = useRunActivity(runId);
  return (
    <Section title="Paso actual">
      <p>{data?.runs[0]?.step ?? "Cargando…"}</p>
      <Link to={{ search: "?tab=activity" }} className="text-primary hover:underline">
        Ver la actividad
      </Link>
    </Section>
  );
}

function Activity({ runId }: { runId: string }) {
  const { data } = useRunActivity(runId);
  const run = data?.runs[0];
  if (run === undefined) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  if (run.agents.length === 0) return <p className="text-sm text-muted-foreground">Ningún agente de este run ha empezado todavía.</p>;
  return <LiveAgents runs={[run]} />;
}

function NextStepLine({ next }: { next: NextStep | null }) {
  if (next === null) return null;
  if (next.kind === "command") {
    return (
      <p className="flex items-center gap-2">
        Siguiente paso:
        <ActionLink command={next.command} issue={next.issue}>
          <code>{next.text}</code>
        </ActionLink>
      </p>
    );
  }
  return <p>Siguiente paso: {next.text}</p>;
}

function Causes({ causes }: { causes: readonly RunCause[] }) {
  if (causes.length === 0) return null;
  return (
    <Section title="Causas">
      <ol className="space-y-3">
        {causes.map((cause, index) => (
          <li key={index} className="space-y-1">
            <p className="font-medium">{`${cause.where}: ${cause.what}`}</p>
            {cause.detail !== null && <p className="text-muted-foreground">{cause.detail}</p>}
            <NextStepLine next={cause.next} />
            {cause.evidence !== null && (
              <Link to={{ search: `?tab=${cause.evidence.tab}`, hash: cause.evidence.anchor }} className="text-primary hover:underline">
                Ver la evidencia
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Summary({ run }: { run: RunDetail }) {
  const { agents, criteria, publicationFailure, pause, block } = run;
  return (
    <div className="space-y-4">
      <Causes causes={run.causes} />
      <Links run={run} />
      {run.inProgress && <CurrentStep runId={run.runId} />}
      {publicationFailure !== null && (
        <Section title="Sin publicar">
          <p>Fase: {publicationFailure.phase}</p>
          <p>Motivo: {publicationFailure.message}</p>
          <p>Hora: {publicationFailure.at}</p>
          <p>
            Para publicar de nuevo: <code>{publicationFailure.command}</code>
          </p>
        </Section>
      )}
      {pause !== null && (
        <Section title="Pausado">
          <p>Motivo: {pause.reason ?? "desconocido"}</p>
          <p>Reset del plan limit: {pause.resetsAt ?? "desconocido"}</p>
        </Section>
      )}
      {block !== null && (
        <Section title="Bloqueo del run" id="run-block">
          <p>Tipo: {block.type}</p>
          <p>Motivo: {block.reason}</p>
          <p>Commit: {block.sha}</p>
          {block.files.length > 0 && (
            <Items>
              {block.files.map((file, index) => (
                <li key={index}>{file}</li>
              ))}
            </Items>
          )}
          <Checks checks={block.checks} />
        </Section>
      )}
      <Section title="Agentes">
        <Items>
          {agents.roles.map((role) => (
            <li key={role.role}>
              {role.role}: {role.agent} / {role.model}
            </li>
          ))}
        </Items>
        {agents.changes.length > 0 && (
          <Group title="Cambios de agente">
            <Items>
              {agents.changes.map((change, index) => (
                <li key={index}>
                  {`${change.role}: ${change.from.agent} / ${change.from.model} → ${change.to.agent} / ${change.to.model} (${change.at})`}
                </li>
              ))}
            </Items>
          </Group>
        )}
      </Section>
      <CriterionGroups criteria={criteria}>
        {(groups) => (
          <div className="grid gap-3 sm:grid-cols-4">
            {groups.map(([title, ids]) => (
              <Group key={title} title={title}>
                <Items label={title}>{ids.length === 0 ? <li>Ninguno</li> : ids.map((id, index) => <li key={index}>{id}</li>)}</Items>
              </Group>
            ))}
          </div>
        )}
      </CriterionGroups>
    </div>
  );
}

function Attempt({ attempt }: { attempt: AttemptView }) {
  return (
    <li className="list-none rounded-md bg-muted/60 px-3 py-2">
      <p>
        Intento {attempt.number}: {attempt.agent} / {attempt.model}
      </p>
      <p>
        Resultado: <ResultBadge succeeded={attempt.succeeded}>{attempt.outcome}</ResultBadge>
      </p>
      {attempt.detail !== null && <p>Detalle: {attempt.detail}</p>}
      {attempt.failure !== null && <p>Fallo: {attempt.failure}</p>}
      <p>Tokens: {attempt.tokens}</p>
      <p>Inicio: {attempt.startedAt}</p>
      {attempt.endedAt !== null && <p>Fin: {attempt.endedAt}</p>}
    </li>
  );
}

function Gate({ gate }: { gate: GateView }) {
  return (
    <div className="space-y-2">
      <h4 className="font-medium">
        Gate {gate.sha}: <ResultBadge succeeded={gate.accepted}>{gate.accepted ? "aceptado" : "rechazado"}</ResultBadge>
      </h4>
      {gate.reasons.length > 0 && (
        <Items>
          {gate.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </Items>
      )}
      <Checks checks={gate.checks} />
      <Criteria criteria={gate.criteria} />
      {gate.verifier.length > 0 && (
        <Group title="Independent verifier">
          <Items>
            {gate.verifier.map((record, index) => (
              <li key={index}>
                {record.id}: <ResultBadge succeeded={record.accepted}>{record.verdict}</ResultBadge>
                {record.reason === null ? "" : ` (${record.reason})`}
              </li>
            ))}
          </Items>
        </Group>
      )}
    </div>
  );
}

function Subtask({ subtask }: { subtask: SubtaskView }) {
  return (
    <details id={`subtask-${subtask.id}`} open={subtask.state !== "merged"}>
      <summary className="cursor-pointer font-mono text-sm font-semibold">{`${subtask.id} · ${subtask.state}`}</summary>
      <Card role="region" aria-label={subtask.id} className="mt-2 space-y-2 p-4 text-sm">
        <h3 className="font-mono text-base font-semibold">{subtask.id}</h3>
        <p>
          Estado: <Badge tone={subtaskStateTone(subtask.state)}>{subtask.state}</Badge>
        </p>
        <p>Criterios: {names(subtask.criteria)}</p>
        <p>Branch: {subtask.branch}</p>
        <p>Scope extensions: {names(subtask.scopeExtensions)}</p>
        {subtask.block !== null && (
          <>
            {subtask.block.type !== null && <p>Bloqueo: {subtask.block.type}</p>}
            {subtask.block.reason !== null && <p>Motivo: {subtask.block.reason}</p>}
            {subtask.block.lastFailure !== null && <p>Último fallo: {subtask.block.lastFailure}</p>}
          </>
        )}
        {subtask.attempts.length > 0 && (
          <Group title="Intentos">
            <ul className="space-y-2">
              {subtask.attempts.map((attempt, index) => (
                <Attempt key={index} attempt={attempt} />
              ))}
            </ul>
          </Group>
        )}
        <p>{subtask.gateRejections} rechazos del gate</p>
        <p>{subtask.verifierRejections} rechazos del independent verifier</p>
        {subtask.gate !== null && <Gate gate={subtask.gate} />}
        {subtask.followUps.length > 0 && (
          <Group title="Follow-up tasks">
            <Items>
              {subtask.followUps.map((followUp, index) => (
                <li key={index}>
                  <p>Follow-up ronda {followUp.round}</p>
                  <p>Criterios: {names(followUp.criteria)}</p>
                  <p>Fallo: {followUp.failure}</p>
                  <p>Resultado: {followUp.outcome}</p>
                </li>
              ))}
            </Items>
          </Group>
        )}
      </Card>
    </details>
  );
}

function Subtasks({ subtasks }: { subtasks: readonly SubtaskView[] }) {
  if (subtasks.length === 0) return <p className="text-sm text-muted-foreground">Sin subtareas</p>;
  return (
    <div className="space-y-4">
      {subtasks.map((subtask, index) => (
        <Subtask key={index} subtask={subtask} />
      ))}
    </div>
  );
}

function Tester({ tester }: { tester: TesterView }) {
  return (
    <Group title="Acceptance tester" id="tester">
      <p>
        Agente: {tester.agent} / {tester.model}
      </p>
      {tester.error !== null && <p>Error: {tester.error}</p>}
      <Checks checks={tester.checks} />
      {tester.verdicts.length > 0 && (
        <Items>
          {tester.verdicts.map((testerVerdict, index) => (
            <li key={index} id={`tester-verdict-${testerVerdict.id}`}>
              {testerVerdict.id}: <Verdict passed={testerVerdict.passed} />{" "}
              {`(${testerVerdict.observation})${testerVerdict.evidence.length === 0 ? "" : ` [${testerVerdict.evidence.join(", ")}]`}`}
              <EvidenceFiles files={testerVerdict.files} />
            </li>
          ))}
        </Items>
      )}
    </Group>
  );
}

function Verification({ verification }: { verification: VerificationView | null }) {
  if (verification === null) {
    return (
      <Section title="Integrated verification">
        <p className="text-muted-foreground">Todavía sin integrated verification</p>
      </Section>
    );
  }
  return (
    <Section title="Integrated verification" id="verification">
      <p>SHA: {verification.sha}</p>
      <p>
        Resultado: <Verdict passed={verification.passed} />
      </p>
      {verification.environment !== null && <p>Entorno: {verification.environment}</p>}
      <Checks checks={verification.checks} anchor="verification-check" />
      <Criteria criteria={verification.criteria} anchor="verification-criterion" />
      {verification.humanCriteria.length > 0 && (
        <Group title="Criterios human" id="human-criteria">
          <Items>
            {verification.humanCriteria.map((criterion, index) => (
              <li key={index}>
                {`${criterion.id}: ${criterion.reason}${criterion.attachments.length === 0 ? "" : ` (${criterion.attachments.join(", ")})`}`}
                <EvidenceFiles files={criterion.files} />
              </li>
            ))}
          </Items>
        </Group>
      )}
      {verification.tester !== null && <Tester tester={verification.tester} />}
    </Section>
  );
}

function stepTitle(step: RunStep): string {
  if (step.kind === "subtask") return `Subtarea ${step.id}`;
  if (step.kind === "integrated-verification") return "Integrated verification";
  if (step.kind === "acceptance-tester") return "Acceptance tester";
  return "Publicación";
}

function stepDetail(step: RunStep): string | null {
  if (step.kind === "subtask") {
    const gate = step.gate === null ? "" : ` · gate ${step.gate === "accepted" ? "aceptado" : "rechazado"}`;
    return `${step.mergedEarlier ? "Fusionada por un run anterior · " : ""}${step.attempts} intentos${gate}`;
  }
  if (step.kind === "integrated-verification") return `checks ${step.checks.passed}/${step.checks.total} · criterios ${step.criteria.passed}/${step.criteria.total}`;
  if (step.kind === "acceptance-tester") {
    if (step.phase !== null) return `fase ${step.phase}`;
    return step.error ?? `veredictos ${step.verdicts.passed}/${step.verdicts.total}`;
  }
  if (step.failure !== null) return step.failure;
  return step.pullRequest === null ? null : `PR #${step.pullRequest.number}${step.pullRequest.draft ? " (draft)" : ""}`;
}

function Steps({ steps }: { steps: readonly RunStep[] }) {
  return (
    <ol aria-label="Pasos del run" className="space-y-2 text-sm">
      {steps.map((step) => (
        <li key={step.anchor} id={step.anchor} className="rounded-md border px-3 py-2">
          <p className="flex items-center gap-2 font-medium">
            {stepTitle(step)} <Badge tone={stepStateTone(step.state)}>{step.state}</Badge>
          </p>
          {stepDetail(step) !== null && <p className="text-muted-foreground">{stepDetail(step)}</p>}
        </li>
      ))}
    </ol>
  );
}

function TabContent({ tab, run }: { tab: TabId; run: RunDetail }) {
  if (tab === "summary") return <Summary run={run} />;
  if (tab === "steps") return <Steps steps={run.steps} />;
  if (tab === "verification") return <Verification verification={run.verification} />;
  if (tab === "subtasks") return <Subtasks subtasks={run.subtasks} />;
  if (tab === "activity") return <Activity runId={run.runId} />;
  return null;
}

function Tabs({ run }: { run: RunDetail }) {
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.find((candidate) => candidate.id === params.get("tab"))?.id ?? "summary";
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Pestañas del run" className="flex gap-1 border-b">
        {TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            id={`tab-${candidate.id}`}
            aria-selected={candidate.id === tab}
            aria-controls="run-tabpanel"
            onClick={() => setParams({ tab: candidate.id })}
            className={cn(
              "-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
              candidate.id === tab && "border-primary font-medium text-foreground",
            )}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="run-tabpanel" aria-labelledby={`tab-${tab}`}>
        <TabContent tab={tab} run={run} />
      </div>
    </div>
  );
}

function IssueActions({ issue }: { issue: number }) {
  const { data } = usePoll<WebActionsList>("/api/actions");
  const last = data?.actions.find((action) => action.issue === issue);
  return (
    <div role="region" aria-label="Acciones web" className="flex flex-wrap items-center gap-2">
      {(["run", "approve", "validate", "publish"] as const).map((command) => (
        <ActionLink key={command} command={command} issue={issue}>
          {`factory ${command} ${issue}`}
        </ActionLink>
      ))}
      {last !== undefined && (
        <Link to={{ search: `?action=${encodeURIComponent(last.id)}` }} className="ml-auto inline-flex items-center gap-2 text-sm text-primary hover:underline">
          Última acción web: <span className="font-mono text-xs">{last.command}</span>
          <ActionStateBadge action={last} />
        </Link>
      )}
    </div>
  );
}

export function RunPage() {
  const { runId = "" } = useParams();
  const { data, failed, missing } = usePoll<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
  if (missing) return <NotFound />;
  return (
    <div className="space-y-6">
      {failed && <OfflineNotice />}
      {data === null ? (
        !failed && <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <Header run={data} />
          <IssueActions issue={data.issue} />
          <Tabs run={data} />
        </>
      )}
    </div>
  );
}
