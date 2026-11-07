// PROTOTYPE, throwaway. Board and Commands (web actions), switchable with ?variant=A|B|C.
// Question: how do the Board, the form of a command and the output of a command fit together?
// Static data and a simulated output: nothing runs, nothing is saved.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleDot, ExternalLink, GitPullRequest, Loader2, MessageSquare, Play, Square, Terminal, X } from "lucide-react";
import { Badge, type Tone } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { cn } from "../cn.ts";

/* ---------- data ---------- */

type Phase = "no-spec" | "ready" | "running" | "attention" | "review" | "done";
const PHASES: { key: Phase; label: string; tone: Tone }[] = [
  { key: "no-spec", label: "Sin spec", tone: "neutral" },
  { key: "ready", label: "Listo para run", tone: "info" },
  { key: "running", label: "Run en marcha", tone: "info" },
  { key: "attention", label: "Necesita atención", tone: "bad" },
  { key: "review", label: "En revisión", tone: "warn" },
  { key: "done", label: "Hecho", tone: "ok" },
];

type Action = "refine" | "approve" | "run" | "stop" | "resume" | "publish" | "open-pr";
const ACTION_LABEL: Record<Action, string> = {
  refine: "Refinar",
  approve: "Aprobar spec",
  run: "Lanzar run",
  stop: "Parar",
  resume: "Nuevo run",
  publish: "Publicar de nuevo",
  "open-pr": "Abrir PR",
};

interface Issue {
  n: number;
  title: string;
  phase: Phase;
  line: string;
  next: Action | null;
}

const ISSUES: Issue[] = [
  { n: 34, title: "Recordatorio por email 24 h antes de la cita", phase: "no-spec", line: "Sin refinar", next: "refine" },
  { n: 33, title: "Exportar la agenda a CSV", phase: "no-spec", line: "Spec escrita, sin aprobar", next: "approve" },
  { n: 31, title: "Cancelar una cita desde el enlace del email", phase: "ready", line: "Spec aprobada · 4 criterios", next: "run" },
  { n: 28, title: "Reservar cita en un hueco libre", phase: "running", line: "Integrated verification · A3 en marcha", next: "stop" },
  { n: 26, title: "Ver la agenda de la semana", phase: "attention", line: "Subtask health: blocked (patience)", next: "resume" },
  { n: 25, title: "Login con enlace mágico", phase: "attention", line: "Publicación fallida: push rechazado", next: "publish" },
  { n: 22, title: "Alta de peluqueros", phase: "review", line: "PR #40 · ready for review", next: "open-pr" },
  { n: 19, title: "Horario de apertura configurable", phase: "done", line: "PR #37 mergeado", next: null },
];

interface CommandRow {
  id: string;
  issue: number;
  command: string;
  state: "running" | "ok" | "failed" | "interrupted";
  started: string;
  duration: string;
}

const HISTORY: CommandRow[] = [
  { id: "a7", issue: 28, command: "factory run 28 --worker-agent claude-code:sonnet --verifier-agent opencode:opencode-go/modelo-a --tester-agent claude-code:sonnet", state: "running", started: "10:42", duration: "18 min" },
  { id: "a6", issue: 25, command: "factory publish 25", state: "failed", started: "10:31", duration: "9 s" },
  { id: "a5", issue: 31, command: "factory approve 31", state: "ok", started: "10:20", duration: "2 s" },
  { id: "a4", issue: 31, command: "factory refine 31 --turn", state: "ok", started: "10:05", duration: "1 min" },
  { id: "a3", issue: 26, command: "factory run 26 …", state: "interrupted", started: "ayer 18:10", duration: "—" },
];

const STATE_BADGE: Record<CommandRow["state"], { tone: Tone; label: string }> = {
  running: { tone: "info", label: "en marcha" },
  ok: { tone: "ok", label: "terminado" },
  failed: { tone: "bad", label: "falló (exit 1)" },
  interrupted: { tone: "warn", label: "interrumpido" },
};

const ROLES = [
  { key: "worker", label: "Workers", value: "claude-code · sonnet" },
  { key: "verifier", label: "Independent verifier", value: "opencode · opencode-go/modelo-a" },
  { key: "tester", label: "Acceptance tester", value: "claude-code · sonnet" },
];

function commandFor(action: Action, n: number): string {
  if (action === "run" || action === "resume")
    return `factory run ${n} --worker-agent claude-code:sonnet --verifier-agent opencode:opencode-go/modelo-a --tester-agent claude-code:sonnet`;
  if (action === "approve") return `factory approve ${n}`;
  if (action === "publish") return `factory publish ${n}`;
  if (action === "refine") return `factory refine ${n} --turn`;
  return "";
}

const RUN_OUTPUT = [
  "✓ Docker en marcha · ✓ gh · ✓ credenciales · ✓ worker image al día",
  "Run 31-20261107-1043 · spec aprobada (hashes ok)",
  "Partición: base subtask + 2 subtasks en 1 wave",
  "▸ base subtask · attempt 1 · claude-code sonnet",
  "  gate: checks ✓ · independent verifier ✓ A1",
  "▸ wave 1 · subtask cancel-link · subtask email-template",
  "  cancel-link: gate checks ✓ · verifier ✓ A2, A3",
  "  email-template: gate checks ✗ (lint) → attempt 2",
  "  email-template: gate checks ✓ · verifier ✓ A4",
  "▸ integrated verification · checks ✓ · A1 ✓ A2 ✓ A3 ✓ A4 ✓",
  "▸ acceptance tester · 4 de 4 criterios pasan",
  "▸ holdout scenarios · 2 de 2 pasan",
  "▸ publicación · push factory/31-cancelar-cita ✓ · PR #41 ready for review",
  "✓ Terminado en 21 min · exit 0",
];

const SIMPLE_OUTPUT: Record<string, string[]> = {
  approve: ["✓ factory validate 33: la spec cumple el formato", "Hashes guardados en specs/33.md", "✓ exit 0"],
  publish: ["push factory/25-login … reintento 1 de 3", "✓ push", "✓ PR #39 actualizado", "✓ exit 0"],
};

/* ---------- shared pieces (small, not layout) ---------- */

function useSimulatedOutput(lines: string[], active: boolean) {
  const [count, setCount] = useState(0);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (!active || stopped || count >= lines.length) return;
    const t = setTimeout(() => setCount((c) => c + 1), 650);
    return () => clearTimeout(t);
  }, [active, stopped, count, lines.length]);
  const shown = lines.slice(0, count).concat(stopped ? ["^C SIGINT al grupo del proceso · el run queda parado; se puede lanzar otro"] : []);
  const state: CommandRow["state"] = stopped ? "interrupted" : count >= lines.length ? "ok" : "running";
  return { shown, state, stop: () => setStopped(true) };
}

function Output({ lines, running }: { lines: string[]; running: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <pre ref={ref} className="max-h-72 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">
      {lines.join("\n")}
      {running && <span className="animate-pulse">▍</span>}
    </pre>
  );
}

function CommandLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/50 p-2 font-mono text-xs">
      <Terminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="break-all">{text}</span>
    </div>
  );
}

function RunForm({ n, onLaunch }: { n: number; onLaunch: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-2">
        {ROLES.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <span className="font-medium">{r.label}</span>
            <select className="h-8 rounded-md border bg-background px-2 text-xs" defaultValue={r.value}>
              <option>{r.value}</option>
              <option>claude-code · opus</option>
              <option>opencode · opencode-go/modelo-b</option>
            </select>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Preseleccionado desde Settings. Un cambio aquí vale solo para este run.</p>
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Se ejecutará</div>
        <CommandLine text={commandFor("run", n)} />
      </div>
      <Button onClick={onLaunch}><Play /> Lanzar run</Button>
    </div>
  );
}

function RefineChat() {
  const [turns, setTurns] = useState<{ who: "agent" | "me"; text: string }[]>([
    { who: "agent", text: "He leído el issue #34 y el código de notificaciones. Hay dos decisiones abiertas:\n\nQ1. ¿El recordatorio se manda también si la cita se creó hace menos de 24 h? Recomiendo: no.\nQ2. ¿Desde qué dirección se envía? Recomiendo: la de la peluquería, configurable." },
  ]);
  const [text, setText] = useState("");
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-2">
        {turns.map((t, i) => (
          <div key={i} className={cn("max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2", t.who === "agent" ? "bg-muted" : "ml-auto bg-primary text-primary-foreground")}>
            {t.text}
          </div>
        ))}
        <div className="text-xs text-muted-foreground">· Read src/notifications/send.ts · Grep "reminder" · gh issue view 34</div>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() === "") return;
          setTurns([...turns, { who: "me", text }, { who: "agent", text: "Entendido. Escribo specs/34.md con A1–A3 y propongo 1 holdout scenario. (siguiente turno: factory refine 34 --turn)" }]);
          setText("");
        }}
      >
        <input id="refine-answer" value={text} onChange={(e) => setText(e.target.value)} className="h-9 flex-1 rounded-md border bg-background px-3" placeholder="Tu respuesta… (sí = acepto las recomendaciones)" />
        <Button type="submit"><MessageSquare /> Enviar</Button>
      </form>
      <p className="text-xs text-muted-foreground">Cada respuesta es un comando: <span className="font-mono">factory refine 34 --turn</span>, con tu texto por la entrada estándar.</p>
    </div>
  );
}

/* What a click on the next step opens: form → output (or chat). Every variant uses it in its own container. */
function ActionFlow({ issue, action }: { issue: Issue; action: Action }) {
  const [launched, setLaunched] = useState(action !== "run" && action !== "resume");
  const lines = action === "run" || action === "resume" ? RUN_OUTPUT : (SIMPLE_OUTPUT[action] ?? []);
  const out = useSimulatedOutput(lines, launched);
  if (action === "refine") return <RefineChat />;
  if (action === "open-pr") return <p className="text-sm">Abre el PR en GitHub, en otra pestaña.</p>;
  if (action === "stop")
    return (
      <div className="space-y-3 text-sm">
        <p>Envía SIGINT al run de #{issue.n}, como Ctrl-C en la terminal. Solo funciona con un run lanzado desde la web.</p>
        <Button><Square /> Parar el run</Button>
      </div>
    );
  if (!launched) return <RunForm n={issue.n} onLaunch={() => setLaunched(true)} />;
  return (
    <div className="space-y-3 text-sm">
      <CommandLine text={commandFor(action, issue.n)} />
      <div className="flex items-center gap-2">
        <Badge tone={STATE_BADGE[out.state].tone}>
          {out.state === "running" && <Loader2 className="animate-spin" />}
          {STATE_BADGE[out.state].label}
        </Badge>
        {out.state === "running" && (
          <Button variant="ghost" onClick={out.stop}><Square /> Stop</Button>
        )}
      </div>
      <Output lines={out.shown} running={out.state === "running"} />
    </div>
  );
}

/* ---------- Variant A: kanban + side drawer; no Commands page, each command lives where it was launched ---------- */

function VariantA() {
  const [open, setOpen] = useState<{ issue: Issue; action: Action } | null>(null);
  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        <h1 className="text-xl font-semibold">Board <span className="text-sm font-normal text-muted-foreground">· acme-reservas</span></h1>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {PHASES.map((p) => (
            <div key={p.key} className="w-48 shrink-0 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {p.label} <span>{ISSUES.filter((i) => i.phase === p.key).length}</span>
              </div>
              {ISSUES.filter((i) => i.phase === p.key).map((i) => (
                <Card key={i.n} className={cn("space-y-2 p-3 text-sm", open?.issue.n === i.n && "ring-2 ring-primary")}>
                  <div className="text-xs text-muted-foreground">#{i.n}</div>
                  <div className="font-medium leading-snug">{i.title}</div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {i.phase === "running" && <Loader2 className="size-3 animate-spin" />}
                    {i.line}
                  </div>
                  {i.next && (
                    <Button className="h-7 w-full text-xs" variant={i.phase === "done" ? "ghost" : "default"} onClick={() => setOpen({ issue: i, action: i.next! })}>
                      {ACTION_LABEL[i.next]}
                    </Button>
                  )}
                </Card>
              ))}
            </div>
          ))}
        </div>
      </div>
      {open && (
        <aside className="fixed top-4 right-4 bottom-20 z-40 w-[30rem] max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto rounded-lg border bg-card p-4 shadow-2xl">
          <div className="flex items-start gap-2">
            <div>
              <div className="text-xs text-muted-foreground">#{open.issue.n} · {ACTION_LABEL[open.action]}</div>
              <div className="font-medium">{open.issue.title}</div>
            </div>
            <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setOpen(null)} aria-label="Cerrar"><X /></Button>
          </div>
          <ActionFlow key={`${open.issue.n}-${open.action}`} issue={open.issue} action={open.action} />
        </aside>
      )}
    </div>
  );
}

/* ---------- Variant B: Board as a list grouped by phase + a Commands page in the menu ---------- */

function VariantB() {
  const [tab, setTab] = useState<"board" | "commands">("board");
  const [open, setOpen] = useState<{ issue: Issue; action: Action } | null>(null);
  const [cmd, setCmd] = useState<CommandRow | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 border-b">
        {(["board", "commands"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setOpen(null); setCmd(null); }} className={cn("-mb-px border-b-2 px-4 py-2 text-sm", tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground")}>
            {t === "board" ? "Board" : <>Comandos <Badge tone="info" className="ml-1">1</Badge></>}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">(en el menú lateral serían dos entradas: Board y Comandos)</span>
      </div>

      {tab === "board" && !open && (
        <div className="space-y-5">
          {PHASES.filter((p) => ISSUES.some((i) => i.phase === p.key)).map((p) => (
            <section key={p.key}>
              <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Badge tone={p.tone}>{p.label}</Badge></h2>
              <table className="w-full text-sm">
                <tbody>
                  {ISSUES.filter((i) => i.phase === p.key).map((i) => (
                    <tr key={i.n} className="border-t hover:bg-accent/50">
                      <td className="w-14 py-2 text-muted-foreground">#{i.n}</td>
                      <td className="py-2 font-medium">{i.title}</td>
                      <td className="py-2 text-muted-foreground">{i.line}</td>
                      <td className="w-40 py-2 text-right">
                        {i.next && <Button className="h-7 text-xs" onClick={() => setOpen({ issue: i, action: i.next! })}>{ACTION_LABEL[i.next]}</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}

      {tab === "board" && open && (
        <div className="max-w-3xl space-y-3">
          <button className="flex items-center gap-1 text-sm text-primary" onClick={() => setOpen(null)}><ArrowLeft className="size-4" /> Board</button>
          <h1 className="text-xl font-semibold">{ACTION_LABEL[open.action]} · #{open.issue.n} {open.issue.title}</h1>
          <Card className="p-4"><ActionFlow key={`${open.issue.n}-${open.action}`} issue={open.issue} action={open.action} /></Card>
        </div>
      )}

      {tab === "commands" && !cmd && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="py-2">Estado</th><th>Issue</th><th>Comando</th><th>Inicio</th><th>Duración</th></tr>
          </thead>
          <tbody>
            {HISTORY.map((h) => (
              <tr key={h.id} className="cursor-pointer border-t hover:bg-accent/50" onClick={() => setCmd(h)}>
                <td className="py-2"><Badge tone={STATE_BADGE[h.state].tone}>{h.state === "running" && <Loader2 className="animate-spin" />}{STATE_BADGE[h.state].label}</Badge></td>
                <td>#{h.issue}</td>
                <td className="max-w-md truncate font-mono text-xs">{h.command}</td>
                <td>{h.started}</td>
                <td>{h.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "commands" && cmd && (
        <div className="max-w-3xl space-y-3">
          <button className="flex items-center gap-1 text-sm text-primary" onClick={() => setCmd(null)}><ArrowLeft className="size-4" /> Comandos</button>
          <CommandLine text={cmd.command} />
          <Badge tone={STATE_BADGE[cmd.state].tone}>{STATE_BADGE[cmd.state].label}</Badge>
          <Output lines={cmd.state === "running" ? RUN_OUTPUT.slice(0, 10) : cmd.state === "failed" ? ["push factory/25-login … rechazado: protected branch", "✗ Not published: Login con enlace mágico → factory publish 25", "exit 1"] : RUN_OUTPUT.slice(0, 3)} running={cmd.state === "running"} />
          {cmd.state === "running" && <Button variant="ghost"><Square /> Stop</Button>}
        </div>
      )}
    </div>
  );
}

/* ---------- Variant C: issue-centric; the life of one issue as steps, each with its commands inline ---------- */

const STEPS: { key: string; label: string; action: Action; doneFor: (p: Phase, line: string) => boolean }[] = [
  { key: "refine", label: "Refinement", action: "refine", doneFor: (p, l) => p !== "no-spec" || l.startsWith("Spec escrita") },
  { key: "approve", label: "Aprobación", action: "approve", doneFor: (p) => p !== "no-spec" },
  { key: "run", label: "Run (gates, verificación, acceptance tester, holdout)", action: "run", doneFor: (p) => p === "review" || p === "done" },
  { key: "pr", label: "Pull request", action: "open-pr", doneFor: (p) => p === "done" },
];

function VariantC() {
  const [selected, setSelected] = useState<Issue>(ISSUES.find((i) => i.n === 31)!);
  const [openStep, setOpenStep] = useState<string | null>("run");
  const phase = PHASES.find((p) => p.key === selected.phase)!;
  const current = STEPS.find((s) => !s.doneFor(selected.phase, selected.line));
  return (
    <div className="flex gap-6">
      <nav className="w-72 shrink-0 space-y-1">
        <h1 className="mb-2 text-xl font-semibold">Issues</h1>
        {ISSUES.map((i) => {
          const p = PHASES.find((x) => x.key === i.phase)!;
          return (
            <button key={i.n} onClick={() => { setSelected(i); setOpenStep(null); }} className={cn("w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent", selected.n === i.n && "bg-accent")}>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">#{i.n}</span>
                <Badge tone={p.tone} className="ml-auto">{p.label}</Badge>
              </div>
              <div className="truncate font-medium">{i.title}</div>
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 max-w-3xl space-y-4">
        <div>
          <div className="text-sm text-muted-foreground">#{selected.n} · <Badge tone={phase.tone}>{phase.label}</Badge></div>
          <h2 className="text-xl font-semibold">{selected.title}</h2>
          <p className="text-sm text-muted-foreground">{selected.line}</p>
        </div>
        <ol className="space-y-2">
          {STEPS.map((s) => {
            const done = s.doneFor(selected.phase, selected.line);
            const isCurrent = current?.key === s.key;
            const expanded = openStep === s.key;
            return (
              <li key={s.key}>
                <Card className={cn("p-0", isCurrent && "ring-2 ring-primary")}>
                  <button className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm" onClick={() => setOpenStep(expanded ? null : s.key)}>
                    {done ? <Check className="size-4 text-ok" /> : isCurrent ? <CircleDot className="size-4 text-primary" /> : <CircleDot className="size-4 text-muted-foreground/40" />}
                    <span className={cn("font-medium", !done && !isCurrent && "text-muted-foreground")}>{s.label}</span>
                    {isCurrent && selected.next && <Badge tone="info" className="ml-2">siguiente: {ACTION_LABEL[selected.next]}</Badge>}
                    <ChevronRight className={cn("ml-auto size-4 transition-transform", expanded && "rotate-90")} />
                  </button>
                  {expanded && (
                    <div className="space-y-3 border-t px-4 py-3">
                      {done && (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <div className="font-medium text-foreground">Comandos de este paso</div>
                          {HISTORY.filter((h) => h.issue === selected.n).map((h) => (
                            <div key={h.id} className="flex items-center gap-2">
                              <Badge tone={STATE_BADGE[h.state].tone}>{STATE_BADGE[h.state].label}</Badge>
                              <span className="truncate font-mono">{h.command}</span>
                              <span className="ml-auto">{h.started}</span>
                            </div>
                          ))}
                          {s.key === "pr" && <a className="inline-flex items-center gap-1 text-primary"><GitPullRequest className="size-3" /> PR #40 <ExternalLink className="size-3" /></a>}
                        </div>
                      )}
                      {isCurrent && selected.next && <ActionFlow key={`${selected.n}-${s.key}`} issue={selected} action={selected.next} />}
                      {!done && !isCurrent && <p className="text-sm text-muted-foreground">Llega cuando termine el paso anterior.</p>}
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/* ---------- switcher ---------- */

const VARIANTS = [
  { key: "A", name: "Kanban + panel lateral, sin página de Comandos", view: VariantA },
  { key: "B", name: "Lista por fases + página de Comandos", view: VariantB },
  { key: "C", name: "Por issue, con sus pasos y comandos dentro", view: VariantC },
];

export function BoardPrototype() {
  const [params, setParams] = useSearchParams();
  const index = Math.max(0, VARIANTS.findIndex((v) => v.key === params.get("variant")));
  const current = VARIANTS[index]!;
  const go = (step: number) => setParams({ variant: VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!.key }, { replace: true });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const View = current.view;
  return (
    <>
      <View key={current.key} />
      <Bar>
        <button aria-label="Variante anterior" onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/20"><ArrowLeft className="size-4" /></button>
        <span className="px-2">PROTOTIPO · {current.key} ({current.name})</span>
        <button aria-label="Variante siguiente" onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/20"><ArrowRight className="size-4" /></button>
      </Bar>
    </>
  );
}

function Bar({ children }: { children: ReactNode }) {
  return <div className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit items-center gap-2 rounded-full bg-black px-2 py-1 text-sm text-white shadow-xl">{children}</div>;
}
