const LEAP_SECONDS = 37;
const GPS_LEAP     = 18;
const J2000_UTC_MS = Date.UTC(2000, 0, 1);
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

export function initNavClocks() {
  const elDateUtc  = document.getElementById('nc-date-utc');
  const elDateTls  = document.getElementById('nc-date-tls');
  const elTlsOff   = document.getElementById('nc-tls-offset');
  const elTls      = document.getElementById('nc-tls');
  const elUtc      = document.getElementById('nc-utc');
  const elTaiTime  = document.getElementById('nc-tai-time');
  const elTaiSec   = document.getElementById('nc-tai-sec');
  const elGnssTime = document.getElementById('nc-gnss-time');
  const elGnssInfo = document.getElementById('nc-gnss-info');
  if (!elUtc) return;

  function tick() {
    const now = new Date();
    const ms  = now.getTime();

    elDateUtc.textContent = now.toLocaleDateString('sv-SE', { timeZone: 'UTC' });
    elDateTls.textContent = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

    // TLS offset label (Paris vs UTC)
    const utcMs   = new Date(now.toLocaleString('sv-SE', { timeZone: 'UTC' })).getTime();
    const parisMs = new Date(now.toLocaleString('sv-SE', { timeZone: 'Europe/Paris' })).getTime();
    const offMin  = Math.round((parisMs - utcMs) / 60000);
    const offH    = Math.floor(Math.abs(offMin) / 60);
    const offM    = Math.abs(offMin) % 60;
    elTlsOff.textContent = `UTC${offMin >= 0 ? '+' : '-'}${offH}${offM ? ':' + String(offM).padStart(2,'0') : ''}`;

    // TLS time
    elTls.textContent = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Europe/Paris' });

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
