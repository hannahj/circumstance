// place from satellite land cover (ESA WorldCover, prepped by tools/wc-prep.py into wc/),
// with OSM kept for zoning (a treed street is not a forest) and public water you can stand beside. Falls back to classify.js
// when the region has no tiles or the network is out.
import { classifyPlace as classifyOsm, takeEvidence as takeOsmEvidence } from "./classify.js";

const PROXY_URL = "https://misty-dew-73be.uglywalks.workers.dev";
const WC_URL = new URL("./wc/", import.meta.url).href;

// thresholds are guesses until field complaints tune them
export const CFG = {
  CLOSE: 1,            // 3x3 px, ~30 m: what is under your feet
  WIDE: 4,             // 9x9 px, ~90 m: what surrounds you
  SHORE: 3,            // 7x7 px, ~30 m (the old OSM water reach): a shoreline pixel this near means you are at the water
  FOREST_WIDE: 0.4,    // forest needs this much tree cover around, not just a stand
  OSM_WATER_DIST: 25,  // public water feature this near counts as water
};
const CODES = ["open", "forest", "water", "built", "nodata"];

let index = null;
const tiles = new Map(); // key -> Uint8Array, kept for the session; the service worker keeps the files

async function loadIndex() {
  if (index) return index;
  const res = await fetch(WC_URL + "index.json");
  if (!res.ok) throw new Error("wc index: HTTP " + res.status);
  return index = await res.json();
}

async function loadTile(key) {
  if (tiles.has(key)) return tiles.get(key);
  const res = await fetch(WC_URL + key + ".bin.gz", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("wc tile " + key + ": HTTP " + res.status);
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const t = new Uint8Array(buf);
  tiles.set(key, t);
  return t;
}

// tally buckets in a square window of pixels around (lat, lon); nodata is dropped
async function tally(lat, lon, half) {
  const { pxDeg: P, tilePx: N } = await loadIndex();
  const row0 = Math.floor(lat / P), col0 = Math.floor(lon / P); // global pixel of the point
  const counts = { open: 0, forest: 0, water: 0, built: 0, nodata: 0 };
  for (let r = row0 - half; r <= row0 + half; r++) {
    for (let c = col0 - half; c <= col0 + half; c++) {
      const li = Math.floor(r / N), lo = Math.floor(c / N);
      const t = await loadTile(li + "_" + lo);
      const rr = N - 1 - (r - li * N); // tile rows run north to south
      counts[CODES[t[rr * N + (c - lo * N)]]]++;
    }
  }
  return counts;
}

const majority = k => Object.entries(k).filter(([n]) => n !== "nodata").sort((a, b) => b[1] - a[1])[0][0];
const share = (k, n) => { const tot = k.open + k.forest + k.water + k.built; return tot ? k[n] / tot : 0; };

// one OSM question per capture: which zoning areas is this point in, and is public water beside it.
// water: natural water and fountains always; pools only if public, named, or in a park.
function osmQuery(lat, lon) {
  const r = CFG.OSM_WATER_DIST;
  lat = +lat.toFixed(4); lon = +lon.toFixed(4);
  return `[out:json][timeout:8];
is_in(${lat},${lon})->.a;
(
  area.a["landuse"~"^(residential|commercial|industrial|retail)$"];
  area.a["natural"="wood"];
  area.a["landuse"="forest"];
  area.a["leisure"~"^(park|nature_reserve)$"];
);
out tags;
area.a["leisure"~"^(park|sports_centre|water_park)$"]->.park;
(
  way(around:${r},${lat},${lon})["natural"~"^(water|wetland)$"];
  relation(around:${r},${lat},${lon})["natural"="water"];
  way(around:${r},${lat},${lon})["waterway"~"^(river|stream|canal|riverbank)$"];
  node(around:${r},${lat},${lon})["amenity"="fountain"];
  way(around:${r},${lat},${lon})["amenity"="fountain"];
  way(around:${r},${lat},${lon})["leisure"="swimming_pool"]["access"~"^(yes|public|permissive)$"];
  way(around:${r},${lat},${lon})["leisure"="swimming_pool"]["name"];
  way(around:${r},${lat},${lon})["leisure"="swimming_pool"](area.park);
);
out tags;`;
}

// device-side memory of OSM answers: zoning per ~110 m square (polygons are neighbourhoods),
// water per ~11 m (a fountain beside you once must not follow you down the street)
function osmCache(get, key, val) {
  try {
    const m = JSON.parse(localStorage.getItem("osmCache") || "{}");
    if (get) return m[key] || null;
    m[key] = val;
    const keys = Object.keys(m);
    if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete m[k];
    localStorage.setItem("osmCache", JSON.stringify(m));
  } catch { return null; }
}

async function osmLookup(lat, lon) {
  const zk = "z" + lat.toFixed(3) + "," + lon.toFixed(3), wk = "w" + lat.toFixed(4) + "," + lon.toFixed(4);
  const z = osmCache(true, zk), w = osmCache(true, wk);
  if (z && w) return { ...z, ...w, cached: true };
  // a refinement, not the answer: if it can't come back in 5 s the satellite stands alone
  const res = await fetch(PROXY_URL, { method: "POST", body: osmQuery(lat, lon), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(await res.text() || "HTTP " + res.status);
  // sort by tags, not element type: Overpass hands is_in areas back as ways
  const tags = ((await res.json()).elements || []).map(e => e.tags || {});
  const out = {
    water: tags.some(t => /^(water|wetland)$/.test(t.natural) || t.waterway || t.amenity === "fountain" || t.leisure === "swimming_pool"),
    zoned: tags.some(t => /^(residential|commercial|industrial|retail)$/.test(t.landuse)),
    wooded: tags.some(t => t.natural === "wood" || t.landuse === "forest" || /^(park|nature_reserve)$/.test(t.leisure)),
  };
  osmCache(false, zk, { zoned: out.zoned, wooded: out.wooded });
  osmCache(false, wk, { water: out.water });
  return out;
}

let _evidence = null;
export function takeEvidence() { const e = _evidence; _evidence = null; return e; }

export async function classifyPlace(lat, lon) {
  // the OSM question leaves at the same time as the tile reads; its answer is only used if needed
  const osmWork = osmLookup(lat, lon).catch(() => null); // unknown, not false
  let close, shore, wide;
  try {
    close = await tally(lat, lon, CFG.CLOSE);
    shore = await tally(lat, lon, CFG.SHORE);
    wide = await tally(lat, lon, CFG.WIDE);
    if (!(close.open + close.forest + close.water + close.built)) throw new Error("no cover data here");
  } catch (e) {
    // outside the prepped region or offline: the old classifier, unchanged
    const bucket = await classifyOsm(lat, lon);
    _evidence = { wc: null, wcError: (e.message || String(e)).slice(0, 80), ...(takeOsmEvidence() || {}) };
    return bucket;
  }

  const near = majority(close);
  const atWater = near === "water" || shore.water > 0;
  const osm = atWater ? null : await osmWork;

  // forest needs tree cover under you and around you, and not to be a treed street:
  // OSM zoning (residential and the like) vetoes it unless a wood or park is mapped there too
  const treed = near === "forest" && share(wide, "forest") >= CFG.FOREST_WIDE && majority(wide) !== "built";
  const street = osm ? osm.zoned && !osm.wooded : false;

  // precedence: water > forest > built > open
  let bucket;
  if (atWater || (osm && osm.water)) bucket = "water";
  else if (treed && !street) bucket = "forest";
  else if (near === "built" || (treed && street)) bucket = "built";
  else bucket = "open";

  _evidence = { wc: { close, shoreWater: shore.water, wide, osm } };
  return bucket;
}
