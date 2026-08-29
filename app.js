import { timeBand, sunTimes } from "./sun.js";
import { fetchWeatherNow, backfillWeather } from "./weather.js";
import { classifyPlace } from "./classify.js";
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

function bestFix(timeoutMs) {
  if (lastFix && Date.now() - lastFix.timestamp < 15000) return Promise.resolve(lastFix);
  return new Promise((res, rej) =>
    navigator.geolocation.getCurrentPosition(res, e => { geoError = e; rej(e); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 }));
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

// ---- rendering ----
function renderGrid(highlight) {
  const grid = $("grid");
  grid.innerHTML = "<div></div>" + WEATHERS.map(w => glyph(w)).join("");
  for (const p of PLACES) {
    grid.insertAdjacentHTML("beforeend", glyph(p));
    for (const w of WEATHERS) {
      const marks = {};
      for (const c of captures)
        if (c.stamped && c.place === p && c.weather === w) marks[c.band] = c;
      const cell = document.createElement("div");
      cell.className = "cell" + (BANDS.every(b => marks[b]) ? " complete" : "");
      for (const b of BANDS) {
        const q = document.createElement("div");
        const isNew = highlight && highlight.place === p && highlight.weather === w && highlight.band === b;
        q.className = "q" + (marks[b] ? "" : " empty") + (isNew ? " new" : "");
        const inner = document.createElement("div");
        if (marks[b]) inner.innerHTML =
          `<svg viewBox="-14 -14 28 28"><circle r="12.5" fill="${SKY[b]}"/></svg>`;
        q.appendChild(inner);
        cell.appendChild(q);
      }
      if (highlight && highlight.pulse && highlight.place === p && highlight.weather === w)
        cell.classList.add("pulse");
      cell.addEventListener("click", () => openSheet(p, w));
      grid.appendChild(cell);
    }
  }
  const n = captures.filter(c => c.stamped).length;
  const devOn = FORCE.weather || FORCE.place || FORCE.band || DEV.has("dist");
  $("counter").textContent = (devOn ? "\u26a0 dev \u00b7 " : "") + n + " / 64";
  const latest = captures[captures.length - 1];
  $("status").textContent = latest
    ? "Last reading: " + relativeDay(latest.time) + ", " + latest.band
    : "";
  renderRepeats();
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

// ---- capture ritual ----
async function takeReading() {
  startWatch(); // first gesture doubles as the permission moment
  $("readBtn").disabled = true;

  const overlay = $("captureOverlay");
  const viewfinder = $("viewfinder");
  overlay.classList.add("open");
  updateToggles();
  ritualActive = true;

  // trust a live attempt over any query or remembered error — probed beneath the open ritual
  if (!lastFix || Date.now() - lastFix.timestamp > 15000) {
    try {
      lastFix = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000, maximumAge: 60000 }));
      geoError = null;
    } catch (e) {
      if (e.code === 1) {
        ritualActive = false;
        overlay.classList.remove("open");
        showNote(geoHelp(e));
        $("readBtn").disabled = false;
        return;
      }
      // timeout or unavailable: proceed — the ritual has a longer window
    }
  }

  const t0 = Date.now();

  // the countdown hides the technology: fix refines, media rolls, weather and place resolve
  let fix = null, weather = null, place = null;
  if (prefs.video) startVideo().then(ok => {
    if (ok && ritualActive) {
      viewfinder.srcObject = videoStreamRef();
      overlay.classList.add("video-live");
    }
  });
  if (prefs.audio) startAudio().then(ok => {
    if (ok && ritualActive) overlay.classList.add("audio-live");
  });

  const work = bestFix(RITUAL_MS - 1000).then(async f => {
    fix = f;
    const { latitude, longitude } = f.coords;
    await Promise.allSettled([
      fetchWeatherNow(latitude, longitude).then(w => { weather = w; }),
      classifyPlace(latitude, longitude).then(p => { place = p; }),
    ]);
  }).catch(() => {});

  const wctx = $("wave").getContext("2d");
  await new Promise(done => {
    (function frame() {
      const t = Math.min(1, (Date.now() - t0) / RITUAL_MS);
      const a = Math.min(t, 0.9999) * 2 * Math.PI; // clockwise from the top
      const x = 80 * Math.sin(a), y = -80 * Math.cos(a);
      const large = a > Math.PI ? 1 : 0;
      const overVideo = overlay.classList.contains("video-live");
      const stroke = overVideo ? PAPER : "var(--ink)";
      const track = overVideo ? "rgba(244,240,230,0.35)" : "var(--ink-wash-12)";
      $("ring").innerHTML =
        `<circle r="80" fill="none" stroke="${track}" stroke-width="3"/>` +
        (t > 0.01 ? `<path d="M0 -80 A80 80 0 ${large} 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>` : "") +
        (overVideo ? "" : `<circle r="6" fill="var(--ink)"/>`);

      // real waveform: drawn only from a live microphone
      const levels = waveLevels(24);
      wctx.clearRect(0, 0, 600, 88);
      if (levels) {
        wctx.fillStyle = overVideo ? PAPER : INKHEX;
        const bw = 600 / 24;
        levels.forEach((v, i) => {
          const bh = Math.max(5, v * 80);
          wctx.fillRect(i * bw + bw * 0.25, 44 - bh / 2, bw * 0.5, bh);
        });
      }
      if (t < 1) requestAnimationFrame(frame); else done();
    })();
  });

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
    showNote("This reading has a photo but no sound \u2014 the microphone isn't available to this browser.\n\nIf you want sound in your readings: Settings \u2192 Privacy & Security \u2192 Microphone \u2192 your browser, then allow the site's mic prompt on the next reading.\n\nReadings work fine without it.");
  }
  if (capture.stamped) {
    renderGrid({ place: capture.place, weather: capture.weather, band: capture.band });
  } else {
    const known = capture.place !== "pending" && capture.weather !== "pending";
    renderGrid(known ? { place: capture.place, weather: capture.weather, pulse: true } : undefined);
    if (!known) flashStatus("Reading kept \u00b7 resolving\u2026");
    else flashStatus("Reading kept, not marked: " + capture.why + ".");
  }
  $("readBtn").disabled = false;

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
      if (capture.place === "pending" && place) { capture.place = place; changed = true; }
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
          renderGrid({ place: capture.place, weather: capture.weather, band: capture.band });
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
        try { c.place = await classifyPlace(c.lat, c.lon); changed = true; }
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
        renderGrid();
      }
    }
  } finally { resolving = false; }
}

async function removeCapture(c) {
  await deleteCapture(c.id);
  captures = captures.filter(x => x.id !== c.id);
  const promoted = await reEvaluateCell(c.place, c.weather);
  renderGrid(promoted ? { place: promoted.place, weather: promoted.weather, band: promoted.band } : undefined);
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
    $("introOverlay").classList.add("open");
    $("beginBtn").addEventListener("click", () => {
      lsSet("circIntroSeen", "1");
      $("introOverlay").classList.remove("open");
      takeReading(); // the first reading IS the tutorial
    });
  }
  captures = await allCaptures();
  if (DEV.get("purge") === "dev") {
    const dev = captures.filter(c => c.devForced);
    for (const c of dev) await deleteCapture(c.id);
    captures = captures.filter(c => !c.devForced);
  }
  if (!lsGet("circIntroSeen")) {
    $("introOverlay").classList.add("open");
    $("beginBtn").addEventListener("click", () => {
      lsSet("circIntroSeen", "1");
      $("introOverlay").classList.remove("open");
      takeReading(); // the first reading IS the tutorial
    });
    $("skipIntro").addEventListener("click", () => {
      lsSet("circIntroSeen", "1");
      $("introOverlay").classList.remove("open");
    });
  }
  renderGrid();
  renderArc();
  setInterval(renderArc, 60000);
  $("readBtn").addEventListener("click", takeReading);
  $("camTog").addEventListener("click", toggleVideo);
  $("micTog").addEventListener("click", toggleAudio);
  updateToggles();
  if (isEphemeral())
    showNote("Private window: readings can be taken but nothing is kept after this tab closes.");
  resolvePending();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
