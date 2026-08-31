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

// layout mirrors the page: witnessed rows and columns only; deep boards show quadrants
export async function boardBlob({ captures, places, weathers, bands, glyph, deepened }) {
  const M = 72, GH = 76, CELLGAP = 22, W = 1080;
  const cols = weathers.length, rowsN = places.length;
  const cellW = Math.min(220, (W - 2 * M - GH - (cols - 1) * CELLGAP) / cols);
  const gridW = GH + cols * cellW + (cols - 1) * CELLGAP;
  const x0 = (W - gridW) / 2;
  const H = M + GH + rowsN * cellW + (rowsN - 1) * CELLGAP + M + 60;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  const gsize = 44;
  for (let ci = 0; ci < cols; ci++) {
    const img = await svgImage(glyph(weathers[ci], gsize));
    ctx.drawImage(img, x0 + GH + ci * (cellW + CELLGAP) + cellW / 2 - gsize / 2, M + (GH - gsize) / 2 - 8);
  }
  for (let ri = 0; ri < rowsN; ri++) {
    const img = await svgImage(glyph(places[ri], gsize));
    ctx.drawImage(img, x0 + (GH - gsize) / 2 - 8, M + GH + ri * (cellW + CELLGAP) + cellW / 2 - gsize / 2);
  }

  for (let ri = 0; ri < rowsN; ri++) for (let ci = 0; ci < cols; ci++) {
    const x = x0 + GH + ci * (cellW + CELLGAP), y = M + GH + ri * (cellW + CELLGAP);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    roundRect(ctx, x, y, cellW, cellW, 10);
    ctx.stroke();
    const kin = captures.filter(c => c.stamped && c.place === places[ri] && c.weather === weathers[ci]);
    if (!deepened) {
      const r = cellW * 0.34, cx = x + cellW / 2, cy = y + cellW / 2;
      if (kin[0] && kin[0].photo) await circlePhoto(ctx, kin[0].photo, cx, cy, r);
      else if (kin[0]) { ctx.fillStyle = SKYHEX[kin[0].band]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); }
      else {
        ctx.strokeStyle = "rgba(182,65,46,0.45)";
        ctx.lineWidth = 2.4;
        ctx.setLineDash([7, 8]);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
      }
    } else {
      const marks = {};
      for (const c of kin) marks[c.band] = c;
      const r = cellW * 0.185;
      for (let qi = 0; qi < 4; qi++) {
        const cx = x + cellW * (qi % 2 ? 0.725 : 0.275);
        const cy = y + cellW * (qi > 1 ? 0.725 : 0.275);
        const m = marks[bands[qi]];
        if (m && m.photo) await circlePhoto(ctx, m.photo, cx, cy, r);
        else if (m) { ctx.fillStyle = SKYHEX[m.band]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); }
        else {
          ctx.strokeStyle = "rgba(182,65,46,0.45)";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 7]);
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
        }
      }
    }
  }

  ctx.setLineDash([]);
  ctx.fillStyle = INK;
  ctx.font = "500 26px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.letterSpacing = "6px";
  ctx.fillText("CIRCUMSTANCE", W / 2, H - M + 14);

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
