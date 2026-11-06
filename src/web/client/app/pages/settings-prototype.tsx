// PROTOTYPE, throwaway. Three variants of the Settings page, switchable with ?variant=A|B|C on /settings.
// Question: what should Settings look like (workspace, default models per role, credentials, Slack),
// and should Settings replace the roles of .factory/config.ts (variant C shows both rules side by side).
// Static data, no API, no mutation: each "Guardar" only shows the command it would start.
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ArrowLeft, ArrowRight, Bell, Folder, FolderGit2, KeyRound, Plug, Plus, MessageSquare as Slack, SlidersHorizontal } from "lucide-react";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { cn } from "../cn.ts";

type Agent = "claude-code" | "opencode";
interface Choice {
  agent: Agent;
  model: string;
}

const ROLES = [
  { key: "refinement", label: "Refinement", hint: "Convierte el issue en spec, contigo" },
  { key: "workers", label: "Workers", hint: "Implementan cada subtask" },
  { key: "verifier", label: "Independent verifier", hint: "Juzga si el test prueba el criterio" },
  { key: "tester", label: "Acceptance tester", hint: "Usa la app como un usuario" },
] as const;
type RoleKey = (typeof ROLES)[number]["key"];

const MODELS: Record<Agent, string[]> = {
  "claude-code": ["opus", "sonnet", "haiku"],
  opencode: ["opencode-go/modelo-a", "opencode-go/modelo-b"],
};

const DEFAULTS: Record<RoleKey, Choice> = {
  refinement: { agent: "claude-code", model: "opus" },
  workers: { agent: "claude-code", model: "sonnet" },
  verifier: { agent: "opencode", model: "opencode-go/modelo-a" },
  tester: { agent: "claude-code", model: "sonnet" },
};

const REPOS = [
  { name: "askwell", origin: "aldorea/askwell", state: "ready" as const, configRoles: { workers: { agent: "opencode", model: "opencode-go/modelo-b" } } as Partial<Record<RoleKey, Choice>> },
  { name: "software-factory", origin: "aldorea/software-factory", state: "ready" as const, configRoles: {} as Partial<Record<RoleKey, Choice>> },
  { name: "acme-web", origin: "aldorea/acme-web", state: "uninitialised" as const, configRoles: {} as Partial<Record<RoleKey, Choice>> },
];

const CREDENTIALS = [
  { agent: "claude-code", variable: "CLAUDE_CODE_OAUTH_TOKEN", origin: "guardada (…a1f3)" },
  { agent: "opencode", variable: "OPENCODE_API_KEY", origin: "del entorno (gana a la guardada)" },
];

const EVENTS = ["Run listo para revisar", "Run en draft", "Run pausado por el plan limit", "Necesita atención (bloqueado, abandonado, publicación fallida)"];

function useRoles() {
  return useState<Record<RoleKey, Choice>>(DEFAULTS);
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

const inputClass = "h-9 rounded-md border bg-background px-3 text-sm";

function ChoiceSelect({ value, onChange }: { value: Choice; onChange: (c: Choice) => void }) {
  return (
    <div className="flex gap-2">
      <select className={inputClass} value={value.agent} onChange={(e) => onChange({ agent: e.target.value as Agent, model: MODELS[e.target.value as Agent][0] ?? "" })}>
        <option value="claude-code">Claude Code</option>
        <option value="opencode">OpenCode Go</option>
      </select>
      <select className={cn(inputClass, "min-w-48")} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
        {MODELS[value.agent].map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
    </div>
  );
}

function Command({ text }: { text: string }) {
  return <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{text}</code>;
}

function SlackForm() {
  const [on, setOn] = useState(true);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Avisar por Slack
      </label>
      <Field label="Webhook de Slack" hint="Se guarda en tu máquina, junto a las credenciales. Nunca entra en un contenedor. Solo se ven los 4 últimos caracteres.">
        <input className={inputClass} type="password" placeholder="https://hooks.slack.com/services/…" defaultValue="xxxxxxxxxxxx9c2e" />
      </Field>
      <fieldset className="grid gap-1 text-sm">
        <legend className="mb-1 font-medium">Avisar cuando</legend>
        {EVENTS.map((e) => (
          <label key={e} className="flex items-center gap-2">
            <input type="checkbox" defaultChecked disabled={!on} /> {e}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        <Button>Guardar</Button>
        <Button variant="ghost">Enviar aviso de prueba</Button>
      </div>
    </div>
  );
}

/* ---------- Variant A: one long page, stacked sections ---------- */

function VariantA() {
  const [roles, setRoles] = useRoles();
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Folder className="size-4" /> Workspace</h2>
        <Field label="Carpeta" hint="La fábrica solo ve los repos git que están directamente dentro.">
          <div className="flex gap-2">
            <input className={cn(inputClass, "flex-1 font-mono")} defaultValue="~/factory" />
            <Button variant="ghost">Elegir…</Button>
          </div>
        </Field>
        <ul className="divide-y rounded-md border text-sm">
          {REPOS.map((r) => (
            <li key={r.name} className="flex items-center gap-3 px-3 py-2">
              <FolderGit2 className="size-4 text-muted-foreground" />
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground">{r.origin}</span>
              <span className="ml-auto">{r.state === "ready" ? <Badge tone="ok">listo</Badge> : <Badge tone="warn">sin inicializar → init</Badge>}</span>
            </li>
          ))}
        </ul>
        <Button variant="ghost"><Plus /> Añadir repo de GitHub</Button>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><SlidersHorizontal className="size-4" /> Modelos por defecto</h2>
        <p className="text-sm text-muted-foreground">Los usa cada run. En el formulario de un run puedes cambiarlos solo para ese run.</p>
        <table className="w-full text-sm">
          <tbody className="divide-y">
            {ROLES.map((r) => (
              <tr key={r.key}>
                <td className="py-2 pr-4">
                  <div className="font-medium">{r.label}</div>
                  <div className="text-xs text-muted-foreground">{r.hint}</div>
                </td>
                <td className="py-2"><ChoiceSelect value={roles[r.key]} onChange={(c) => setRoles({ ...roles, [r.key]: c })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button>Guardar</Button>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" /> Credenciales</h2>
        {CREDENTIALS.map((c) => (
          <div key={c.agent} className="flex items-center gap-3 text-sm">
            <span className="w-28 font-medium">{c.agent}</span>
            <span className="text-muted-foreground">{c.origin}</span>
            <Button variant="ghost" className="ml-auto">Cambiar</Button>
          </div>
        ))}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Plug className="size-4" /> Integraciones</h2>
        <div className="flex items-center gap-2 font-medium"><Slack className="size-4" /> Slack</div>
        <SlackForm />
      </Card>
    </div>
  );
}

/* ---------- Variant B: sub-navigation, one section at a time, sticky save bar with the command ---------- */

const B_SECTIONS = [
  { key: "workspace", label: "Workspace", icon: Folder },
  { key: "models", label: "Modelos", icon: SlidersHorizontal },
  { key: "credentials", label: "Credenciales", icon: KeyRound },
  { key: "integrations", label: "Integraciones", icon: Plug },
] as const;

function VariantB() {
  const [section, setSection] = useState<(typeof B_SECTIONS)[number]["key"]>("models");
  const [roles, setRoles] = useRoles();
  const changed = ROLES.filter((r) => roles[r.key].agent !== DEFAULTS[r.key].agent || roles[r.key].model !== DEFAULTS[r.key].model);
  return (
    <div className="flex gap-8">
      <nav className="w-48 shrink-0 space-y-0.5">
        <h1 className="mb-3 text-xl font-semibold">Settings</h1>
        {B_SECTIONS.map((s) => (
          <button key={s.key} onClick={() => setSection(s.key)} className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent", section === s.key && "bg-accent font-medium")}>
            <s.icon className="size-4" /> {s.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 max-w-2xl space-y-4 pb-20">
        {section === "workspace" && (
          <>
            <h2 className="text-lg font-semibold">Workspace</h2>
            <Field label="Carpeta del workspace" hint="Puede ser la carpeta donde ya tienes tus repos.">
              <input className={cn(inputClass, "font-mono")} defaultValue="~/Code" />
            </Field>
            <p className="text-sm text-muted-foreground">3 repos git con origin en GitHub · 1 sin inicializar</p>
          </>
        )}
        {section === "models" && (
          <>
            <h2 className="text-lg font-semibold">Modelos por defecto</h2>
            <p className="text-sm text-muted-foreground">Para todos los repos y todos los runs. Un run concreto puede elegir otro en su formulario.</p>
            <div className="grid gap-4">
              {ROLES.map((r) => (
                <Card key={r.key} className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <div className="font-medium">{r.label}</div>
                    <div className="text-xs text-muted-foreground">{r.hint}</div>
                  </div>
                  <ChoiceSelect value={roles[r.key]} onChange={(c) => setRoles({ ...roles, [r.key]: c })} />
                </Card>
              ))}
            </div>
          </>
        )}
        {section === "credentials" && (
          <>
            <h2 className="text-lg font-semibold">Credenciales</h2>
            {CREDENTIALS.map((c) => (
              <Card key={c.agent} className="space-y-2 p-4">
                <div className="font-medium">{c.agent} <span className="font-mono text-xs text-muted-foreground">{c.variable}</span></div>
                <div className="text-sm text-muted-foreground">{c.origin}</div>
                <input className={inputClass} type="password" placeholder="Nueva credencial" />
              </Card>
            ))}
          </>
        )}
        {section === "integrations" && (
          <>
            <h2 className="text-lg font-semibold">Integraciones</h2>
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2 font-medium"><Slack className="size-4" /> Slack <Badge tone="ok" className="ml-auto">conectado</Badge></div>
              <SlackForm />
            </Card>
            <Card className="flex items-center gap-2 border-dashed p-4 text-sm text-muted-foreground"><Plus className="size-4" /> Más integraciones, más adelante</Card>
          </>
        )}
      </div>
      {section === "models" && changed.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-40 mx-auto flex w-fit items-center gap-3 rounded-lg border bg-card px-4 py-2 shadow-lg">
          <span className="text-sm">{changed.length} cambio(s) · ejecutará</span>
          <Command text={`factory settings set ${changed.map((r) => `--${r.key}-agent ${roles[r.key].agent}:${roles[r.key].model}`).join(" ")}`} />
          <Button>Guardar</Button>
        </div>
      )}
    </div>
  );
}

/* ---------- Variant C: per repo, what the next run will use, under each rule for .factory/config.ts ---------- */

function VariantC() {
  const [roles, setRoles] = useRoles();
  const [repoName, setRepoName] = useState("askwell");
  const [rule, setRule] = useState<"settings" | "config">("settings");
  const repo = REPOS.find((r) => r.name === repoName) ?? REPOS[0]!;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <div className="ml-auto flex items-center gap-2 rounded-md border p-1 text-sm">
          <span className="px-2 text-muted-foreground">Regla (la decisión pendiente):</span>
          <button onClick={() => setRule("settings")} className={cn("rounded px-2 py-1", rule === "settings" && "bg-primary text-primary-foreground")}>(a) Settings manda</button>
          <button onClick={() => setRule("config")} className={cn("rounded px-2 py-1", rule === "config" && "bg-primary text-primary-foreground")}>(b) config.ts del repo gana</button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="space-y-4 p-4">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">Modelos</h2>
            <span className="text-sm text-muted-foreground">vistos desde el repo</span>
            <select className={inputClass} value={repoName} onChange={(e) => setRepoName(e.target.value)}>
              {REPOS.map((r) => <option key={r.name}>{r.name}</option>)}
            </select>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2">Rol</th>
                <th className="pb-2">Por defecto (Settings)</th>
                {rule === "config" && <th className="pb-2">.factory/config.ts de {repo.name}</th>}
                <th className="pb-2">Usará el próximo run</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ROLES.map((r) => {
                const fromConfig = repo.configRoles[r.key];
                const effective = rule === "config" && fromConfig ? fromConfig : roles[r.key];
                const origin = rule === "config" && fromConfig ? "config.ts" : "settings";
                return (
                  <tr key={r.key}>
                    <td className="py-2 pr-3 font-medium">{r.label}</td>
                    <td className="py-2 pr-3"><ChoiceSelect value={roles[r.key]} onChange={(c) => setRoles({ ...roles, [r.key]: c })} /></td>
                    {rule === "config" && (
                      <td className="py-2 pr-3 font-mono text-xs">{fromConfig ? `${fromConfig.agent} · ${fromConfig.model}` : <span className="text-muted-foreground">—</span>}</td>
                    )}
                    <td className="py-2">
                      <span className="font-mono text-xs">{effective.agent} · {effective.model}</span>{" "}
                      <Badge tone={origin === "settings" ? "neutral" : "warn"}>{origin}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
            {rule === "settings"
              ? "Un único sitio: cambias aquí y lo usan todos los repos. Si un run necesita otro modelo, lo eliges en su formulario solo para ese run. Los roles desaparecen de .factory/config.ts."
              : `Cambiar aquí no afecta a ${repo.name} en los roles que su config.ts fija: tendrías que editar ese fichero, en el repo, con un commit.`}
          </p>
        </Card>

        <div className="space-y-4">
          <Card className="space-y-2 p-4 text-sm">
            <h2 className="flex items-center gap-2 font-semibold"><Folder className="size-4" /> Workspace</h2>
            <input className={cn(inputClass, "w-full font-mono")} defaultValue="~/factory" />
            <div className="text-muted-foreground">{REPOS.length} repos · {REPOS.filter((r) => r.state !== "ready").length} sin inicializar</div>
          </Card>
          <Card className="space-y-2 p-4 text-sm">
            <h2 className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" /> Credenciales</h2>
            {CREDENTIALS.map((c) => <div key={c.agent}>{c.agent}: <span className="text-muted-foreground">{c.origin}</span></div>)}
          </Card>
          <Card className="space-y-2 p-4 text-sm">
            <h2 className="flex items-center gap-2 font-semibold"><Bell className="size-4" /> Slack</h2>
            <div className="text-muted-foreground">Conectado · avisa de 4 eventos</div>
            <Button variant="ghost">Configurar</Button>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------- Switcher ---------- */

const VARIANTS = [
  { key: "A", name: "Una página", view: VariantA },
  { key: "B", name: "Subsecciones", view: VariantB },
  { key: "C", name: "Por repo, con la regla de config.ts", view: VariantC },
];

export function SettingsPrototype() {
  const [params, setParams] = useSearchParams();
  const index = Math.max(0, VARIANTS.findIndex((v) => v.key === params.get("variant")));
  const current = VARIANTS[index]!;
  const go = (step: number) => setParams({ variant: VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!.key }, { replace: true });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const View = current.view;
  return (
    <>
      <View />
      {import.meta.env.DEV && (
        <div className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit items-center gap-2 rounded-full bg-black px-2 py-1 text-sm text-white shadow-xl">
          <button aria-label="Variante anterior" onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/20"><ArrowLeft className="size-4" /></button>
          <span className="px-2">PROTOTIPO · {current.key} ({current.name})</span>
          <button aria-label="Variante siguiente" onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/20"><ArrowRight className="size-4" /></button>
        </div>
      )}
    </>
  );
}
