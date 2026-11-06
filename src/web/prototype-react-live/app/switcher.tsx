import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight, Braces, X } from "lucide-react";
import { useLiveData } from "./shared";

export function PrototypeSwitcher({ variants, names }: { variants: string[]; names: Record<string, string> }) {
  const [params, setParams] = useSearchParams();
  const current = params.get("variant") ?? variants[0]!;
  const [showState, setShowState] = useState(false);
  const live = useLiveData();
  const go = (delta: number) => {
    const index = (variants.indexOf(current) + delta + variants.length) % variants.length;
    const next = new URLSearchParams(params);
    next.set("variant", variants[index]!);
    next.delete("agent");
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, [contenteditable]") !== null)) return;
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!import.meta.env.DEV) return null;
  return (
    <>
      {showState && (
        <div className="fixed inset-x-4 bottom-20 top-16 z-[60] mx-auto max-w-3xl overflow-auto rounded-xl border border-zinc-700 bg-zinc-950 p-4 font-mono text-[11px] leading-relaxed text-zinc-200 shadow-2xl">
          <div className="mb-2 flex items-center justify-between font-sans text-xs text-zinc-400">
            <span>Estado completo de /api/live (lo que recibe React en cada sondeo)</span>
            <button className="cursor-pointer" onClick={() => setShowState(false)}>
              <X className="size-4" />
            </button>
          </div>
          <pre>{JSON.stringify(live.data, null, 2)}</pre>
        </div>
      )}
      <div className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-1 rounded-full border-2 border-fuchsia-500 bg-zinc-950 px-2 py-1.5 font-sans text-sm text-white shadow-2xl">
        <span className="px-2 text-[10px] font-bold uppercase tracking-widest text-fuchsia-400">prototype</span>
        <button className="cursor-pointer rounded-full p-1 hover:bg-zinc-800" onClick={() => go(-1)} aria-label="Variante anterior">
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-52 text-center">
          <b>{current}</b> <span className="text-zinc-400">({names[current]})</span>
        </span>
        <button className="cursor-pointer rounded-full p-1 hover:bg-zinc-800" onClick={() => go(1)} aria-label="Variante siguiente">
          <ChevronRight className="size-4" />
        </button>
        <button className={`ml-1 cursor-pointer rounded-full p-1 hover:bg-zinc-800 ${showState ? "text-fuchsia-400" : ""}`} onClick={() => setShowState((v) => !v)} aria-label="Ver estado">
          <Braces className="size-4" />
        </button>
      </div>
    </>
  );
}
