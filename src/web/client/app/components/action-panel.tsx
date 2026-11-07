import { Loader2, Square, X } from "lucide-react";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiOrigin, usePoll, type ActionRequest, type RunForm, type RunFormRole, type WebActionView } from "../api.ts";
import { duration } from "../format.ts";
import { Badge, type Tone } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";

export type FormCommand = ActionRequest["command"];

const FORM_COMMANDS: readonly FormCommand[] = ["run", "approve", "validate", "publish", "doctor", "image", "init"];
const ISSUE_COMMANDS: readonly FormCommand[] = ["run", "approve", "validate", "publish"];

type RoleChoices = Partial<Record<RunFormRole["role"], { agent: string; model: string }>>;

function formSearch(command: FormCommand, issue: number | null): string {
  const params = new URLSearchParams({ form: command });
  if (issue !== null) params.set("issue", String(issue));
  return `?${params.toString()}`;
}

export function ActionLink({ command, issue = null, children }: { command: FormCommand; issue?: number | null; children: ReactNode }) {
  const [current] = useSearchParams();
  const params = new URLSearchParams(current);
  params.delete("action");
  for (const [key, value] of new URLSearchParams(formSearch(command, issue))) params.set(key, value);
  return (
    <Link
      to={{ search: `?${params.toString()}` }}
      className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 font-mono text-xs hover:bg-accent"
    >
      {children}
    </Link>
  );
}

export function ActionStateBadge({ action }: { action: WebActionView }) {
  const { state } = action;
  if (state.kind === "running") {
    return (
      <Badge tone="info">
        <Loader2 className="animate-spin" />
        working
      </Badge>
    );
  }
  if (state.kind === "interrupted") return <Badge tone="warn">interrupted</Badge>;
  const tone: Tone = state.exitCode === 0 ? "ok" : "bad";
  return <Badge tone={tone}>{`exit ${state.exitCode}`}</Badge>;
}

async function post(origin: string, path: string, body: object): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as { id?: string; error?: string };
    if (response.ok && answer.id !== undefined) return { ok: true, id: answer.id };
    return { ok: false, error: answer.error ?? `HTTP ${response.status}` };
  } catch (failure) {
    return { ok: false, error: (failure as Error).message };
  }
}

function useRunForm(issue: number | null): RunForm | null {
  const origin = useContext(ApiOrigin);
  const [form, setForm] = useState<RunForm | null>(null);
  useEffect(() => {
    if (issue === null) return;
    let alive = true;
    void fetch(`${origin}/api/run-form/${issue}`)
      .then((response) => response.json() as Promise<RunForm>)
      .then((data) => {
        if (alive) setForm(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [origin, issue]);
  return form;
}

function initialChoices(form: RunForm): RoleChoices {
  return Object.fromEntries(form.roles.flatMap((role) => (role.choice === null ? [] : [[role.role, { ...role.choice }]])));
}

function RoleField({ role, value, onChange }: { role: RunFormRole; value: { agent: string; model: string } | undefined; onChange: (next: { agent: string; model: string }) => void }) {
  const agent = value?.agent ?? role.offered[0] ?? "";
  const listId = `models-${role.role}`;
  return (
    <fieldset className="space-y-1.5 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{role.label}</legend>
      <div className="flex gap-2">
        <select
          aria-label={`Agente: ${role.label}`}
          value={agent}
          onChange={(event) => onChange({ agent: event.target.value, model: "" })}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          {role.offered.map((offered) => (
            <option key={offered} value={offered}>
              {offered}
            </option>
          ))}
        </select>
        <input
          aria-label={`Modelo: ${role.label}`}
          list={listId}
          value={value?.model ?? ""}
          onChange={(event) => onChange({ agent, model: event.target.value })}
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 font-mono text-sm"
        />
        <datalist id={listId}>
          {(role.models[agent as keyof typeof role.models] ?? []).map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </div>
      {role.origin !== null && <p className="text-xs text-muted-foreground">{`(${role.origin})`}</p>}
      {role.warning !== null && <p className="text-xs text-warn">{role.warning}</p>}
    </fieldset>
  );
}

function runRequest(issue: number, choices: RoleChoices): ActionRequest {
  const roles = Object.fromEntries(Object.entries(choices).filter(([, choice]) => choice !== undefined && choice.model.trim() !== ""));
  return { command: "run", issue, roles: roles as Extract<ActionRequest, { command: "run" }>["roles"] };
}

function request(command: FormCommand, issue: number | null, choices: RoleChoices): ActionRequest | null {
  if (!ISSUE_COMMANDS.includes(command)) return { command: command as "doctor" | "image" | "init" };
  if (issue === null) return null;
  if (command === "run") return runRequest(issue, choices);
  return { command: command as "approve" | "validate" | "publish", issue };
}

function preview(action: ActionRequest, roles: readonly RunFormRole[]): string {
  if (!("issue" in action)) return `factory ${action.command}`;
  const base = `factory ${action.command} ${action.issue}`;
  if (action.command !== "run") return base;
  const flags = roles.flatMap((role) => {
    const choice = action.roles[role.role];
    return choice === undefined ? [] : [`${role.flag} ${choice.agent}:${choice.model}`];
  });
  return [base, ...flags].join(" ");
}

function ActionForm({ command, issue }: { command: FormCommand; issue: number | null }) {
  const origin = useContext(ApiOrigin);
  const [, setSearchParams] = useSearchParams();
  const form = useRunForm(command === "run" ? issue : null);
  const [choices, setChoices] = useState<RoleChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const runForm = command === "run" ? form : null;
  const current = choices ?? (runForm === null ? {} : initialChoices(runForm));
  const action = request(command, issue, current);
  if (action === null) return <p className="text-sm text-bad">Falta el número del issue.</p>;
  const start = async () => {
    setSending(true);
    const answer = await post(origin, "/api/actions", action);
    setSending(false);
    if (answer.ok) setSearchParams((params) => {
      params.delete("form");
      params.delete("issue");
      params.set("action", answer.id);
      return params;
    });
    else setError(answer.error);
  };
  return (
    <div className="space-y-3">
      {command === "run" && runForm === null && <p className="text-sm text-muted-foreground">Cargando…</p>}
      {runForm?.problem != null && <p className="text-sm text-warn">{runForm.problem}</p>}
      {runForm?.roles.map((role) => (
        <RoleField key={role.role} role={role} value={current[role.role]} onChange={(next) => setChoices({ ...current, [role.role]: next })} />
      ))}
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Comando</p>
        <pre aria-label="Comando" className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
          {preview(action, runForm?.roles ?? [])}
        </pre>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <Button onClick={() => void start()} disabled={sending || (command === "run" && runForm === null)}>
        Empezar
      </Button>
    </div>
  );
}

function ActionOutput({ id }: { id: string }) {
  const origin = useContext(ApiOrigin);
  const { data, missing } = usePoll<WebActionView>(`/api/actions/${encodeURIComponent(id)}`);
  const [error, setError] = useState<string | null>(null);
  if (missing) return <p className="text-sm text-muted-foreground">No existe esa acción web.</p>;
  if (data === null) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  const stop = async () => {
    const answer = await post(origin, `/api/actions/${encodeURIComponent(id)}/stop`, {});
    setError(answer.ok ? null : answer.error);
  };
  return (
    <div className="space-y-3">
      <pre aria-label="Comando" className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
        {data.command}
      </pre>
      <div className="flex items-center gap-2 text-sm">
        <ActionStateBadge action={data} />
        {data.state.kind === "running" && <span className="text-muted-foreground">{duration(data.state.elapsedMs)}</span>}
        {data.canStop && (
          <Button variant="ghost" className="ml-auto border" onClick={() => void stop()}>
            <Square />
            Stop
          </Button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <pre aria-label="Salida" className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-xs">
        {data.output === null || data.output === "" ? "Sin salida todavía." : data.output}
      </pre>
    </div>
  );
}

function parsedIssue(value: string | null): number | null {
  return value !== null && /^[1-9][0-9]*$/.test(value) ? Number(value) : null;
}

export function ActionPanel() {
  const [params, setSearchParams] = useSearchParams();
  const form = params.get("form");
  const action = params.get("action");
  const command = FORM_COMMANDS.find((candidate) => candidate === form);
  if (command === undefined && action === null) return null;
  const close = () =>
    setSearchParams((current) => {
      for (const key of ["form", "issue", "action"]) current.delete(key);
      return current;
    });
  return (
    <aside aria-label="Acción web" className="fixed inset-y-0 right-0 z-20 w-full max-w-xl overflow-y-auto border-l bg-background p-4 shadow-xl">
      <Card className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{command !== undefined ? `factory ${command}` : "Acción web"}</h2>
          <Button variant="ghost" size="icon" className="ml-auto" aria-label="Cerrar" onClick={close}>
            <X />
          </Button>
        </div>
        {command !== undefined ? <ActionForm key={`${command}-${params.get("issue")}`} command={command} issue={parsedIssue(params.get("issue"))} /> : <ActionOutput id={action ?? ""} />}
      </Card>
    </aside>
  );
}
