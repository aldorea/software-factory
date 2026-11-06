import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { Activity, LayoutDashboard, ListChecks, Play, Settings, type LucideIcon } from "lucide-react";
import { useLive, type LiveRun, type Polled, type LiveResponse } from "./api";

export const LiveContext = createContext<Polled<LiveResponse> | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const live = useLive();
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLiveData(): Polled<LiveResponse> {
  const value = useContext(LiveContext);
  if (value === null) throw new Error("no LiveProvider");
  return value;
}

export function useActiveAgents(): number {
  const { data } = useLiveData();
  return data?.runs.flatMap((run) => run.cards).filter((card) => card.state === "working" || card.state === "silent").length ?? 0;
}

export function useVariantHref(): (path: string) => string {
  const [params] = useSearchParams();
  const variant = params.get("variant");
  return (path) => (variant === null ? path : `${path}${path.includes("?") ? "&" : "?"}variant=${variant}`);
}

export function VLink({ to, ...props }: Omit<Parameters<typeof Link>[0], "to"> & { to: string }) {
  const href = useVariantHref();
  return <Link to={href(to)} {...props} />;
}

export interface NavItem {
  label: string;
  path: string | null;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
}

export const NAV: NavItem[] = [
  { label: "Live", path: "/live", icon: Activity, match: (p) => p === "/live" },
  { label: "Board", path: null, icon: LayoutDashboard, match: () => false },
  { label: "Runs", path: "/", icon: ListChecks, match: (p) => p === "/" || p.startsWith("/runs/") },
  { label: "Web actions", path: null, icon: Play, match: () => false },
  { label: "Settings", path: null, icon: Settings, match: () => false },
];

export function useNavActive(): (item: NavItem) => boolean {
  const { pathname } = useLocation();
  return (item) => item.match(pathname);
}

export type Theme = "light" | "dark";

export function useTheme(fallback: Theme, key: string): [Theme, () => void] {
  const storageKey = `proto-theme-${key}`;
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "light" || saved === "dark") return saved;
    } catch {}
    return fallback;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  return [
    theme,
    () =>
      setTheme((current) => {
        const next = current === "dark" ? "light" : "dark";
        try {
          localStorage.setItem(storageKey, next);
        } catch {}
        return next;
      }),
  ];
}

export function LiveIndicator({ className = "" }: { className?: string }) {
  const { polling, fetchedAt, error } = useLiveData();
  const [, force] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const age = fetchedAt === null ? null : Math.round((Date.now() - fetchedAt) / 1000);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs text-muted-foreground ${className}`}>
      <span className={`size-2 rounded-full ${error ? "bg-bad" : polling ? "bg-ok animate-pulse" : "bg-muted-foreground/40"}`} />
      {error ? "sin conexión" : polling ? `en vivo · cada 2 s${age !== null && age > 2 ? ` · hace ${age}s` : ""}` : "sin nada en curso · sin sondeo"}
    </span>
  );
}

export function filterRun(runs: LiveRun[], runId: string): LiveRun[] {
  return runs.filter((run) => run.runId === runId);
}
