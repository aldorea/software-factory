import { Route, Routes } from "react-router";
import { LiveProvider } from "./live-data.tsx";
import { HomePage } from "./pages/home.tsx";
import { LivePage } from "./pages/live.tsx";
import { NotFound, NotYet } from "./pages/notices.tsx";
import { RunPage } from "./pages/run.tsx";
import { SettingsPrototype } from "./pages/settings-prototype.tsx";
import { NAV, Shell } from "./shell.tsx";

export function App() {
  return (
    <LiveProvider>
      <Shell>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/runs/:runId" element={<RunPage />} />
          <Route path="/settings" element={<SettingsPrototype />} />
          {NAV.filter((item) => item.path !== "/" && item.path !== "/live" && item.path !== "/settings").map((item) => (
            <Route key={item.path} path={item.path} element={<NotYet title={item.label} />} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Shell>
    </LiveProvider>
  );
}
