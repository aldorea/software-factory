export interface VerifierQuestion {
  id: string;
  criterion: string;
  test: string;
  logPath: string;
}

export type VerifierAnswer =
  | { kind: "accept" }
  | { kind: "refute"; reason: string }
  | { kind: "error"; message: string };

export interface Verifier {
  judge(question: VerifierQuestion): Promise<VerifierAnswer>;
}
