/** Pure formatting helpers, no OBS/Electron dependency. */

/** Format a duration in milliseconds as HH:MM:SS, matching the status
 * strip's "● LIVE 00:42:13". Always zero-padded, hours can exceed 99. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Format a price string for the item bar / SOLD banner. Accepts digits and
 * an optional decimal point already typed by the seller; just prefixes a
 * dollar sign if one isn't already there. Never throws — a malformed price
 * is shown as typed rather than blocking SOLD. */
export function formatPrice(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return trimmed.startsWith("$") ? trimmed : `$${trimmed}`;
}
