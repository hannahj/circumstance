// specimen card: one reading rendered for the outside world
const INK = "#b6412e";
const PAPER = "#f4f0e6";
const SKYHEX = { dawn: "#dcaab8", day: "#a3c3d6", dusk: "#b8623a", night: "#333c54" };
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
function glyphImage(name) {
  if (glyphCache[name]) return Promise.resolve(glyphCache[name]);
  return new Promise(res => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${GLYPH_PATHS[name].replaceAll("I", INK)}</svg>`;
    const img = new Image();
    img.onload = () => { glyphCache[name] = img; res(img); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// fully synchronous: the video recorder samples frames constantly,
// so every draw must be complete the moment it returns
function drawCard(ctx, capture, assets) {
  const { photoBitmap, g1, g2 } = assets;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.fillStyle = INK;
  ctx.font = "600 44px ui-monospace, Menlo, monospace";
  ctx.textAlign = "left";
  ctx.fillText("C I R C U M S T A N C E", 80, 130);
  ctx.fillRect(80, 160, W - 160, 6);

  // central circle: photo, ringed in ink — or the band coin
  const cx = W / 2, cy = 640, r = 360;
  if (photoBitmap) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.clip();
    const s = Math.max((2 * r) / photoBitmap.width, (2 * r) / photoBitmap.height);
    ctx.drawImage(photoBitmap,
      cx - photoBitmap.width * s / 2, cy - photoBitmap.height * s / 2,
      photoBitmap.width * s, photoBitmap.height * s);
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  } else {
    ctx.fillStyle = SKYHEX[capture.band] || INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.75, 0, 2 * Math.PI);
    ctx.fill();
  }

  // condition glyphs
  if (g1 && g2) {
    const gs = 110, gap = 70;
    ctx.drawImage(g1, cx - gs - gap / 2, 1090, gs, gs);
    ctx.drawImage(g2, cx + gap / 2, 1090, gs, gs);
  }

  // band, date, small mark
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.font = "36px ui-monospace, Menlo, monospace";
  const when = new Date(capture.time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  ctx.globalAlpha = 0.85;
  ctx.fillText(capture.band + " \u00b7 " + when, cx, 1275);
  ctx.globalAlpha = 1;
}

async function cardCanvas(capture) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const known = capture.place && capture.place !== "pending" && capture.weather && capture.weather !== "pending";
  const assets = {
    photoBitmap: capture.photo ? await createImageBitmap(capture.photo) : null,
    g1: known ? await glyphImage(capture.place) : null,
    g2: known ? await glyphImage(capture.weather) : null,
  };
  drawCard(canvas.getContext("2d"), capture, assets);
  return { canvas, assets };
}

function canvasBlob(canvas) {
  return new Promise(res => canvas.toBlob(b => res(b), "image/jpeg", 0.9));
}

// card + sound -> realtime-recorded video, the length of the recording
async function cardVideo(capture, canvas, assets) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(await capture.audio.arrayBuffer());
  const dest = ac.createMediaStreamDestination();
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(dest);

  const mime = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    .find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("no video support");

  const stream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

  const ctx = canvas.getContext("2d");
  const repaint = setInterval(() => drawCard(ctx, capture, assets), 250); // keep frames flowing

  const done = new Promise(res => { rec.onstop = res; });
  rec.start();
  src.start();
  src.onended = () => setTimeout(() => rec.stop(), 400);
  await done;
  clearInterval(repaint);
  ac.close();
  return new Blob(chunks, { type: mime.split(";")[0] });
}

export async function shareCapture(capture) {
  const { canvas, assets } = await cardCanvas(capture);
  let blob, filename;
  if (capture.audio) {
    try {
      blob = await cardVideo(capture, canvas, assets);
      filename = "circumstance-reading." + (blob.type.includes("mp4") ? "mp4" : "webm");
    } catch {
      blob = await canvasBlob(canvas);
      filename = "circumstance-reading.jpg";
    }
  } else {
    blob = await canvasBlob(canvas);
    filename = "circumstance-reading.jpg";
  }

  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  // fallback: download
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}
