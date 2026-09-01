// the board as a shareable image: paper, glyphs, dashed possibility, photographed fact.
const PAPER = "#f4f0e6", INK = "#b6412e";
const SKYHEX = { dawn: "#e39b78", day: "#ddbe7c", dusk: "#a9707b", night: "#333c54" };

function svgImage(svgString) {
  return new Promise((res, rej) => {
    const withNS = svgString.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
                            .replaceAll("var(--ink)", INK);
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(withNS)));
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// photos are rounded squares now, matching the page; coins and empties stay circles
async function rectPhoto(ctx, blob, x, y, w, h, r) {
  const bmp = await createImageBitmap(blob);
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const sc = Math.max(w / bmp.width, h / bmp.height);
  ctx.drawImage(bmp, x + w / 2 - bmp.width * sc / 2, y + h / 2 - bmp.height * sc / 2, bmp.width * sc, bmp.height * sc);
  ctx.restore();
  bmp.close();
}

async function circlePhoto(ctx, blob, cx, cy, r) {
  const bmp = await createImageBitmap(blob);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.clip();
  const s = Math.max(2 * r / bmp.width, 2 * r / bmp.height);
  ctx.drawImage(bmp, cx - bmp.width * s / 2, cy - bmp.height * s / 2, bmp.width * s, bmp.height * s);
  ctx.restore();
  bmp.close();
}

// layout mirrors the page: witnessed rows and columns only; deep boards show quadrants.
// canvas sized to the board itself — no fixed width, no dead margins
export async function boardBlob({ captures, places, weathers, bands, glyph, deepened }) {
  const CELL = 340, GH = 110, GAP = 34, M = 72, MT = 40, CAPTION = 110;
  const cols = weathers.length, rowsN = places.length;
  const W = 2 * M + GH + cols * CELL + (cols - 1) * GAP;
  const H = MT + GH + rowsN * CELL + (rowsN - 1) * GAP + CAPTION + M / 2;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  const x0 = M, gsize = 66;
  for (let ci = 0; ci < cols; ci++) {
    const img = await svgImage(glyph(weathers[ci], gsize));
    ctx.drawImage(img, x0 + GH + ci * (CELL + GAP) + CELL / 2 - gsize / 2, MT + (GH - gsize) / 2 - 12);
  }
  for (let ri = 0; ri < rowsN; ri++) {
    const img = await svgImage(glyph(places[ri], gsize));
    ctx.drawImage(img, x0 + (GH - gsize) / 2 - 12, MT + GH + ri * (CELL + GAP) + CELL / 2 - gsize / 2);
  }

  for (let ri = 0; ri < rowsN; ri++) for (let ci = 0; ci < cols; ci++) {
    const x = x0 + GH + ci * (CELL + GAP), y = MT + GH + ri * (CELL + GAP);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.setLineDash([]);
    roundRect(ctx, x, y, CELL, CELL, 16);
    ctx.stroke();
    const kin = captures.filter(c => c.stamped && c.place === places[ri] && c.weather === weathers[ci]);
    if (!deepened) {
      const r = CELL * 0.34, cx = x + CELL / 2, cy = y + CELL / 2;
      const sq = CELL * 0.68;
      if (kin[0] && kin[0].photo) await rectPhoto(ctx, kin[0].photo, cx - sq / 2, cy - sq / 2, sq, sq, 18);
      else if (kin[0]) { ctx.fillStyle = SKYHEX[kin[0].band]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); }
      else {
        ctx.strokeStyle = "rgba(182,65,46,0.45)";
        ctx.lineWidth = 4.6;
        ctx.setLineDash([11, 13]);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
      }
    } else {
      const marks = {};
      for (const c of kin) marks[c.band] = c;
      const r = CELL * 0.185;
      const qs = CELL * 0.40; // quadrant photo square
      for (let qi = 0; qi < 4; qi++) {
        const cx = x + CELL * (qi % 2 ? 0.725 : 0.275);
        const cy = y + CELL * (qi > 1 ? 0.725 : 0.275);
        const m = marks[bands[qi]];
        if (m && m.photo) await rectPhoto(ctx, m.photo, cx - qs / 2, cy - qs / 2, qs, qs, 14);
        else if (m) { ctx.fillStyle = SKYHEX[m.band]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); }
        else {
          ctx.strokeStyle = "rgba(182,65,46,0.45)";
          ctx.lineWidth = 4;
          ctx.setLineDash([9, 11]);
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
        }
      }
    }
  }

  ctx.setLineDash([]);
  ctx.fillStyle = INK;
  ctx.font = "500 42px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.letterSpacing = "11px";
  ctx.fillText("CIRCUMSTANCE", W / 2, H - 46);

  return new Promise(res => canvas.toBlob(res, "image/png"));
}

export async function shareBoard(args) {
  const blob = await boardBlob(args);
  if (!blob) return;
  const file = new File([blob], "circumstance-board.png", { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch {}
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "circumstance-board.png";
  a.click();
}
