/** Prompt, skema JSON, dan normalisasi respons AI untuk terjemahan halaman manga. */
import type { TextBlock } from '../types.ts';

export const PAGE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      // box_2d lebih dulu: model melokalisasi dulu, baru membaca isi kotaknya (OCR lebih akurat)
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
      originalText: { type: 'STRING' },
      translatedText: { type: 'STRING' },
      kind: { type: 'STRING' },
      isBalloon: { type: 'BOOLEAN' },
      vertical: { type: 'BOOLEAN' },
      fontSize: { type: 'NUMBER' },
      fontStyle: { type: 'STRING' },
      fontFamily: { type: 'STRING' }
    },
    required: ['box_2d', 'originalText', 'translatedText', 'kind', 'isBalloon']
  }
};

export interface PromptInput {
  ocrOnly: boolean;
  langGuidelines: string;
  scopeInstruction: string;
  literal: boolean;
  context?: string;
  corrections?: string;
}

export function buildPagePrompt(p: PromptInput): string {
  return `You are a professional manga/manhwa/manhua translator. Find EVERY text unit on this page, transcribe it exactly, then ${p.ocrOnly ? 'leave translatedText empty ("")' : 'translate it into natural Indonesian'}.

Return a JSON array in READING ORDER (Japanese manga: panels and vertical columns go right-to-left, top-to-bottom; manhwa/webtoon/manhua: top-to-bottom, left-to-right). One object per balloon / caption / SFX:
- box_2d: [ymin, xmin, ymax, xmax], integers 0-1000 relative to the full image. TIGHT around the ORIGINAL glyphs of that unit (all its lines/columns), with ~1% slack. Never shrink it into the balloon interior and never stretch it to the balloon outline.
- originalText: exact transcription. Vertical CJK: read column by column, right to left. Never invent unreadable text.
- translatedText: Indonesian, ALWAYS plain horizontal prose even if the source is vertical. No manual line breaks.
- kind: speech | thought | narration | sfx | other
- isBalloon: true only if inside a speech/thought balloon; false for narration boxes, SFX and free text.
- vertical: true if the source text is written vertically.
- fontSize: height of one source character relative to image height (0-1000 scale, typical 12-30).
- fontStyle: normal | bold | italic | bold-italic.
- fontFamily: '"Comic Neue", cursive' (dialogue) | '"Bangers", cursive' (shouting/SFX) | '"Architects Daughter", cursive' (whisper/notes) | '"Fredoka", sans-serif' (cute/comedic) | '"Inter", sans-serif' (narration).

RULES
1. All lines/columns of ONE balloon = ONE unit. Different balloons = different units; boxes must not overlap.
2. Transcribe first, then translate FROM the transcription. Translate meaning, tone and speaker voice, not word-for-word. Indonesian runs longer than CJK, so keep phrasing short and natural so it fits the balloon.
3. Keep character names and terms consistent across the page and with the previous-page context.
4. Skip scanlator credits, watermarks and page numbers.
5. SFX: kind "sfx", short Indonesian equivalent (1-3 words).
6. Keep expressive punctuation (…, !?, ♡).
7. Style: ${p.literal ? 'literal and direct' : 'natural and idiomatic (bahasa santai komik)'}.
${p.langGuidelines}
${p.scopeInstruction}
${p.context || ''}
${p.corrections || ''}
If there is no text, return [].`;
}

export function buildContext(prev: TextBlock[] | undefined): string {
  const lines = (prev || []).filter(b => b.originalText && b.translatedText).slice(-6);
  if (!lines.length) return '';
  return `PREVIOUS PAGE (context only, do NOT output these):\n${lines.map(b => `- ${b.originalText} => ${b.translatedText}`).join('\n')}`;
}

const FONTS: [RegExp, string][] = [
  [/comic/i, '"Comic Neue", cursive'],
  [/banger/i, '"Bangers", cursive'],
  [/architect|daughter|handwrit/i, '"Architects Daughter", cursive'],
  [/fredoka|round/i, '"Fredoka", sans-serif'],
  [/inter|sans/i, '"Inter", sans-serif']
];
const KINDS = ['speech', 'thought', 'narration', 'sfx', 'other'];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const truthy = (v: any) => v === true || v === 'true' || v === 1 || v === '1';

function readBox(b: any): { x: number; y: number; w: number; h: number } | null {
  let x: number, y: number, w: number, h: number;
  if (Array.isArray(b.box_2d) && b.box_2d.length === 4 && b.box_2d.every((n: any) => Number.isFinite(Number(n)))) {
    let [y0, x0, y1, x1] = b.box_2d.map(Number);
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (x1 < x0) [x0, x1] = [x1, x0];
    x = x0; y = y0; w = x1 - x0; h = y1 - y0;
  } else if ([b.x, b.y, b.width, b.height].every(n => Number.isFinite(Number(n)))) {
    x = Number(b.x); y = Number(b.y); w = Number(b.width); h = Number(b.height);
  } else return null;
  x = clamp(x, 0, 999); y = clamp(y, 0, 999);
  w = clamp(w, 8, 1000 - x); h = clamp(h, 8, 1000 - y);
  return { x, y, w, h };
}

const iou = (a: any, b: any) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

export function normalizeBlocks(raw: any[], opt: { balloonOnly: boolean }): TextBlock[] {
  const out: TextBlock[] = [];
  const boxes: any[] = [];
  (Array.isArray(raw) ? raw : []).forEach((b, idx) => {
    if (!b) return;
    const box = readBox(b);
    if (!box) return;
    const kind = KINDS.includes(b.kind) ? b.kind : truthy(b.isBalloon) ? 'speech' : 'other';
    const isBalloon = b.isBalloon === undefined ? kind === 'speech' || kind === 'thought' : truthy(b.isBalloon);
    if (opt.balloonOnly && !isBalloon) return;
    if (boxes.some(o => iou(o, box) > 0.6)) return; // duplikat
    boxes.push(box);
    const fam = FONTS.find(([re]) => re.test(String(b.fontFamily || '')));
    out.push({
      id: Math.random().toString(36).slice(2, 11),
      originalText: String(b.originalText ?? ''),
      translatedText: String(b.translatedText ?? ''),
      aiText: String(b.translatedText ?? ''),
      x: box.x, y: box.y, width: box.w, height: box.h,
      fontSize: Number.isFinite(Number(b.fontSize)) ? Number(b.fontSize) : undefined,
      fontStyle: ['normal', 'bold', 'italic', 'bold-italic'].includes(b.fontStyle) ? b.fontStyle : 'normal',
      fontFamily: fam ? fam[1] : '"Comic Neue", cursive',
      isBalloon,
      kind,
      sourceVertical: truthy(b.vertical),
      isVertical: false, // terjemahan Indonesia selalu horizontal
      eraseMode: 'auto',
      order: idx + 1,
      type: 'auto'
    });
  });
  return out;
}

// ───────── Belajar dari koreksi pengguna (pengganti "training": dipakai langsung di prompt) ─────────
const CK = 'mt_corrections';
export interface Correction { o: string; t: string }

export function loadCorrections(): Correction[] {
  try {
    const v = JSON.parse(localStorage.getItem(CK) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function clearCorrections() {
  try { localStorage.removeItem(CK); } catch { /* abaikan */ }
}
/** Simpan pasangan (teks asli -> terjemahan yang sudah dikoreksi pengguna) */
export function recordCorrections(blocks: TextBlock[]) {
  try {
    const list = loadCorrections();
    let changed = false;
    for (const b of blocks) {
      const o = (b.originalText || '').trim();
      const t = (b.translatedText || '').trim();
      const a = (b.aiText || '').trim();
      if (!o || !t || !a || t === a || o.length > 120 || t.length > 160) continue;
      const i = list.findIndex(c => c.o === o);
      if (i >= 0) list.splice(i, 1);
      list.push({ o, t });
      changed = true;
    }
    if (changed) localStorage.setItem(CK, JSON.stringify(list.slice(-80)));
  } catch { /* abaikan */ }
}
export function correctionsPrompt(): string {
  const l = loadCorrections().slice(-25);
  if (!l.length) return '';
  return `USER CORRECTIONS (the user fixed earlier translations; reuse these terms, names and style whenever the same or similar text appears):\n${l.map(c => `- ${c.o} => ${c.t}`).join('\n')}`;
}
