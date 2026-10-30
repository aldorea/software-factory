const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

export type SetupLine =
  | { kind: "ok" | "fail" | "warn"; text: string; command?: string }
  | { kind: "title"; text: string }
  | { kind: "text"; text: string; command?: string };

const MARKS = { ok: { mark: "✓", code: 92 }, fail: { mark: "✗", code: 91 }, warn: { mark: "⚠", code: 93 } } as const;
const CYAN = 96;

export function colorEnabled({ stdout, noColor }: { stdout: boolean; noColor: string | undefined }): boolean {
  return stdout && (noColor === undefined || noColor === "");
}

function strong(code: number, text: string, color: boolean): string {
  return color ? `${ESC}[1;${code}m${text}${RESET}` : text;
}

function renderLine(line: SetupLine, color: boolean): string {
  if (line.kind === "title") return color ? `${ESC}[1m${line.text}${RESET}` : line.text;
  if (line.kind === "text") {
    return line.command === undefined ? line.text : `${line.text}${strong(CYAN, line.command, color)}`;
  }
  const { mark, code } = MARKS[line.kind];
  const head = `${strong(code, mark, color)} ${line.text}`;
  return line.command === undefined ? head : `${head} → ${strong(CYAN, line.command, color)}`;
}

export function renderSetup(lines: SetupLine[], color: boolean): string[] {
  return lines.map((line) => renderLine(line, color));
}
