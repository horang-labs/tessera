export function TesseraMark() {
  return (
    <span aria-hidden="true" className="grid h-7 w-7 grid-cols-2 gap-0.5 border border-(--input-border) bg-(--input-bg) p-1">
      <span className="bg-(--accent)" />
      <span className="bg-(--text-muted)" />
      <span className="bg-(--text-muted)" />
      <span className="bg-(--accent)" />
    </span>
  );
}
