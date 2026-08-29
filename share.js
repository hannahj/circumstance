// specimen card: one reading rendered for the outside world (image only — video was too slow)
const INK = "#b6412e";
const PAPER = "#f4f0e6";
const SKYHEX = { dawn: "#dcaab8", day: "#a3c3d6", dusk: "#b8623a", night: "#333c54" };
const GAME_URL = "hannahj.github.io/circumstance";
const W = 1080, H = 1350;

const GLYPH_PATHS = {
  // display set: 48-unit grid, rounded terminals, one vocabulary at every size
  clear: '<circle cx="24" cy="24" r="12" fill="none" stroke="I" stroke-width="3.2"/>',
  cloud: '<path d="M13 33a7.5 7.5 0 0 1 .5-15 11 11 0 0 1 21-2.5 8 8 0 0 1-1 17.5Z" fill="none" stroke="I" stroke-width="3" stroke-linejoin="round"/>',
  rain: '<g stroke="I" stroke-width="3" stroke-linecap="round" fill="none"><path d="M14 8l-6 14M26 6l-6 14M38 8l-6 14M20 28l-5 11M32 28l-5 11"/></g>',
  snow: '<g stroke="I" stroke-width="2.4" stroke-linecap="round" fill="none"><path d="M24 6v36M8.4 15l31.2 18M39.6 15L8.4 33"/><path d="M24 12.5l-1.6 2.8M24 12.5l1.6 2.8M24 35.5l-1.6-2.8M24 35.5l1.6-2.8M34 29.8l-3.2 0M34 29.8l1.6-2.8M14 18.2l3.2 0M14 18.2l-1.6 2.8M34 18.2l-3.2 0M34 18.2l1.6 2.8M14 29.8l3.2 0M14 29.8l-1.6-2.8"/></g>',
  forest: '<path d="M24 5L15 19h4L12 32h9v10h6V32h9L29 19h4Z" fill="I"/>',
  water: '<g fill="none" stroke="I" stroke-width="3" stroke-linecap="round"><path d="M8 17q4-5 8 0t8 0 8 0 8 0"/><path d="M8 25q4-5 8 0t8 0 8 0 8 0"/><path d="M8 33q4-5 8 0t8 0 8 0 8 0"/></g>',
  open: '<path d="M5 35q10-13 19-13t19 13" fill="none" stroke="I" stroke-width="3" stroke-linecap="round"/><circle cx="36" cy="11" r="4.5" fill="I"/>',
  built: '<g fill="none" stroke="I" stroke-width="2.6" stroke-linejoin="round"><path d="M8 40V18h9v22M17 40V8h12v32M29 40V24h11v16M5 40h38"/></g><g fill="I"><rect x="20.5" y="13" width="2.6" height="2.6"/><rect x="25.5" y="13" width="2.6" height="2.6"/><rect x="20.5" y="19" width="2.6" height="2.6"/><rect x="25.5" y="19" width="2.6" height="2.6"/><rect x="20.5" y="25" width="2.6" height="2.6"/><rect x="25.5" y="25" width="2.6" height="2.6"/></g>',
};

const glyphCache = {};
function glyphImage(name, color) {
  const key = name + color;
  if (glyphCache[key]) return Promise.resolve(glyphCache[key]);
  return new Promise(res => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${GLYPH_PATHS[name].replaceAll("I", color)}</svg>`;
    const img = new Image();
    img.onload = () => { glyphCache[key] = img; res(img); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

async function cardBlob(capture) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // the sky colour of the capture IS the card; foreground flips for legibility
  const bg = SKYHEX[capture.band] || PAPER;
  const fg = (capture.band === "dawn" || capture.band === "day") ? INK : PAPER;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.font = "600 44px ui-monospace, Menlo, monospace";
  ctx.fillText("C I R C U M S T A N C E", W / 2, 130);
  ctx.fillRect(W / 2 - 460, 160, 920, 6);

  const cx = W / 2, cy = 640, r = 360;
  if (capture.photo) {
    const bmp = await createImageBitmap(capture.photo);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.clip();
    const s = Math.max((2 * r) / bmp.width, (2 * r) / bmp.height);
    ctx.drawImage(bmp, cx - bmp.width * s / 2, cy - bmp.height * s / 2, bmp.width * s, bmp.height * s);
    ctx.restore();
    ctx.strokeStyle = fg;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  } else {
    // no photo: the condition drawn as a stamp — dial geometry, place on the horizon, weather in the sky
    const R = r * 0.82;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, 0, 2 * Math.PI); ctx.stroke();

    const hy = cy + R * 0.28; // horizon chord
    const half = Math.sqrt(Math.max(0, (R * 0.9) ** 2 - (hy - cy) ** 2));
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(cx - half, hy); ctx.lineTo(cx + half, hy); ctx.stroke();

    if (capture.place && capture.place !== "pending") {
      const g = await glyphImage(capture.place, fg);
      const gs = 250;
      ctx.drawImage(g, cx - gs / 2, hy - gs + 22, gs, gs); // standing on the horizon
    }
    if (capture.weather && capture.weather !== "pending") {
      const g = await glyphImage(capture.weather, fg);
      const gs = 130;
      ctx.drawImage(g, cx + half * 0.45 - gs / 2, cy - R * 0.6, gs, gs); // in the sky
    }
  }

  const known = capture.place && capture.place !== "pending" && capture.weather && capture.weather !== "pending";
  if (known && capture.photo) {
    const g1 = await glyphImage(capture.place, fg);
    const g2 = await glyphImage(capture.weather, fg);
    const gs = 110, gap = 70;
    ctx.drawImage(g1, cx - gs - gap / 2, 1090, gs, gs);
    ctx.drawImage(g2, cx + gap / 2, 1090, gs, gs);
  }

  ctx.font = "36px ui-monospace, Menlo, monospace";
  ctx.globalAlpha = 0.85;
  ctx.fillText(new Date(capture.time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }), cx, 1260);
  ctx.font = "30px ui-monospace, Menlo, monospace";
  ctx.globalAlpha = 0.7;
  ctx.fillText(GAME_URL, cx, 1315);
  ctx.globalAlpha = 1;

  return new Promise(res => canvas.toBlob(b => res(b), "image/jpeg", 0.9));
}

export async function shareCapture(capture) {
  const blob = await cardBlob(capture);
  const file = new File([blob], "circumstance-reading.jpg", { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "circumstance-reading.jpg";
  a.click();
}
