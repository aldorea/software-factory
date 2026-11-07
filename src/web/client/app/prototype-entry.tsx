import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { SettingsPrototype } from "./pages/settings-prototype.tsx";
import { Shell } from "./shell.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter initialEntries={["/settings?variant=A"]}>
      <Shell>
        <SettingsPrototype />
      </Shell>
    </MemoryRouter>
  </StrictMode>,
);
