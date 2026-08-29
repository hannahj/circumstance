import { timeBand, sunTimes } from "./sun.js";
import { fetchWeatherNow, backfillWeather } from "./weather.js";
import { classifyPlace, takeEvidence } from "./classify.js";
import { addCapture, putCapture, allCaptures, deleteCapture, isEphemeral } from "./db.js";
import { getMediaPrefs, saveMediaPrefs, startVideo, startAudio, stopVideo, stopAudio,
         videoStreamRef, audioActive, waveLevels, snapPhoto, finishMedia } from "./media.js";
import { shareCapture } from "./share.js";

// rules
const MIN_DIST_M = 500;      // spatial uniqueness: min distance between a cell's captures
const RITUAL_MS = 10000;     // fixed reading duration
const GOOD_FIX_M = 25;       // accuracy above this gets flagged on the record

const PLACES = ["forest", "water", "open", "built"];
const WEATHERS = ["clear", "cloud", "rain", "snow"];
const BANDS = ["dawn", "day", "dusk", "night"];
const SKY = { dawn: "var(--sky-dawn)", day: "var(--sky-day)", dusk: "var(--sky-dusk)", night: "var(--sky-night)" };

const GLYPHS = {
  // display set: 48-unit grid, rounded terminals, one vocabulary at every size
  clear: '<circle cx="24" cy="24" r="12" fill="none" stroke="var(--ink)" stroke-width="3.2"/>',
  cloud: '<path d="M13 33a7.5 7.5 0 0 1 .5-15 11 11 0 0 1 21-2.5 8 8 0 0 1-1 17.5Z" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linejoin="round"/>',
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
const prefs = getMediaPrefs();
let ritualActive = false;

// intro decision happens before the page is allowed to paint
if (!lsGet("circIntroSeen")) $("introOverlay").classList.add("open");
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
    p => { lastFix = p; geoError = null; renderArc(); },
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (geoError) { watching = false; startWatch(); }
  resolvePending();
});

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

function geoHelp(e) {
  if (e && e.code === 1)
    return "Location is switched off for this browser, so a reading can't be taken.\n\n" +
      "iPhone: Settings \u2192 Privacy & Security \u2192 Location Services \u2192 your browser \u2192 While Using.\n\n" +
      "Then also allow location for this site in the browser itself, and reload.";
  if (e && e.code === 3)
    return "Couldn't get a fix in time. Open sky helps \u2014 try again outdoors.";
  return "Couldn't get a location fix. Try again in a moment.";
}

// ---- geometry ----
function distM(aLat, aLon, bLat, bLon) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(aLat * Math.PI / 180);
  return Math.hypot((bLat - aLat) * mLat, (bLon - aLon) * mLon);
}

// ---- stamping rules ----
function tryStamp(capture) {
  const kin = captures.filter(c => c.stamped && c.place === capture.place && c.weather === capture.weather);
  if (kin.some(c => c.band === capture.band)) return { stamped: false, why: "already marked" };
  if (kin.some(c => distM(c.lat, c.lon, capture.lat, capture.lon) < MIN_DIST))
    return { stamped: false, why: "too near an earlier mark of this square" };
  return { stamped: true };
}

// ---- rendering: the grid grows toward what the player witnesses ----
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

  if (stage === "seed") {
    // one unlabeled mystery circle: the grid waits to be planted
    grid.style.gridTemplateColumns = "1fr";
    grid.style.maxWidth = "";
    grid.innerHTML = '<div class="seedwrap"><div class="seedcircle"></div></div>';
  } else if (stage === "coins") {
    const { places, weathers } = witnessed();
    grid.style.gridTemplateColumns =
      `22px repeat(${weathers.length}, ${weathers.length < 4 ? "minmax(0, 112px)" : "1fr"})`;
    grid.innerHTML = "<div></div>" + weathers.map(w => glyph(w).replace("<svg ", '<svg class="colg" ')).join("");
    for (const p of places) {
      grid.insertAdjacentHTML("beforeend", glyph(p).replace("<svg ", '<svg class="rowg" '));
      for (const w of weathers) {
        const kin = cellStamped(p, w);
        const cell = document.createElement("div");
        cell.className = "cell mono";
        const isNew = highlight && highlight.place === p && highlight.weather === w;
        if (kin.length) {
          cell.innerHTML =
            `<div class="q${isNew && highlight.band ? " new" : ""}"><div>` +
            `<svg viewBox="-14 -14 28 28"><circle r="12.5" fill="${SKY[kin[0].band]}"/></svg>` +
            `</div></div>`;
        } else {
          cell.innerHTML = '<div class="q empty"><div></div></div>';
        }
        if (highlight && highlight.pulse && isNew) cell.classList.add("pulse");
        cell.addEventListener("click", () => openSheet(p, w));
        grid.appendChild(cell);
      }
    }
  } else {
    // deepened, but still growing: only witnessed rows and columns, now subdivided
    const { places: dp, weathers: dw } = witnessed();
    grid.style.gridTemplateColumns =
      `22px repeat(${dw.length}, ${dw.length < 4 ? "minmax(0, 112px)" : "1fr"})`;
    const trig = opts.deepening;
    grid.innerHTML = "<div></div>" + dw.map(w => glyph(w).replace("<svg ", '<svg class="colg" ')).join("");
    for (const p of dp) {
      grid.insertAdjacentHTML("beforeend", glyph(p).replace("<svg ", '<svg class="rowg" '));
      for (const w of dw) {
        const marks = {};
        for (const c of captures)
          if (c.stamped && c.place === p && c.weather === w) marks[c.band] = c;
        const cell = document.createElement("div");
        cell.className = "cell" + (BANDS.every(b => marks[b]) ? " complete" : "");
        if (trig) {
          // the bloom washes outward from the cell that earned it
          const pr = dp.indexOf(p) - dp.indexOf(trig.place);
          const wc = dw.indexOf(w) - dw.indexOf(trig.weather);
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
          if (marks[b]) inner.innerHTML =
            `<svg viewBox="-14 -14 28 28"><circle r="12.5" fill="${SKY[b]}"/></svg>`;
          q.appendChild(inner);
          cell.appendChild(q);
        });
        if (highlight && highlight.pulse && highlight.place === p && highlight.weather === w)
          cell.classList.add("pulse");
        cell.addEventListener("click", () => openSheet(p, w));
        grid.appendChild(cell);
      }
    }
  }

  const devOn = FORCE.weather || FORCE.place || FORCE.band || DEV.has("dist");
  $("counter").textContent = devOn ? "\u26a0 dev" : "";
  const latest = captures[captures.length - 1];
  $("status").textContent = latest
    ? "Last reading: " + relativeDay(latest.time) + ", " + latest.band +
      (latest.why ? " \u00b7 repeat" : "")
    : "";
  renderRepeats();
}

// a stamp lands: bud, mark — or deepen
function landStamp(c) {
  const wasDeep = lsGet("deepened");
  const doubled = cellStamped(c.place, c.weather).length >= 2;
  if (!wasDeep && doubled) {
    lsSet("deepened", "1");
    // held beat on the familiar page, then the whole grid subdivides at once
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

function renderRepeats() {
  const box = $("repeats");
  const rows = captures
    .filter(c => !c.stamped && c.why && c.place !== "pending" && c.weather !== "pending")
    .sort((a, b) => a.time < b.time ? 1 : -1)
    .slice(0, 6);
  if (!rows.length) { box.innerHTML = ""; return; }
  box.innerHTML = '<div class="rc-title">Repeat circumstance</div>';
  for (const c of rows) {
    const row = document.createElement("div");
    row.className = "rc-row";
    row.innerHTML =
      `<div class="coin" style="background:${SKY[c.band]}"></div>` +
      glyph(c.place, 16) + glyph(c.weather, 16) +
      `<div class="when">${relativeDay(c.time)}</div>`;
    row.addEventListener("click", () => openSheet(c.place, c.weather));
    box.appendChild(row);
  }
}

let statusTimer = null;
function flashStatus(text) {
  $("status").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => renderGrid(), 6000);
}

function relativeDay(iso) {
  const d = new Date(iso), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderArc() {
  const svg = $("arc");
  const bare = '<path d="M2 34H198" stroke="var(--ink)" stroke-width="1.4"/>';
  if (!lastFix) { svg.innerHTML = bare; return; }
  const { latitude: lat, longitude: lon } = lastFix.coords;
  const now = new Date();
  const { rise, set } = sunTimes(lat, lon, now);
  if (!rise || !set) { svg.innerHTML = bare; return; }

  const x1 = 22, x2 = 182, cy = 34, rx = (x2 - x1) / 2, ry = 25, cx = (x1 + x2) / 2;
  const frac = (now - rise) / (set - rise);
  // at night there is no dot: the sun is not in the sky
  let dot = "";
  if (frac >= 0 && frac <= 1) {
    const th = Math.PI * (1 - frac);
    const dx = cx + rx * Math.cos(th), dy = cy - ry * Math.sin(th);
    dot = `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="4.5" fill="${SKY[timeBand(lat, lon, now).band]}"/>`;
  }
  const fmt = d => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  svg.innerHTML =
    `<path d="M2 ${cy}H198" stroke="var(--ink)" stroke-width="1.4"/>` +
    `<path d="M${x1} ${cy}A${rx} ${ry} 0 0 1 ${x2} ${cy}" fill="none" stroke="var(--ink)" stroke-width="1.4"/>` +
    dot +
    `<text x="${x1}" y="47" text-anchor="middle" font-size="10" fill="var(--ink)" opacity="0.8" font-family="var(--mono)">${fmt(rise)}</text>` +
    `<text x="${x2}" y="47" text-anchor="middle" font-size="10" fill="var(--ink)" opacity="0.8" font-family="var(--mono)">${fmt(set)}</text>`;
}

// ---- capture toggles ----
const TOG_ICONS = {
  cam: '<path d="M4 8h4l2-2h4l2 2h4v10H4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>',
  mic: '<rect x="9.5" y="4" width="5" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20M9 20h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
function togSvg(kind, on) {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%">${TOG_ICONS[kind]}` +
    (on ? "" : '<path d="M4 3.5L20 20.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>') +
    "</svg>";
}
function updateToggles() {
  $("camTog").innerHTML = togSvg("cam", prefs.video);
  $("micTog").innerHTML = togSvg("mic", prefs.audio);
  $("camTog").classList.toggle("on", prefs.video);
  $("camTog").classList.toggle("off", !prefs.video);
  $("micTog").classList.toggle("on", prefs.audio);
  $("micTog").classList.toggle("off", !prefs.audio);
}
async function toggleVideo() {
  prefs.video = !prefs.video;
  saveMediaPrefs(prefs);
  updateToggles();
  if (!ritualActive) return;
  if (!prefs.video) {
    stopVideo();
    $("captureOverlay").classList.remove("video-live");
    $("viewfinder").srcObject = null;
  } else if (await startVideo() && ritualActive) {
    $("viewfinder").srcObject = videoStreamRef();
    $("captureOverlay").classList.add("video-live");
  }
}
async function toggleAudio() {
  prefs.audio = !prefs.audio;
  saveMediaPrefs(prefs);
  updateToggles();
  if (!ritualActive) return;
  if (!prefs.audio) {
    stopAudio();
    $("captureOverlay").classList.remove("audio-live");
  } else if (await startAudio() && ritualActive) {
    $("captureOverlay").classList.add("audio-live");
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

// required sense, explained before asked — and a hard gate: no fix, no reading
function primeLocation() {
  return new Promise(res => {
    cancelFns.push(() => res(false));
    capPhase("priming");
    $("primeCard").innerHTML =
      '<div>A reading is taken from your location and necessary for the game, but it is only stored on your device.</div>' +
      '<button class="pill" id="locGo">Continue</button>' +
      '<div id="locWait"></div>';
    const go = $("locGo");
    go.addEventListener("click", async () => {
      lsSet("locPrimed", "1");
      // our button steps aside: the browser's dialog is the one that grants
      go.style.display = "none";
      const pre = await geoPermState();
      $("locWait").textContent = pre === "granted"
        ? "Locating\u2026"
        : "Answer your browser's location request.";
      const ok = await tryFix(20000);
      if (ok) return res(true);
      const st = await geoPermState();
      if (st === "denied") {
        endRitual();
        showNote(geoHelp({ code: 1 }));
        return res(false);
      }
      go.style.display = "";
      if (st === "prompt") {
        go.textContent = "Continue";
        $("locWait").textContent = "Location permission hasn't been given yet \u2014 your browser will ask again.";
      } else {
        go.textContent = "Try again";
        $("locWait").textContent = "No location yet \u2014 open sky helps.";
      }
    });
  });
}

// optional senses, chosen before asked
function primeMedia() {
  return new Promise(res => {
    cancelFns.push(() => res(false));
    capPhase("priming");
    const row = (kind, label, on) =>
      `<div class="checkrow${on ? " checked" : ""}" data-k="${kind}">
        <svg class="g" viewBox="0 0 24 24">${TOG_ICONS[kind]}</svg>
        <div>${label}</div>
        <div class="checkbox"><svg viewBox="0 0 14 14"><path d="M2 7.5L5.5 11L12 3.5" fill="none" stroke="#f4f0e6" stroke-width="2.4" stroke-linecap="round"/></svg></div>
      </div>`;
    $("primeCard").innerHTML =
      '<div>Your readings can optionally include a photo and/or short sound clip. These are also stored only on your device.</div>' +
      row("cam", "Photo", prefs.video) + row("mic", "Sound", prefs.audio) +
      '<button class="pill" id="mediaGo">Continue</button>';
    document.querySelectorAll("#primeCard .checkrow").forEach(r => {
      r.addEventListener("click", () => {
        const k = r.dataset.k === "cam" ? "video" : "audio";
        prefs[k] = !prefs[k];
        saveMediaPrefs(prefs);
        r.classList.toggle("checked", prefs[k]);
      });
    });
    $("mediaGo").addEventListener("click", () => {
      lsSet("mediaPrimed", "1");
      res(true);
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
      if (settled || e.target.closest(".tbtn") || e.target.closest(".close")) return;
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

// ---- capture ritual ----
async function takeReading() {
  startWatch(); // first gesture doubles as the permission moment
  $("readBtn").disabled = true;

  const overlay = $("captureOverlay");
  const viewfinder = $("viewfinder");
  overlay.classList.add("open");
  updateToggles();
  ritualActive = true;

  // arming: explain, choose, then settle each sense in turn — no time runs yet
  let located = lsGet("locPrimed") ? await tryFix(8000) : false;
  if (!located && geoError && geoError.code === 1 && (await geoPermState()) === "denied") {
    endRitual();
    showNote(geoHelp(geoError));
    return;
  }
  if (!located) located = await primeLocation(); // card blocks until a real fix
  if (!located || !ritualActive) return;
  if (!lsGet("mediaPrimed")) {
    if (!await primeMedia()) return;
  }
  if (!ritualActive) return;
  capPhase(null);
  if (prefs.video) {
    const ok = await startVideo();
    if (ok && ritualActive) {
      viewfinder.srcObject = videoStreamRef();
      overlay.classList.add("video-live");
    }
  }
  if (prefs.audio) {
    const ok = await startAudio();
    if (ok && ritualActive) overlay.classList.add("audio-live");
  }
  if (!ritualActive) return;

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

  // ready: the player frames, listens, and presses the stamp when they choose
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
  if (!ritualActive) return;

  // close of the ring: take the frame, seal the sound
  const photo = (prefs.video && overlay.classList.contains("video-live")) ? await snapPhoto(viewfinder) : null;
  const audio = await finishMedia();
  ritualActive = false;
  overlay.classList.remove("video-live", "audio-live");
  viewfinder.srcObject = null;
  await Promise.race([work, new Promise(r => setTimeout(r, 2000))]);
  overlay.classList.remove("open");

  if (!fix) {
    showNote(geoHelp(geoError));
    $("readBtn").disabled = false;
    return;
  }

  const { latitude: lat, longitude: lon, accuracy } = fix.coords;
  const tb = timeBand(lat, lon, new Date());
  const capture = {
    time: new Date().toISOString(),
    lat: +lat.toFixed(6), lon: +lon.toFixed(6),
    accuracy: Math.round(accuracy),
    roughFix: accuracy > GOOD_FIX_M || undefined,
    band: tb.band, sunElev: tb.elev,
    weather: weather ? weather.bucket : "pending",
    weatherCode: weather?.code, tempC: weather?.temp, windKmh: weather?.wind,
    place: place || "pending",
    stamped: false,
  };
  if (capture0Evidence) capture.placeEvidence = capture0Evidence;
  if (FORCE.weather) { capture.weather = FORCE.weather; capture.devForced = true; }
  if (FORCE.place) { capture.place = FORCE.place; capture.devForced = true; }
  if (FORCE.band) { capture.band = FORCE.band; capture.devForced = true; }
  if (photo) capture.photo = photo;
  if (audio) { capture.audio = audio; capture.audioType = audio.type; }
  if (capture.place !== "pending" && capture.weather !== "pending") {
    const s = tryStamp(capture);
    capture.stamped = s.stamped;
    capture.why = s.why;
  }
  capture.id = await addCapture(capture);
  captures.push(capture);

  // one-time note when the reading saw but couldn't hear
  if (photo && !audio && prefs.audio && !lsGet("micNoteSeen")) {
    lsSet("micNoteSeen", "1");
    showNote("This reading has a photo but no sound \u2014 the microphone isn't available to your browser.\n\nIf you want sound in your readings: Settings \u2192 Privacy & Security \u2192 Microphone \u2192 your browser, then allow the site's mic prompt on the next reading.\n\nReadings work fine without it.");
  }
  if (capture.stamped) {
    landStamp(capture);
  } else {
    const known = capture.place !== "pending" && capture.weather !== "pending";
    renderGrid(known ? { place: capture.place, weather: capture.weather, pulse: true } : undefined);
    if (!known) flashStatus("Reading kept \u00b7 resolving\u2026");
    else flashStatus("Reading kept, not marked: " + capture.why + ".");
  }
  $("readBtn").disabled = false;

  if (DEV.has("label")) {
    const note = $("noteOverlay"), txt = $("noteText");
    txt.innerHTML = '<div style="margin-bottom:10px">Your call:</div>' +
      '<div style="display:flex;gap:14px;justify-content:center">' +
      PLACES.map(p => `<button class="tbtn on" data-hp="${p}" style="width:52px;height:52px">${glyph(p, 30)}</button>`).join("") +
      "</div>";
    note.classList.add("open");
    note.onclick = async e => {
      const b = e.target.closest("[data-hp]");
      if (b) { capture.humanPlace = b.dataset.hp; await putCapture(capture); }
      note.classList.remove("open");
      note.onclick = null;
    };
  }

  if (!lsGet("firstRevealSeen")) {
    lsSet("firstRevealSeen", "1");
    $("revealCoin").style.background = SKY[capture.band];
    $("revealGlyphs").innerHTML =
      (capture.place !== "pending" ? glyph(capture.place, 44) : "") +
      (capture.weather !== "pending" ? glyph(capture.weather, 44) : "");
    const ro = $("revealOverlay");
    ro.classList.add("open");
    ro.onclick = () => ro.classList.remove("open");
  }

  // if the ritual's fetches land late, keep their answers instead of discarding them
  if (capture.place === "pending" || capture.weather === "pending") {
    work.then(async () => {
      let changed = false;
      if (capture.place === "pending" && place) { capture.place = place; capture.placeEvidence = capture0Evidence; changed = true; }
      if (capture.weather === "pending" && weather) {
        capture.weather = weather.bucket; capture.weatherCode = weather.code;
        capture.tempC = weather.temp; capture.windKmh = weather.wind;
        changed = true;
      }
      if (changed) {
        if (capture.place !== "pending" && capture.weather !== "pending" && !capture.stamped && !capture.why) {
          const st = tryStamp(capture);
          capture.stamped = st.stamped;
          capture.why = st.why;
        }
        await putCapture(capture);
        if (capture.stamped)
          landStamp(capture);
        else {
          renderGrid();
          if (capture.place !== "pending" && capture.weather !== "pending" && capture.why)
            flashStatus("Reading kept, not marked: " + capture.why + ".");
        }
      }
    });
    setTimeout(resolvePending, 15000);
  }
}

// ---- pending resolution ----
let resolving = false;
async function resolvePending() {
  if (resolving) return;
  resolving = true;
  try {
    for (const c of captures) {
      let changed = false;
      if (c.place === "pending") {
        try { c.place = await classifyPlace(c.lat, c.lon); c.placeEvidence = takeEvidence(); changed = true; }
        catch (e) { if (DEV.has("debug")) flashStatus("place: " + (e.message || e).slice(0, 120)); }
      }
      if (c.weather === "pending") {
        try {
          const recent = Date.now() - new Date(c.time).getTime() < 30 * 60000;
          const w = recent ? await fetchWeatherNow(c.lat, c.lon) : await backfillWeather(c.lat, c.lon, c.time);
          c.weather = w.bucket; c.weatherCode = w.code; c.tempC = w.temp; c.windKmh = w.wind;
          if (w.backfilled) c.weatherBackfilled = true;
          changed = true;
        } catch (e) { if (DEV.has("debug")) flashStatus("weather: " + (e.message || e).slice(0, 120)); }
      }
      if (!c.stamped && !c.why && c.place !== "pending" && c.weather !== "pending") {
        const s = tryStamp(c);
        c.stamped = s.stamped;
        c.why = s.why;
        changed = true;
        if (!c.stamped) flashStatus("Reading kept, not marked: " + c.why + ".");
      }
      if (changed) {
        await putCapture(c);
        if (c.stamped) landStamp(c); else renderGrid();
      }
    }
  } finally { resolving = false; }
}

async function removeCapture(c) {
  await deleteCapture(c.id);
  captures = captures.filter(x => x.id !== c.id);
  const promoted = await reEvaluateCell(c.place, c.weather);
  if (promoted) landStamp(promoted); else renderGrid();
}

async function reEvaluateCell(p, w) {
  const kin = captures
    .filter(x => x.place === p && x.weather === w && !x.stamped && x.why)
    .sort((a, b) => a.time < b.time ? -1 : 1);
  let promoted = null;
  for (const x of kin) {
    x.why = undefined;
    const s = tryStamp(x);
    x.stamped = s.stamped;
    x.why = s.why;
    await putCapture(x);
    if (x.stamped && !promoted) promoted = x;
  }
  return promoted;
}

// row action icons: drawn, not typed, so weight and reach are ours to set
const ICON_SHARE = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6.5 17.5L17 7M9.5 6.5H17.5V14.5" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6L18 18M18 6L6 18" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round"/></svg>';

// ---- cell sheet ----
function openSheet(p, w) {
  const sheet = $("cellSheet");
  $("sheetHead").innerHTML = glyph(p) + glyph(w);
  const body = $("sheetBody");
  body.innerHTML = "";
  const rows = captures
    .filter(c => c.place === p && c.weather === w)
    .sort((a, b) => a.time < b.time ? 1 : -1);
  if (!rows.length) body.innerHTML = '<div class="sheet-empty">Nothing here yet.</div>';
  for (const c of rows) {
    const row = document.createElement("div");
    row.className = "sheet-row";
    row.innerHTML =
      `<div class="coin" style="background:${SKY[c.band]}"></div>
       <div>${c.band}${c.stamped ? "" : " \u00b7 unmarked"}</div>
       <div class="when grow">${relativeDay(c.time)}${c.tempC !== undefined ? " \u00b7 " + c.tempC + "\u00b0C" : ""}</div>`;
    if (c.photo) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = URL.createObjectURL(c.photo);
      img.addEventListener("click", e => { e.stopPropagation(); showPhoto(c.photo); });
      row.appendChild(img);
    }
    if (c.audio) {
      const btn = document.createElement("button");
      btn.className = "play";
      btn.textContent = "\u25b6";
      btn.addEventListener("click", e => {
        e.stopPropagation();
        new Audio(URL.createObjectURL(c.audio)).play().catch(() => {});
      });
      row.appendChild(btn);
    }
    const share = document.createElement("button");
    share.className = "play";
    share.innerHTML = ICON_SHARE;
    share.addEventListener("click", async e => {
      e.stopPropagation();
      share.disabled = true;
      try { await shareCapture(c); } catch {}
      share.disabled = false;
    });
    row.appendChild(share);
    const del = document.createElement("button");
    del.className = "play";
    del.innerHTML = ICON_X;
    del.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm("Delete this reading? Its photo and sound go with it.")) return;
      await removeCapture(c);
      openSheet(p, w); // refresh the sheet in place
    });
    row.appendChild(del);
    body.appendChild(row);
  }
  sheet.classList.add("open");
}

// one permanent close handler: taps outside close the sheet,
// taps on another cell or repeat row switch it instead
document.addEventListener("click", e => {
  const sheet = $("cellSheet");
  if (!sheet.classList.contains("open")) return;
  if (sheet.contains(e.target)) return;
  if (e.target.closest(".cell") || e.target.closest(".rc-row")) return;
  sheet.classList.remove("open");
});

// ---- overlays ----
function showNote(text) {
  $("noteText").textContent = text;
  const o = $("noteOverlay");
  o.classList.add("open");
  o.onclick = () => o.classList.remove("open");
}
function showPhoto(blob) {
  $("photoFull").src = URL.createObjectURL(blob);
  const o = $("photoOverlay");
  o.classList.add("open");
  o.onclick = () => o.classList.remove("open");
}

// ---- init ----
(async function init() {
  if (!lsGet("circIntroSeen")) {
    $("beginBtn").addEventListener("click", () => {
      lsSet("circIntroSeen", "1");
      $("introOverlay").classList.remove("open");
      takeReading(); // the first reading IS the tutorial
    });
  }

  // paint and wire everything synchronously: no data load may delay the page
  renderGrid();
  renderArc();
  setInterval(renderArc, 60000);
  $("readBtn").addEventListener("click", takeReading);
  $("camTog").addEventListener("click", toggleVideo);
  $("capClose").addEventListener("click", endRitual);
  $("micTog").addEventListener("click", toggleAudio);
  updateToggles();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  // then the archive arrives, however long it takes
  try {
    captures = await allCaptures();
  } catch (e) {
    captures = [];
    console.error("capture load failed", e);
  }
  if (DEV.get("purge") === "dev") {
    const dev = captures.filter(c => c.devForced);
    for (const c of dev) await deleteCapture(c.id);
    captures = captures.filter(c => !c.devForced);
    lsSet("deepened", ""); // let a purged board grow again
  }
  renderGrid();
  resolvePending();
  // heartbeat: while anything is pending, keep trying (worker caching makes retries cheap)
  setInterval(() => {
    if (captures.some(c => c.place === "pending" || c.weather === "pending")) resolvePending();
  }, 20000);
  if (isEphemeral())
    showNote("Private window: readings can be taken but nothing is kept after this tab closes.");
  if (DEV.has("export")) {
    const rows = captures.map(({ photo, audio, ...rest }) => rest);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" }));
    a.download = "circumstance-archive.json";
    a.click();
  }
})();
