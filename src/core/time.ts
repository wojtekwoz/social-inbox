const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const H = HOUR;
export const D = DAY;

/** Compact relative duration: "4m", "2h", "3d". */
export function dur(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MIN))}m`;
  if (ms < 2 * DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

export function age(ts: number, now = Date.now()): string {
  return dur(Math.max(0, now - ts));
}
