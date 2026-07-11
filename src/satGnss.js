import { store } from './store.js';

const PACKET    = 'TM_3_25_OBSW_HK_GNSS_RTE';
const LOOKBACK  = 7 * 86400_000; // 7 days
const MAX_ROWS  = 1000;

function _satIp(noradId) {
  return localStorage.getItem(`sat-baseurl-${noradId}`) ?? '';
}

async function _queryParam(ip, param, signal) {
  const now   = Date.now();
  const start = new Date(now - LOOKBACK).toISOString();
  const end   = new Date(now + 10_000).toISOString();
  const url   = `http://${ip}:15000/api/v1/parameters`
    + `?start=${encodeURIComponent(start)}`
    + `&end=${encodeURIComponent(end)}`
    + `&orderBy=onBoardTime`
    + `&filter=${encodeURIComponent(PACKET)}`
    + `&requestedParameters=${encodeURIComponent(param)}`
    + `&maxLimit=${MAX_ROWS}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data[0])) return data[0];        // [[...rows...]]
    if (Array.isArray(data.parameters)) return data.parameters;
    if (Array.isArray(data)) return data;
    return null;
  } catch { return null; }
}

function _rowTime(row) {
  const t = row?.onBoardTime ?? row?.generationTime ?? row?.receptionTime ?? row?.time;
  return t ? new Date(t) : null;
}

function _rowValue(row, param) {
  if (row == null) return null;
  // Direct key (CSV-style or flat object)
  if (row[param] !== undefined) return String(row[param]);
  // Yamcs physicalValue / engValue wrappers
  const pv = row.physicalValue ?? row.engValue;
  if (pv != null) return String(pv.value ?? pv.stringValue ?? pv);
  if (row.value !== undefined) return String(row.value);
  return null;
}

function _lastMatch(rows, param, target) {
  if (!rows?.length) return null;
  const tgt = target.toUpperCase();
  // Walk backwards — rows are in ascending time order
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = _rowValue(rows[i], param);
    if (v?.toUpperCase() === tgt) return _rowTime(rows[i]);
  }
  return null;
}

export async function fetchSatGnss(sat) {
  const ip = _satIp(sat.noradId);
  if (!ip) return;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const [tsRows, hwRows] = await Promise.all([
      _queryParam(ip, 'GNSS_AM_TIMESYNC_STATUS', ctrl.signal),
      _queryParam(ip, 'GNSS_AM_HW_HK_VALID',     ctrl.signal),
    ]);

    store.setSatGnss(sat.id, {
      lastFinesteering: _lastMatch(tsRows, 'GNSS_AM_TIMESYNC_STATUS', 'FINESTEERING'),
      lastValid:        _lastMatch(hwRows,  'GNSS_AM_HW_HK_VALID',    'VALID'),
    });
  } catch { /* offline or aborted */ }
  finally { clearTimeout(timer); }
}
