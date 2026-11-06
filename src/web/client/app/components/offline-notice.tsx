export function OfflineNotice() {
  return (
    <p role="status" className="rounded-md border border-warn/40 bg-warn/15 px-3 py-2 text-sm text-warn">
      Sin conexión con factory web; se vuelve a intentar cada 2 s.
    </p>
  );
}
