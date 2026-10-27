import { createInterface } from "node:readline/promises";
import type { RoleChoice } from "../config/config.ts";
import type { AgentKind } from "../workers/types.ts";
import type { RoleQuestion } from "./main.ts";

const ROLE_NAMES = { workers: "the workers", verifier: "the independent verifier", tester: "the acceptance tester" } as const;

export async function askRoleInTerminal(question: RoleQuestion): Promise<RoleChoice> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const { role, offered, preselected } = question;
    const preselectedAgent = preselected !== undefined && offered.includes(preselected.agent) ? preselected.agent : offered[0];
    let agent: AgentKind | undefined;
    while (agent === undefined) {
      const answer = (await terminal.question(`Agent of ${ROLE_NAMES[role]} (${offered.join(", ")}) [${preselectedAgent ?? ""}]: `)).trim();
      const picked = answer === "" ? preselectedAgent : answer;
      agent = offered.find((kind) => kind === picked);
    }
    const modelDefault = preselected?.agent === agent ? preselected.model : "";
    let model = "";
    while (model === "") {
      model = (await terminal.question(`Model of ${ROLE_NAMES[role]} [${modelDefault}]: `)).trim() || modelDefault;
    }
    return { agent, model };
  } finally {
    terminal.close();
  }
}
