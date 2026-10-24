const CRITERIA_HEADING = /^(#{1,6})\s+acceptance criteria\s*$/i;
const CRITERION_ITEM = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?\**(A\d+)\b/;

export function criteriaSection(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => CRITERIA_HEADING.test(line));
  if (start === -1) return null;
  const level = CRITERIA_HEADING.exec(lines[start] ?? "")?.[1]?.length ?? 1;
  const nextHeading = new RegExp(`^#{1,${level}}\\s`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => nextHeading.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

export function issueCriteria(body: string): string[] | null {
  const section = criteriaSection(body);
  if (section === null) return null;
  return section.split("\n").flatMap((line) => {
    const id = CRITERION_ITEM.exec(line)?.[1];
    return id ? [id] : [];
  });
}
