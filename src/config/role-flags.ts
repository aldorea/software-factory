import type { Role } from "../workers/agent-adapter.ts";

export const ROLE_FLAGS: Record<Role, string> = {
  workers: "--worker-agent",
  verifier: "--verifier-agent",
  tester: "--tester-agent",
  refinement: "--refinement-agent",
};
