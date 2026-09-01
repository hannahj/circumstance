import { timeBand } from "./sun.js";
import { fetchWeatherNow, backfillWeather } from "./weather.js";
import { classifyPlace, takeEvidence } from "./classify.js";
import { addCapture, putCapture, allCaptures, deleteCapture, isEphemeral } from "./db.js";
import { startAllMedia, videoStreamRef, waveLevels, snapPhoto, finishMedia, startClip, stopClip } from "./media.js";
import { shareCapture } from "./share.js";
import { ping } from "./telemetry.js";
import { makeBackup, readBackup } from "./backup.js";
import { shareBoard } from "./board-export.js";

// rules
const MIN_DIST_M = 200;      // spatial uniqueness: every mark on the grid from a different place
const RITUAL_MS = 10000;     // reading cap (fixed duration in tap mode)
const VIDEO = new URLSearchParams(location.search).get("video") !== "0"; // clip capture is the default; ?video=0 restores photo+sound
const HOLD = VIDEO || new URLSearchParams(location.search).has("hold"); // video implies hold-to-record
const HOLD_MIN_MS = 1000;    // shorter holds reset gently instead of minting junk
const GOOD_FIX_M = 25;       // accuracy above this gets flagged on the record

const PLACES = ["forest", "water", "open", "built"];
const WEATHERS = ["clear", "cloud", "rain", "snow"];
const BANDS = ["dawn", "day", "dusk", "night"];
const SKY = { dawn: "var(--sky-dawn)", day: "var(--sky-day)", dusk: "var(--sky-dusk)", night: "var(--sky-night)" };

const GLYPHS = {
  // display set: 48-unit grid, rounded terminals, one vocabulary at every size
  clear: '<circle cx="24" cy="24" r="12" fill="none" stroke="var(--ink)" stroke-width="3.2"/>',
  cloud: '<g transform="translate(0 2)"><path d="M13 33a7.5 7.5 0 0 1 .5-15 11 11 0 0 1 21-2.5 8 8 0 0 1-1 17.5Z" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linejoin="round"/></g>',
  rain: '<g stroke="var(--ink)" stroke-width="3" stroke-linecap="round" fill="none"><path d="M14 8l-6 14M26 6l-6 14M38 8l-6 14M20 28l-5 11M32 28l-5 11"/></g>',
  snow: '<g stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" fill="none"><path d="M24 6v36M8.4 15l31.2 18M39.6 15L8.4 33"/><path d="M24 12.5l-1.6 2.8M24 12.5l1.6 2.8M24 35.5l-1.6-2.8M24 35.5l1.6-2.8M34 29.8l-3.2 0M34 29.8l1.6-2.8M14 18.2l3.2 0M14 18.2l-1.6 2.8M34 18.2l-3.2 0M34 18.2l1.6 2.8M14 29.8l3.2 0M14 29.8l-1.6-2.8"/></g>',
  forest: '<path d="M24 5L15 19h4L12 32h9v10h6V32h9L29 19h4Z" fill="var(--ink)"/>',
  water: '<g fill="none" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"><path d="M8 17q4-5 8 0t8 0 8 0 8 0"/><path d="M8 25q4-5 8 0t8 0 8 0 8 0"/><path d="M8 33q4-5 8 0t8 0 8 0 8 0"/></g>',
  open: '<path d="M5 35q10-13 19-13t19 13" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/><circle cx="36" cy="11" r="4.5" fill="var(--ink)"/>',
  built: '<g fill="none" stroke="var(--ink)" stroke-width="2.6" stroke-linejoin="round"><path d="M8 40V18h9v22M17 40V8h12v32M29 40V24h11v16M5 40h38"/></g><g fill="var(--ink)"><rect x="20.5" y="13" width="2.6" height="2.6"/><rect x="25.5" y="13" width="2.6" height="2.6"/><rect x="20.5" y="19" width="2.6" height="2.6"/><rect x="25.5" y="19" width="2.6" height="2.6"/><rect x="20.5" y="25" width="2.6" height="2.6"/><rect x="25.5" y="25" width="2.6" height="2.6"/></g>',
};
const glyph = (name, size = 22) =>
  `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-label="${name}">${GLYPHS[name]}</svg>`;

// dev overrides, URL-only, no UI: ?w=snow&p=water&b=dusk&dist=0
// w/p/b force weather, place, band; dist overrides the uniqueness distance (0 disables)
const DEV = new URLSearchParams(location.search);
const FORCE = {
  weather: WEATHERS.includes(DEV.get("w")) ? DEV.get("w") : null,
  place: PLACES.includes(DEV.get("p")) ? DEV.get("p") : null,
  band: BANDS.includes(DEV.get("b")) ? DEV.get("b") : null,
};
const MIN_DIST = DEV.has("dist") ? Math.max(0, +DEV.get("dist") || 0) : MIN_DIST_M;

const $ = id => document.getElementById(id);
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const PAPER = "#f4f0e6", INKHEX = "#b6412e";
let ritualActive = false;

document.body.classList.remove("booting");
let captures = [];
let lastFix = null;
let watching = false;
let watchId = null;
let geoError = null;

// ---- location ----
function startWatch() {
  if (watching) return;
  watching = true;
  watchId = navigator.geolocation.watchPosition(
    p => { lastFix = p; geoError = null; },
    e => {
      geoError = e;
      // a denied watch is dead — drop it so the next attempt registers fresh
      if (e.code === 1 && watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        watching = false;
      }
    },
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}
// no permission ambush: auto-start only if already granted; self-heal when granted later
if (navigator.permissions?.query) {
  navigator.permissions.query({ name: "geolocation" }).then(st => {
    if (st.state === "granted") startWatch();
    st.onchange = () => {
      if (st.state === "granted") { geoError = null; watching = false; startWatch(); }
    };
  }).catch(() => {});
}

async function geoPermState() {
  try { return (await navigator.permissions.query({ name: "geolocation" })).state; }
  catch { return "unknown"; }
}

// a genuine attempt at a fix; sets geoError on failure
async function tryFix(timeoutMs) {
  if (lastFix && Date.now() - lastFix.timestamp < 15000) return true;
  try {
    lastFix = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: timeoutMs, maximumAge: 60000 }));
    geoError = null;
    if (watchId === null) { watching = false; startWatch(); }
    return true;
  } catch (e) { geoError = e; return false; }
}

async function bestFix(timeoutMs) {
  if (lastFix && Date.now() - lastFix.timestamp < 15000) return lastFix;
  try {
    return await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej,
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 120000 }));
  } catch (e) {
    geoError = e;
    // the player stands still during a ritual: a slightly old fix beats none
    if (lastFix && Date.now() - lastFix.timestamp < 180000) return lastFix;
    throw e;
  }
}

function distM(aLat, aLon, bLat, bLon) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(aLat * Math.PI / 180);
  return Math.hypot((bLat - aLat) * mLat, (bLon - aLon) * mLon);
}

function relativeDay(iso) {
  const d = new Date(iso), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function geoHelp(e) {
  if (e && e.code === 1)
    return "Location is switched off for this browser, so a reading can't be taken.\n\n" +
      "iPhone: Settings \u2192 Privacy & Security \u2192 Location Services \u2192 your browser \u2192 While Using.\n\n" +
      "Then also allow location for this site in the browser itself, and reload.";
  if (e && e.code === 3)
    return "Couldn't get a fix in time. Open sky helps \u2014 try again outdoors.";
  return "Couldn't get a location fix. Try again in a moment.";
}

let statusTimer = null;
function flashStatus(text) {
  $("status").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => renderGrid(), 6000);
}

function showNote(text) {
  $("noteText").textContent = text;
  const o = $("noteOverlay");
  o.classList.add("open");
  o.onclick = () => o.classList.remove("open");
}

function showClip(videoBlob) {
  const o = $("photoOverlay");
  const v = $("clipFull");
  const url = URL.createObjectURL(videoBlob);
  v.src = url;
  o.classList.add("open", "clip");
  v.play().catch(() => {});
  o.onclick = e => {
    if (e.target === v) return;
    v.pause();
    v.removeAttribute("src");
    URL.revokeObjectURL(url);
    o.classList.remove("open", "clip");
  };
}

function showPhoto(blob, audioBlob) {
  const purl = URL.createObjectURL(blob);
  $("photoFull").src = purl;
  const o = $("photoOverlay");
  o.classList.add("open");
  let player = null, aurl = null;
  if (audioBlob) {
    aurl = URL.createObjectURL(audioBlob);
    player = new Audio(aurl);
    player.play().catch(() => {});
  }
  o.onclick = () => {
    o.classList.remove("open");
    $("photoFull").removeAttribute("src");
    URL.revokeObjectURL(purl);
    if (player) { player.pause(); player = null; }
    if (aurl) URL.revokeObjectURL(aurl);
  };
}

const ICON_SHARE = '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M6.5 17.5L17 7M9.5 6.5H17.5V14.5" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13M10 10.5v6M14 10.5v6" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PROMOTE = '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M12 19V6M7 11l5-5 5 5" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';


// one sentence per refusal, in plain words
function refusalText(s) {
  if (s.why === "already marked")
    return "Repeat \u2014 already marked in this light (flashing).";
  if (s.dist !== undefined)
    return "Repeat \u2014 " + s.dist + " m from an earlier mark (flashing).";
  return "Repeat \u2014 " + s.why + ".";
}

// ---- rules: one place, one mark ----
function tryStamp(capture, ignoreId) {
  const marks = captures.filter(c => c.stamped && c.id !== ignoreId);
  const slot = marks.find(c => c.place === capture.place && c.weather === capture.weather && c.band === capture.band);
  if (slot) return { stamped: false, why: "already marked", conflict: slot };
  const near = marks.find(c => distM(c.lat, c.lon, capture.lat, capture.lon) < MIN_DIST);
  if (near) return {
    stamped: false,
    why: "too near an earlier mark",
    conflict: near,
    dist: Math.round(distM(near.lat, near.lon, capture.lat, capture.lon)),
  };
  return { stamped: true };
}

async function reEvaluateAll() {
  const waiting = captures
    .filter(x => !x.stamped && x.why && x.why !== "swapped out" &&
                 x.place !== "pending" && x.weather !== "pending")
    .sort((a, b) => a.time < b.time ? -1 : 1);
  let promoted = null, firstRefusal = null;
  for (const x of waiting) {
    if (!captures.includes(x)) continue; // deleted since this pass began
    x.why = undefined;
    const s = tryStamp(x);
    x.stamped = s.stamped;
    x.why = s.why;
    await putCapture(x);
    if (x.stamped && !promoted) promoted = x;
    if (!x.stamped && !firstRefusal) firstRefusal = s;
  }
  return { promoted, firstRefusal };
}

// mutations run one at a time: overlapping deletes were resurrecting records mid-flight
let opChain = Promise.resolve();
const serialize = fn => { const p = opChain.then(fn, fn); opChain = p.catch(() => {}); return p; };

function removeCapture(c) { return serialize(() => doRemove(c)); }
async function doRemove(c) {
  await deleteCapture(c.id);
  captures = captures.filter(x => x.id !== c.id);
  const { promoted, firstRefusal } = await reEvaluateAll();
  if (promoted) landStamp(promoted);
  else if (firstRefusal && firstRefusal.conflict) {
    // deletion freed nothing: show what still blocks
    renderGrid({ place: firstRefusal.conflict.place, weather: firstRefusal.conflict.weather, band: firstRefusal.conflict.band });
    flashStatus(refusalText(firstRefusal));
  } else renderGrid();
}

function promoteCapture(c) { return serialize(() => doPromote(c)); }
async function doPromote(c) {
  const occupant = captures.find(x =>
    x.stamped && x.place === c.place && x.weather === c.weather && x.band === c.band);
  const s = tryStamp(c, occupant ? occupant.id : undefined);
  if (!s.stamped) return { ok: false, why: s.why, conflict: s.conflict };
  if (occupant) {
    occupant.stamped = false;
    occupant.why = "swapped out";
    await putCapture(occupant);
  }
  c.stamped = true;
  c.why = undefined;
  await putCapture(c);
  landStamp(c);
  return { ok: true };
}

// ---- rendering: the grid grows toward what the player witnesses ----
const thumbURLs = new Map();
function photoURL(c) {
  if (!c.photo) return null;
  if (!thumbURLs.has(c.id)) thumbURLs.set(c.id, URL.createObjectURL(c.photo));
  return thumbURLs.get(c.id);
}
function markHTML(c) {
  const u = photoURL(c);
  return u
    ? `<img src="${u}" data-id="${c.id}" alt="">`
    : `<svg viewBox="-14 -14 28 28"><circle r="12.5" fill="${SKY[c.band]}"/></svg>`;
}
function resolvedCaptures() {
  return captures.filter(c => c.place !== "pending" && c.weather !== "pending");
}
function cellStamped(p, w) {
  return captures.filter(c => c.stamped && c.place === p && c.weather === w);
}
function gridStage() {
  if (lsGet("deepened")) return "deep";
  for (const p of PLACES) for (const w of WEATHERS)
    if (cellStamped(p, w).length >= 2) { lsSet("deepened", "1"); return "deep"; }
  return resolvedCaptures().length ? "coins" : "seed";
}
function witnessed() {
  const rc = resolvedCaptures();
  return {
    places: PLACES.filter(p => rc.some(c => c.place === p)),
    weathers: WEATHERS.filter(w => rc.some(c => c.weather === w)),
  };
}

function renderGrid(highlight, opts = {}) {
  const grid = $("grid");
  const stage = opts.forceStage || gridStage();
  grid.classList.toggle("seed", stage === "seed");
  grid.classList.toggle("deepening", !!opts.deepening);
  grid.classList.remove("wide", "young");

  if (stage === "seed") {
    grid.style.gridTemplateColumns = "1fr";
    grid.innerHTML = '<div class="seedwrap"><div class="seedcircle"></div><div class="seedhint">Record unique circumstances.</div></div>';
  } else {
    const { places, weathers } = witnessed();
    grid.classList.toggle("wide", weathers.length === 4);
    grid.classList.toggle("young", weathers.length <= 2);
    grid.style.gridTemplateColumns =
      `30px repeat(${weathers.length}, ${weathers.length < 4 ? "minmax(0, 112px)" : "1fr"})`;
    const trig = opts.deepening;
    grid.innerHTML = "<div></div>" + weathers.map(w => glyph(w, 26).replace("<svg ", '<svg class="colg" ')).join("");
    for (const p of places) {
      grid.insertAdjacentHTML("beforeend", glyph(p, 26).replace("<svg ", '<svg class="rowg" '));
      for (const w of weathers) {
        const cell = document.createElement("div");
        if (stage === "coins") {
          const kin = cellStamped(p, w);
          cell.className = "cell mono";
          const isNew = highlight && highlight.place === p && highlight.weather === w;
          cell.innerHTML = kin.length
            ? `<div class="q${isNew && highlight.band ? " new" : ""}"><div>${markHTML(kin[0])}</div></div>`
            : '<div class="q empty"><div></div></div>';
          if (highlight && highlight.pulse && isNew) cell.classList.add("pulse");
        } else {
          const marks = {};
          for (const c of captures)
            if (c.stamped && c.place === p && c.weather === w) marks[c.band] = c;
          cell.className = "cell" + (BANDS.every(b => marks[b]) ? " complete" : "");
          if (trig) {
            const pr = places.indexOf(p) - places.indexOf(trig.place);
            const wc = weathers.indexOf(w) - weathers.indexOf(trig.weather);
            cell.style.setProperty("--bloom-delay", (Math.hypot(pr, wc) * 90).toFixed(0) + "ms");
          }
          BANDS.forEach((b, qi) => {
            const q = document.createElement("div");
            const isNew = highlight && highlight.place === p && highlight.weather === w && highlight.band === b;
            q.className = "q" + (marks[b] ? "" : " empty") + (isNew ? " new" : "");
            if (trig && marks[b]) {
              q.classList.add("settle");
              q.style.setProperty("--sx", (qi % 2 ? "-54%" : "54%"));
              q.style.setProperty("--sy", (qi > 1 ? "-54%" : "54%"));
            }
            const inner = document.createElement("div");
            if (marks[b]) inner.innerHTML = markHTML(marks[b]);
            q.appendChild(inner);
            cell.appendChild(q);
          });
          if (highlight && highlight.pulse && highlight.place === p && highlight.weather === w)
            cell.classList.add("pulse");
        }
        grid.appendChild(cell);
      }
    }
  }

  const devOn = FORCE.weather || FORCE.place || FORCE.band || DEV.has("dist");
  $("counter").textContent = devOn ? "\u26a0 dev" : "";
  $("status").textContent = "";
  renderCircumstances();
}

// a stamp lands: bud, mark \u2014 or deepen
function landStamp(c) {
  const wasDeep = lsGet("deepened");
  const doubled = cellStamped(c.place, c.weather).length >= 2;
  if (!wasDeep && doubled) {
    lsSet("deepened", "1");
    renderGrid({ place: c.place, weather: c.weather, pulse: true, band: c.band }, { forceStage: "coins" });
    document.body.classList.add("hush");
    setTimeout(() => {
      renderGrid(null, { deepening: { place: c.place, weather: c.weather } });
      setTimeout(() => {
        $("grid").classList.remove("deepening");
        document.body.classList.remove("hush");
      }, 2400);
    }, 1100);
  } else {
    renderGrid({ place: c.place, weather: c.weather, band: c.band });
  }
}

// a one-line anchored tip that dismisses itself
function showTip(anchor, html, ms = 3200) {
  document.querySelectorAll(".tip").forEach(t => t.remove());
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.innerHTML = html;
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + "px";
  const above = r.top - tip.offsetHeight - 8;
  tip.style.top = (above < 8 ? r.bottom + 8 : above) + "px";
  const dismiss = e => {
    if (e && e.target && e.target.closest && e.target.closest(".tip")) return;
    tip.remove();
    document.removeEventListener("pointerdown", dismiss, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 50);
  setTimeout(dismiss, ms);
}

// ---- the circumstances list: every recording, always up ----
const INFO_TEXT =
  "Record unique circumstances, based on time, location, and weather.\n\n" +
  "Recordings include ten seconds of sound and one photograph, which are only stored on your device.";

async function saveBackup() {
  const blob = await makeBackup(captures);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "circumstance-backup.json";
  a.click();
}
async function loadBackup() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "application/json,.json";
  inp.addEventListener("change", async () => {
    try {
      const rows = await readBackup(inp.files[0]);
      const have = new Set(captures.map(c => c.time));
      let added = 0;
      for (const r of rows) {
        if (have.has(r.time)) continue;
        r.id = await addCapture(r);
        captures.push(r);
        added++;
      }
      renderGrid();
      flashStatus(added ? "Restored " + added + " recording" + (added === 1 ? "" : "s") + "." : "Nothing new in that file.");
    } catch {
      flashStatus("Couldn't read that backup.");
    }
  });
  inp.click();
}

function renderCircumstances() {
  const box = $("repeats");
  const rows = [...captures].sort((a, b) => a.time < b.time ? 1 : -1);
  box.innerHTML = '<div class="rc-title">Circumstances</div>';
  for (const c of rows) {
    const pending = c.place === "pending" || c.weather === "pending";
    const row = document.createElement("div");
    row.className = "sheet-row";
    row.innerHTML =
      `<div class="coin${!pending && !c.stamped ? " unplaced" : ""}" style="background:${SKY[c.band]}"></div>` +
      (pending ? "" : glyph(c.place, 18) + glyph(c.weather, 18)) +
      `<div class="when grow">${pending ? "resolving\u2026" : relativeDay(c.time)}</div>`;
    if (c.photo) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.dataset.id = c.id;
      img.src = photoURL(c);
      img.addEventListener("click", () => c.video ? showClip(c.video) : showPhoto(c.photo, c.audio));
      row.appendChild(img);
    }
    if (c.audio) {
      const btn = document.createElement("button");
      btn.className = "play";
      btn.textContent = "\u25b6";
      btn.addEventListener("click", () => {
        const u = URL.createObjectURL(c.audio);
        const a = new Audio(u);
        a.onended = () => URL.revokeObjectURL(u);
        a.play().catch(() => URL.revokeObjectURL(u));
      });
      row.appendChild(btn);
    }
    const share = document.createElement("button");
    share.className = "play";
    share.innerHTML = ICON_SHARE;
    share.addEventListener("click", async () => {
      share.disabled = true;
      try { await shareCapture(c); } catch {}
      share.disabled = false;
    });
    row.appendChild(share);
    const more = document.createElement("button");
    more.className = "play morebtn";
    more.textContent = "\u22ef";
    more.addEventListener("click", () => row.classList.toggle("more-open"));
    row.appendChild(more);
    if (!c.stamped && c.why && !pending) {
      const up = document.createElement("button");
      up.className = "play more";
      up.innerHTML = ICON_PROMOTE;
      up.addEventListener("click", async () => {
        const r = await promoteCapture(c);
        if (r.ok) {
          $("grid").scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (r.conflict) {
          // show the blocker itself: flash it on the grid and say why beside it
          renderGrid({ place: r.conflict.place, weather: r.conflict.weather, band: r.conflict.band });
          $("grid").scrollIntoView({ behavior: "smooth", block: "center" });
          flashStatus("Can't swap \u2014 " + r.why + " (flashing).");
        } else {
          showTip(row, "Can't swap \u2014 " + r.why + ".");
        }
      });
      row.appendChild(up);
    }
    const del = document.createElement("button");
    del.className = "play more";
    del.innerHTML = ICON_TRASH;
    del.addEventListener("click", async () => {
      if (!confirm("Delete this recording? Its photo and sound go with it.")) return;
      await removeCapture(c);
    });
    row.appendChild(del);

    // tapping the row: placed recordings flash on the grid; kept ones explain themselves
    row.addEventListener("click", e => {
      if (e.target.closest("button") || e.target.closest("img")) return;
      if (pending) return;
      if (c.stamped) {
        renderGrid({ place: c.place, weather: c.weather, band: c.band });
        $("grid").scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        showTip(row, 'Repeat \u2014 not on the grid. <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px"><path d="M12 19V6M7 11l5-5 5 5" fill="none" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg> replaces another.');
      }
    });
    box.appendChild(row);
  }
}

// ---- ritual phases ----
let cancelFns = [];
function capPhase(name) {
  const o = $("captureOverlay");
  o.classList.remove("priming", "ready", "reading");
  if (name) o.classList.add(name);
}
function endRitual() {
  ritualActive = false;
  cancelFns.forEach(f => f());
  cancelFns = [];
  finishMedia();
  const o = $("captureOverlay");
  o.classList.remove("open", "video-live", "audio-live", "priming", "ready", "reading");
  $("viewfinder").srcObject = null;
  $("readBtn").disabled = false;
}

// hard gate, silent when it works: words appear only on failure
function retryLocationCard() {
  return new Promise(res => {
    cancelFns.push(() => res(false));
    capPhase("priming");
    $("primeCard").innerHTML =
      '<div id="locWait"></div>' +
      '<button class="pill" id="locGo">Try again</button>';
    $("locWait").textContent = "No location yet \u2014 open sky helps.";
    $("locGo").addEventListener("click", async () => {
      $("locGo").style.display = "none";
      $("locWait").textContent = "Locating\u2026";
      const ok = await tryFix(20000);
      if (ok) return res(true);
      const st = await geoPermState();
      if (st === "denied") {
        endRitual();
        showNote(geoHelp({ code: 1 }));
        return res(false);
      }
      $("locGo").style.display = "";
      $("locWait").textContent = st === "prompt"
        ? "Answer your browser's location request, then try again."
        : "No location yet \u2014 open sky helps.";
    });
  });
}

function drawWave(wctx, overVideo) {
  const levels = waveLevels(24);
  wctx.clearRect(0, 0, 600, 88);
  if (!levels) return;
  wctx.fillStyle = overVideo ? PAPER : INKHEX;
  const bw = 600 / 24;
  levels.forEach((v, i) => {
    const bh = Math.max(5, v * 80);
    wctx.fillRect(i * bw + bw * 0.25, 44 - bh / 2, bw * 0.5, bh);
  });
}

// the player fires the reading: a tap begins it
function readyPhase() {
  return new Promise(res => {
    cancelFns.push(() => res(false));
    capPhase("ready");
    const ov = $("captureOverlay");
    const wctx = $("wave").getContext("2d");
    let settled = false;
    const down = e => {
      if (settled || e.target.closest(".close")) return;
      settled = true;
      cleanup();
      res(true);
    };
    ov.addEventListener("pointerdown", down);
    const cleanup = () => ov.removeEventListener("pointerdown", down);
    (function frame() {
      if (!ritualActive || settled) { cleanup(); return; }
      const overVideo = ov.classList.contains("video-live");
      const stroke = overVideo ? PAPER : "var(--ink)";
      const track = overVideo ? "rgba(244,240,230,0.35)" : "var(--ink-wash-12)";
      const pulse = 6 + 2 * Math.sin(Date.now() / 320);
      $("ring").innerHTML =
        `<circle r="80" fill="none" stroke="${track}" stroke-width="3"/>` +
        `<circle r="${pulse.toFixed(1)}" fill="${stroke}"/>`;
      drawWave(wctx, overVideo);
      requestAnimationFrame(frame);
    })();
  });
}

// hold-to-record (dev experiment): press grows the ring, release seals; too-short holds reset
function holdPhase(overlay) {
  return new Promise(res => {
    cancelFns.push(() => res(false));
    capPhase("ready");
    const wctx = $("wave").getContext("2d");
    let holding = false, t0 = 0, sealed = false;
    const cleanup = () => {
      overlay.removeEventListener("pointerdown", down);
      overlay.removeEventListener("pointerup", up);
      overlay.removeEventListener("pointercancel", up);
    };
    const seal = () => {
      if (sealed) return;
      sealed = true;
      cleanup();
      res(Date.now() - t0);
    };
    const down = e => {
      if (sealed || e.target.closest(".close")) return;
      e.preventDefault(); // the hold is ours, not the browser's
      try { overlay.setPointerCapture(e.pointerId); } catch {}
      holding = true;
      t0 = Date.now();
      if (VIDEO) startClip();
      capPhase("reading");
    };
    const up = () => {
      if (!holding || sealed) return;
      holding = false;
      if (Date.now() - t0 >= HOLD_MIN_MS) seal();
      else {
        if (VIDEO) stopClip(); // discard the graze
        capPhase("ready");
      }
    };
    overlay.addEventListener("pointerdown", down);
    overlay.addEventListener("pointerup", up);
    overlay.addEventListener("pointercancel", up);
    (function frame() {
      if (!ritualActive) { cleanup(); return res(false); }
      if (sealed) return;
      const ov2 = overlay.classList.contains("video-live");
      const stroke = ov2 ? PAPER : "var(--ink)";
      const track = ov2 ? "rgba(244,240,230,0.35)" : "var(--ink-wash-12)";
      if (!holding) {
        const pulse = 6 + 2 * Math.sin(Date.now() / 320);
        $("ring").innerHTML =
          `<circle r="80" fill="none" stroke="${track}" stroke-width="3"/>` +
          `<circle r="${pulse.toFixed(1)}" fill="${stroke}"/>`;
      } else {
        const t = Math.min(1, (Date.now() - t0) / RITUAL_MS);
        const a = Math.min(t, 0.9999) * 2 * Math.PI;
        const x = 80 * Math.sin(a), y = -80 * Math.cos(a);
        const large = a > Math.PI ? 1 : 0;
        $("ring").innerHTML =
          `<circle r="80" fill="none" stroke="${track}" stroke-width="3"/>` +
          (t > 0.01 ? `<path d="M0 -80 A80 80 0 ${large} 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>` : "") +
          (ov2 ? "" : `<circle r="6" fill="var(--ink)"/>`);
        if (t >= 1) return seal(); // the ring closes: a full reading even mid-hold
      }
      drawWave(wctx, ov2);
      requestAnimationFrame(frame);
    })();
  });
}

// ---- the recording ----
async function takeReading() {
  if (ritualActive) return;
  const po = $("photoOverlay");
  if (po.classList.contains("open") && po.onclick) po.onclick({ target: po }); // close a viewer cleanly first
  startWatch(); // first gesture doubles as the permission moment
  $("readBtn").disabled = true;
  const overlay = $("captureOverlay");
  const viewfinder = $("viewfinder");
  overlay.classList.add("open");
  overlay.oncontextmenu = e => e.preventDefault(); // long-press menu would cut the hold short
  ritualActive = true;

  // arming: the browser's own prompts are the only words on the happy path
  let located = await tryFix(20000);
  if (!located && geoError && geoError.code === 1 && (await geoPermState()) === "denied") {
    endRitual();
    showNote(geoHelp(geoError));
    return;
  }
  if (!located) located = await retryLocationCard();
  if (!located || !ritualActive) return;
  capPhase(null);
  const senses = await startAllMedia();
  if (!ritualActive) return;
  if (senses.video) {
    viewfinder.srcObject = videoStreamRef();
    overlay.classList.add("video-live");
  }
  if (senses.audio) overlay.classList.add("audio-live");

  // resolution starts while the player frames: by the tap, answers are usually already home
  let fix = null, weather = null, place = null, capture0Evidence = null;
  const work = bestFix(RITUAL_MS - 1000).then(async f => {
    fix = f;
    const { latitude, longitude } = f.coords;
    await Promise.allSettled([
      fetchWeatherNow(latitude, longitude).then(w => { weather = w; }),
      classifyPlace(latitude, longitude).then(p => { place = p; capture0Evidence = takeEvidence(); }),
    ]);
  }).catch(() => {});

  // ready: the player frames, listens, and chooses the moment
  let heldMs = null;
  if (HOLD) {
    heldMs = await holdPhase(overlay);
    if (!heldMs || !ritualActive) return;
  } else {
  if (!await readyPhase()) return;
  if (!ritualActive) return;

  // the reading: a fixed window, hands-free
  capPhase("reading");
  const t0 = Date.now();
  const wctx = $("wave").getContext("2d");
  await new Promise(done => {
    (function frame() {
      if (!ritualActive) return done();
      const t = Math.min(1, (Date.now() - t0) / RITUAL_MS);
      const a = Math.min(t, 0.9999) * 2 * Math.PI; // clockwise from the top
      const x = 80 * Math.sin(a), y = -80 * Math.cos(a);
      const large = a > Math.PI ? 1 : 0;
      const ov2 = overlay.classList.contains("video-live");
      const stroke = ov2 ? PAPER : "var(--ink)";
      const track = ov2 ? "rgba(244,240,230,0.35)" : "var(--ink-wash-12)";
      $("ring").innerHTML =
        `<circle r="80" fill="none" stroke="${track}" stroke-width="3"/>` +
        (t > 0.01 ? `<path d="M0 -80 A80 80 0 ${large} 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>` : "") +
        (ov2 ? "" : `<circle r="6" fill="var(--ink)"/>`);
      drawWave(wctx, ov2);
      if (t < 1) requestAnimationFrame(frame); else done();
    })();
  });
  }
  if (!ritualActive) return;

  // close of the ring: seal the clip, take the poster frame, stop the senses
  const clip = VIDEO ? await stopClip() : null;
  const photo = overlay.classList.contains("video-live") ? await snapPhoto(viewfinder) : null;
  let audio = await finishMedia();
  if (clip) audio = null; // the clip carries the sound
  ritualActive = false;
  overlay.classList.remove("video-live", "audio-live");
  viewfinder.srcObject = null;
  await Promise.race([work, new Promise(r => setTimeout(r, 2000))]);
  overlay.classList.remove("open");

  if (!fix) {
    fix = lastFix;
    if (!fix) {
      showNote(geoHelp(geoError || { code: 3 }));
      $("readBtn").disabled = false;
      return;
    }
  }

  const now = new Date();
  const capture = {
    time: now.toISOString(),
    lat: fix.coords.latitude,
    lon: fix.coords.longitude,
    band: timeBand(fix.coords.latitude, fix.coords.longitude, now).band,
    photo, audio,
    weather: weather ? weather.bucket : "pending",
    weatherCode: weather?.code, tempC: weather?.temp, windKmh: weather?.wind, cloud: weather?.cloud,
    place: place || "pending",
    stamped: false,
  };
  if (heldMs) capture.heldMs = heldMs;
  if (clip) capture.video = clip;
  if (capture0Evidence) capture.placeEvidence = capture0Evidence;
  if (weather?.backfilled) capture.weatherBackfilled = true;
  if (FORCE.weather) { capture.weather = FORCE.weather; capture.devForced = true; }
  if (FORCE.place) { capture.place = FORCE.place; capture.devForced = true; }
  if (FORCE.band) { capture.band = FORCE.band; capture.devForced = true; }

  let refusedBy = null;
  if (capture.place !== "pending" && capture.weather !== "pending") {
    const s = tryStamp(capture);
    capture.stamped = s.stamped;
    capture.why = s.why;
    refusedBy = s.conflict || null;
    if (s.dist !== undefined) capture.refusedDist = s.dist;
  }
  capture.id = await addCapture(capture);
  captures.push(capture);
  ping("recording");

  if (DEV.has("debug") && capture.cloud !== undefined)
    setTimeout(() => flashStatus(capture.weather + " \u00b7 " + capture.cloud + "% cloud cover"), 2600);
  if (capture.stamped) landStamp(capture);
  else {
    renderGrid(refusedBy ? { place: refusedBy.place, weather: refusedBy.weather, band: refusedBy.band } : undefined);
    if (capture.why) flashStatus(refusalText({ why: capture.why, dist: capture.refusedDist }));
    else flashStatus("Recorded \u2014 resolving\u2026");
  }
  $("readBtn").disabled = false;

  // if the ritual's fetches land late, the answers are still kept
  work.then(async () => {
    let changed = false;
    if (capture.place === "pending" && place) { capture.place = place; capture.placeEvidence = capture0Evidence; changed = true; }
    if (capture.weather === "pending" && weather) {
      capture.weather = weather.bucket;
      capture.weatherCode = weather.code; capture.tempC = weather.temp; capture.windKmh = weather.wind;
      changed = true;
    }
    if (changed) {
      let late = null;
      if (!capture.stamped && !capture.why && capture.place !== "pending" && capture.weather !== "pending") {
        late = tryStamp(capture);
        capture.stamped = late.stamped;
        capture.why = late.why;
      }
      await putCapture(capture);
      if (capture.stamped) landStamp(capture);
      else if (late && late.conflict) {
        renderGrid({ place: late.conflict.place, weather: late.conflict.weather, band: late.conflict.band });
        flashStatus(refusalText(late));
      } else renderGrid();
    }
  });
}

// ---- pending resolution ----
async function resolvePending() {
  for (const c of captures) {
    if (c.place !== "pending" && c.weather !== "pending") continue;
    let changed = false;
    if (c.place === "pending") {
      try { c.place = await classifyPlace(c.lat, c.lon); c.placeEvidence = takeEvidence(); changed = true; }
      catch (e) { if (DEV.has("debug")) flashStatus("place: " + (e.message || e).slice(0, 120)); }
    }
    if (c.weather === "pending") {
      try {
        const w = await fetchWeatherNow(c.lat, c.lon, c.time);
        c.weather = w.bucket; c.weatherCode = w.code; c.tempC = w.temp; c.windKmh = w.wind;
        if (w.backfilled) c.weatherBackfilled = true;
        changed = true;
      } catch (e) { if (DEV.has("debug")) flashStatus("weather: " + (e.message || e).slice(0, 120)); }
    }
    if (changed && c.place !== "pending" && c.weather !== "pending") {
      if (!c.stamped && !c.why) {
        const s = tryStamp(c);
        c.stamped = s.stamped;
        c.why = s.why;
        if (!c.stamped) flashStatus("Kept \u00b7 " + c.why);
      }
      await putCapture(c);
      if (c.stamped) landStamp(c); else renderGrid();
    } else if (changed) {
      await putCapture(c);
      renderGrid();
    }
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (geoError) { watching = false; startWatch(); }
  resolvePending();
});

// ---- init ----
(async function init() {
  // paint and wire everything synchronously: no data load may delay the page
  if (HOLD) document.querySelector(".capthint").textContent = "HOLD TO RECORD";
  if (VIDEO) flashStatus("clip mode");
  renderGrid();
  ping("open");
  $("readBtn").addEventListener("click", takeReading);
  // image load failures (memory-purged blob URLs) heal themselves from the stored blob
  document.addEventListener("error", e => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.dataset || !img.dataset.id) return;
    const c = captures.find(x => String(x.id) === img.dataset.id);
    if (!c || !c.photo || img.dataset.healed) return;
    img.dataset.healed = "1"; // one retry, no loops
    thumbURLs.delete(c.id);
    img.src = photoURL(c);
  }, true);
  $("grid").addEventListener("click", e => {
    const img = e.target.closest && e.target.closest("img[data-id]");
    if (!img) return;
    const c = captures.find(x => String(x.id) === img.dataset.id);
    if (c) c.video ? showClip(c.video) : showPhoto(c.photo, c.audio);
  });
  $("capClose").addEventListener("click", endRitual);
  $("infoBtn").addEventListener("click", e => {
    e.stopPropagation();
    showTip($("infoBtn"), INFO_TEXT, 12000);
  });
  $("gearBtn").addEventListener("click", e => {
    e.stopPropagation();
    const gear = $("gearBtn");
    const canExport = captures.some(c => c.stamped);
    showTip(gear,
      '<div class="menu">' +
      (canExport ? '<button id="mExport">Export board image</button>' : "") +
      '<button id="mBack">Back up</button>' +
      '<button id="mRestore">Restore</button></div>', 15000);
    const done = () => document.querySelectorAll(".tip").forEach(t => t.remove());
    if (canExport) $("mExport").addEventListener("click", async () => {
      done();
      const { places, weathers } = witnessed();
      try { await shareBoard({ captures, places, weathers, bands: BANDS, glyph, deepened: !!lsGet("deepened") }); } catch {}
    });
    $("mBack").addEventListener("click", () => { done(); saveBackup(); });
    $("mRestore").addEventListener("click", () => { done(); loadBackup(); });
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  // then the archive arrives, however long it takes
  try {
    captures = await allCaptures();
  } catch (e) {
    captures = [];
    console.error("capture load failed", e);
  }
  // one-time repack: legacy Blob-stored media becomes ArrayBuffer-stored (Safari reliability)
  if (!lsGet("packedV1")) {
    let dead = 0;
    for (const c of captures) {
      try { await putCapture(c); }
      catch { dead++; }
    }
    if (!dead) lsSet("packedV1", "1");
    else flashStatus(dead + " recording(s) have unreadable media \u2014 delete and re-record them.");
  }

  // repair: captures saved with an object where the band string belongs
  let repaired = false;
  for (const c of captures) {
    if (c.band && typeof c.band === "object" && typeof c.band.band === "string") {
      c.band = c.band.band;
      await putCapture(c);
      repaired = true;
    }
  }
  if (repaired) { const r = await reEvaluateAll(); if (r.promoted) renderGrid(); }

  if (DEV.get("purge") === "dev") {
    const dev = captures.filter(c => c.devForced);
    for (const c of dev) await deleteCapture(c.id);
    captures = captures.filter(c => !c.devForced);
    lsSet("deepened", ""); // let a purged board grow again
  }
  renderGrid();
  resolvePending();
  setInterval(() => {
    if (captures.some(c => c.place === "pending" || c.weather === "pending")) resolvePending();
  }, 20000);
  setTimeout(resolvePending, 15000);
  if (isEphemeral())
    showNote("Private window: recordings can be taken but nothing is kept after this tab closes.");
  if (DEV.has("export")) {
    const rows = captures.map(({ photo, audio, ...rest }) => rest);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" }));
    a.download = "circumstance-archive.json";
    a.click();
  }
})();
