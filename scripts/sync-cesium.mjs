// Copies Cesium's prebuilt bundle out of node_modules into public/cesium so the
// app can serve it from its own origin instead of unpkg.com.
//
// Why not just commit public/cesium: it's ~20MB of vendored build output. Why
// not keep loading it from unpkg: this is an ops dashboard on a VPN'd network,
// and index.html's Cesium <script> is a hard dependency — globe/SatEntity.js
// evaluates Cesium.* at module scope, so if the CDN is unreachable the page goes
// blank, not "app minus globe". Copying at install/build time keeps the repo
// small AND the runtime self-contained.
//
// CESIUM_BASE_URL in index.html points at the copy's root: Cesium fetches
// Workers/, Assets/ and ThirdParty/ from there lazily at runtime, so the whole
// directory has to travel, not just Cesium.js.
import { cp, mkdir, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src  = join(root, 'node_modules', 'cesium', 'Build', 'Cesium');
const dest = join(root, 'public', 'cesium');

const exists = async p => { try { await stat(p); return true; } catch { return false; } };

if (!await exists(src)) {
  console.error(`[cesium] ${src} not found — run npm install first.`);
  process.exit(1);
}

// Version-stamped so a Cesium upgrade actually re-copies. Comparing mtimes
// would re-copy 20MB on every npm run; comparing the resolved version is both
// cheaper and the thing that actually matters.
const { version } = JSON.parse(
  await (await import('node:fs/promises')).readFile(join(root, 'node_modules', 'cesium', 'package.json'), 'utf8'),
);
const stampPath = join(dest, '.version');
if (await exists(stampPath)) {
  const { readFile } = await import('node:fs/promises');
  if ((await readFile(stampPath, 'utf8')).trim() === version) {
    console.log(`[cesium] public/cesium already at ${version}`);
    process.exit(0);
  }
  await rm(dest, { recursive: true, force: true });
}

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
const { writeFile } = await import('node:fs/promises');
await writeFile(stampPath, version + '\n');
console.log(`[cesium] copied ${version} -> public/cesium`);
