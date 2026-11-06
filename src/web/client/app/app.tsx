import { Route, Routes } from "react-router";
import { HomePage } from "./pages/home.tsx";
import { NotFound, NotYet } from "./pages/notices.tsx";
import { RunPage } from "./pages/run.tsx";
import { NAV, Shell } from "./shell.tsx";

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:runId" element={<RunPage />} />
        {NAV.filter((item) => item.path !== "/").map((item) => (
          <Route key={item.path} path={item.path} element={<NotYet title={item.label} />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
