import { badgeVariant, formatEnumLabel } from './format';

/** Renders an enum-like status value (e.g. "ESCALATING", "COMPLETED") as a color-coded pill
 *  with a human-readable label, instead of the raw SCREAMING_SNAKE_CASE string in flat gray. */
export function StatusBadge({ value }: { value: string | null | undefined }) {
  return <span className={`badge badge-${badgeVariant(value)}`}>{formatEnumLabel(value)}</span>;
}
