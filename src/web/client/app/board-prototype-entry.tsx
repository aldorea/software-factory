import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { BoardPrototype } from "./pages/board-prototype.tsx";
import { Shell } from "./shell.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter initialEntries={["/board?variant=A"]}>
      <Shell>
        <BoardPrototype />
      </Shell>
    </MemoryRouter>
  </StrictMode>,
);
