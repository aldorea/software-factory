import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { Badge } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import { cn } from "../cn.ts";
import {
  usePoll,
  type AttemptView,
  type CheckView,
  type CriterionView,
  type GateView,
  type RunDetail,
  type SubtaskView,
  type TesterView,
  type VerificationView,
} from "../api.ts";
import { relativeTime, STATUS_TONE, toneOf } from "../format.ts";
import { NotFound } from "./notices.tsx";

const TABS = [
  { id: "summary", label: "Resumen" },
  { id: "steps", label: "Pasos" },
  { id: "verification", label: "Verificación y evidencia" },
  { id: "subtasks", label: "Subtareas" },
  { id: "activity", label: "Actividad" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const RAW_LOG = "Log crudo";
const FULL_OUTPUT = "Salida completa";

function verdict(passed: boolean): string {
  return passed ? "pasa" : "falla";
}

function Tone({ value }: { value: string }) {
  return <Badge tone={toneOf(value)}>{value}</Badge>;
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card role="region" aria-label={title} className="space-y-2 p-4 text-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
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

function Checks({ checks }: { checks: readonly CheckView[] }) {
  if (checks.length === 0) return null;
  return (
    <Group title="Checks">
      <Items>
        {checks.map((check, index) => (
          <li key={index}>
            {check.name}: <Tone value={verdict(check.passed)} />
            {check.firstError === null ? "" : ` (${check.firstError})`} <FileLink url={check.outputUrl} label={FULL_OUTPUT} />
          </li>
        ))}
      </Items>
    </Group>
  );
}

function Criteria({ criteria }: { criteria: readonly CriterionView[] }) {
  if (criteria.length === 0) return null;
  return (
    <Group title="Criterios con evidencia">
      <Items>
        {criteria.map((criterion, index) => (
          <li key={index}>
            {criterion.id}: <Tone value={verdict(criterion.passed)} /> <FileLink url={criterion.outputUrl} label={FULL_OUTPUT} />
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
          <Badge tone={STATUS_TONE[run.status]}>
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

function Summary({ run }: { run: RunDetail }) {
  const { publicationFailure, pause, block, agents, criteria } = run;
  return (
    <div className="space-y-4">
      <Links run={run} />
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
        <Section title="Bloqueo del run">
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
      <Section title="Criterios">
        <div className="grid gap-3 sm:grid-cols-4">
          {(
            [
              ["Pasan", criteria.passing],
              ["Bloqueados", criteria.blocked],
              ["Human", criteria.human],
              ["Pendientes", criteria.pending],
            ] as const
          ).map(([title, ids]) => (
            <Group key={title} title={title}>
              <Items label={title}>{ids.length === 0 ? <li>Ninguno</li> : ids.map((id, index) => <li key={index}>{id}</li>)}</Items>
            </Group>
          ))}
        </div>
      </Section>
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
        Resultado: <Tone value={attempt.outcome} />
      </p>
      {attempt.detail !== null && <p>Detalle: {attempt.detail}</p>}
      {attempt.failure !== null && <p>Fallo: {attempt.failure}</p>}
      <p>Tokens: {attempt.tokens}</p>
      <p>Inicio: {attempt.startedAt}</p>
      {attempt.endedAt !== null && <p>Fin: {attempt.endedAt}</p>}
      <FileLink url={attempt.logUrl} label={RAW_LOG} />
    </li>
  );
}

function Gate({ gate }: { gate: GateView }) {
  return (
    <div className="space-y-2">
      <h4 className="font-medium">
        Gate {gate.sha}: <Tone value={gate.accepted ? "aceptado" : "rechazado"} />
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
                {record.id}: <Tone value={record.verdict} />
                {record.reason === null ? "" : ` (${record.reason})`} <FileLink url={record.logUrl} label={RAW_LOG} />
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
    <Card role="region" aria-label={subtask.id} className="space-y-2 p-4 text-sm">
      <h3 className="font-mono text-base font-semibold">{subtask.id}</h3>
      <p>
        Estado: <Tone value={subtask.state} />
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
    <Group title="Acceptance tester">
      <p>
        Agente: {tester.agent} / {tester.model}
      </p>
      <FileLink url={tester.logUrl} label={RAW_LOG} />
      {tester.error !== null && <p>Error: {tester.error}</p>}
      <Checks checks={tester.checks} />
      {tester.verdicts.length > 0 && (
        <Items>
          {tester.verdicts.map((testerVerdict, index) => (
            <li key={index}>
              {testerVerdict.id}: <Tone value={verdict(testerVerdict.passed)} />{" "}
              {`(${testerVerdict.observation})${testerVerdict.evidence.length === 0 ? "" : ` [${testerVerdict.evidence.join(", ")}]`}`}
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
    <Section title="Integrated verification">
      <p>SHA: {verification.sha}</p>
      <p>
        Resultado: <Tone value={verdict(verification.passed)} />
      </p>
      {verification.environment !== null && <p>Entorno: {verification.environment}</p>}
      <Checks checks={verification.checks} />
      <Criteria criteria={verification.criteria} />
      {verification.humanCriteria.length > 0 && (
        <Group title="Criterios human">
          <Items>
            {verification.humanCriteria.map((criterion, index) => (
              <li key={index}>
                {`${criterion.id}: ${criterion.reason}${criterion.attachments.length === 0 ? "" : ` (${criterion.attachments.join(", ")})`}`}
              </li>
            ))}
          </Items>
        </Group>
      )}
      {verification.tester !== null && <Tester tester={verification.tester} />}
    </Section>
  );
}

function Empty() {
  return <p className="text-sm text-muted-foreground">Esta pestaña todavía no tiene contenido.</p>;
}

function TabContent({ tab, run }: { tab: TabId; run: RunDetail }) {
  if (tab === "summary") return <Summary run={run} />;
  if (tab === "verification") return <Verification verification={run.verification} />;
  if (tab === "subtasks") return <Subtasks subtasks={run.subtasks} />;
  return <Empty />;
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

export function RunPage() {
  const { runId = "" } = useParams();
  const { data, failed, missing } = usePoll<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
  if (missing) return <NotFound />;
  return (
    <div className="space-y-6">
      {failed && (
        <p role="status" className="rounded-md border border-warn/40 bg-warn/15 px-3 py-2 text-sm text-warn">
          Sin conexión con factory web; se vuelve a intentar cada 2 s.
        </p>
      )}
      {data === null ? (
        !failed && <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <Header run={data} />
          <Tabs run={data} />
        </>
      )}
    </div>
  );
}
