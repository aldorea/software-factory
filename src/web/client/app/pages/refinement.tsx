import { Square, Wrench } from "lucide-react";
import { useContext, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiOrigin, usePoll, type RefinementConversation, type TurnMessage } from "../api.ts";
import { ActionStateBadge, post } from "../components/action-panel.tsx";
import { OfflineNotice } from "../components/offline-notice.tsx";
import { Section } from "../components/section.tsx";
import { Button } from "../components/ui/button.tsx";
import { duration } from "../format.ts";
import { NotFound } from "./notices.tsx";

function Message({ message }: { message: TurnMessage }) {
  if (message.kind === "tool") {
    return (
      <li aria-label="Herramienta" className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <Wrench className="size-3 shrink-0" />
        <span className="truncate">{message.text}</span>
      </li>
    );
  }
  if (message.kind === "end") {
    return <li className="text-xs text-muted-foreground">{message.text === "completed" ? "Fin del turno" : "El turno falló"}</li>;
  }
  return <li className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{message.text}</li>;
}

function AnswerForm({ issue, started }: { issue: number; started: boolean }) {
  const origin = useContext(ApiOrigin);
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    const agent = model.trim() === "" ? {} : { agent: { agent: "claude-code", model: model.trim() } };
    const sent = await post(origin, "/api/actions", { command: "refine", issue, ...agent, ...(started ? { answer } : {}) });
    setSending(false);
    if (sent.ok) {
      setAnswer("");
      setError(null);
    } else setError(sent.error);
  };
  return (
    <div className="space-y-3">
      {started && (
        <textarea
          aria-label="Respuesta"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={6}
          className="w-full rounded-md border bg-background p-2 text-sm"
        />
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Modelo de Claude Code (vacío: el de la configuración)
        <input
          aria-label="Modelo"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="rounded-md border bg-background px-2 py-1 font-mono text-xs"
        />
      </label>
      {error !== null && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <Button onClick={() => void send()} disabled={sending || (started && answer.trim() === "")}>
        {started ? "Responder" : "Empezar el refinamiento"}
      </Button>
    </div>
  );
}

function CurrentTurn({ conversation }: { conversation: RefinementConversation }) {
  const origin = useContext(ApiOrigin);
  const [error, setError] = useState<string | null>(null);
  const current = conversation.current;
  if (current === null) return null;
  const stop = async () => {
    const answer = await post(origin, `/api/actions/${encodeURIComponent(current.id)}/stop`, {});
    setError(answer.ok ? null : answer.error);
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <ActionStateBadge action={current} />
      {current.state.kind === "running" && <span className="text-muted-foreground">{duration(current.state.elapsedMs)}</span>}
      <Link to={{ search: `?action=${encodeURIComponent(current.id)}` }} className="text-primary hover:underline">
        Salida
      </Link>
      {current.canStop && (
        <Button variant="ghost" className="ml-auto border" onClick={() => void stop()}>
          <Square />
          Stop
        </Button>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

export function RefinementPage() {
  const { issue: issueParam } = useParams();
  const issue = /^[1-9][0-9]*$/.test(issueParam ?? "") ? Number(issueParam) : null;
  const { data, failed } = usePoll<RefinementConversation>(`/api/refinements/${issue ?? 0}`);
  if (issue === null) return <NotFound />;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{`Refinamiento de #${issue}`}</h1>
      {failed && <OfflineNotice />}
      {data === null ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <Section title="Mensajes">
            <div role="log" aria-label="Conversación" className="space-y-4">
              {data.turns.length === 0 && <p className="text-muted-foreground">Todavía no hay ningún turno.</p>}
              {data.turns.map((turn) => (
                <ul key={turn.id} className="space-y-2">
                  {turn.messages.map((message, index) => (
                    <Message key={index} message={message} />
                  ))}
                </ul>
              ))}
            </div>
          </Section>
          <CurrentTurn conversation={data} />
          {data.current === null && <AnswerForm issue={issue} started={data.started} />}
        </>
      )}
    </div>
  );
}
