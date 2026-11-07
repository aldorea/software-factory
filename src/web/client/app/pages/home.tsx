import { GitPullRequest, Loader2 } from "lucide-react";
import { Link } from "react-router";
import { ActionLink } from "../components/action-panel.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import { OfflineNotice } from "../components/offline-notice.tsx";
import { usePoll, type PullRequestCell, type RunRow, type RunsResponse } from "../api.ts";
import { relativeTime } from "../format.ts";
import { runStatusTone } from "../tones.ts";
import { Statistics } from "./stats.tsx";

function PullRequest({ cell }: { cell: PullRequestCell }) {
  if (cell.kind === "none") return <span className="text-muted-foreground">—</span>;
  if (cell.kind === "not-published") return <Badge tone="bad">not published</Badge>;
  const label = `#${cell.number}`;
  if (cell.url === null) return <span>{label}</span>;
  return (
    <a href={cell.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
      <GitPullRequest className="size-3.5" />
      {label}
    </a>
  );
}

function Row({ row, now }: { row: RunRow; now: string }) {
  return (
    <tr className="border-t hover:bg-accent/50">
      <td className="px-4 py-3">#{row.issue}</td>
      <td className="px-4 py-3 font-mono text-xs">
        {row.href === null ? row.runId : (
          <Link to={row.href} className="text-primary hover:underline">
            {row.runId}
          </Link>
        )}
      </td>
      <td className="px-4 py-3">
        <Badge tone={runStatusTone(row.status)}>
          {row.status === "running" && <Loader2 className="animate-spin" />}
          {row.status}
        </Badge>
      </td>
      <td className="px-4 py-3 text-muted-foreground">{relativeTime(row.modifiedAt, now)}</td>
      <td className="px-4 py-3">
        <PullRequest cell={row.pullRequest} />
      </td>
      <td className="px-4 py-3 text-muted-foreground">{row.line ?? ""}</td>
    </tr>
  );
}

function Runs({ data }: { data: RunsResponse }) {
  if (data.runs.length === 0) {
    return <p className="text-sm text-muted-foreground">Todavía no hay runs: .factory/logs no tiene ficheros run.json.</p>;
  }
  return (
    <Card className="overflow-hidden">
      <table aria-label="Lista de runs" className="w-full text-sm">
        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Issue</th>
            <th className="px-4 py-2 font-medium">Run ID</th>
            <th className="px-4 py-2 font-medium">Resultado</th>
            <th className="px-4 py-2 font-medium">Último cambio</th>
            <th className="px-4 py-2 font-medium">Pull request</th>
            <th className="px-4 py-2 font-medium">Causa o último evento</th>
          </tr>
        </thead>
        <tbody>
          {data.runs.map((row) => (
            <Row key={row.runId} row={row} now={data.now} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Unreadable({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  return (
    <section aria-label="run.json ilegibles" className="space-y-2">
      <h2 className="text-lg font-semibold">run.json ilegibles</h2>
      <ul className="list-disc pl-5 font-mono text-xs">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </section>
  );
}

export function HomePage() {
  const { data, failed } = usePoll<RunsResponse>("/api/runs");
  return (
    <div className="space-y-6">
      {failed && <OfflineNotice />}
      {data === null ? (
        !failed && <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          {data.stats !== null && <Statistics stats={data.stats} />}
          <section aria-label="Runs" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="mr-auto text-xl font-semibold">Runs</h1>
              {(["doctor", "image", "init"] as const).map((command) => (
                <ActionLink key={command} command={command}>{`factory ${command}`}</ActionLink>
              ))}
            </div>
            <Runs data={data} />
          </section>
          <Unreadable files={data.unreadable} />
        </>
      )}
    </div>
  );
}
