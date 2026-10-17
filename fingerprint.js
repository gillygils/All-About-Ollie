'use strict';

// Per-viewer fingerprints. Everyone's copy of a photo carries a faint pattern of their own: a grid of
// cells, each nudged a few shades brighter or darker, spread smoothly over the whole picture. It's
// too faint to see, and it survives resizing, recompression (as social sites do) and screenshots.
//
// To check a copy found elsewhere we already have the clean original, so we line the copy up with
// it, take the difference, and ask which person's pattern is in that difference. We only have to
// choose between the family's accounts (not decode a hidden message), which works even when the
// mark is faint.

const crypto = require('node:crypto');
const fs = require('node:fs');
const sharp = require('sharp');

const GRID = 64;   // cells along the picture's long side
const AMP = 2.5;   // most each cell is nudged, in brightness levels (0–255), in busy parts of a picture
const AMP_FLAT = 0.3; // ...and in smooth parts (under half a level: smooth areas are left almost untouched)
const WORK = 384;  // long side the checker compares at (6 pixels per cell)
const ALIGN = 160; // long side used to line the copy up with the original

// ---- patterns

const patterns = new Map();
// ±1 for each of GRID × GRID cells, the same every time for a given person (and secret).
function patternFor(secret, key) {
  const k = `${secret}:${key}`;
  let p = patterns.get(k);
  if (p) return p;
  p = new Int8Array(GRID * GRID);
  for (let block = 0; block * 256 < p.length; block++) {
    const bytes = crypto.createHmac('sha256', secret).update(`fp:${key}:${block}`).digest();
    for (let b = 0; b < 256 && block * 256 + b < p.length; b++) p[block * 256 + b] = (bytes[b >> 3] >> (b & 7)) & 1 ? 1 : -1;
  }
  if (patterns.size > 2000) patterns.clear();
  patterns.set(k, p);
  return p;
}

// How many cells across and down for a picture of this shape.
const gridDims = (w, h) => (w >= h
  ? [GRID, Math.max(4, Math.round((GRID * h) / w))]
  : [Math.max(4, Math.round((GRID * w) / h)), GRID]);

// ---- stamping a copy

// Writes `src` with this person's pattern blended in, to `out` (JPEG or WebP, by its extension).
async function stamp(src, pattern, out) {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const [cols, rows] = gridDims(w, h);
  const cells = Buffer.alloc(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells[r * cols + c] = 128 + 100 * pattern[r * GRID + c];
  // stretched smoothly over the picture, so there are no hard cell edges to see
  const field = await sharp(cells, { raw: { width: cols, height: rows, channels: 1 } })
    .resize(w, h, { fit: 'fill', kernel: 'cubic' }).extractChannel(0).raw().toBuffer();
  // How busy each part of the picture is: the mark is kept very faint on smooth skin, sky and
  // walls (where the eye would spot it) and a little stronger in texture, which hides it.
  const B = 8;
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const busy = Buffer.alloc(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let n = 0, s = 0, ss = 0;
      for (let y = by * B; y < Math.min(h, by * B + B); y++) {
        for (let x = bx * B; x < Math.min(w, bx * B + B); x++) {
          const i = (y * w + x) * channels;
          const l = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
          n++; s += l; ss += l * l;
        }
      }
      const sd = Math.sqrt(Math.max(0, ss / n - (s / n) ** 2));
      busy[by * bw + bx] = Math.round(50 * Math.min(AMP, AMP_FLAT + sd * 0.2)); // strength × 50
    }
  }
  const strengthMap = await sharp(busy, { raw: { width: bw, height: bh, channels: 1 } })
    .resize(w, h, { fit: 'fill', kernel: 'cubic' }).extractChannel(0).raw().toBuffer();
  const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  for (let p = 0, i = 0; p < w * h; p++, i += channels) {
    const d = ((field[p] - 128) / 100) * (strengthMap[p] / 50);
    px[i] += d; px[i + 1] += d; px[i + 2] += d;
  }
  let img = sharp(data, { raw: { width: w, height: h, channels } });
  img = out.endsWith('.webp') ? img.webp({ quality: 82 }) : img.jpeg({ quality: 88 });
  const part = `${out}.${process.pid}.part`;
  await fs.promises.writeFile(part, await img.toBuffer());
  await fs.promises.rename(part, out);
}

// ---- reading a copy

// A tiny greyscale version of a picture, for recognising which photo a found copy is.
async function signature(input) {
  return sharp(input, { failOn: 'none' }).rotate().removeAlpha().greyscale()
    .resize(32, 32, { fit: 'fill' }).raw().toBuffer();
}

function ncc(a, b) {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

// Greyscale pixels of a picture, scaled by `scale`.
async function grey(buf, scale) {
  const meta = await sharp(buf, { failOn: 'none' }).rotate().metadata();
  const upright = (meta.orientation || 1) >= 5;
  const W = upright ? meta.height : meta.width;
  const H = upright ? meta.width : meta.height;
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const data = await sharp(buf, { failOn: 'none' }).rotate().removeAlpha().greyscale()
    .resize(w, h, { fit: 'fill' }).raw().toBuffer();
  return { data, w, h };
}

// Where the whole original sits in a found picture: a rectangle in the found picture's pixels.
// It can reach past the edges of what was found (the copy was cropped) or sit inside it
// (a screenshot with other things around the photo).
//
// Samples the found picture onto an outW × outH grid laid over the original, averaging s × s
// points per pixel. Pixels that fall outside `box` (the part of the found picture that shows the
// photo) are marked as missing.
function sample(img, box, map, outW, outH, s = 2) {
  const vals = new Float32Array(outW * outH);
  const ok = new Uint8Array(outW * outH);
  const { data, w, h } = img;
  const sx = map.w / outW, sy = map.h / outH;
  const x1 = Math.min(box.x + box.w, w) - 1.001, y1 = Math.min(box.y + box.h, h) - 1.001; // (rounding can make the box a hair bigger than the picture)
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const cx = map.x + (ox + 0.5) * sx - 0.5, cy = map.y + (oy + 0.5) * sy - 0.5;
      if (cx < box.x || cy < box.y || cx > x1 || cy > y1) continue;
      let sum = 0;
      for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
          const fx = Math.min(x1, Math.max(box.x, map.x + (ox + (i + 0.5) / s) * sx - 0.5));
          const fy = Math.min(y1, Math.max(box.y, map.y + (oy + (j + 0.5) / s) * sy - 0.5));
          const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, k = y0 * w + x0;
          sum += (data[k] * (1 - ax) + data[k + 1] * ax) * (1 - ay) + (data[k + w] * (1 - ax) + data[k + w + 1] * ax) * ay;
        }
      }
      vals[oy * outW + ox] = sum / (s * s);
      ok[oy * outW + ox] = 1;
    }
  }
  return { vals, ok };
}

// How alike two pictures are where both are present (−1 to 1); −2 if too little overlaps to say.
function nccMasked(a, ok, ref, minShare) {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < ok.length; i++) if (ok[i]) { n++; sa += a[i]; sb += ref[i]; }
  if (n < minShare * ok.length) return -2;
  const ma = sa / n, mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < ok.length; i++) if (ok[i]) { const x = a[i] - ma, y = ref[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

const fit = (W, H, long) => (W >= H ? [long, Math.max(1, Math.round((long * H) / W))] : [Math.max(1, Math.round((long * W) / H)), long]);

async function refGrey(origFile, w, h) {
  return new Float32Array(await sharp(origFile).greyscale().resize(w, h, { fit: 'fill' }).raw().toBuffer());
}

// The found picture's size, the right way up.
async function uprightSize(buf) {
  const meta = await sharp(buf, { failOn: 'none' }).rotate().metadata();
  const turned = (meta.orientation || 1) >= 5;
  return turned ? [meta.height, meta.width] : [meta.width, meta.height];
}

// Finds where the original sits in the found picture. `crop` (fractions 0–1) is the part that shows
// the photo. First assume the photo fills it and nudge; if that doesn't fit well, search every size
// and position (a copy cropped down to part of the photo), then nudge ever more finely.
async function align(foundBuf, crop, origFile, origW, origH) {
  const aspect = origW / origH;
  const [FW, FH] = await uprightSize(foundBuf);
  const cw = crop.w * FW, ch = crop.h * FH;
  const scale = Math.min(1, (2 * ALIGN) / Math.max(cw, ch));
  const img = await grey(foundBuf, scale);
  const box = { x: crop.x * FW * scale, y: crop.y * FH * scale, w: cw * scale, h: ch * scale };
  const [aw, ah] = fit(origW, origH, ALIGN);
  const ref = await refGrey(origFile, aw, ah);
  const at = (m) => { const r = sample(img, box, m, aw, ah, 2); return nccMasked(r.vals, r.ok, ref, 0.25); };
  const sw0 = Math.sqrt(box.w * box.h * aspect);
  let best = { x: box.x + box.w / 2 - sw0 / 2, y: box.y + box.h / 2 - sw0 / aspect / 2, w: sw0, score: -2 };
  const consider = (m, score) => { if (score > best.score) best = { x: m.x, y: m.y, w: m.w, score }; };
  const refine = (steps) => {
    for (const step of steps) for (let pass = 0; pass < 4; pass++) {
      const { x, y, w, score: before } = best;
      const cx = x + w / 2, cy = y + w / aspect / 2;
      for (let s = -2; s <= 2; s++) {
        const nw = w * (1 + s * step * 2);
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
          const m = { x: cx + dx * step * w - nw / 2, y: cy + dy * step * w - nw / aspect / 2, w: nw, h: nw / aspect };
          consider(m, at(m));
        }
      }
      if (best.score <= before) break; // settled at this step size
    }
  };
  consider({ ...best, h: best.w / aspect }, at({ ...best, h: best.w / aspect }));
  refine([0.02, 0.005]);
  if (best.score < 0.95) {
    const [lw, lh] = fit(origW, origH, 72);
    const small = await refGrey(origFile, lw, lh);
    const atSmall = (m) => { const r = sample(img, box, m, lw, lh, 1); return nccMasked(r.vals, r.ok, small, 0.2); };
    let rough = { score: -2 };
    for (let k = 0; k <= 14; k++) {
      const w = sw0 * 0.9 * Math.pow(2.6, k / 14);
      const h = w / aspect;
      const step = w / 64;
      const x0 = Math.min(box.x, box.x + box.w - w) - 0.1 * box.w, x1 = Math.max(box.x, box.x + box.w - w) + 0.1 * box.w;
      const y0 = Math.min(box.y, box.y + box.h - h) - 0.1 * box.h, y1 = Math.max(box.y, box.y + box.h - h) + 0.1 * box.h;
      for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
        const sc = atSmall({ x, y, w, h });
        if (sc > rough.score) rough = { x, y, w, score: sc };
      }
    }
    if (rough.score > -2) {
      const kept = best;
      const m = { x: rough.x, y: rough.y, w: rough.w, h: rough.w / aspect };
      best = { ...m, score: at(m) };
      refine([0.02, 0.005]);
      if (kept.score > best.score) best = kept;
    }
  }
  refine([0.00125]);
  return { map: { x: best.x / scale, y: best.y / scale, w: best.w / scale, h: best.w / aspect / scale }, match: best.score };
}

// The faint difference between the found copy and the original, averaged per cell, with smooth
// changes (brightness, colour grading, vignettes) taken out. Cells mostly cut off are left out.
async function residualCells(foundBuf, crop, map, origFile, origW, origH) {
  const [ww, wh] = fit(origW, origH, WORK);
  const ref = await refGrey(origFile, ww, wh);
  const [FW, FH] = await uprightSize(foundBuf);
  const scale = Math.min(1, (2 * WORK) / Math.max(map.w, map.h));
  const img = await grey(foundBuf, scale);
  const box = { x: crop.x * FW * scale, y: crop.y * FH * scale, w: crop.w * FW * scale, h: crop.h * FH * scale };
  const { vals: s, ok } = sample(img, box, { x: map.x * scale, y: map.y * scale, w: map.w * scale, h: map.h * scale }, ww, wh, 3);
  // least-squares fit found ≈ a·original + b, then what's left over
  let n = 0, so = 0, ss = 0, soo = 0, sos = 0;
  for (let i = 0; i < ok.length; i++) if (ok[i]) { n++; so += ref[i]; ss += s[i]; soo += ref[i] * ref[i]; sos += ref[i] * s[i]; }
  const a = (n * sos - so * ss) / (n * soo - so * so || 1);
  const b = (ss - a * so) / (n || 1);
  const [cols, rows] = gridDims(origW, origH);
  const sum = new Float64Array(cols * rows);
  const cnt = new Float64Array(cols * rows);
  const area = (ww / cols) * (wh / rows);
  for (let y = 0; y < wh; y++) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / wh));
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      if (!ok[i]) continue;
      const c = Math.min(cols - 1, Math.floor((x * cols) / ww));
      sum[r * cols + c] += Math.max(-12, Math.min(12, s[i] - (a * ref[i] + b))); // edges that didn't line up perfectly shouldn't dominate
      cnt[r * cols + c]++;
    }
  }
  const valid = new Uint8Array(cols * rows);
  const m = new Float64Array(cols * rows);
  for (let i = 0; i < m.length; i++) if (cnt[i] >= 0.6 * area) { valid[i] = 1; m[i] = sum[i] / cnt[i]; }
  return { cells: highPass(m, valid, cols, rows), valid, cols, rows };
}

// Each cell minus the average of its neighbours: keeps the cell-to-cell pattern, drops smooth shifts.
function highPass(m, valid, cols, rows) {
  const out = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!valid[i]) continue;
      let s = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if ((dr || dc) && rr >= 0 && rr < rows && cc >= 0 && cc < cols && valid[rr * cols + cc]) { s += m[rr * cols + cc]; n++; }
      }
      out[i] = n ? m[i] - s / n : 0;
    }
  }
  return out;
}

// How strongly a pattern shows up in the cells (a correlation, −1 to 1).
function strength(cells, valid, cols, rows, pattern) {
  const p = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) p[r * cols + c] = pattern[r * GRID + c];
  const hp = highPass(p, valid, cols, rows);
  let dot = 0, mm = 0, pp = 0;
  for (let i = 0; i < hp.length; i++) if (valid[i]) { dot += cells[i] * hp[i]; mm += cells[i] * cells[i]; pp += hp[i] * hp[i]; }
  return mm && pp ? dot / Math.sqrt(mm * pp) : 0;
}

// Scores every candidate (a list of { key }) against a found copy of the original. Each score says
// how many times further than chance that person's pattern shows up, measured against 200 made-up
// patterns nobody has: chance alone stays under about 3, so 6 or more is a clear match.
async function check(foundBuf, crop, origFile, candidates, secret) {
  const meta = await sharp(origFile).metadata();
  const { map, match } = await align(foundBuf, crop, origFile, meta.width, meta.height);
  const { cells, valid, cols, rows } = await residualCells(foundBuf, crop, map, origFile, meta.width, meta.height);
  const used = valid.reduce((s, v) => s + v, 0);
  const nulls = [];
  for (let k = 0; k < 200; k++) nulls.push(strength(cells, valid, cols, rows, patternFor(secret, `nobody-${k}`)));
  const mean = nulls.reduce((s, v) => s + v, 0) / nulls.length;
  const sd = Math.sqrt(nulls.reduce((s, v) => s + (v - mean) ** 2, 0) / nulls.length) || 1;
  const scores = candidates.map((c) => ({ ...c, score: (strength(cells, valid, cols, rows, patternFor(secret, c.key)) - mean) / sd }));
  scores.sort((x, y) => y.score - x.score);
  return { scores, lineUp: match, coverage: used / (cols * rows) };
}

module.exports = { patternFor, stamp, signature, ncc, check };
