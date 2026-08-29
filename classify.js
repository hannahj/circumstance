// thresholds under field tuning — see place-classifier field test
// after deploying worker.js to Cloudflare, put its URL here (no trailing slash)
const PROXY_URL = "https://misty-dew-73be.uglywalks.workers.dev/";

export const CFG = {
  WATER_DIST: 30,
  FOREST_EDGE: 25,
  BUILDING_DIST: 45,
  ROAD_DIST: 20,
  QUERY_RADIUS: 60,
};

function overpassQuery(lat, lon) {
  const r = CFG.QUERY_RADIUS;
  return `[out:json][timeout:8];
is_in(${lat},${lon})->.a;
(
  area.a["natural"~"^(water|wood|wetland)$"];
  area.a["landuse"~"^(forest|residential|commercial|industrial|retail|meadow|grass|farmland|recreation_ground)$"];
  area.a["leisure"~"^(park|nature_reserve|golf_course|garden|pitch)$"];
);
out tags;
relation(around:${r},${lat},${lon})["natural"="water"]->.wr;
way(r.wr)(around:${r},${lat},${lon})->.wm;
(
  .wm;
  way(around:${r},${lat},${lon})["natural"~"^(water|wood)$"];
  way(around:${r},${lat},${lon})["waterway"~"^(river|stream|canal)$"];
  way(around:${r},${lat},${lon})["waterway"="riverbank"];
  way(around:${r},${lat},${lon})["landuse"="forest"];
  way(around:${r},${lat},${lon})["building"];
  way(around:${r},${lat},${lon})["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service)$"];
);
out geom;`;
}

// min distance (m) from point to a way's geometry, equirectangular
function distToWay(lat, lon, geom) {
  if (!geom || !geom.length) return Infinity;
  const mLat = 111320;
  const mLon = 111320 * Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  const pts = geom.map(g => [(g.lon - lon) * mLon, (g.lat - lat) * mLat]);
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    best = Math.min(best, Math.hypot(ax, ay));
    if (i + 1 < pts.length) {
      const [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 > 0) {
        let t = (-ax * dx - ay * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return best;
}

export async function classifyPlace(lat, lon) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    body: overpassQuery(lat, lon),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(await res.text() || "HTTP " + res.status);
  const elements = (await res.json()).elements || [];

  const areas = elements.filter(e => e.type === "area");
  const ways = elements.filter(e => e.type === "way");
  const inArea = pred => areas.some(a => pred(a.tags || {}));
  const inWaterArea = inArea(t => t.natural === "water" || t.natural === "wetland");
  const inWoodArea = inArea(t => t.natural === "wood" || t.landuse === "forest");

  const near = { water: Infinity, wood: Infinity, building: Infinity, road: Infinity };
  for (const w of ways) {
    const t = w.tags || {};
    const d = distToWay(lat, lon, w.geometry);
    if (t.natural === "water" || t.waterway) near.water = Math.min(near.water, d);
    else if (t.natural === "wood" || t.landuse === "forest") near.wood = Math.min(near.wood, d);
    else if (t.building) near.building = Math.min(near.building, d);
    else if (t.highway) near.road = Math.min(near.road, d);
    else if (Object.keys(t).length === 0) near.water = Math.min(near.water, d); // water-relation member
  }

  // precedence: water > forest > built > open
  if (inWaterArea || near.water <= CFG.WATER_DIST) return "water";
  if (inWoodArea || near.wood <= CFG.FOREST_EDGE) return "forest";
  if (near.building <= CFG.BUILDING_DIST || near.road <= CFG.ROAD_DIST) return "built";
  return "open";
}
