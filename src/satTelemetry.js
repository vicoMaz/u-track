import { store } from './store.js';

// Inline to avoid circular dep with satPing.js
function _satIp(noradId) {
  return localStorage.getItem(`sat-baseurl-${noradId}`) ?? '';
}

// ── Per-satellite TM parameter mapping ───────────────────────────

// Each field has its own packet + param name — they may come from different TMs
export const TM_DEFAULTS = {
  sysMode:   { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_MASTER_SAT_MODE'   },
  gncMode:   { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_GNC_MODE'           },
  battery:   { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_BATT_CALC_VOLTAGE'  },
  evtNormal: { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_NB_NORMAL_EVT'      },
  evtLow:    { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_NB_LOW_SEV_EVT'     },
  evtMed:    { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_NB_MED_SEV_EVT'     },
  evtHigh:   { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_NB_HIGH_SEV_EVT'    },
};

export function getTmConfig(noradId) {
  try {
    const saved = JSON.parse(localStorage.getItem(`sat-tmconfig-${noradId}`) ?? '{}');
    const cfg = {};
    for (const [k, def] of Object.entries(TM_DEFAULTS)) {
      cfg[k] = { ...def, ...(saved[k] ?? {}) };
    }
    return cfg;
  } catch { return structuredClone(TM_DEFAULTS); }
}

export function setTmConfig(noradId, config) {
  localStorage.setItem(`sat-tmconfig-${noradId}`, JSON.stringify(config));
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

async function _fetchPacket(ip, packetName) {
  const end   = new Date(Date.now() + 10_000).toISOString();
  const start = new Date(Date.now() - 4 * 3_600_000).toISOString();
  const url   = `http://${ip}:15000/api/v1/tm-packets`
    + `?start=${encodeURIComponent(start)}`
    + `&end=${encodeURIComponent(end)}`
    + `&orderBy=OnBoardTime`
    + `&filter=${encodeURIComponent(packetName)}`
    + `&maxLimit=1`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0] ?? null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function fetchSatTelemetry(sat) {
  const ip = _satIp(sat.noradId);
  if (!ip) return;

  const cfg = getTmConfig(sat.noradId);

  // Group fields by their packet name so each unique TM is fetched only once
  const byPacket = new Map(); // packetName → [{field, param}]
  for (const [field, { packet, param }] of Object.entries(cfg)) {
    if (!byPacket.has(packet)) byPacket.set(packet, []);
    byPacket.get(packet).push({ field, param });
  }

  // Fetch all unique packets in parallel
  const extracted = {}; // field → {value, status} | null
  let receptionTime = null;

  await Promise.all([...byPacket.entries()].map(async ([packetName, fields]) => {
    const pkt = await _fetchPacket(ip, packetName);
    if (!pkt) return;
    if (!receptionTime) receptionTime = pkt.receptionTime ?? null;
    const root = pkt.spacePacket?.rootContainer?.subContainers ?? [];
    for (const { field, param } of fields) {
      extracted[field] = _extract(_findParam(root, param));
    }
  }));

  store.setSatTelemetry(sat.id, {
    receptionTime,
    sysMode:     extracted.sysMode   ?? null,
    gncMode:     extracted.gncMode   ?? null,
    battVoltage: extracted.battery   ?? null,
    events: {
      normal: extracted.evtNormal ?? null,
      low:    extracted.evtLow    ?? null,
      med:    extracted.evtMed    ?? null,
      high:   extracted.evtHigh   ?? null,
    },
  });
}
