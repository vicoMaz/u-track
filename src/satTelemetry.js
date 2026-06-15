import { store } from './store.js';

// Inline to avoid circular dep with satPing.js
function _satIp(noradId) {
  return localStorage.getItem(`sat-baseurl-${noradId}`) ?? '';
}

// Recursively find a leaf parameter by name in the nested subContainers tree
function _findParam(containers, name) {
  for (const c of containers) {
    if (c.name === name && c.physicalValue !== undefined) return c;
    if (c.subContainers?.length) {
      const hit = _findParam(c.subContainers, name);
      if (hit) return hit;
    }
  }
  return null;
}

function _extract(param) {
  if (!param) return null;
  return { value: param.physicalValue?.value ?? null, status: param.status ?? 'NOMINAL' };
}

export async function fetchSatTelemetry(sat) {
  const ip = _satIp(sat.noradId);
  if (!ip) return;

  const end   = new Date(Date.now() + 10_000).toISOString();
  const start = new Date(Date.now() - 4 * 3_600_000).toISOString();
  const url   = `http://${ip}:15000/api/v1/tm-packets`
    + `?start=${encodeURIComponent(start)}`
    + `&end=${encodeURIComponent(end)}`
    + `&orderBy=OnBoardTime`
    + `&filter=TM_3_25_OBSW_HK_PLT`
    + `&maxLimit=1`;

  let packets;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return;
      packets = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return;
  }

  if (!packets?.length) return;

  const pkt  = packets[0];
  const root = pkt.spacePacket?.rootContainer?.subContainers ?? [];
  const get  = name => _extract(_findParam(root, name));

  store.setSatTelemetry(sat.id, {
    receptionTime: pkt.receptionTime ?? null,
    sysMode:      get('OBSW_AM_MASTER_SAT_MODE'),
    gncMode:      get('OBSW_AM_GNC_MODE'),
    battVoltage:  get('OBSW_AM_BATT_CALC_VOLTAGE'),
    events: {
      normal: get('OBSW_AM_NB_NORMAL_EVT'),
      low:    get('OBSW_AM_NB_LOW_SEV_EVT'),
      med:    get('OBSW_AM_NB_MED_SEV_EVT'),
      high:   get('OBSW_AM_NB_HIGH_SEV_EVT'),
    },
  });
}
