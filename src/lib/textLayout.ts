/**
 * Tata letak teks terjemahan: SELALU horizontal, memperhatikan bentuk balon (oval / persegi).
 *
 * Prinsip:
 *  - Cari ukuran font terbesar yang muat (binary search), bukan memakai ukuran font tebakan AI.
 *  - Pemenggalan hanya di batas kata. Pemotongan kata (dengan "-") adalah pilihan TERAKHIR.
 *  - Teks tidak pernah dipotong dengan "..." ; bila tidak muat, area diperluas atau font dikecilkan
 *    sampai batas keterbacaan, lalu dibiarkan sedikit meluber.
 *  - Lebar tiap baris di balon oval mengikuti lengkung elips, jadi baris atas/bawah otomatis lebih pendek.
 */

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutInput {
  text: string;
  rect: LayoutRect;
  shape: 'rect' | 'ellipse';
  /** Lebar teks (px) pada ukuran font tertentu. Biasanya ctx.measureText. */
  measure: (text: string, fontPx: number) => number;
  maxFont: number;
  minFont: number;
  /** Margin ke dalam (px) dari tepi rect */
  padding: number;
  lineHeight?: number;
  /** Faktor maksimum pembesaran rect jika teks tidak muat di ukuran font minimum (1 = tidak boleh). */
  expandBudget?: number;
  /** Batas luar untuk pembesaran (ukuran gambar) */
  bounds?: { w: number; h: number };
  /** Eksponen superellipse bentuk balon (2 = oval, makin besar makin persegi) */
  shapeN?: number;
  /** Batas pembesaran area bila font hasil terlalu kecil dibanding ukuran yang diinginkan */
  growBudget?: number;
}

export interface LayoutLine {
  text: string;
  /** Titik tengah baris (px) */
  cx: number;
  cy: number;
  width: number;
}

export interface LayoutResult {
  fontPx: number;
  lineHeight: number;
  lines: LayoutLine[];
  rect: LayoutRect;
  overflow: boolean;
}

const LH_DEFAULT = 1.14;

function tokenize(text: string): string[] {
  return text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Lebar tersedia untuk baris ke-i dari n baris pada rect berbentuk shape. */
function lineLimit(
  i: number,
  n: number,
  lh: number,
  rect: LayoutRect,
  shape: 'rect' | 'ellipse',
  pad: number,
  sn = 2
): number {
  const innerW = Math.max(4, rect.w - 2 * pad);
  if (shape === 'rect') return innerW;
  const a = innerW / 2;
  const b = Math.max(4, (rect.h - 2 * pad) / 2);
  const total = n * lh;
  // baris menempati [top, bottom] relatif ke pusat; pakai sisi yang paling menjauhi pusat
  const top = -total / 2 + i * lh;
  const bottom = top + lh * 0.95;
  const dy = Math.max(Math.abs(top), Math.abs(bottom));
  const r = dy / b;
  if (r >= 0.98) return 0;
  return 2 * a * Math.pow(1 - Math.pow(r, sn), 1 / sn);
}

/** Greedy wrap dengan batas lebar per-baris. Return null jika ada kata yang tidak muat sama sekali. */
function wrapGreedy(
  words: string[],
  wordW: number[],
  spaceW: number,
  limits: number[]
): { lines: string[]; widths: number[] } | null {
  const lines: string[] = [];
  const widths: number[] = [];
  let cur: string[] = [];
  let curW = 0;
  let li = 0;
  for (let k = 0; k < words.length; k++) {
    const ww = wordW[k];
    const limit = limits[Math.min(li, limits.length - 1)];
    const add = cur.length === 0 ? ww : curW + spaceW + ww;
    if (add <= limit) {
      cur.push(words[k]);
      curW = add;
    } else {
      if (cur.length === 0) return null; // satu kata lebih lebar dari baris
      lines.push(cur.join(' '));
      widths.push(curW);
      li++;
      if (li >= limits.length) return { lines: lines.concat(words.slice(k).join(' ')), widths }; // melebihi n baris
      const nl = limits[li];
      if (ww > nl) return null;
      cur = [words[k]];
      curW = ww;
    }
  }
  if (cur.length) {
    lines.push(cur.join(' '));
    widths.push(curW);
  }
  return { lines, widths };
}

function tryLayout(
  words: string[],
  s: number,
  rect: LayoutRect,
  shape: 'rect' | 'ellipse',
  pad: number,
  lhMul: number,
  measure: (t: string, s: number) => number,
  sn = 2
): { lines: string[]; widths: number[] } | null {
  const lh = s * lhMul;
  const availH = Math.max(4, rect.h - 2 * pad) * (shape === 'ellipse' ? 0.98 : 1);
  const maxLines = Math.floor(availH / lh);
  if (maxLines < 1) return null;

  const wordW = words.map(w => measure(w, s));
  const spaceW = measure(' ', s);

  for (let n = 1; n <= maxLines; n++) {
    const limits: number[] = [];
    for (let i = 0; i < n; i++) limits.push(lineLimit(i, n, lh, rect, shape, pad, sn));
    if (limits.some(l => l <= 0)) continue;
    let res = wrapGreedy(words, wordW, spaceW, limits);
    if (!res || res.lines.length > n) continue;

    // Seimbangkan panjang baris: persempit batas selama jumlah baris tidak bertambah.
    let best = res;
    for (let f = 0.92; f >= 0.55; f -= 0.06) {
      const r2 = wrapGreedy(words, wordW, spaceW, limits.map(l => l * f));
      if (r2 && r2.lines.length <= best.lines.length) best = r2;
      else break;
    }
    return best;
  }
  return null;
}

/** Pecah kata yang terlalu panjang dengan tanda "-" (pilihan terakhir). */
function hardBreak(words: string[], maxW: number, s: number, measure: (t: string, s: number) => number): string[] {
  const out: string[] = [];
  for (const w of words) {
    if (measure(w, s) <= maxW) {
      out.push(w);
      continue;
    }
    let rest = w;
    while (rest.length > 0) {
      let k = rest.length;
      while (k > 1 && measure(rest.slice(0, k) + (k < rest.length ? '-' : ''), s) > maxW) k--;
      out.push(rest.slice(0, k) + (k < rest.length ? '-' : ''));
      rest = rest.slice(k);
    }
  }
  return out;
}

export function layoutText(input: LayoutInput): LayoutResult {
  const { measure, shape } = input;
  const lhMul = input.lineHeight || LH_DEFAULT;
  const pad = Math.max(0, input.padding);
  const sn = Math.max(2, input.shapeN || 2);
  const words = tokenize(input.text);
  let rect = { ...input.rect };

  if (words.length === 0) {
    return { fontPx: input.minFont, lineHeight: input.minFont * lhMul, lines: [], rect, overflow: false };
  }

  const minF = Math.max(4, Math.min(input.minFont, input.maxFont));
  const maxF = Math.max(minF, input.maxFont);

  const attempt = (r: LayoutRect): { s: number; res: { lines: string[]; widths: number[] } } | null => {
    // binary search ukuran terbesar yang muat (resolusi 0.5px)
    let lo = minF;
    let hi = maxF;
    let best: { s: number; res: { lines: string[]; widths: number[] } } | null = null;
    const atMin = tryLayout(words, lo, r, shape, pad, lhMul, measure, sn);
    if (!atMin) return null;
    best = { s: lo, res: atMin };
    const atMax = tryLayout(words, hi, r, shape, pad, lhMul, measure, sn);
    if (atMax) return { s: hi, res: atMax };
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      const res = tryLayout(words, mid, r, shape, pad, lhMul, measure, sn);
      if (res) {
        best = { s: mid, res };
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return best;
  };

  let found = attempt(rect);

  // Font terlalu kecil dibanding yang diinginkan -> coba perbesar area sedikit (selama masih wajar)
  const grow = Math.max(1, input.growBudget || 1);
  if (found && grow > 1 && found.s < maxF * 0.8) {
    const gcx = rect.x + rect.w / 2;
    const gcy = rect.y + rect.h / 2;
    let best = found;
    let bestRect = rect;
    for (const f of [1.1, 1.2, 1.35, 1.5].filter(v => v <= grow + 1e-6)) {
      let nw = input.rect.w * f;
      let nh = input.rect.h * f;
      if (input.bounds) { nw = Math.min(nw, input.bounds.w); nh = Math.min(nh, input.bounds.h); }
      const nr: LayoutRect = { x: gcx - nw / 2, y: gcy - nh / 2, w: nw, h: nh };
      if (input.bounds) {
        nr.x = Math.max(0, Math.min(input.bounds.w - nr.w, nr.x));
        nr.y = Math.max(0, Math.min(input.bounds.h - nr.h, nr.y));
      }
      const g = attempt(nr);
      if (g && g.s > best.s * 1.05) { best = g; bestRect = nr; }
      if (best.s >= maxF * 0.9) break;
    }
    if (best !== found) { found = best; rect = bestRect; }
  }

  // Tidak muat di ukuran minimum -> perluas area bertahap (terbatas oleh expandBudget & batas gambar)
  const budget = Math.max(1, input.expandBudget || 1);
  if (!found && budget > 1) {
    const steps = [1.12, 1.25, 1.4, 1.6].filter(f => f <= budget + 1e-6);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    for (const f of steps) {
      let nw = input.rect.w * f;
      let nh = input.rect.h * f;
      if (input.bounds) {
        nw = Math.min(nw, input.bounds.w);
        nh = Math.min(nh, input.bounds.h);
      }
      const nr: LayoutRect = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
      if (input.bounds) {
        nr.x = Math.max(0, Math.min(input.bounds.w - nr.w, nr.x));
        nr.y = Math.max(0, Math.min(input.bounds.h - nr.h, nr.y));
      }
      found = attempt(nr);
      if (found) {
        rect = nr;
        break;
      }
    }
  }

  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  if (found) {
    const lh = found.s * lhMul;
    const n = found.res.lines.length;
    const top = cy - (n * lh) / 2;
    const lines: LayoutLine[] = found.res.lines.map((t, i) => ({
      text: t,
      cx,
      cy: top + i * lh + lh / 2,
      width: found!.res.widths[i] ?? measure(t, found!.s)
    }));
    return { fontPx: found.s, lineHeight: lh, lines, rect, overflow: false };
  }

  // Fallback terakhir: ukuran minimum, pecah kata panjang, biarkan meluber vertikal.
  const s = minF;
  const lh = s * lhMul;
  const maxW = Math.max(8, rect.w - 2 * pad);
  const broken = hardBreak(words, maxW, s, measure);
  const spaceW = measure(' ', s);
  const wordW = broken.map(w => measure(w, s));
  const lines: string[] = [];
  const widths: number[] = [];
  let cur: string[] = [];
  let curW = 0;
  for (let k = 0; k < broken.length; k++) {
    const add = cur.length === 0 ? wordW[k] : curW + spaceW + wordW[k];
    if (add <= maxW || cur.length === 0) {
      cur.push(broken[k]);
      curW = add;
    } else {
      lines.push(cur.join(' '));
      widths.push(curW);
      cur = [broken[k]];
      curW = wordW[k];
    }
  }
  if (cur.length) {
    lines.push(cur.join(' '));
    widths.push(curW);
  }
  const top = cy - (lines.length * lh) / 2;
  return {
    fontPx: s,
    lineHeight: lh,
    lines: lines.map((t, i) => ({ text: t, cx, cy: top + i * lh + lh / 2, width: widths[i] })),
    rect,
    overflow: true
  };
}
