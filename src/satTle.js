import { store }      from './store.js';
import { satSubsystemOrigin } from './satSubsystems.js';
import { parseTLE }   from './tle.js';

export async function fetchSatTle(sat) {
  const origin = satSubsystemOrigin(sat.noradId, 'gnm');
  if (!origin) return;
  const id = sat.satelliteId || sat.name;
  if (!id) return;
  const url  = `${origin}/api/v1/data/orbit/best-tle?satellite_id=${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.first_line || !data.second_line) return;
    const { satrec } = parseTLE(`${data.first_line}\n${data.second_line}`);
    store.updateSatTle(sat.noradId, satrec);
  } catch { /* non-fatal */ }
}
