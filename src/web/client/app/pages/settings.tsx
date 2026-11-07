import { useContext, useEffect, useState } from "react";
import { ApiOrigin, type AuthPage } from "../api.ts";
import { ActionLink } from "../components/action-panel.tsx";
import { Section } from "../components/section.tsx";

function useAuthPage(): AuthPage | null {
  const origin = useContext(ApiOrigin);
  const [page, setPage] = useState<AuthPage | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(`${origin}/api/auth`)
      .then((response) => response.json() as Promise<AuthPage>)
      .then((data) => {
        if (alive) setPage(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [origin]);
  return page;
}

export function SettingsPage() {
  const page = useAuthPage();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Section title="Credenciales">
        {page === null && <p className="text-muted-foreground">Cargando…</p>}
        {page?.problem != null && (
          <p className="text-warn">
            {page.problem.problem}
            {page.problem.fix !== undefined && <code className="ml-2 font-mono text-xs">{page.problem.fix}</code>}
          </p>
        )}
        {page !== null && (
          <table className="w-full text-left">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Agente</th>
                <th className="py-2 pr-4 font-medium">Variable</th>
                <th className="py-2 pr-4 font-medium">Origen</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {page.agents.map((row) => (
                <tr key={row.agent} className="border-t align-top">
                  <td className="py-2 pr-4">{row.agent}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{row.variable}</td>
                  <td className="py-2 pr-4">
                    {row.origin}
                    <p className="text-xs text-muted-foreground">{`${row.how}. Roles: ${row.roles.join(", ")}.`}</p>
                  </td>
                  <td className="py-2 text-right">
                    <ActionLink command="auth" extra={{ agent: row.agent }}>{`factory auth ${row.agent}`}</ActionLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {page?.path != null && <p className="text-xs text-muted-foreground">{`Se guardan en ${page.path} y sirven a cada repo.`}</p>}
      </Section>
    </div>
  );
}
