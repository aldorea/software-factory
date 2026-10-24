import { readFile } from "node:fs/promises";

export function renderTemplate(template: string, values: Record<string, string>): string {
  const missing = new Set<string>();
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) missing.add(key);
    return value ?? "";
  });
  if (missing.size > 0) throw new Error(`the prompt template needs ${[...missing].join(", ")}`);
  return rendered;
}

export function readPromptTemplate(name: string): Promise<string> {
  return readFile(new URL(`./${name}.md`, import.meta.url), "utf8");
}
