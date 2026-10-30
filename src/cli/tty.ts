export interface TerminalFeatures {
  screen: boolean;
  menu: boolean;
}

export function terminalFeatures({ stdout, stdin }: { stdout: boolean; stdin: boolean }): TerminalFeatures {
  return { screen: stdout, menu: stdout && stdin };
}

export function hidesSecret({ stdin }: { stdin: boolean }): boolean {
  return stdin;
}

export interface KeyInput extends NodeJS.ReadableStream {
  setRawMode(mode: boolean): unknown;
}
