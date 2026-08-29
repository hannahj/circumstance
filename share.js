// specimen card: one reading rendered for the outside world (image only — video was too slow)
const INK = "#b6412e";
const PAPER = "#f4f0e6";
const SKYHEX = { dawn: "#dcaab8", day: "#a3c3d6", dusk: "#b8623a", night: "#333c54" };
const GAME_URL = "hannahj.github.io/circumstance";
const W = 1080, H = 1350;

const GLYPH_PATHS = {
  clear: '<circle cx="12" cy="12" r="5.5" fill="none" stroke="I" stroke-width="2.2"/>',
  cloud: '<path d="M6 16a4 4 0 1 1 1-7.9A5 5 0 0 1 16.8 9 3.5 3.5 0 0 1 16 16Z" fill="none" stroke="I" stroke-width="2"/>',
  rain: '<path d="M7 4l-3 8M13 4l-3 8M19 4l-3 8" stroke="I" stroke-width="2" fill="none"/><path d="M4 18h16" stroke="I" stroke-width="2"/>',
  snow: '<path d="M12 3v18M4 7l16 10M20 7L4 17" stroke="I" stroke-width="1.8" fill="none"/>',
  forest: '<path d="M12 3L6 14h4L7 21h10l-3-7h4Z" fill="I"/>',
  water: '<path d="M3 9q3-3 6 0t6 0 6 0M3 15q3-3 6 0t6 0 6 0" fill="none" stroke="I" stroke-width="2"/>',
  open: '<path d="M3 17q4-6 9-6t9 6" fill="none" stroke="I" stroke-width="2"/><circle cx="18" cy="7" r="2.5" fill="I"/>',
  built: '<path d="M5 21V9h6v12M11 21V4h8v17M3 21h18" fill="none" stroke="I" stroke-width="2"/>',
};

const glyphCache = {};
function glyphImage(name, color) {
  const key = name + color;
  if (glyphCache[key]) return Promise.resolve(glyphCache[key]);
  return new Promise(res => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${GLYPH_PATHS[name].replaceAll("I", color)}</svg>`;
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
