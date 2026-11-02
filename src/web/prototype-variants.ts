// PROTOTYPE (throwaway, branch prototype/web-run-causes): three variants of the run page and of the home page,
// switchable with ?variant=A|B|C. Answers "what should the cause summary and the live activity look like?".
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { attemptAbandoned, lastChange, runStatus } from "../coordinator/abandoned.ts";
import type { RunEntry } from "../coordinator/run-history.ts";
import { isUnpublished, type AttemptRecord, type CheckRecord, type RunLog, type SubtaskRecord } from "../coordinator/run-log.ts";
import { countedTokens } from "../coordinator/stop-rules.ts";
import { claudeCodeAdapter } from "../workers/claude-code.ts";
import { openCodeAdapter } from "../workers/opencode.ts";
import type { ActivityEvent } from "../workers/types.ts";
import { anchor, badge, escapeHtml, link, page } from "./html.ts";
import type { LogUrl } from "./log-path.ts";
import { relativeTime } from "./relative-time.ts";
import { runView } from "./run-view.ts";
import { homeView, type HomeData } from "./home-view.ts";

export const VARIANTS = ["A", "B", "C"] as const;
export type Variant = (typeof VARIANTS)[number];
const NAMES: Record<Variant, string> = { A: "Resumen arriba", B: "Panel lateral", C: "Línea de tiempo" };
const HOME_NAMES: Record<Variant, string> = { A: "Tabla + causa", B: "Grupos por atención", C: "Lista compacta" };

export function parseVariant(value: string | null): Variant | null {
  return VARIANTS.find((variant) => variant === value) ?? null;
}

type Cause = { tone: "bad" | "warn" | "info"; where: string; what: string; detail?: string; evidence?: { url: string; text: string }; next?: string; nextNote?: string };

function failingChecks(checks: readonly CheckRecord[], logUrl: LogUrl): { text: string; url: string | null }[] {
  return checks.filter((check) => !check.passed).map((check) => ({ text: `check ${check.name}${check.firstError ? `: ${check.firstError}` : ""}`, url: logUrl(check.outputLog) }));
}

function lastAttempt(subtask: SubtaskRecord): AttemptRecord | undefined {
  return subtask.attempts.at(-1);
}

function subtaskCause(subtask: SubtaskRecord, issue: number, logUrl: LogUrl): Cause {
  const type = subtask.blockType ?? subtask.block?.type ?? "blocked";
  const reason = subtask.reason ?? subtask.block?.reason ?? "sin motivo";
  const scope = type === "scope";
  return {
    tone: "bad",
    where: `Subtarea ${subtask.id}`,
    what: `bloqueada (${type})`,
    detail: subtask.block?.lastFailure ?? reason,
    ...(scope
      ? { nextNote: "Revisa los scope paths de la spec o autoriza el fichero; después vuelve a lanzar el run." }
      : { next: `factory run ${issue}` }),
  };
}

export function runCauses(entry: RunEntry, now: Date, logUrl: LogUrl): Cause[] {
  const { log } = entry;
  const causes: Cause[] = [];
  const status = runStatus(entry, now);
  if (status === "abandoned") {
    causes.push({ tone: "warn", where: "Run", what: "abandonado", detail: `Sin cambios desde hace ${relativeTime(lastChange(entry), now)}: el proceso de factory run ya no está.`, next: `factory run ${log.issue}` });
  }
  if (log.result === "paused") {
    causes.push({ tone: "info", where: "Run", what: "pausado", detail: `${log.pauseReason ?? "motivo desconocido"}. Reset del plan limit: ${log.resetsAt ?? "desconocido"}.`, next: `factory run ${log.issue}` });
  }
  if (isUnpublished(log)) {
    causes.push({ tone: "bad", where: "Publicación", what: `falló en ${log.publicationFailure.phase}`, detail: log.publicationFailure.message, next: `factory publish ${log.issue}` });
  }
  if (log.block) {
    const check = log.block.type === "default-branch-conflict" ? undefined : failingChecks(log.block.checks, logUrl)[0];
    causes.push({ tone: "bad", where: "Run", what: `bloqueado (${log.block.type})`, detail: log.block.reason, ...(check?.url ? { evidence: { url: check.url, text: check.text } } : {}) });
  }
  for (const subtask of log.subtasks) if (subtask.state === "blocked") causes.push(subtaskCause(subtask, log.issue, logUrl));
  const verification = log.verification;
  if (verification && !verification.passed) {
    for (const check of failingChecks(verification.checks, logUrl)) {
      causes.push({ tone: "bad", where: "Integrated verification", what: "falla un check", detail: check.text, evidence: { url: "#checks", text: "ver la salida" }, next: `factory run ${log.issue}` });
    }
    for (const criterion of verification.criteria.filter((item) => !item.passed)) {
      causes.push({ tone: "bad", where: "Integrated verification", what: `falla el criterio ${criterion.id}`, evidence: { url: `#${criterion.id}`, text: `ver la salida de ${criterion.id}` }, next: `factory run ${log.issue}` });
    }
    const tester = verification.tester;
    if (tester?.error) causes.push({ tone: "bad", where: "Acceptance tester", what: "error", detail: tester.error, evidence: { url: "#tester", text: "ver las evidencias del tester" }, next: `factory run ${log.issue}` });
    for (const verdict of tester?.verdicts.filter((item) => !item.passed) ?? []) {
      causes.push({ tone: "bad", where: "Acceptance tester", what: `falla ${verdict.id}`, detail: verdict.observation, evidence: { url: `#${verdict.id}`, text: `ver las evidencias de ${verdict.id}` }, next: `factory run ${log.issue}` });
    }
  }
  if (causes.length === 0 && log.result === "draft" && log.criteria.human.length > 0) {
    causes.push({ tone: "info", where: "Criterios human", what: `${log.criteria.human.length} por revisar a mano`, detail: log.criteria.human.join(", ") });
  }
  return causes;
}

type Activity = { label: string; agent: string; logUrl: string | null; startedAt: string; endedAt?: string; lastChange?: Date; events: { at?: Date; event: ActivityEvent }[]; live: boolean };

function eventText(event: ActivityEvent): string {
  if (event.kind === "message") return event.text;
  if (event.kind === "tool") return event.target ? `${event.tool} ${event.target}` : event.tool;
  return `fin del intento: ${event.outcome}`;
}

function lineTime(line: string): Date | undefined {
  try {
    const value = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    return typeof value === "number" ? new Date(value) : undefined;
  } catch {
    return undefined;
  }
}

async function parseActivity(path: string, agent: string): Promise<{ at?: Date; event: ActivityEvent }[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  const stream = (agent === "opencode" ? openCodeAdapter : claudeCodeAdapter).createStream();
  const events: { at?: Date; event: ActivityEvent }[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    stream.onLine(line);
    const at = lineTime(line);
    for (const event of stream.activity?.(line) ?? []) events.push({ ...(at ? { at } : {}), event });
  }
  return events.slice(-20);
}

export async function readActivity(entry: RunEntry, logUrl: LogUrl): Promise<Activity | null> {
  const { log } = entry;
  const candidates: { label: string; agent: string; path: string; startedAt: string; endedAt?: string; running: boolean }[] = [];
  for (const subtask of log.subtasks) {
    for (const attempt of subtask.attempts) candidates.push({ label: `${subtask.id} · intento ${attempt.number}`, agent: attempt.agent.agent, path: attempt.logPath, startedAt: attempt.startedAt, ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}), running: attempt.outcome === "running" });
  }
  const chosen = candidates.find((candidate) => candidate.running) ?? candidates.filter((candidate) => candidate.path.startsWith("/")).at(-1);
  if (!chosen) return null;
  const events = await parseActivity(chosen.path, chosen.agent);
  const lastChangeOfLog = entry.logTimes.get(chosen.path);
  return { label: chosen.label, agent: chosen.agent, logUrl: logUrl(chosen.path), startedAt: chosen.startedAt, ...(chosen.endedAt ? { endedAt: chosen.endedAt } : {}), ...(lastChangeOfLog ? { lastChange: lastChangeOfLog } : {}), events, live: chosen.running };
}

const PROTO_STYLE = `<style>
.cause{border-left:4px solid var(--line);background:var(--card);border-radius:6px;padding:.6rem .9rem;margin:.5rem 0;border:1px solid var(--line)}
.cause.bad{border-left:4px solid var(--bad)}.cause.warn{border-left:4px solid var(--warn)}.cause.info{border-left:4px solid var(--info)}
.cause .where{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.cause .what{font-weight:600}.cause .detail{margin:.25rem 0;white-space:pre-wrap;max-height:7.5em;overflow:hidden}
code.cmd{background:var(--muted-bg);padding:.1rem .4rem;border-radius:4px;font-size:.85rem}
.feed{font:12.5px/1.5 ui-monospace,monospace;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.5rem .75rem;margin:.5rem 0}
.feed div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.feed .t{color:var(--muted);margin-right:.6rem}.feed .tool{color:var(--accent)}
.live{display:flex;gap:1rem;color:var(--muted);font-size:.85rem}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.4rem .9rem;margin:.5rem 0}summary{cursor:pointer;font-weight:600}
.grid{display:grid;grid-template-columns:18rem 1fr;gap:1.5rem;align-items:start}.side{position:sticky;top:1rem}
.side .box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem}
.tl{border-left:2px solid var(--line);margin-left:.5rem;padding-left:1.25rem}.tl .ev{position:relative;margin:.9rem 0}
.tl .ev::before{content:"";position:absolute;left:-1.62rem;top:.35rem;width:.7rem;height:.7rem;border-radius:50%;background:var(--line)}
.tl .ev.bad::before{background:var(--bad)}.tl .ev.ok::before{background:var(--ok)}.tl .ev.info::before{background:var(--info)}.tl .ev.warn::before{background:var(--warn)}
.tl .when{font-size:.75rem;color:var(--muted)}
.cards{display:grid;gap:.6rem}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem}
.row{display:flex;gap:.75rem;align-items:baseline;padding:.35rem 0;border-bottom:1px solid var(--line)}.row .muted{color:var(--muted);font-size:.85rem}
pre.out{font:12.5px/1.5 ui-monospace,monospace;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;overflow:auto;max-height:28rem;white-space:pre}
pre.out .bad{color:var(--bad);font-weight:600}pre.out .ok{color:var(--ok)}pre.out .hl{background:var(--bad-bg);display:inline-block;width:100%}pre.out .em{font-weight:700}pre.out .dim{color:var(--muted)}
.crit{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem;margin:.5rem 0}.crit .head{margin-bottom:.25rem}.muted{color:var(--muted)}.obs{font-style:italic}
.shots{display:flex;flex-wrap:wrap;gap:.6rem;margin:.5rem 0}.shot{margin:0;width:15rem}.shot img,.shot video{width:100%;border:1px solid var(--line);border-radius:6px}.shot figcaption{font-size:.75rem;color:var(--muted)}
details.file{padding:.2rem .6rem}details.file summary{font-weight:400;font-size:.9rem}
.proto-bar{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:#111;color:#fff;border-radius:999px;padding:.4rem .6rem;display:flex;gap:.6rem;align-items:center;box-shadow:0 4px 18px #0006;font:13px system-ui;z-index:9}
.proto-bar a{color:#fff;padding:0 .5rem;font-size:1.1rem}
@media (max-width:50rem){.grid{grid-template-columns:1fr}.side{position:static}}
</style>`;

function switcher(variant: Variant, names: Record<Variant, string>): string {
  const index = VARIANTS.indexOf(variant);
  const prev = VARIANTS[(index + VARIANTS.length - 1) % VARIANTS.length];
  const next = VARIANTS[(index + 1) % VARIANTS.length];
  return `<div class="proto-bar"><a id="pv" href="?variant=${prev}">←</a><span>PROTOTIPO · ${variant} (${escapeHtml(names[variant])}) · <a href="?" style="font-size:.8rem">actual</a></span><a id="nx" href="?variant=${next}">→</a></div>
<script>addEventListener("keydown",e=>{if(e.target.closest("input,textarea,[contenteditable]"))return;if(e.key==="ArrowLeft")location=document.getElementById("pv").href;if(e.key==="ArrowRight")location=document.getElementById("nx").href;})</script>`;
}

function inject(html: string, extra: string): string {
  return html.replace("</head>", `${PROTO_STYLE}</head>`).replace("</body>", `${extra}</body>`);
}

function causeCard(cause: Cause): string {
  return `<div class="cause ${cause.tone}"><div class="where">${escapeHtml(cause.where)}</div><div class="what">${escapeHtml(cause.what)}</div>${cause.detail ? `<div class="detail">${escapeHtml(cause.detail)}</div>` : ""}${cause.evidence ? `<div>→ ${link(cause.evidence.url, cause.evidence.text)}</div>` : ""}${cause.next ? `<div>Para continuar: <code class="cmd">${escapeHtml(cause.next)}</code></div>` : ""}${cause.nextNote ? `<div>Siguiente paso: ${escapeHtml(cause.nextNote)}</div>` : ""}</div>`;
}

function hhmmss(date: Date): string {
  return date.toISOString().slice(11, 19);
}

function feed(activity: Activity): string {
  const lines = activity.events.map(({ at, event }) => `<div><span class="t">${at ? hhmmss(at) : "··:··:··"}</span><span class="${event.kind}">${escapeHtml(eventText(event))}</span></div>`);
  return `<div class="feed">${lines.join("") || "<div>Sin activity todavía</div>"}</div>`;
}

function activityBlock(activity: Activity | null, now: Date): string {
  if (!activity) return "";
  const note = activity.live ? "" : `<p class="live">(prototipo: ningún intento en curso en estos datos, se muestra el último terminado)</p>`;
  const started = activity.startedAt ? `duración ${relativeTime(new Date(activity.startedAt), activity.endedAt ? new Date(activity.endedAt) : now).replace("hace ", "")}` : "";
  const silent = activity.lastChange ? `última activity ${relativeTime(activity.lastChange, now)}` : "";
  return [
    `<h2>Ahora</h2>`,
    note,
    `<p><strong>${escapeHtml(activity.label)}</strong> · ${escapeHtml(activity.agent)}</p>`,
    `<div class="live"><span>${escapeHtml(started)}</span><span>${escapeHtml(silent)}</span></div>`,
    feed(activity),
  ].join("\n");
}

function header(log: RunLog, status: string, entry: RunEntry, now: Date): string {
  const pr = log.pullRequest ? ` · PR ${anchor(log.pullRequest.url, `#${log.pullRequest.number}`)}${log.pullRequest.draft ? " (draft)" : ""}` : "";
  return `<p><a href="/?variant=A">Runs</a></p><h1>#${escapeHtml(String(log.issue))} ${escapeHtml(log.runId)}</h1><p>${badge(status)} · último cambio ${escapeHtml(relativeTime(entry.modifiedAt, now))}${pr}</p>`;
}

function subtaskSummary(subtask: SubtaskRecord, entry: RunEntry, now: Date, logUrl: LogUrl): string {
  const attempts = subtask.attempts
    .map((attempt) => `<li>Intento ${attempt.number} · ${escapeHtml(attempt.agent.model)} · ${badge(attemptAbandoned(attempt, entry, now) ? "abandoned" : attempt.outcome)} · ${countedTokens(attempt.usage)} tokens${attempt.failure ? `<br><span style="color:var(--bad)">${escapeHtml(attempt.failure.description)}</span>` : ""}</li>`)
    .join("");
  const open = subtask.state !== "merged" ? " open" : "";
  return `<details${open}><summary>${escapeHtml(subtask.id)} ${badge(subtask.state)} <span style="color:var(--muted);font-weight:400">· ${subtask.attempts.length} intentos · criterios ${escapeHtml(subtask.criteria.join(", "))}</span></summary><ul>${attempts}</ul><p>${subtask.gateRejections} rechazos del gate · ${subtask.verifierRejections} del independent verifier</p></details>`;
}

function variantA(entry: RunEntry, now: Date, logUrl: LogUrl, causes: Cause[], activity: Activity | null, evidence: EvidenceFiles): string {
  const { log } = entry;
  const status = runStatus(entry, now);
  const why = causes.length === 0 ? "" : [`<h2>Por qué está así</h2>`, ...causes.map(causeCard)].join("\n");
  const body = [
    header(log, status, entry, now),
    why,
    activityBlock(activity, now),
    verificationEvidence(log, evidence),
    `<h2>Subtareas</h2>`,
    ...log.subtasks.map((subtask) => subtaskSummary(subtask, entry, now, logUrl)),
  ].join("\n");
  return page(`run ${log.runId}`, body);
}

function variantB(entry: RunEntry, now: Date, logUrl: LogUrl, causes: Cause[], activity: Activity | null): string {
  const { log } = entry;
  const status = runStatus(entry, now);
  const next = causes.find((cause) => cause.next)?.next;
  const agents = Object.entries(log.agents)
    .filter(([role]) => role !== "changes")
    .map(([role, choice]) => `<div><span style="color:var(--muted)">${escapeHtml(role)}</span><br>${escapeHtml((choice as { model: string }).model)}</div>`)
    .join("");
  const criteria = `<div>Pasan ${log.criteria.passing.length} · bloqueados ${log.criteria.blocked.length} · human ${log.criteria.human.length} · pendientes ${log.criteria.pending.length}</div>`;
  const side = [
    `<div class="side">`,
    `<div class="box"><p><a href="/?variant=B">← Runs</a></p><h1 style="margin:.25rem 0">#${escapeHtml(String(log.issue))}</h1><p style="font-size:.8rem;color:var(--muted)">${escapeHtml(log.runId)}</p><p>${badge(status)}</p>${log.pullRequest ? `<p>${anchor(log.pullRequest.url, `PR #${log.pullRequest.number}`)}</p>` : ""}</div>`,
    next ? `<div class="box"><h4 style="margin-top:0">Siguiente paso</h4><code class="cmd">${escapeHtml(next)}</code></div>` : "",
    `<div class="box"><h4 style="margin-top:0">Criterios</h4>${criteria}</div>`,
    `<div class="box"><h4 style="margin-top:0">Agentes</h4>${agents}</div>`,
    `</div>`,
  ].join("");
  const main = [
    `<div>`,
    causes.length ? `<h2 style="margin-top:0">${causes.length} ${causes.length === 1 ? "causa" : "causas"}</h2>${causes.map(causeCard).join("")}` : `<h2 style="margin-top:0">Sin problemas</h2>`,
    activityBlock(activity, now),
    `<h2>Subtareas</h2>`,
    `<div class="cards">${log.subtasks.map((subtask) => `<div class="card"><strong>${escapeHtml(subtask.id)}</strong> ${badge(subtask.state)} <span style="color:var(--muted)">· ${subtask.attempts.length} intentos · ${countedTokens(subtask.usage)} tokens</span></div>`).join("")}</div>`,
    `<p style="margin-top:1rem">${link("?", "Ver el detalle completo (vista actual)")}</p>`,
    `</div>`,
  ].join("");
  return page(`run ${log.runId}`, `<div class="grid">${side}${main}</div>`).replace("max-width:60rem", "max-width:76rem");
}

type TimelineEvent = { at: string; tone: "ok" | "bad" | "info" | "warn"; html: string };

function variantC(entry: RunEntry, now: Date, logUrl: LogUrl, causes: Cause[], activity: Activity | null): string {
  const { log } = entry;
  const status = runStatus(entry, now);
  const events: TimelineEvent[] = [];
  for (const subtask of log.subtasks) {
    for (const attempt of subtask.attempts) {
      const url = logUrl(attempt.logPath);
      const outcome = attemptAbandoned(attempt, entry, now) ? "abandoned" : attempt.outcome;
      events.push({ at: attempt.startedAt, tone: "info", html: `<strong>${escapeHtml(subtask.id)}</strong> · empieza el intento ${attempt.number} (${escapeHtml(attempt.agent.model)})` });
      if (attempt.endedAt) events.push({ at: attempt.endedAt, tone: outcome === "completed" ? "ok" : "bad", html: `<strong>${escapeHtml(subtask.id)}</strong> · intento ${attempt.number} ${badge(outcome)} · ${countedTokens(attempt.usage)} tokens${attempt.failure ? `<br>${escapeHtml(attempt.failure.description)}` : ""}${url ? ` · ${link(url, "log")}` : ""}` });
    }
    if (subtask.gate) {
      const lastEnd = subtask.attempts.at(-1)?.endedAt ?? "";
      events.push({ at: lastEnd, tone: subtask.gate.accepted ? "ok" : "bad", html: `<strong>${escapeHtml(subtask.id)}</strong> · gate ${badge(subtask.gate.accepted ? "aceptado" : "rechazado")}` });
    }
  }
  events.sort((left, right) => left.at.localeCompare(right.at));
  if (log.verification) events.push({ at: "", tone: log.verification.passed ? "ok" : "bad", html: `Integrated verification ${badge(log.verification.passed ? "pasa" : "falla")} · SHA ${escapeHtml(log.verification.sha.slice(0, 8))}` });
  const stop = causes.length
    ? `<div class="ev bad"><div class="when">aquí se paró</div>${causes.map(causeCard).join("")}</div>`
    : status === "running"
      ? ""
      : `<div class="ev ok"><div class="when">fin</div>${badge(status)}</div>`;
  const live = activity ? `<div class="ev info"><div class="when">ahora</div>${activityBlock(activity, now).replace("<h2>Ahora</h2>", "")}</div>` : "";
  const timeline = events.map((event) => `<div class="ev ${event.tone}"><div class="when">${event.at ? escapeHtml(event.at.slice(11, 19)) : ""}</div>${event.html}</div>`).join("");
  const body = [header(log, status, entry, now).replace("/?variant=A", "/?variant=C"), `<div class="tl">${timeline}${stop}${live}</div>`].join("\n");
  return page(`run ${log.runId}`, body);
}

export function prototypeRunPage(variant: Variant, entry: RunEntry, now: Date, logUrl: LogUrl, activity: Activity | null, evidence: EvidenceFiles): string {
  const causes = runCauses(entry, now, logUrl);
  const html = variant === "A" ? variantA(entry, now, logUrl, causes, activity, evidence) : { B: variantB, C: variantC }[variant](entry, now, logUrl, causes, activity);
  return inject(html, switcher(variant, NAMES));
}

export function prototypeCurrentRun(entry: RunEntry, now: Date, logUrl: LogUrl): string {
  return runView({ entry, now, logUrl });
}

function shortCause(entry: RunEntry, now: Date): string {
  const cause = runCauses(entry, now, () => null)[0];
  if (!cause) return "";
  return `${cause.where}: ${cause.what}`;
}

type HomeActivity = Map<string, Activity | null>;

function nowText(entry: RunEntry, activities: HomeActivity, now: Date): string {
  const activity = activities.get(entry.dir);
  const last = activity?.events.at(-1);
  if (!activity || !last) return "";
  return `${activity.label.split(" · ")[0]} · ${eventText(last.event)}${activity.lastChange ? ` · ${relativeTime(activity.lastChange, now)}` : ""}`;
}

function runLink(entry: RunEntry, variant: Variant, text: string): string {
  return link(`/runs/${entry.dir}?variant=${variant}`, text);
}

function homeA(data: HomeData, activities: HomeActivity): string {
  const rows = [...data.runs].reverse().map((entry) => {
    const status = runStatus(entry, data.now);
    const extra = status === "running" ? nowText(entry, activities, data.now) : shortCause(entry, data.now);
    return `<tr><td>#${entry.log.issue}</td><td>${runLink(entry, "A", entry.log.runId)}</td><td>${badge(status)}</td><td style="color:var(--muted)">${escapeHtml(extra)}</td><td>${escapeHtml(relativeTime(entry.modifiedAt, data.now))}</td><td>${entry.log.pullRequest ? anchor(entry.log.pullRequest.url, `#${entry.log.pullRequest.number}`) : ""}</td></tr>`;
  });
  return page("factory web", `<h1>Runs</h1><table><thead><tr><th>Issue</th><th>Run ID</th><th>Resultado</th><th>Causa / ahora</th><th>Último cambio</th><th>PR</th></tr></thead><tbody>${rows.join("")}</tbody></table>`);
}

function homeB(data: HomeData, activities: HomeActivity): string {
  const groups: Record<string, RunEntry[]> = { "Necesitan atención": [], "En curso": [], Terminados: [] };
  for (const entry of [...data.runs].reverse()) {
    const status = runStatus(entry, data.now);
    const key = status === "running" ? "En curso" : status === "ready" ? "Terminados" : "Necesitan atención";
    groups[key]?.push(entry);
  }
  const card = (entry: RunEntry): string => {
    const status = runStatus(entry, data.now);
    const line = status === "running" ? nowText(entry, activities, data.now) : shortCause(entry, data.now);
    return `<div class="card"><div>${runLink(entry, "B", `#${entry.log.issue}`)} ${badge(status)} <span style="color:var(--muted);font-size:.8rem">${escapeHtml(entry.log.runId)} · ${escapeHtml(relativeTime(entry.modifiedAt, data.now))}</span></div>${line ? `<div style="margin-top:.25rem">${escapeHtml(line)}</div>` : ""}</div>`;
  };
  const body = Object.entries(groups)
    .filter(([, entries]) => entries.length > 0)
    .map(([title, entries]) => `<h2>${title} <span style="color:var(--muted);font-weight:400">${entries.length}</span></h2><div class="cards">${entries.map(card).join("")}</div>`)
    .join("");
  return page("factory web", `<h1>Runs</h1>${body}`);
}

function homeC(data: HomeData, activities: HomeActivity): string {
  const byIssue = new Map<number, RunEntry[]>();
  for (const entry of [...data.runs].reverse()) byIssue.set(entry.log.issue, [...(byIssue.get(entry.log.issue) ?? []), entry]);
  const body = [...byIssue.entries()]
    .map(([issue, entries]) => {
      const [latest, ...older] = entries as [RunEntry, ...RunEntry[]];
      const status = runStatus(latest, data.now);
      const line = status === "running" ? nowText(latest, activities, data.now) : shortCause(latest, data.now);
      const history = older.map((entry) => runLink(entry, "C", runStatus(entry, data.now))).join(" · ");
      return `<div class="row"><strong>${runLink(latest, "C", `#${issue}`)}</strong>${badge(status)}<span>${escapeHtml(line)}</span><span class="muted">${escapeHtml(relativeTime(lastChange(latest), data.now))}${older.length ? ` · antes: ` : ""}</span>${history ? `<span class="muted">${history}</span>` : ""}</div>`;
    })
    .join("");
  return page("factory web", `<h1>Issues</h1><p style="color:var(--muted)">Un renglón por issue con su último run; los runs anteriores quedan al final.</p>${body}`);
}

export function prototypeHome(variant: Variant, data: HomeData, activities: HomeActivity): string {
  const render = { A: homeA, B: homeB, C: homeC }[variant];
  return inject(render(data, activities), switcher(variant, HOME_NAMES));
}

export { homeView };

export type EvidenceFile = { name: string; url: string; text?: string };
export type EvidenceFiles = { outputs: Map<string, string>; byCriterion: Map<string, EvidenceFile[]>; tester: EvidenceFile[] };

const TEXT_FILE = /\.(txt|log|json|md|mjs|js)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_FILE = /\.(webm|mp4)$/i;

async function filesIn(runDir: string, runId: string, segments: string[]): Promise<EvidenceFile[]> {
  const dir = join(runDir, ...segments);
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: EvidenceFile[] = [];
  for (const dirent of names) {
    if (!dirent.isFile()) continue;
    const url = `/runs/${runId}/${[...segments, dirent.name].map(encodeURIComponent).join("/")}`;
    const text = TEXT_FILE.test(dirent.name) ? await readFile(join(dir, dirent.name), "utf8") : undefined;
    files.push({ name: dirent.name, url, ...(text !== undefined ? { text } : {}) });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readEvidence(entry: RunEntry, runDir: string): Promise<EvidenceFiles> {
  const { log } = entry;
  const outputs = new Map<string, string>();
  const byCriterion = new Map<string, EvidenceFile[]>();
  const verification = log.verification;
  for (const item of [...(verification?.checks ?? []), ...(verification?.criteria ?? [])]) {
    const key = "name" in item ? `check:${item.name}` : item.id;
    if (item.outputLog) outputs.set(key, await readFile(join(runDir, item.outputLog), "utf8").catch(() => ""));
  }
  for (const id of [...(verification?.criteria.map((criterion) => criterion.id) ?? []), ...log.criteria.passing, ...log.criteria.blocked]) {
    if (!byCriterion.has(id)) byCriterion.set(id, await filesIn(runDir, entry.dir, ["tester", "verification", id]));
  }
  return { outputs, byCriterion, tester: await filesIn(runDir, entry.dir, ["tester", "verification"]) };
}

function lineClass(line: string): string {
  if (/✘|^\s*\d+\)|Error:|ERR_|failed|did not run/.test(line)) return "bad";
  if (/✓|passed/.test(line)) return "ok";
  if (/^\s*>\s*\d+\s*\|/.test(line)) return "hl";
  if (/^\s*(Expected|Received)/.test(line)) return "em";
  if (/^\s*\d+\s*\|/.test(line) || /^\s*\|/.test(line) || /^\s+at /.test(line)) return "dim";
  return "";
}

export function formatOutput(text: string): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+$/, "");
  const lines = clean.split("\n").map((line) => {
    const css = lineClass(line);
    return css ? `<span class="${css}">${escapeHtml(line)}</span>` : escapeHtml(line);
  });
  return `<pre class="out">${lines.join("\n")}</pre>`;
}

function fileBlock(file: EvidenceFile): string {
  if (IMAGE_FILE.test(file.name)) return `<figure class="shot"><a href="${escapeHtml(file.url)}"><img src="${escapeHtml(file.url)}" alt="${escapeHtml(file.name)}"></a><figcaption>${escapeHtml(file.name)}</figcaption></figure>`;
  if (VIDEO_FILE.test(file.name)) return `<figure class="shot"><video controls src="${escapeHtml(file.url)}"></video><figcaption>${escapeHtml(file.name)}</figcaption></figure>`;
  if (file.text !== undefined) return `<details class="file"><summary>${escapeHtml(file.name)}</summary>${formatOutput(file.text)}</details>`;
  return `<p>${escapeHtml(file.name)}</p>`;
}

function filesBlock(files: readonly EvidenceFile[]): string {
  const media = files.filter((file) => IMAGE_FILE.test(file.name) || VIDEO_FILE.test(file.name));
  const texts = files.filter((file) => !media.includes(file));
  return [media.length ? `<div class="shots">${media.map(fileBlock).join("")}</div>` : "", ...texts.map(fileBlock)].join("");
}

function verificationEvidence(log: RunLog, evidence: EvidenceFiles): string {
  const verification = log.verification;
  if (!verification) return `<h2>Verificación y evidencias</h2><p>Todavía sin integrated verification.</p>`;
  const checks = verification.checks
    .map((check) => {
      const output = evidence.outputs.get(`check:${check.name}`);
      const body = !check.passed && output ? formatOutput(output) : check.firstError ? `<p>${escapeHtml(check.firstError)}</p>` : "";
      return `<div class="crit"><div class="head"><strong>${escapeHtml(check.name)}</strong> ${badge(check.passed ? "pasa" : "falla")}</div>${body}</div>`;
    })
    .join("");
  const verdicts = new Map((verification.tester?.verdicts ?? []).map((verdict) => [verdict.id, verdict]));
  const criteria = verification.criteria
    .map((criterion) => {
      const verdict = verdicts.get(criterion.id);
      const output = evidence.outputs.get(criterion.id);
      const files = evidence.byCriterion.get(criterion.id) ?? [];
      const videos = files.filter((file) => VIDEO_FILE.test(file.name));
      return [
        `<div class="crit" id="${escapeHtml(criterion.id)}">`,
        `<div class="head"><strong>${escapeHtml(criterion.id)}</strong> <span class="muted">${escapeHtml(criterion.evidence ?? "")}</span> · comando ${badge(criterion.passed ? "pasa" : "falla")} · tester ${verdict ? badge(verdict.passed ? "pasa" : "falla") : badge("sin veredicto")}</div>`,
        verdict ? `<p class="obs">${escapeHtml(verdict.observation)}</p>` : "",
        !criterion.passed && output ? formatOutput(output) : "",
        filesBlock(files),
        criterion.evidence === "playwright" && videos.length === 0 ? `<p class="muted">Vídeo: no está en el run log.</p>` : "",
        `</div>`,
      ].join("");
    })
    .join("");
  const human = verification.humanCriteria.map((criterion) => `<div class="crit"><div class="head"><strong>${escapeHtml(criterion.id)}</strong> ${badge("human")}</div><p>${escapeHtml(criterion.reason)}</p></div>`).join("");
  const tester = verification.tester;
  const testerOwn = evidence.tester;
  const testerBlock = tester
    ? `<h3 id="tester">Acceptance tester · ${escapeHtml(tester.agent.model)}</h3>${tester.error ? `<p style="color:var(--bad)">${escapeHtml(tester.error)}</p>` : ""}${filesBlock(testerOwn)}`
    : "";
  return [
    `<h2>Verificación y evidencias</h2>`,
    `<p class="muted">Integrated verification sobre ${escapeHtml(verification.sha.slice(0, 8))} · ${badge(verification.passed ? "pasa" : "falla")}${verification.environment ? ` · ${escapeHtml(verification.environment)}` : ""}</p>`,
    `<h3 id="checks">Checks</h3>${checks}`,
    `<h3>Criterios</h3>${criteria}${human}`,
    testerBlock,
  ].join("\n");
}
