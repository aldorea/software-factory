import { Link } from "react-router";

export function NotYet({ title }: { title: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">Esta página todavía no existe.</p>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">Página no encontrada</h1>
      <p className="text-sm text-muted-foreground">
        Esta dirección no es ninguna página de factory web.{" "}
        <Link to="/" className="text-primary hover:underline">
          Volver a Runs
        </Link>
      </p>
    </div>
  );
}
