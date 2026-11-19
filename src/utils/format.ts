export function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatProgressBytes(completed: number | null, total: number | null): string {
  if (completed == null && total == null) return 'Preparing download...';
  const doneStr = completed != null ? formatGiB(completed) : '0.0 GiB';
  if (total != null && total > 0) {
    const pct = Math.min(100, Math.round(((completed ?? 0) / total) * 100));
    return `${doneStr} / ${formatGiB(total)} (${pct}%)`;
  }
  return doneStr;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
