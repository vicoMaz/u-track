// Fleet table's "Alerts" column lookback window — 1 day or 7 days, toggled
// from the column header (ChadOps.js) and read by both fetchers that feed
// it (satGroundEvents.js's own count, satEventBaseline.js's "N days ago"
// snapshot for the Board delta). Client-local (localStorage), not a
// per-satellite property — this is how THIS operator wants to look at every
// satellite's alert history right now, not a property of any one satellite.
const KEY = 'co-alert-window-days';
const VALID_DAYS = [1, 7];
const DEFAULT_DAYS = 7;

export function getAlertWindowDays() {
  const v = Number(localStorage.getItem(KEY));
  return VALID_DAYS.includes(v) ? v : DEFAULT_DAYS;
}

export function setAlertWindowDays(days) {
  localStorage.setItem(KEY, String(VALID_DAYS.includes(days) ? days : DEFAULT_DAYS));
}
