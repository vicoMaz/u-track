// Fetches and parses the per-pass "Procedure execution report" that routine
// pass procedures emit to Grafana Loki — a fixed-width STEP/STATUS/INFO/TIME
// table ending in a TOTAL PROCEDURE line. Uses the same Loki datasource the
// app's existing per-procedure Grafana deep-links already point at.
import { queryLoki as _queryLoki } from './lokiQuery.js';

const STEP_RE  = /^(.*?)\s{2,}(\S+)\s{2,}(.*?)\s{2,}(\d+(?:\.\d+)?)\s*$/;
const TOTAL_RE = /^TOTAL PROCEDURE\s+(\d+(?:\.\d+)?)\s*$/;

// Exported (alongside the internal name) so tests can feed it fixture Loki
// lines directly — this is the piece most exposed to the report's log format
// drifting, without needing a live Grafana connection to exercise it.
export function parseProcedureReport(lines) { return _parseReport(lines); }

function _parseReport(lines) {
  const startIdx = lines.findIndex(l => l.text.includes('Procedure execution report'));
  if (startIdx === -1) return null;

  const steps = [];
  let total = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const text = lines[i].text.trim();
    if (!text) continue;
    if (text.startsWith('```')) { if (total !== null) break; else continue; }
    if (/^-{5,}$/.test(text)) continue;
    if (/^STEP\s+STATUS\s+INFO\s+TIME/.test(text)) continue;

    const totalMatch = text.match(TOTAL_RE);
    if (totalMatch) { total = parseFloat(totalMatch[1]); continue; }

    const m = text.match(STEP_RE);
    if (m) steps.push({ step: m[1].trim(), status: m[2].trim(), info: m[3].trim(), time: parseFloat(m[4]) });
  }
  return steps.length ? { steps, total } : null;
}

// Hover in/out/in on the same pass shouldn't re-hit Grafana every time.
const _cache = new Map(); // `${grafanaHost}|${startMs}|${endMs}` → report | null

export async function fetchProcedureReport(grafanaHost, startMs, endMs) {
  if (!grafanaHost) return null;
  const key = `${grafanaHost}|${startMs}|${endMs}`;
  if (_cache.has(key)) return _cache.get(key);

  // Step 1: cheap filtered search for the TOTAL PROCEDURE line within the pass window.
  const hits = await _queryLoki(grafanaHost, '{service_name="/scc"} |= "TOTAL PROCEDURE"', startMs, endMs, 5);
  if (!hits?.length) { _cache.set(key, null); return null; }
  const hitMs = hits[hits.length - 1].ts / 1e6; // most recent match in the window

  // Step 2: pull the handful of lines around it and parse the full report block.
  const lines  = await _queryLoki(grafanaHost, '{service_name="/scc"}', hitMs - 3000, hitMs + 3000, 200);
  const report = lines ? _parseReport(lines) : null;
  _cache.set(key, report);
  return report;
}

const _STATUS_CLS = { SUCCESS: 'co-tt-preport-success', FAILURE: 'co-tt-preport-failure' };

// "Pass plan" step's INFO packs two Y/N flags from the pass-plan generator:
//   Point — antenna pointing (mechanical steering) was used for this pass
//   BX    — this was an X-band pass (vs. the default S-band)
const INFO_FLAG_LABEL = { Point: 'Antenna pointing', BX: 'X-band pass' };

// Expands known "Key:Y" / "Key:N" flags (see INFO_FLAG_LABEL) into a readable
// tooltip, e.g. "Point:Y BX:N" → "Antenna pointing: Y · X-band pass: N".
// Returns null for INFO values that don't match this shape (nothing to add).
function _decodeInfo(info) {
  const flags = [...info.matchAll(/(\w+):([YN])\b/g)];
  if (!flags.length) return null;
  return flags.map(([, key, val]) => `${INFO_FLAG_LABEL[key] ?? key}: ${val}`).join(' · ');
}

export function procedureReportHTML(report) {
  if (!report?.steps?.length) {
    return `<div class="co-tt-sep"></div>
      <div class="co-tt-section-title">Routine Report</div>
      <div class="co-tt-note">No routine report found</div>`;
  }
  const rows = report.steps.map(s => {
    const cls = _STATUS_CLS[s.status.toUpperCase()] ?? 'co-tt-preport-other';
    let info = '';
    if (s.info !== '-') {
      const decoded = _decodeInfo(s.info);
      const title = decoded ? ` title="${decoded}"` : '';
      info = `<span class="co-tt-preport-opt"${title}>${s.info}</span>`;
    }
    return `<tr>
      <td class="co-tt-preport-step">${s.step}</td>
      <td class="co-tt-preport-status ${cls}">${s.status}</td>
      <td class="co-tt-preport-info">${info}</td>
      <td class="co-tt-preport-time">${s.time.toFixed(2)}s</td>
    </tr>`;
  }).join('');
  const total = report.total != null
    ? `<tr class="co-tt-preport-total"><td colspan="3">TOTAL</td><td class="co-tt-preport-time">${report.total.toFixed(2)}s</td></tr>`
    : '';
  return `<div class="co-tt-sep"></div>
    <div class="co-tt-section-title">Routine Report</div>
    <table class="co-tt-preport">${rows}${total}</table>`;
}
