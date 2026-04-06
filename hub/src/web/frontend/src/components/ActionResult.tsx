export function ActionResult({ result }: { result: { ok: boolean; message: string } | null }) {
  if (!result) return null;
  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${
      result.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
    }`}>
      {result.message}
    </div>
  );
}
