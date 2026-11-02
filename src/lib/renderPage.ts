/**
 * Pipeline render halaman:
 *  1. Analisis teks asli (area dari srcX/srcY/srcW/srcH, BUKAN kotak terjemahan) pada gambar ASLI.
 *  2. Hapus teks (inpaint) -> hasil di-cache per halaman, jadi edit teks tidak mengulang proses berat.
 *  3. Tulis teks Indonesia horizontal sesuai bentuk balon.
 */
import type { TextBlock } from '../types.ts';
import { analyzeBlock, applyErase, clampRect, fullRectMask, inpaint, type BlockAnalysis, type Rect } from './pixel.ts';
import { layoutText } from './textLayout.ts';

export interface RenderSettings {
  autoClean: boolean;
  showText: boolean;
  fontFamily: string;
  weight: string;
  sizeMultiplier: number;
  outline: boolean;
  bgOpacity: number;
  boxPadding: number;
  autoExpand: boolean;
}

export interface PageCacheEntry {
  sig: string;
  canvas: HTMLCanvasElement;
  analyses: Map<string, BlockAnalysis>;
}

export interface RenderOptions {
  pageId: string;
  cache?: Map<string, PageCacheEntry>;
  /** Sesuaikan kotak teks ke interior balon (dipakai sekali setelah AI menerjemahkan) */
  fit?: boolean;
  quality?: number;
}

const nFromFill = (f: number) => (f < 0.8 ? 2 : f < 0.865 ? 2.5 : f < 0.905 ? 3 : f < 0.945 ? 4 : f < 0.975 ? 6 : 10);
const to1000 = (v: number, total: number) => (v / total) * 1000;
const toPx = (v: number, total: number) => (v / 1000) * total;
const isTrue = (v: any) => v === true || v === 'true' || v === 1 || v === '1';

function srcRectPx(b: TextBlock, W: number, H: number): Rect {
  const useSrc = !b.isCleanOnly && !b.eraseFollow && b.srcX !== undefined && b.srcW !== undefined;
  return {
    x: toPx(useSrc ? b.srcX! : b.x, W),
    y: toPx(useSrc ? b.srcY! : b.y, H),
    w: toPx(useSrc ? b.srcW! : b.width, W),
    h: toPx(useSrc ? b.srcH! : b.height, H)
  };
}

function layoutShape(b: TextBlock): 'rect' | 'ellipse' {
  if (b.cleanShape === 'ellipse') return 'ellipse';
  if (b.cleanShape === 'rect' || b.cleanShape === 'rounded-rect') return 'rect';
  return isTrue(b.isBalloon) && b.kind !== 'narration' ? 'ellipse' : 'rect';
}

function paintShape(ctx: CanvasRenderingContext2D, r: Rect, shape: string, color: string, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const { x, y, w, h } = r;
  if (shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === 'rounded-rect') {
    const rad = Math.min(w, h) * 0.3;
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
    ctx.fill();
  } else if (shape === 'rect') {
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

function meanLum(ctx: CanvasRenderingContext2D, r: Rect, W: number, H: number): number {
  const c = clampRect(r, W, H);
  const d = ctx.getImageData(c.x, c.y, c.w, c.h).data;
  const step = Math.max(1, Math.floor(d.length / 4 / 400)) * 4;
  let s = 0, n = 0;
  for (let i = 0; i < d.length; i += step) {
    s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    n++;
  }
  return n ? s / n : 255;
}

/** Fallback: teks vertikal (hanya jika pengguna memilih arah vertikal secara manual). */
function drawVertical(ctx: CanvasRenderingContext2D, text: string, r: Rect, size: number, stroke: boolean, strokeColor: string) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  let s = size;
  const colsFor = (sz: number) => {
    const per = Math.max(1, Math.floor(r.h / (sz * 1.1)));
    return Math.ceil(chars.length / per);
  };
  while (s > 8 && colsFor(s) * s * 1.2 > r.w) s -= 0.5;
  const per = Math.max(1, Math.floor(r.h / (s * 1.1)));
  const cols = Math.ceil(chars.length / per);
  ctx.font = ctx.font.replace(/[\d.]+px/, `${s}px`);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let c = 0; c < cols; c++) {
    const part = chars.slice(c * per, (c + 1) * per);
    const x = r.x + r.w / 2 + ((cols - 1) / 2 - c) * s * 1.2;
    const y0 = r.y + r.h / 2 - (part.length * s * 1.1) / 2 + (s * 1.1) / 2;
    part.forEach((ch, i) => {
      if (stroke) ctx.strokeText(ch, x, y0 + i * s * 1.1);
      ctx.fillText(ch, x, y0 + i * s * 1.1);
    });
  }
}

export function renderPage(
  img: HTMLImageElement,
  blocksIn: TextBlock[],
  st: RenderSettings,
  opt: RenderOptions
): { url: string; blocks: TextBlock[] } {
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  let blocks = (Array.isArray(blocksIn) ? blocksIn : []).filter(Boolean);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!ctx) return { url: img.src, blocks };

  // ── 1 & 2. Analisis + hapus teks (dengan cache) ──
  const sig = JSON.stringify([
    W, H, st.autoClean,
    blocks.map(b => {
      const r = srcRectPx(b, W, H);
      return [b.id, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h),
        isTrue(b.isBalloon), !!b.isCleanOnly, b.cleanShape || 'auto', b.eraseMode || 'auto'];
    })
  ]);
  const cached = opt.cache?.get(opt.pageId);
  let analyses: Map<string, BlockAnalysis>;
  if (cached && cached.sig === sig && !opt.fit) {
    ctx.drawImage(cached.canvas, 0, 0);
    analyses = cached.analyses;
  } else {
    ctx.drawImage(img, 0, 0, W, H);
    const imgData = ctx.getImageData(0, 0, W, H);
    analyses = new Map();
    const needFit = !!opt.fit;
    for (const b of blocks) {
      const wantsErase = (st.autoClean || b.isCleanOnly) && b.eraseMode !== 'none';
      if (!wantsErase && !needFit) continue;
      const r = srcRectPx(b, W, H);
      analyses.set(b.id, analyzeBlock(imgData, r, { isBalloon: isTrue(b.isBalloon) }));
    }
    for (const b of blocks) {
      const a = analyses.get(b.id);
      if (!a) continue;
      const wantsErase = (st.autoClean || b.isCleanOnly) && b.eraseMode !== 'none';
      if (!wantsErase) continue;
      const explicitShape = b.cleanShape && b.cleanShape !== 'auto' && b.cleanShape !== 'none';
      if (b.isCleanOnly) {
        if (explicitShape) continue; // dicat dengan bentuk di bawah
        if (a.mask) applyErase(imgData, a);
        else {
          const r = clampRect(srcRectPx(b, W, H), W, H);
          inpaint(imgData, a.win, fullRectMask(a.win, r));
        }
      } else {
        applyErase(imgData, a);
      }
    }
    ctx.putImageData(imgData, 0, 0);
    if (opt.cache) {
      const keep = document.createElement('canvas');
      keep.width = W;
      keep.height = H;
      keep.getContext('2d')!.drawImage(canvas, 0, 0);
      opt.cache.set(opt.pageId, { sig, canvas: keep, analyses });
      while (opt.cache.size > 3) opt.cache.delete(opt.cache.keys().next().value as string);
    }
  }

  // ── Fit: sesuaikan kotak teks ke interior balon (sekali, setelah terjemahan AI) ──
  if (opt.fit) {
    blocks = blocks.map(b => {
      if (b.srcX !== undefined || b.isCleanOnly) return b;
      const out: TextBlock = { ...b, srcX: b.x, srcY: b.y, srcW: b.width, srcH: b.height, isVertical: b.isVertical === true ? true : false };
      const a = analyses.get(b.id);
      const src = srcRectPx(b, W, H);
      const ib = a?.interiorBBox;
      const srcArea = src.w * src.h;
      if (ib && isTrue(b.isBalloon) && ib.w * ib.h <= 9 * srcArea && ib.w * ib.h >= 0.9 * srcArea) {
        out.x = to1000(ib.x, W); out.y = to1000(ib.y, H); out.width = to1000(ib.w, W); out.height = to1000(ib.h, H);
        out.shapeN = nFromFill(a!.interiorFill);
        out.kind = out.kind || (a!.interiorFill > 0.9 ? 'narration' : 'speech');
      } else if (src.h > src.w * 1.4) {
        // kolom sempit (mis. teks vertikal asli): lebarkan agar teks Indonesia horizontal terbaca
        const nw = Math.min(0.3 * W, Math.max(src.w, src.h * 0.6));
        const cx = src.x + src.w / 2;
        out.x = to1000(Math.max(0, Math.min(W - nw, cx - nw / 2)), W);
        out.width = to1000(nw, W);
      }
      return out;
    });
  }

  // ── Patch bentuk manual (bila pengguna memilih Oval/Siku/Rounded) ──
  for (const b of blocks) {
    const shape = b.cleanShape;
    if (!shape || shape === 'auto' || shape === 'none') continue;
    const a = analyses.get(b.id);
    const col = b.cleanColor || (a && a.mode === 'flat' ? `rgb(${a.bg.map(Math.round).join(',')})` : '#FFFFFF');
    const r = { x: toPx(b.x, W), y: toPx(b.y, H), w: toPx(b.width, W), h: toPx(b.height, H) };
    paintShape(ctx, r, shape, col, st.bgOpacity);
  }

  // ── 3. Tulis teks terjemahan ──
  if (st.showText) {
    const measureCache = new Map<string, number>();
    for (const b of blocks) {
      if (b.isCleanOnly) continue;
      const text = (b.translatedText || '').trim();
      if (!text) continue;

      const family = b.fontFamily || st.fontFamily;
      let weight = st.weight || 'bold';
      let style = '';
      if (b.fontStyle) {
        if (b.fontStyle.includes('bold')) weight = 'bold';
        else if (b.fontStyle === 'normal') weight = 'normal';
        if (b.fontStyle.includes('italic')) style = 'italic';
      }
      const fontOf = (px: number) => `${style} ${weight} ${px}px ${family}`.trim();
      const measure = (t: string, px: number) => {
        const key = `${family}|${weight}|${style}|${t}`;
        let w100 = measureCache.get(key);
        if (w100 === undefined) {
          ctx.font = fontOf(100);
          w100 = ctx.measureText(t).width;
          measureCache.set(key, w100);
        }
        return (w100 * px) / 100;
      };

      const rect = { x: toPx(b.x, W), y: toPx(b.y, H), w: toPx(b.width, W), h: toPx(b.height, H) };
      const shape = layoutShape(b);
      const balloon = isTrue(b.isBalloon);
      const mult = st.sizeMultiplier || 1;
      const hint = ((b.fontSize || 24) / 1000) * H * mult;
      const locked = b.fontSizeLocked === true || (b.type === 'manual' && !!b.fontSize);
      const capMax = (balloon ? 0.06 : 0.05) * H;
      const maxFont = locked ? hint : Math.min(capMax, Math.max(hint * 1.5, 0.026 * H * mult));
      const minFont = locked ? Math.max(6, maxFont * 0.5) : Math.max(9, 0.0115 * H);
      const basePad = b.padding !== undefined ? b.padding : st.boxPadding;
      const pad = Math.max(basePad, shape === 'ellipse' ? 0.035 * Math.min(rect.w, rect.h) : 2);

      const vertical = b.isVertical === true;
      const a = analyses.get(b.id);
      const lum = a && a.mode === 'flat' ? 0.299 * a.bg[0] + 0.587 * a.bg[1] + 0.114 * a.bg[2] : meanLum(ctx, rect, W, H);
      const dark = lum < 125;
      let color = b.color || (dark ? '#FFFFFF' : '#000000');
      if (dark && /^(#000000|black|#111111|#222222)$/i.test(color)) color = '#FFFFFF';
      if (!dark && /^(#ffffff|white|#f8f9fa|#eeeeee)$/i.test(color)) color = '#000000';
      const strokeColor = /^(#fff|#ffffff|white)/i.test(color) ? '#000000' : '#FFFFFF';
      const onArt = !balloon && !(a && a.mode === 'flat');

      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = b.strokeColor || strokeColor;
      ctx.lineJoin = 'round';
      ctx.textBaseline = 'middle';

      if (vertical) {
        ctx.font = fontOf(maxFont);
        ctx.lineWidth = Math.max(1.5, maxFont * 0.15);
        drawVertical(ctx, text, rect, maxFont, st.outline || onArt, strokeColor);
        ctx.restore();
        continue;
      }

      const lay = layoutText({
        text, rect, shape, measure, maxFont, minFont, padding: pad,
        expandBudget: st.autoExpand ? (balloon ? 1.4 : 1.6) : 1.12,
        growBudget: st.autoExpand ? (balloon ? 1.1 : 1.5) : 1,
        shapeN: b.shapeN, bounds: { w: W, h: H }
      });
      ctx.font = fontOf(lay.fontPx);
      const align = b.align || 'center';
      ctx.textAlign = align;
      const hasStrokeOverride = b.strokeW !== undefined;
      const stroke = hasStrokeOverride ? (b.strokeW as number) > 0 : st.outline || onArt || lay.overflow;
      ctx.lineWidth = hasStrokeOverride ? Math.max(0.5, (lay.fontPx * (b.strokeW as number)) / 50) : Math.max(1.5, lay.fontPx * 0.15);
      const glowPx = b.glowBlur ? (lay.fontPx * b.glowBlur) / 25 : 0;
      const shadowPx = b.shadowBlur ? (lay.fontPx * b.shadowBlur) / 25 : 0;
      for (const ln of lay.lines) {
        let x = ln.cx;
        if (align === 'left') x = lay.rect.x + pad + 2;
        else if (align === 'right') x = lay.rect.x + lay.rect.w - pad - 2;
        if (glowPx > 0) {
          ctx.shadowColor = b.glowColor || '#FFFFFF';
          ctx.shadowBlur = glowPx;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          ctx.fillText(ln.text, x, ln.cy);
          ctx.fillText(ln.text, x, ln.cy);
        }
        if (shadowPx > 0) {
          ctx.shadowColor = b.shadowColor || '#000000';
          ctx.shadowBlur = shadowPx;
          ctx.shadowOffsetX = lay.fontPx * 0.06;
          ctx.shadowOffsetY = lay.fontPx * 0.06;
          ctx.fillText(ln.text, x, ln.cy);
        }
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        if (stroke) ctx.strokeText(ln.text, x, ln.cy);
        ctx.fillText(ln.text, x, ln.cy);
      }
      ctx.restore();
    }
  }

  return { url: canvas.toDataURL('image/jpeg', opt.quality ?? 0.92), blocks };
}
