import { store } from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';

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
  rw1:       { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_RW1_STATUS'          },
  rw2:       { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_RW2_STATUS'          },
  rw3:       { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_RW3_STATUS'          },
  rw4:       { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_RW4_STATUS'          },
  uptime:    { packet: 'TM_3_25_OBSW_HK_PLT', param: 'OBSW_AM_UPTIME'              },
};

const TM_DEFAULTS_12U = {
  ...TM_DEFAULTS,
  battery: { packet: 'TM_3_25_OBSW_HK_EPS_1S', param: 'EPS_AM_BAT_CALC' },
};

function _modelDefaults(model) {
  return model === '12U' ? TM_DEFAULTS_12U : TM_DEFAULTS;
}

export function getTmConfig(noradId, model) {
  const defaults = _modelDefaults(model);
  try {
    const saved = JSON.parse(localStorage.getItem(`sat-tmconfig-${noradId}`) ?? '{}');
    const cfg = {};
    for (const [k, def] of Object.entries(defaults)) {
      cfg[k] = { ...def, ...(saved[k] ?? {}) };
    }
    return cfg;
  } catch { return structuredClone(defaults); }
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

const _SEV_RANK = { WATCH: 1, WARNING: 2, DISTRESS: 3, SEVERE: 4, CRITICAL: 5 };

function _rangeContains(range, value) {
  const minOk = range.minInclusive != null ? value >= range.minInclusive
              : range.minExclusive  != null ? value >  range.minExclusive : true;
  const maxOk = range.maxInclusive != null ? value <= range.maxInclusive
              : range.maxExclusive  != null ? value <  range.maxExclusive : true;
  return minOk && maxOk;
}

// Numeric ranges: each range defines the safe operating band — outside it triggers the alarm.
// Enum conditions: each condition maps an exact string value to a criticality level.
function _computeStatus(monitoring, value) {
  if (!monitoring || value == null) return null;

  // Numeric range monitoring
  const ranges = [
    monitoring.watchRange, monitoring.warningRange, monitoring.distressRange,
    monitoring.severeRange, monitoring.criticalRange,
  ].filter(Boolean);
  if (ranges.length) {
    let worstRank = 0, worstStatus = null;
    for (const r of ranges) {
      if (!_rangeContains(r, value)) {
        const rank = _SEV_RANK[r.criticality] ?? 0;
        if (rank > worstRank) { worstRank = rank; worstStatus = r.criticality; }
      }
    }
    return worstStatus ?? 'NOMINAL';
  }

  // Enum/textual condition monitoring
  const conditions = [
    monitoring.criticalCondition, monitoring.severeCondition, monitoring.distressCondition,
    monitoring.warningCondition,  monitoring.watchCondition,  monitoring.nominalCondition,
  ].filter(Boolean);
  if (conditions.length) {
    const strVal = String(value).toUpperCase();
    for (const c of conditions) {
      if (String(c.condition).toUpperCase() === strVal) return c.criticality;
    }
    return 'NOMINAL'; // value not mapped to any condition
  }

  return null;
}

function _extract(param) {
  if (!param) return null;
  const value      = param.physicalValue?.value ?? null;
  const monitoring = param.monitoring ?? null;
  const status     = _computeStatus(monitoring, value) ?? param.status ?? 'NOMINAL';
  return { value, status, monitoring };
}

async function _fetchPacket(fdsOrigin, packetName, signal) {
  const end   = new Date(Date.now() + 10_000).toISOString();
  const start = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const url   = `${fdsOrigin}/api/v1/tm-packets`
    + `?start=${encodeURIComponent(start)}`
    + `&end=${encodeURIComponent(end)}`
    + `&orderBy=OnBoardTime&sortDir=DESC`
    + `&filter=${encodeURIComponent(packetName)}`
    + `&maxLimit=1`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0] ?? null;
  } catch { return null; }
}

// Cancel a satellite's still-running fetch rather than let it pile up
// alongside a new one — e.g. a manual "force ping" click, or the next poll
// cycle landing before a slow previous one finished, would otherwise leave
// two independent fetch chains racing to write store.satTelemetry, with
// whichever happens to resolve LAST winning regardless of which was actually
// requested more recently.
const _ctrl = new Map(); // satId → AbortController

export async function fetchSatTelemetry(sat) {
  const ip = satSubsystemOrigin(sat.noradId, 'sccRo');
  if (!ip) return;

  _ctrl.get(sat.id)?.abort();
  const ctrl = new AbortController();
  _ctrl.set(sat.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 8_000);

  try {
    const cfg = getTmConfig(sat.noradId, sat.model);

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
      const pkt = await _fetchPacket(ip, packetName, ctrl.signal);
      if (!pkt) return;
      if (!receptionTime) receptionTime = pkt.receptionTime ?? null;
      const root = pkt.spacePacket?.rootContainer?.subContainers ?? [];
      for (const { field, param } of fields) {
        extracted[field] = _extract(_findParam(root, param));
      }
    }));

    if (ctrl.signal.aborted) return; // superseded or timed out — don't overwrite with a stale/partial result

    const battV   = extracted.battery?.value;
    const [socA, socB] = sat.model === 'FF' ? [-361.07, 18.55] : [-361.5, 27.86];
    const battSoc = battV != null
      ? Math.max(0, Math.min(100, Math.round(socA + socB * battV)))
      : null;

    store.setSatTelemetry(sat.id, {
      receptionTime,
      sysMode:     extracted.sysMode   ?? null,
      gncMode:     extracted.gncMode   ?? null,
      battVoltage: extracted.battery   ?? null,
      battSoc:     battSoc != null ? { value: battSoc } : null,
      rw: [extracted.rw1 ?? null, extracted.rw2 ?? null, extracted.rw3 ?? null, extracted.rw4 ?? null],
      uptime: extracted.uptime ?? null,
      events: {
        normal: extracted.evtNormal ?? null,
        low:    extracted.evtLow    ?? null,
        med:    extracted.evtMed    ?? null,
        high:   extracted.evtHigh   ?? null,
      },
    });
  } finally {
    clearTimeout(timer);
    if (_ctrl.get(sat.id) === ctrl) _ctrl.delete(sat.id);
  }
}
