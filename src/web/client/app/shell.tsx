import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import { Activity, Factory, LayoutDashboard, ListChecks, Moon, Settings, Sun, type LucideIcon } from "lucide-react";
import { ActionPanel } from "./components/action-panel.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { useLive } from "./live-data.tsx";
import { cn } from "./cn.ts";

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

export const NAV: readonly NavItem[] = [
  { label: "Live", path: "/live", icon: Activity },
  { label: "Board", path: "/board", icon: LayoutDashboard },
  { label: "Runs", path: "/", icon: ListChecks },
  { label: "Settings", path: "/settings", icon: Settings },
];

type Theme = "light" | "dark";

const THEME_KEY = "factory-web-theme";

function savedTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return [theme, () => setTheme((current) => (current === "dark" ? "light" : "dark"))];
}

function LiveIndicator() {
  const { data } = useLive();
  if (data === null || !data.inProgress) return null;
  return <span role="img" aria-label="Actualizando en directo" className="size-2 animate-pulse rounded-full bg-info" />;
}

function AtWork() {
  const { data } = useLive();
  if (data === null || data.atWork === 0) return null;
  return (
    <Badge tone="info" className="ml-auto" title="Agentes trabajando">
      {data.atWork}
    </Badge>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [theme, toggle] = useTheme();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Factory className="size-4" />
          </div>
          <div className="text-sm font-semibold leading-tight">factory web</div>
        </div>
        <nav aria-label="Menú" className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.label}
              to={item.path}
              end
              className={({ isActive }) =>
                cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-accent", isActive && "bg-accent font-medium text-foreground")
              }
            >
              <item.icon className="size-4" />
              {item.label}
              {item.path === "/live" && (
                <>
                  <LiveIndicator />
                  <AtWork />
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-end border-t px-4 py-3">
          <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === "dark" ? "Tema claro" : "Tema oscuro"}>
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-6 pb-24">
        <div className="mx-auto max-w-[90rem]">{children}</div>
      </main>
      <ActionPanel />
    </div>
  );
}
