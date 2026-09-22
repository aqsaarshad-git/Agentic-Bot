/** Compact, readable date — "Sep 7, 3:45 PM" instead of a verbose locale string. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "2m ago" / "3h ago" / "5d ago" — falls back to a compact date once it's old enough. */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatDateTime(iso);
}

/** "SCHEDULED_CALLBACK" -> "Scheduled callback" — raw enum values read as noise otherwise. */
export function formatEnumLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Picks a semantic badge color by keyword — one mapping shared by every status/state/priority/outcome column instead of a bespoke table per page. */
export function badgeVariant(value: string | null | undefined): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (!value) return 'neutral';
  const v = value.toUpperCase();
  if (/(FAIL|ESCALAT|SUSPEND|URGENT|CANCEL|ERROR|REJECT)/.test(v)) return 'danger';
  if (/(PENDING|WAITING|PROCESSING|IN_PROGRESS|SCHEDULED|DRAFT|HIGH)/.test(v)) return 'warning';
  if (/(RESOLV|COMPLET|ACTIVE|DONE|SUCCESS|ANSWERED|PUBLISHED|CLOSED)/.test(v)) return 'success';
  if (/(NEW|OPEN|LISTENING|CALL_STARTED|LOW)/.test(v)) return 'info';
  return 'neutral';
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '—';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '—';
  return id.slice(0, length);
}
