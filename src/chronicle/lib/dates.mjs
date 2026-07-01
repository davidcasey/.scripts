/**
 * lib/dates.mjs — date/week/quarter helpers shared across chronicle scripts.
 * Week logic is ISO-8601 (Monday-start). "local day" helpers use the machine's
 * local timezone, which is what "my day" means for the daily digest.
 */

export function pad(n) { return String(n).padStart(2, "0"); }
export function fmtDate(d) { return d.toISOString().slice(0, 10); }
export function fmtDateShort(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export function weekBounds(year, week) {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() + 1 - dow);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

export function quarterBounds(year, q) {
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end   = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59, 999));
  return { start, end };
}

export function weeksInRange(start, end) {
  const weeks = [];
  const cursor = new Date(start);
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= end) {
    weeks.push(isoWeek(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

// Local YYYY-MM-DD for a Date.
export function localDay(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// Most recent business day before `from` — Monday looks back to Friday.
export function previousBusinessDay(from = new Date()) {
  const d = new Date(from);
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return localDay(d);
}
