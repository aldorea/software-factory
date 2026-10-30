import type { EnvFacts } from "./env-facts.ts";
import type { SetupLine } from "./setup-render.ts";
import type { Credentials } from "../config/credentials.ts";
import type { AgentKind } from "../workers/types.ts";

export interface NextStepsFacts {
  image: string;
  env: EnvFacts;
  agents: AgentKind[];
  credentials: Credentials;
  workerImagePresent: boolean;
}

interface Step {
  done: boolean;
  lead?: string;
  command?: string;
  note?: string;
}

const NOTE_COLUMN = 22;

function padded(command: string, description: string): string {
  return `${" ".repeat(Math.max(1, NOTE_COLUMN - command.length))}${description}`;
}

function steps(facts: NextStepsFacts): Step[] {
  const { variables: envVariables, values: envValues } = facts.env;
  const envDone = envValues !== null && envVariables.every((name) => (envValues[name] ?? "") !== "");
  return [
    ...(envVariables.length === 0
      ? []
      : [{ done: envDone, lead: `fill .factory/.env (copy of .env.example: ${envVariables.join(", ")})` }]),
    {
      done: facts.agents.every((agent) => Boolean(facts.credentials[agent])),
      command: "factory auth",
      note: padded("factory auth", "set the credential of each agent, once for every repo"),
    },
    {
      done: facts.workerImagePresent,
      command: "factory image",
      note: padded("factory image", `build the base image and ${facts.image}`),
    },
    { done: false, command: "factory doctor", note: padded("factory doctor", "check that everything is ready") },
    { done: false, command: "factory refine <n>" },
  ];
}

function renderStep(step: Step, number: number): SetupLine {
  if (step.done) return { kind: "ok", text: `${number}. ${step.lead ?? `${step.command}${step.note ?? ""}`}` };
  if (step.command === undefined) return { kind: "text", text: `  ${number}. ${step.lead ?? ""}` };
  return { kind: "text", text: `  ${number}. `, command: step.command, ...(step.note ? { note: step.note } : {}) };
}

export function nextSteps(facts: NextStepsFacts): SetupLine[] {
  return [{ kind: "title", text: "Next:" }, ...steps(facts).map((step, index) => renderStep(step, index + 1))];
}
