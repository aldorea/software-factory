// PROTOTYPE (throwaway, branch prototype/web-react-live): three variants of the shell and of the Live page of factory web,
// plus the run page re-skinned, switchable with ?variant=A|B|C|D on the real routes (/live, /, /runs/:runId).
import { StrictMode, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useSearchParams } from "react-router";
import { TooltipProvider } from "./components/ui/tooltip";
import { RunPage, RunsPage, type LiveView } from "./pages";
import { LiveProvider, useLiveData } from "./shared";
import { PrototypeSwitcher } from "./switcher";
import * as A from "./variants/a-console";
import * as B from "./variants/b-terminal";
import * as C from "./variants/c-focus";
import * as D from "./variants/d-combined";
import "./styles.css";

interface Variant {
  name: string;
  Shell: ComponentType<{ children: ReactNode }>;
  Live: LiveView;
  dense?: boolean;
}

const VARIANTS: Record<string, Variant> = { A, B: { ...B, dense: true }, C, D };
const KEYS = Object.keys(VARIANTS);
const NAMES = Object.fromEntries(KEYS.map((key) => [key, VARIANTS[key]!.name]));

function LivePage({ Live }: { Live: LiveView }) {
  const { data } = useLiveData();
  return <Live runs={data?.runs ?? []} scope="global" />;
}

function App() {
  const [params] = useSearchParams();
  const key = params.get("variant") ?? "A";
  const variant = VARIANTS[key] ?? VARIANTS.A!;
  const { Shell, Live } = variant;
  return (
    <>
      <Shell key={key}>
        <Routes>
          <Route path="/live" element={<LivePage Live={Live} />} />
          <Route path="/" element={<RunsPage dense={variant.dense ?? false} />} />
          <Route path="/runs/:runId" element={<RunPage Live={Live} />} />
          <Route path="*" element={<p>404</p>} />
        </Routes>
      </Shell>
      <PrototypeSwitcher variants={KEYS} names={NAMES} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <LiveProvider>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </LiveProvider>
    </BrowserRouter>
  </StrictMode>,
);
