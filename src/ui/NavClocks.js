const LEAP_SECONDS = 37;
const GPS_LEAP     = 18;
const J2000_UTC_MS = Date.UTC(2000, 0, 1);
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

// ── Configurable second clock (Settings → Local Clock) ─────────────
// Was hardcoded to Toulouse/Europe-Paris; now operator-settable, but
// resolved entirely from the browser's own IANA timezone database
// (Intl.supportedValuesOf/Intl.DateTimeFormat) — no network lookup, ever.
const CLOCK_LABEL_KEY = 'nc-clock-label';
const CLOCK_TZ_KEY    = 'nc-clock-tz';
const DEFAULT_LABEL   = 'Toulouse';
const DEFAULT_TZ      = 'Europe/Paris';

function _isValidTz(tz) {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
  catch { return false; }
}

function getClockLabel() {
  return localStorage.getItem(CLOCK_LABEL_KEY) || DEFAULT_LABEL;
}

// Falls back to DEFAULT_TZ if localStorage holds something stale/invalid —
// a bad timeZone string thrown from inside tick() would otherwise take
// UTC/TAI/GNSS down with it, not just this one clock.
function getClockTz() {
  const v = localStorage.getItem(CLOCK_TZ_KEY) || DEFAULT_TZ;
  return _isValidTz(v) ? v : DEFAULT_TZ;
}

// Every IANA zone this browser itself knows about — Intl.supportedValuesOf
// is the whole reason this can stay offline (built into the JS engine, no
// fetch). Short hand-picked fallback for a browser old enough not to have
// it (Safari < 15.4).
const FALLBACK_TZS = [
  'UTC', 'Europe/Paris', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai', 'Australia/Sydney',
];
function _allTimeZones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch { /* fall through to the static list below */ }
  return FALLBACK_TZS;
}

function _initClockSettings() {
  const labelInput = document.getElementById('clock-label-input');
  const tzSelect   = document.getElementById('clock-tz-select');
  if (!labelInput || !tzSelect) return;

  tzSelect.innerHTML = _allTimeZones().map(tz => `<option value="${tz}">${tz}</option>`).join('');
  labelInput.value = getClockLabel();
  tzSelect.value   = getClockTz();
  // getClockTz() already falls back to DEFAULT_TZ for a bad stored value,
  // but if that fallback itself isn't in THIS list for some reason, land on
  // whatever the <select> actually has rather than leaving it blank.
  if (!tzSelect.value) tzSelect.value = tzSelect.options[0]?.value ?? '';

  labelInput.addEventListener('change', () => {
    const v = labelInput.value.trim() || DEFAULT_LABEL;
    labelInput.value = v;
    localStorage.setItem(CLOCK_LABEL_KEY, v);
  });
  labelInput.addEventListener('keydown', e => { if (e.key === 'Enter') labelInput.blur(); });

  tzSelect.addEventListener('change', () => {
    localStorage.setItem(CLOCK_TZ_KEY, tzSelect.value);
  });
}

export function initNavClocks() {
  const elDateUtc  = document.getElementById('nc-date-utc');
  const elDateTls  = document.getElementById('nc-date-tls');
  const elTlsLabel = document.getElementById('nc-tls-label');
  const elTlsOff   = document.getElementById('nc-tls-offset');
  const elTls      = document.getElementById('nc-tls');
  const elUtc      = document.getElementById('nc-utc');
  const elTaiTime  = document.getElementById('nc-tai-time');
  const elTaiSec   = document.getElementById('nc-tai-sec');
  const elGnssTime = document.getElementById('nc-gnss-time');
  const elGnssInfo = document.getElementById('nc-gnss-info');
  if (!elUtc) return;

  _initClockSettings();

  function tick() {
    const now = new Date();
    const ms  = now.getTime();
    const tz  = getClockTz();

    elDateUtc.textContent  = now.toLocaleDateString('sv-SE', { timeZone: 'UTC' });
    elDateTls.textContent  = now.toLocaleDateString('sv-SE', { timeZone: tz });
    elTlsLabel.textContent = getClockLabel();

    // Second clock's offset label (its configured tz vs UTC)
    const utcMs = new Date(now.toLocaleString('sv-SE', { timeZone: 'UTC' })).getTime();
    const tzMs  = new Date(now.toLocaleString('sv-SE', { timeZone: tz })).getTime();
    const offMin  = Math.round((tzMs - utcMs) / 60000);
    const offH    = Math.floor(Math.abs(offMin) / 60);
    const offM    = Math.abs(offMin) % 60;
    elTlsOff.textContent = `UTC${offMin >= 0 ? '+' : '-'}${offH}${offM ? ':' + String(offM).padStart(2,'0') : ''}`;

    // Second clock's time
    elTls.textContent = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: tz });

    // UTC time
    elUtc.textContent = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });

    // TAI = UTC + 37s, shown as time-of-day + elapsed seconds since J2000
    const taiMs   = ms + LEAP_SECONDS * 1000;
    elTaiTime.textContent = new Date(taiMs).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });
    const taiSec  = Math.floor((ms - J2000_UTC_MS) / 1000) + LEAP_SECONDS;
    elTaiSec.textContent = taiSec.toLocaleString('en-US') + ' s';

    // GNSS (GPS) = UTC + 18s
    const gnssMs   = ms + GPS_LEAP * 1000;
    elGnssTime.textContent = new Date(gnssMs).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });
    const gnssSec  = Math.floor((ms - GPS_EPOCH_MS) / 1000) + GPS_LEAP;
    const gnssWeek = Math.floor(gnssSec / 604800);
    const gnssTow  = Math.round((gnssSec % 604800) * 1000);
    elGnssInfo.textContent = `W${gnssWeek} · ${gnssTow.toLocaleString('en-US')} ms`;
  }

  tick();
  setInterval(tick, 1000);
}
