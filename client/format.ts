export function percent(value: number | null): string {
  return value === null ? "no data" : `${Math.round(value * 100)}%`;
}

export function duration(seconds: number | null): string {
  if (seconds === null) return "no data";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function dateTime(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Sentence-case label for a machine state such as `suspected_fixed`. */
export function label(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
