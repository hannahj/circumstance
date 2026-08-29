import { timeBand, sunTimes } from "./sun.js";
import { fetchWeatherNow, backfillWeather } from "./weather.js";
import { classifyPlace } from "./classify.js";
import { addCapture, putCapture, allCaptures, deleteCapture } from "./db.js";
import { startMedia, snapPhoto, stopMedia } from "./media.js";
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
  clear: '<circle cx="12" cy="12" r="5.5" fill="none" stroke="var(--ink)" stroke-width="2.2"/>',
  cloud: '<path d="M6 16a4 4 0 1 1 1-7.9A5 5 0 0 1 16.8 9 3.5 3.5 0 0 1 16 16Z" fill="none" stroke="var(--ink)" stroke-width="2"/>',
  rain: '<path d="M7 4l-3 8M13 4l-3 8M19 4l-3 8" stroke="var(--ink)" stroke-width="2" fill="none"/><path d="M4 18h16" stroke="var(--ink)" stroke-width="2"/>',
  snow: '<path d="M12 3v18M4 7l16 10M20 7L4 17" stroke="var(--ink)" stroke-width="1.8" fill="none"/>',
  forest: '<path d="M12 3L6 14h4L7 21h10l-3-7h4Z" fill="var(--ink)"/>',
  water: '<path d="M3 9q3-3 6 0t6 0 6 0M3 15q3-3 6 0t6 0 6 0" fill="none" stroke="var(--ink)" stroke-width="2"/>',
  open: '<path d="M3 17q4-6 9-6t9 6" fill="none" stroke="var(--ink)" stroke-width="2"/><circle cx="18" cy="7" r="2.5" fill="var(--ink)"/>',
  built: '<path d="M5 21V9h6v12M11 21V4h8v17M3 21h18" fill="none" stroke="var(--ink)" stroke-width="2"/>',
};
const glyph = (name, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-label="${name}">${GLYPHS[name]}</svg>`;

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
  $("counter").textContent = n + " / 64";
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

// ---- capture ritual ----
async function takeReading() {
  startWatch(); // first gesture doubles as the permission moment
  $("readBtn").disabled = true;

  // trust a live attempt over any query or remembered error
  if (!lastFix || Date.now() - lastFix.timestamp > 15000) {
    try {
      lastFix = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000, maximumAge: 60000 }));
      geoError = null;
    } catch (e) {
      if (e.code === 1) {
        showNote(geoHelp(e));
        $("readBtn").disabled = false;
        return;
      }
      // timeout or unavailable: proceed — the ritual has a longer window
    }
  }

  const overlay = $("captureOverlay");
  const viewfinder = $("viewfinder");
  overlay.classList.add("open");
  const t0 = Date.now();

  // the countdown hides the technology: fix refines, media rolls, weather and place resolve
  let fix = null, weather = null, place = null;
  const mediaP = startMedia().then(m => {
    if (m.video) {
      viewfinder.srcObject = m.stream;
      viewfinder.classList.add("live");
    }
    return m;
  }).catch(() => ({ video: false, audio: false }));

  const work = bestFix(RITUAL_MS - 1000).then(async f => {
    fix = f;
    const { latitude, longitude } = f.coords;
    await Promise.allSettled([
      fetchWeatherNow(latitude, longitude).then(w => { weather = w; }),
      classifyPlace(latitude, longitude).then(p => { place = p; }),
    ]);
  }).catch(() => {});

  await new Promise(done => {
    (function frame() {
      const t = Math.min(1, (Date.now() - t0) / RITUAL_MS);
      const a = Math.min(t, 0.9999) * 2 * Math.PI; // clockwise from the top
      const x = 80 * Math.sin(a), y = -80 * Math.cos(a);
      const large = a > Math.PI ? 1 : 0;
      const hasVideo = viewfinder.classList.contains("live");
      $("ring").innerHTML =
        `<circle r="80" fill="none" stroke="var(--ink-wash-12)" stroke-width="3"/>` +
        (t > 0.01 ? `<path d="M0 -80 A80 80 0 ${large} 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>` : "") +
        (hasVideo ? "" : `<circle r="6" fill="var(--ink)"/>`);
      if (t < 1) requestAnimationFrame(frame); else done();
    })();
  });

  // close of the ring: take the frame, seal the sound
  const photo = viewfinder.classList.contains("live") ? await snapPhoto(viewfinder) : null;
  const audio = await stopMedia();
  viewfinder.classList.remove("live");
  viewfinder.srcObject = null;
  await mediaP;
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
  if (photo && !audio && !localStorage.getItem("micNoteSeen")) {
    localStorage.setItem("micNoteSeen", "1");
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
        try { c.place = await classifyPlace(c.lat, c.lon); changed = true; } catch {}
      }
      if (c.weather === "pending") {
        try {
          const recent = Date.now() - new Date(c.time).getTime() < 30 * 60000;
          const w = recent ? await fetchWeatherNow(c.lat, c.lon) : await backfillWeather(c.lat, c.lon, c.time);
          c.weather = w.bucket; c.weatherCode = w.code; c.tempC = w.temp; c.windKmh = w.wind;
          if (w.backfilled) c.weatherBackfilled = true;
          changed = true;
        } catch {}
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
    share.textContent = "\u2197";
    share.addEventListener("click", async e => {
      e.stopPropagation();
      share.disabled = true;
      try { await shareCapture(c); } catch {}
      share.disabled = false;
    });
    row.appendChild(share);
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
  captures = await allCaptures();
  if (DEV.get("purge") === "dev") {
    const dev = captures.filter(c => c.devForced);
    for (const c of dev) await deleteCapture(c.id);
    captures = captures.filter(c => !c.devForced);
  }
  if (!localStorage.getItem("circIntroSeen")) {
    $("introOverlay").classList.add("open");
    $("beginBtn").addEventListener("click", () => {
      localStorage.setItem("circIntroSeen", "1");
      $("introOverlay").classList.remove("open");
    });
  }
  renderGrid();
  renderArc();
  setInterval(renderArc, 60000);
  $("readBtn").addEventListener("click", takeReading);
  resolvePending();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
