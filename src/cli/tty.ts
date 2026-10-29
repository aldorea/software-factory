export interface TerminalFeatures {
  screen: boolean;
  menu: boolean;
}

export function terminalFeatures({ stdout, stdin }: { stdout: boolean; stdin: boolean }): TerminalFeatures {
  return { screen: stdout, menu: stdout && stdin };
}
