// replay saved captures through classify-wc.js offline and print where it disagrees with
// the place stored at capture time (OSM). Public-water fusion is skipped (no network), so
// "osm: null" throughout: shoreline water and the treed-street veto both need the live app.
// usage: node tools/wc-replay.mjs circumstance-archive.json   (from ?export=1, or a backup file)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
globalThis.fetch = async (url) => {
  url = String(url);
  const i = url.indexOf("/wc/");
  if (i < 0) throw new Error("offline: " + url);
  const body = await readFile(root + url.slice(i + 1));
  return new Response(body, { status: 200 });
};

const { classifyPlace, takeEvidence } = await import("../classify-wc.js");
let rows = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!Array.isArray(rows)) rows = rows.captures || rows.rows || [];

let same = 0;
for (const c of rows) {
  if (typeof c.lat !== "number") continue;
  let wc, ev;
  try { wc = await classifyPlace(c.lat, c.lon); ev = takeEvidence(); }
  catch (e) { wc = "error"; ev = { error: e.message }; }
  const stored = c.place;
  if (wc === stored) { same++; continue; }
  const when = c.time ? new Date(c.time).toISOString().slice(0, 10) : "";
  const close = ev.wc ? Object.entries(ev.wc.close).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") : ev.wcError || ev.error;
  const wide = ev.wc ? Object.entries(ev.wc.wide).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") : "";
  console.log(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}  ${when}  stored ${stored} -> wc ${wc}\n    close: ${close}\n    wide:  ${wide}`);
}
console.log(`${same} of ${rows.length} agree`);
