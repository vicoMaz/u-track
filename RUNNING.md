# Running the Satellite Tracker

## Prerequisites

Node.js 18+ installed.

## First-time setup

```bash
cd satellite-tracker
npm install
```

## Start

```bash
npm start
```

This builds the app and serves the build, from a single server:

| URL | Purpose |
|-----|---------|
| http://localhost:4173 | Globe, planisphere, controls, and REST API |

`npm start` is what operators should use. It serves ~176 KB gzipped over 2 requests;
`npm run dev` serves the same app as 87 unbundled modules totalling ~6 MB uncompressed
(inline sourcemaps, no compression) — fine for development, needlessly slow to load
otherwise. Both mount the same REST API.

For development with hot reload:

```bash
npm run dev     # http://localhost:5173
```

## Stop

Press **Ctrl+C** in the terminal.

## Restart

```bash
# Ctrl+C to stop, then:
npm start
```

---

## API Docs

Open http://localhost:4173/api-docs.html (or click **API Docs ↗** in the top bar).

### Add a satellite

```bash
curl -X POST http://localhost:4173/api/satellites \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ISS",
    "tle": "1 25544U 98067A   24001.50000000  .00002182  00000-0  44000-4 0  9990\n2 25544  51.6434  29.5680 0001234  45.6789 314.3210 15.49897890000000"
  }'
```

Ground stations are not managed via this API — each satellite's own FDS server exposes
`/api/v1/data/antennas`, and the tracker discovers and groups them automatically per satellite.

Satellites appear in the tracker within 2 seconds (the UI polls `/api/feed` automatically).
