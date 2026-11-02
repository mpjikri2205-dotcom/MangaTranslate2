/**
 * Mesin pixel untuk menghapus teks asli manga.
 *
 * Semua fungsi di sini "pure": hanya butuh { data, width, height } (kompatibel dengan ImageData),
 * tidak menyentuh DOM, sehingga bisa diuji di Node.
 *
 * Alur:
 *   analyzeBlock()  -> menentukan MASK piksel teks (+ bentuk interior balon) dari gambar ASLI
 *   applyErase()    -> mengisi piksel mask dengan warna sekitar (inpainting)
 *
 * Dua jalur deteksi teks:
 *   - FLAT     : teks di atas warna rata (balon putih, kotak narasi, latar hitam rata).
 *                Flood-fill area latar -> semua "lubang" di dalamnya adalah teks.
 *                Garis tepi balon TIDAK ikut terhapus karena bukan lubang tertutup.
 *   - TEXTURED : teks di atas gambar/screentone. Deteksi goresan tipis kontras tinggi
 *                (black-hat + white-hat morphology), lalu inpaint.
 */

export interface Bitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlockAnalysis {
  mode: 'flat' | 'textured' | 'none';
  /** Jendela kerja (koordinat gambar, piksel). mask & interior berukuran win.w * win.h */
  win: Rect;
  /** 1 = piksel teks yang harus dihapus. null jika tidak ada. */
  mask: Uint8Array | null;
  maskCount: number;
  /** Warna latar dominan (hanya bermakna untuk mode 'flat') */
  bg: [number, number, number];
  /** bbox interior balon (koordinat gambar, piksel). null jika tidak terdeteksi / bocor. */
  interiorBBox: Rect | null;
  /** luas interior / luas bbox. ~0.785 = oval, ~1 = persegi */
  interiorFill: number;
}

export interface AnalyzeOptions {
  isBalloon: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function clampRect(r: Rect, W: number, H: number): Rect {
  const x0 = clamp(Math.floor(r.x), 0, W - 1);
  const y0 = clamp(Math.floor(r.y), 0, H - 1);
  const x1 = clamp(Math.ceil(r.x + r.w), x0 + 1, W);
  const y1 = clamp(Math.ceil(r.y + r.h), y0 + 1, H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function expandRect(r: Rect, ex: number, ey: number, W: number, H: number): Rect {
  return clampRect({ x: r.x - ex, y: r.y - ey, w: r.w + 2 * ex, h: r.h + 2 * ey }, W, H);
}

// ───────────────────────── Komponen terhubung ─────────────────────────

interface Components {
  labels: Int32Array; // 0 = bukan komponen, 1..count
  count: number;
  area: number[];
  x0: number[];
  y0: number[];
  x1: number[];
  y1: number[];
}

function labelComponents(mask: Uint8Array, w: number, h: number, eight: boolean): Components {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const area: number[] = [0];
  const x0: number[] = [0];
  const y0: number[] = [0];
  const x1: number[] = [0];
  const y1: number[] = [0];
  let count = 0;

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    count++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    let a = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p - px) / w;
      a++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!eight && dx !== 0 && dy !== 0) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = count;
            stack[sp++] = q;
          }
        }
      }
    }
    area.push(a);
    x0.push(minX);
    y0.push(minY);
    x1.push(maxX);
    y1.push(maxY);
  }
  return { labels, count, area, x0, y0, x1, y1 };
}

// ───────────────────────── Morfologi biner ─────────────────────────

export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) tmp[row + k] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!tmp[y * w + x]) continue;
      const a = Math.max(0, y - r);
      const b = Math.min(h - 1, y + r);
      for (let k = a; k <= b; k++) out[k * w + x] = 1;
    }
  }
  return out;
}

// ───────────────────────── Morfologi grayscale (min/max filter) ─────────────────────────

function rankFilter(src: Uint8Array, w: number, h: number, r: number, takeMax: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      let v = src[row + a];
      for (let k = a + 1; k <= b; k++) {
        const s = src[row + k];
        if (takeMax ? s > v : s < v) v = s;
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r);
      const b = Math.min(h - 1, y + r);
      let v = tmp[a * w + x];
      for (let k = a + 1; k <= b; k++) {
        const s = tmp[k * w + x];
        if (takeMax ? s > v : s < v) v = s;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

// ───────────────────────── Analisis 1 blok ─────────────────────────

function emptyAnalysis(win: Rect): BlockAnalysis {
  return { mode: 'none', win, mask: null, maskCount: 0, bg: [255, 255, 255], interiorBBox: null, interiorFill: 0 };
}

/**
 * Analisis blok teks pada gambar ASLI (belum dihapus apa pun).
 * @param src area teks asli dalam piksel gambar
 */
export function analyzeBlock(bmp: Bitmap, srcIn: Rect, opts: AnalyzeOptions): BlockAnalysis {
  const W = bmp.width;
  const H = bmp.height;
  const src = clampRect(srcIn, W, H);
  if (src.w < 3 || src.h < 3) return emptyAnalysis(src);

  // Jendela kerja: cukup besar untuk mencapai garis tepi balon, tapi terbatas agar flood-fill tidak bocor jauh.
  const ex = clamp(0.7 * src.w, 16, 0.3 * W);
  const ey = clamp(0.7 * src.h, 16, 0.3 * H);
  const win = expandRect(src, ex, ey, W, H);
  const ww = win.w;
  const wh = win.h;
  const d = bmp.data;

  // Koordinat src relatif jendela
  const sx0 = src.x - win.x;
  const sy0 = src.y - win.y;
  const sx1 = sx0 + src.w;
  const sy1 = sy0 + src.h;

  // 1) Warna latar dominan dari area src (histogram 5-bit per kanal)
  const hist = new Map<number, number>();
  for (let y = src.y; y < src.y + src.h; y++) {
    for (let x = src.x; x < src.x + src.w; x++) {
      const i = (y * W + x) * 4;
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  let topKey = 0;
  let topCount = -1;
  hist.forEach((c, k) => {
    if (c > topCount) {
      topCount = c;
      topKey = k;
    }
  });
  const kr = ((topKey >> 10) & 31) * 8 + 4;
  const kg = ((topKey >> 5) & 31) * 8 + 4;
  const kb = (topKey & 31) * 8 + 4;
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = src.y; y < src.y + src.h; y++) {
    for (let x = src.x; x < src.x + src.w; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(d[i] - kr) <= 14 && Math.abs(d[i + 1] - kg) <= 14 && Math.abs(d[i + 2] - kb) <= 14) {
        sr += d[i];
        sg += d[i + 1];
        sb += d[i + 2];
        sn++;
      }
    }
  }
  const bg: [number, number, number] = sn > 0 ? [sr / sn, sg / sn, sb / sn] : [kr, kg, kb];

  // 2) Peta "dekat warna latar" pada jendela
  const TOL = 26;
  const near = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((win.y + y) * W + (win.x + x)) * 4;
      if (
        Math.abs(d[i] - bg[0]) <= TOL &&
        Math.abs(d[i + 1] - bg[1]) <= TOL &&
        Math.abs(d[i + 2] - bg[2]) <= TOL
      ) {
        near[y * ww + x] = 1;
      }
    }
  }
  let nearInSrc = 0;
  for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) nearInSrc += near[y * ww + x];
  const srcArea = src.w * src.h;
  const flatRatio = nearInSrc / srcArea;
  const isFlat = flatRatio >= (opts.isBalloon ? 0.3 : 0.45);

  if (isFlat) {
    const res = analyzeFlat(bmp, win, src, near, bg, opts);
    if (res) return res;
  }
  return analyzeTextured(bmp, win, src, bg);
}

function analyzeFlat(
  bmp: Bitmap,
  win: Rect,
  src: Rect,
  near: Uint8Array,
  bg: [number, number, number],
  opts: AnalyzeOptions
): BlockAnalysis | null {
  const ww = win.w;
  const wh = win.h;
  const sx0 = src.x - win.x;
  const sy0 = src.y - win.y;
  const srcArea = src.w * src.h;

  const cc = labelComponents(near, ww, wh, false);
  const inSrc = new Int32Array(cc.count + 1);
  for (let y = sy0; y < sy0 + src.h; y++) {
    for (let x = sx0; x < sx0 + src.w; x++) {
      const l = cc.labels[y * ww + x];
      if (l) inSrc[l]++;
    }
  }
  const minArea = Math.max(24, 0.02 * srcArea);
  const reachedLabel = new Uint8Array(cc.count + 1);
  let anyReached = false;
  for (let l = 1; l <= cc.count; l++) {
    if (cc.area[l] >= minArea && inSrc[l] >= Math.max(4, 0.01 * srcArea)) {
      reachedLabel[l] = 1;
      anyReached = true;
    }
  }
  if (!anyReached) return null;

  const reached = new Uint8Array(ww * wh);
  for (let i = 0; i < ww * wh; i++) {
    const l = cc.labels[i];
    if (l && reachedLabel[l]) reached[i] = 1;
  }

  // "Di luar": piksel non-reached yang terhubung ke tepi jendela (garis balon, seni, dll.)
  const notReached = new Uint8Array(ww * wh);
  for (let i = 0; i < ww * wh; i++) notReached[i] = reached[i] ? 0 : 1;
  const outside = new Uint8Array(ww * wh);
  {
    const stack = new Int32Array(ww * wh);
    let sp = 0;
    const push = (p: number) => {
      if (notReached[p] && !outside[p]) {
        outside[p] = 1;
        stack[sp++] = p;
      }
    };
    for (let x = 0; x < ww; x++) {
      push(x);
      push((wh - 1) * ww + x);
    }
    for (let y = 0; y < wh; y++) {
      push(y * ww);
      push(y * ww + ww - 1);
    }
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % ww;
      const py = (p - px) / ww;
      if (px > 0) push(p - 1);
      if (px < ww - 1) push(p + 1);
      if (py > 0) push(p - ww);
      if (py < wh - 1) push(p + ww);
    }
  }

  // Lubang tertutup = kandidat teks
  const holes = new Uint8Array(ww * wh);
  for (let i = 0; i < ww * wh; i++) holes[i] = notReached[i] && !outside[i] ? 1 : 0;

  // Interior terisi (untuk bentuk balon)
  const interior = new Uint8Array(ww * wh);
  let interiorArea = 0;
  let ix0 = ww, iy0 = wh, ix1 = -1, iy1 = -1;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      if (reached[i] || holes[i]) {
        interior[i] = 1;
        interiorArea++;
        if (x < ix0) ix0 = x;
        if (x > ix1) ix1 = x;
        if (y < iy0) iy0 = y;
        if (y > iy1) iy1 = y;
      }
    }
  }

  // Filter komponen lubang: hanya yang berada di sekitar area teks.
  // Interior balon terpercaya (tertutup, mencakup teks, ukuran wajar) -> semua goresan netral di dalamnya = teks,
  // walaupun kotak AI melewatkan sebagian (mis. satu kolom/baris di tepi).
  let trusted = false;
  {
    let bh0 = 0;
    for (let x = 0; x < ww; x++) bh0 += interior[x] + interior[(wh - 1) * ww + x];
    for (let y = 0; y < wh; y++) bh0 += interior[y * ww] + interior[y * ww + ww - 1];
    let cov = 0;
    for (let y = sy0; y < sy0 + src.h; y++) for (let x = sx0; x < sx0 + src.w; x++) cov += interior[y * ww + x];
    trusted = opts.isBalloon && bh0 <= 0.25 * (2 * ww + 2 * wh) && cov / srcArea >= 0.7 && interiorArea <= 9 * srcArea;
  }
  const hc = labelComponents(holes, ww, wh, true);
  const kx = opts.isBalloon ? Math.max(6, 0.15 * src.w) : Math.max(3, 0.08 * src.w);
  const ky = opts.isBalloon ? Math.max(6, 0.15 * src.h) : Math.max(3, 0.08 * src.h);
  const kr = { x0: sx0 - kx, y0: sy0 - ky, x1: sx0 + src.w + kx, y1: sy0 + src.h + ky };
  const keep = new Uint8Array(hc.count + 1);
  // Teks manga netral (hitam/abu/putih). Komponen berwarna (mulut, bibir, rambut) bukan teks -> jangan dihapus.
  const neutralCnt = new Int32Array(hc.count + 1);
  {
    const dd = bmp.data;
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const l = hc.labels[y * ww + x];
        if (!l) continue;
        const i = ((win.y + y) * bmp.width + (win.x + x)) * 4;
        const spread = Math.max(dd[i], dd[i + 1], dd[i + 2]) - Math.min(dd[i], dd[i + 1], dd[i + 2]);
        if (spread <= 40) neutralCnt[l]++;
      }
    }
  }
  for (let l = 1; l <= hc.count; l++) {
    if (neutralCnt[l] < 0.6 * hc.area[l]) continue;
    const bw = hc.x1[l] - hc.x0[l] + 1;
    const bh = hc.y1[l] - hc.y0[l] + 1;
    const ox = Math.max(0, Math.min(hc.x1[l] + 1, kr.x1) - Math.max(hc.x0[l], kr.x0));
    const oy = Math.max(0, Math.min(hc.y1[l] + 1, kr.y1) - Math.max(hc.y0[l], kr.y0));
    const frac = (ox * oy) / (bw * bh);
    if ((trusted || frac >= 0.7) && hc.area[l] <= 0.6 * ww * wh) keep[l] = 1;
  }
  const kept = new Uint8Array(ww * wh);
  let keptCount = 0;
  for (let i = 0; i < ww * wh; i++) {
    const l = hc.labels[i];
    if (l && keep[l]) {
      kept[i] = 1;
      keptCount++;
    }
  }

  // Dilasi untuk menutup halo anti-alias; lindungi piksel yang bukan teks (garis balon).
  const mask = dilate(kept, ww, wh, 2);
  let maskCount = 0;
  for (let i = 0; i < ww * wh; i++) {
    if (mask[i]) {
      if (outside[i] || (holes[i] && !kept[i])) mask[i] = 0;
      else maskCount++;
    }
  }

  // Bocor? (interior menyentuh tepi jendela di banyak tempat)
  let borderHit = 0;
  for (let x = 0; x < ww; x++) {
    borderHit += interior[x] + interior[(wh - 1) * ww + x];
  }
  for (let y = 0; y < wh; y++) {
    borderHit += interior[y * ww] + interior[y * ww + ww - 1];
  }
  const leaky = borderHit > 0.25 * (2 * ww + 2 * wh);

  let interiorBBox: Rect | null = null;
  let interiorFill = 0;
  if (!leaky && ix1 >= ix0 && iy1 >= iy0) {
    const bw = ix1 - ix0 + 1;
    const bh = iy1 - iy0 + 1;
    // interior harus mencakup sebagian besar area teks asli
    let covered = 0;
    for (let y = sy0; y < sy0 + src.h; y++) for (let x = sx0; x < sx0 + src.w; x++) covered += interior[y * ww + x];
    if (covered / srcArea >= 0.7) {
      const pad = 2;
      interiorBBox = {
        x: win.x + ix0 + pad,
        y: win.y + iy0 + pad,
        w: Math.max(1, bw - 2 * pad),
        h: Math.max(1, bh - 2 * pad)
      };
      interiorFill = interiorArea / (bw * bh);
    }
  }

  return {
    mode: 'flat',
    win,
    mask: maskCount > 0 ? mask : null,
    maskCount,
    bg,
    interiorBBox,
    interiorFill
  };
}

function analyzeTextured(bmp: Bitmap, win0: Rect, src: Rect, bg: [number, number, number], depth = 0): BlockAnalysis {
  const W = bmp.width;
  const H = bmp.height;
  const d = bmp.data;
  const m = Math.max(4, Math.round(0.1 * Math.min(src.w, src.h)));
  const win = expandRect(src, m, m, W, H);
  const ww = win.w;
  const wh = win.h;

  const gray = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((win.y + y) * W + (win.x + x)) * 4;
      gray[y * ww + x] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
  }

  // Kernel morfologi harus lebih tebal dari goresan huruf (termasuk outline).
  const r = clamp(Math.round(0.12 * Math.min(src.w, src.h)), 3, 24);
  const opened = rankFilter(rankFilter(gray, ww, wh, r, false), ww, wh, r, true); // opening
  const closed = rankFilter(rankFilter(gray, ww, wh, r, true), ww, wh, r, false); // closing

  // Teks manga hampir selalu hitam/putih (atau beroutline hitam/putih): batasi kandidat ke piksel ekstrem
  // agar gambar berwarna/nada-menengah tidak ikut terdeteksi.
  const TH = 30;
  const raw = new Uint8Array(ww * wh);
  for (let i = 0; i < ww * wh; i++) {
    const g = gray[i];
    const px = (((win.y + ((i / ww) | 0)) * W) + (win.x + (i % ww))) * 4;
    const spread = Math.max(d[px], d[px + 1], d[px + 2]) - Math.min(d[px], d[px + 1], d[px + 2]);
    if (spread > 60) continue; // piksel berwarna = gambar, bukan teks
    if (g >= 200 && g - opened[i] > TH) raw[i] = 1; // goresan terang tipis
    else if (g <= 70 && closed[i] - g > TH) raw[i] = 1; // goresan gelap tipis
  }

  // Batasi ke kotak teks dari AI (+ margin kecil). Garis gambar yang menembus kotak ikut terhapus
  // di dalam kotak saja -> kerusakan terbatas, dan huruf yang menyatu dengan garis tetap terdeteksi.
  const winArea = ww * wh;
  const cm = Math.max(6, Math.round(0.1 * Math.min(src.w, src.h)));
  const bx0 = src.x - win.x - cm;
  const by0 = src.y - win.y - cm;
  const bx1 = src.x - win.x + src.w + cm;
  const by1 = src.y - win.y + src.h + cm;
  const kept = new Uint8Array(winArea);
  let keptCount = 0;
  for (let y = Math.max(0, by0); y < Math.min(wh, by1); y++) {
    for (let x = Math.max(0, bx0); x < Math.min(ww, bx1); x++) {
      if (raw[y * ww + x]) {
        kept[y * ww + x] = 1;
        keptCount++;
      }
    }
  }

  // Goresan menempel di batas kotak = teks melewati kotak AI -> perluas kotak lalu ulangi (maks 2x)
  if (depth < 2) {
    let edge = 0;
    const band = 2;
    for (let y = Math.max(0, by0); y < Math.min(wh, by1); y++) {
      for (let x = Math.max(0, bx0); x < Math.min(ww, bx1); x++) {
        if (kept[y * ww + x] && (x < bx0 + band || x >= bx1 - band || y < by0 + band || y >= by1 - band)) edge++;
      }
    }
    const bandArea = 2 * band * ((bx1 - bx0) + (by1 - by0));
    if (edge > 0.08 * bandArea) {
      const bigger = expandRect(src, Math.max(6, 0.12 * src.w), Math.max(6, 0.12 * src.h), W, H);
      if (bigger.w > src.w || bigger.h > src.h) return analyzeTextured(bmp, win0, bigger, bg, depth + 1);
    }
  }

  const density = keptCount / ((bx1 - bx0) * (by1 - by0));
  if ((globalThis as any).__PIXEL_DEBUG) console.log('[textured]', { r, keptCount, density: density.toFixed(3) });
  if (keptCount < 6 || density > 0.78) {
    const e = emptyAnalysis(win);
    e.bg = bg;
    return e;
  }

  const mask = dilate(kept, ww, wh, 2);
  let maskCount = 0;
  for (let i = 0; i < winArea; i++) maskCount += mask[i];
  return { mode: 'textured', win, mask, maskCount, bg, interiorBBox: null, interiorFill: 0 };
}

// ───────────────────────── Inpainting ─────────────────────────

/**
 * Isi piksel mask dengan warna sekitar: "onion-peel" dari tepi ke dalam, lalu difusi halus.
 * Mengubah bmp.data langsung.
 * @param snapBg jika diberikan (mode flat), hasil yang mendekati warna ini dipaku ke warna tsb agar bersih/rata.
 */
export function inpaint(bmp: Bitmap, win: Rect, mask: Uint8Array, snapBg?: [number, number, number]): void {
  const W = bmp.width;
  const H = bmp.height;
  const d = bmp.data;
  const ww = win.w;
  const wh = win.h;

  const state = new Uint8Array(ww * wh); // 0 known, 1 pending, 2 filled
  let pending: number[] = [];
  for (let i = 0; i < ww * wh; i++) {
    if (mask[i]) {
      state[i] = 1;
      pending.push(i);
    }
  }
  if (pending.length === 0) return;

  const idxOf = (lx: number, ly: number) => ((win.y + ly) * W + (win.x + lx)) * 4;
  const isPendingAt = (lx: number, ly: number) => {
    if (lx < 0 || ly < 0 || lx >= ww || ly >= wh) return false;
    return state[ly * ww + lx] === 1;
  };
  const inImage = (lx: number, ly: number) => win.x + lx >= 0 && win.y + ly >= 0 && win.x + lx < W && win.y + ly < H;

  let guard = 0;
  while (pending.length > 0 && guard++ < 400) {
    const writes: number[] = []; // [idx, r, g, b] * n
    const stillPending: number[] = [];
    for (const p of pending) {
      const lx = p % ww;
      const ly = (p - lx) / ww;
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = lx + dx;
          const ny = ly + dy;
          if (!inImage(nx, ny)) continue;
          if (isPendingAt(nx, ny)) continue;
          const wgt = dx === 0 || dy === 0 ? 1 : 0.7;
          const i = idxOf(nx, ny);
          sr += d[i] * wgt;
          sg += d[i + 1] * wgt;
          sb += d[i + 2] * wgt;
          sw += wgt;
        }
      }
      if (sw > 0) {
        writes.push(p, sr / sw, sg / sw, sb / sw);
      } else {
        stillPending.push(p);
      }
    }
    if (writes.length === 0) {
      // Tidak ada tetangga yang diketahui sama sekali -> pakai warna latar / putih
      const fb = snapBg || [255, 255, 255];
      for (const p of stillPending) {
        const lx = p % ww;
        const ly = (p - lx) / ww;
        const i = idxOf(lx, ly);
        d[i] = fb[0];
        d[i + 1] = fb[1];
        d[i + 2] = fb[2];
        state[p] = 2;
      }
      break;
    }
    for (let k = 0; k < writes.length; k += 4) {
      const p = writes[k];
      const lx = p % ww;
      const ly = (p - lx) / ww;
      const i = idxOf(lx, ly);
      d[i] = writes[k + 1];
      d[i + 1] = writes[k + 2];
      d[i + 2] = writes[k + 3];
      state[p] = 2;
    }
    pending = stillPending;
  }

  // Difusi halus (Jacobi) hanya di area mask supaya tidak bergaris-garis.
  const maskIdx: number[] = [];
  for (let i = 0; i < ww * wh; i++) if (mask[i]) maskIdx.push(i);
  const buf = new Float32Array(maskIdx.length * 3);
  for (let iter = 0; iter < 6; iter++) {
    for (let k = 0; k < maskIdx.length; k++) {
      const p = maskIdx[k];
      const lx = p % ww;
      const ly = (p - lx) / ww;
      let sr = 0, sg = 0, sb = 0, n = 0;
      const nbrs = [
        [lx - 1, ly],
        [lx + 1, ly],
        [lx, ly - 1],
        [lx, ly + 1]
      ];
      for (const [nx, ny] of nbrs) {
        if (!inImage(nx, ny)) continue;
        const i = idxOf(nx, ny);
        sr += d[i];
        sg += d[i + 1];
        sb += d[i + 2];
        n++;
      }
      const i0 = idxOf(lx, ly);
      if (n > 0) {
        buf[k * 3] = sr / n;
        buf[k * 3 + 1] = sg / n;
        buf[k * 3 + 2] = sb / n;
      } else {
        buf[k * 3] = d[i0];
        buf[k * 3 + 1] = d[i0 + 1];
        buf[k * 3 + 2] = d[i0 + 2];
      }
    }
    for (let k = 0; k < maskIdx.length; k++) {
      const p = maskIdx[k];
      const lx = p % ww;
      const ly = (p - lx) / ww;
      const i0 = idxOf(lx, ly);
      d[i0] = buf[k * 3];
      d[i0 + 1] = buf[k * 3 + 1];
      d[i0 + 2] = buf[k * 3 + 2];
    }
  }

  // Paku ke warna latar bila sangat dekat (hasil rata & bersih di balon putih)
  if (snapBg) {
    for (const p of maskIdx) {
      const lx = p % ww;
      const ly = (p - lx) / ww;
      const i = idxOf(lx, ly);
      if (
        Math.abs(d[i] - snapBg[0]) + Math.abs(d[i + 1] - snapBg[1]) + Math.abs(d[i + 2] - snapBg[2]) <
        45
      ) {
        d[i] = snapBg[0];
        d[i + 1] = snapBg[1];
        d[i + 2] = snapBg[2];
      }
    }
  }
}

export function applyErase(bmp: Bitmap, a: BlockAnalysis): void {
  if (!a.mask || a.maskCount === 0) return;
  inpaint(bmp, a.win, a.mask, a.mode === 'flat' ? a.bg : undefined);
}

/** Untuk blok "Mask Eraser" mode auto: jika tidak ada teks terdeteksi, hapus seluruh rect dengan isi dari sekitarnya. */
export function fullRectMask(win: Rect, rect: Rect): Uint8Array {
  const mask = new Uint8Array(win.w * win.h);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const lx = x - win.x;
      const ly = y - win.y;
      if (lx >= 0 && ly >= 0 && lx < win.w && ly < win.h) mask[ly * win.w + lx] = 1;
    }
  }
  return mask;
}
