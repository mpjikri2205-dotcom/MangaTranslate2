/**
 * apiFetch: pengganti fetch() untuk rute '/api/*'.
 *  - Web/localhost : diteruskan apa adanya ke server Node (server.ts), perilaku TIDAK berubah.
 *  - Android (APK) : tidak ada server, jadi rute dikerjakan langsung di aplikasi:
 *      /api/translate       -> SDK Gemini/OpenAI/Anthropic dipanggil dari aplikasi (kunci API dari Pengaturan)
 *      /api/free-translate  -> endpoint terjemahan gratis (Google/MyMemory)
 *      /api/env-check       -> tidak ada kunci "dari server"
 * Hasilnya selalu objek Response standar, sehingga kode pemanggil tidak perlu diubah.
 */
import { isNative } from './platform.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function withAbort<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return p;
  const err = () => new DOMException('Aborted', 'AbortError');
  if (signal.aborted) return Promise.reject(err());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(err());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

/** Pemetaan error -> status HTTP, sama dengan server.ts */
export function classifyError(error: any): { status: number; msg: string; details: string; retry: number } {
  let status = 500;
  let msg = 'Internal Server Error';
  let details = '';
  if (typeof error === 'string') {
    msg = error;
  } else if (error) {
    msg = error.message || msg;
    const s = `${error.message || ''} ${error.status || ''} ${JSON.stringify(error.error || {})}`;
    if (/429|RESOURCE_EXHAUSTED|quota|Quota exceeded/.test(s)) status = 429;
    else if (/503|UNAVAILABLE|Service Unavailable|experiencing high demand/.test(s)) status = 503;
    else if (/401|invalid_api_key|API key/.test(s)) status = 401;
    else if (/403|PERMISSION_DENIED/.test(s)) status = 403;
    else if (/400|INVALID_ARGUMENT|BAD_REQUEST/.test(s)) status = 400;
    else {
      const st = Number(error.status ?? error.statusCode);
      if (st >= 400 && st <= 599) status = st;
    }
    try {
      if (error.error && typeof error.error === 'object') details = JSON.stringify(error.error);
      else if (error.response?.data) details = typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : String(error.response.data);
      else details = String(error);
    } catch {
      details = '';
    }
  }
  let retry = 0;
  const full = `${msg} ${details}`;
  const m1 = full.match(/retry in\s+([0-9.]+)\s*s/i);
  if (m1) retry = parseFloat(m1[1]);
  else {
    const m2 = full.match(/"retryDelay"\s*:\s*"(\d+)\s*s?"/i);
    if (m2) retry = parseFloat(m2[1]);
  }
  return { status, msg, details, retry };
}

async function nativeTranslate(init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body || '{}'));
  const { provider, model, contents, config, customKey, customBaseURL } = body;
  const key = typeof customKey === 'string' ? customKey.trim() : '';
  if (!key) return json(401, { error: `API key untuk "${provider}" belum diisi. Isi di Pengaturan (ikon gerigi) lalu coba lagi.` });
  try {
    const { GeminiProvider, OpenAIProvider, AnthropicProvider } = await import('../services/aiProviders.ts');
    const ai =
      provider === 'openai' ? new OpenAIProvider(key)
      : provider === 'anthropic' ? new AnthropicProvider(key)
      : provider === 'custom' ? new OpenAIProvider(key, customBaseURL)
      : new GeminiProvider(key);
    const response = await withAbort(ai.generateContent({ model, contents, config }), init?.signal);
    return json(200, response);
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    const c = classifyError(error);
    return json(c.status, { error: c.msg, details: c.details, retrySeconds: c.retry > 0 ? c.retry : undefined });
  }
}

// ───────── Terjemahan gratis (port dari server.ts) ─────────
const detectLang = (text: string): string => {
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
  if (/[\u4E00-\u9FAF]/.test(text)) return /[\u3040-\u309F\u30A0-\u30FF]/.test(text) ? 'ja' : 'zh';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
  if (/[a-zA-Z]{3,}/.test(text)) return 'en';
  return 'ja';
};

async function getJson(url: string): Promise<any> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Status ${r.status}`);
    return await r.json();
  } catch (e) {
    // Cadangan: HTTP native Capacitor (tanpa batasan CORS) bila tersedia
    const http = (globalThis as any).window?.Capacitor?.Plugins?.CapacitorHttp;
    if (!http) throw e;
    const r = await http.get({ url, responseType: 'json' });
    if (r.status >= 400) throw new Error(`Status ${r.status}`);
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  }
}

const parseGtx = (p: any): string => {
  if (p && p[0]) return p[0].map((i: any) => i[0]).join('');
  throw new Error('Invalid format');
};
const parseChrome = (p: any): string => {
  if (Array.isArray(p)) {
    if (Array.isArray(p[0])) return p[0].map((i: any) => i[0] || i).join('');
    if (typeof p[0] === 'string') return p.join('');
    throw new Error('Invalid array format');
  }
  if (p && typeof p === 'object') {
    if (Array.isArray(p.sentences)) return p.sentences.map((s: any) => s.trans).join('');
    if (p.translatedText) return p.translatedText;
    throw new Error('Invalid object format');
  }
  throw new Error('Unknown format');
};

export async function freeTranslate(text: string, from = 'auto', to = 'id'): Promise<string> {
  const detected = from === 'auto' ? detectLang(text) : from;
  const q = encodeURIComponent(text);
  const sl = encodeURIComponent(from);
  const tl = encodeURIComponent(to);
  const methods: (() => Promise<string>)[] = [
    async () => parseGtx(await getJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${q}`)),
    async () => parseChrome(await getJson(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&q=${q}`)),
    async () => {
      const p = await getJson(`https://api.mymemory.translated.net/get?q=${q}&langpair=${encodeURIComponent(detected)}|${tl}`);
      if (p?.responseData?.translatedText) return p.responseData.translatedText;
      throw new Error('Invalid MyMemory response');
    },
    async () => parseGtx(await getJson(`https://translate.google.com/translate_a/single?client=at&sl=${sl}&tl=${tl}&dt=t&q=${q}`))
  ];
  let last: any = null;
  for (const m of methods) {
    try {
      const r = await m();
      if (r && r.trim() !== '') return r;
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('All free translation engines failed');
}

async function nativeFreeTranslate(init?: RequestInit): Promise<Response> {
  const { text, from = 'auto', to = 'id' } = JSON.parse(String(init?.body || '{}'));
  if (!text || typeof text !== 'string' || text.trim() === '') return json(200, { translatedText: '' });
  try {
    return json(200, { translatedText: await withAbort(freeTranslate(text, from, to), init?.signal) });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    return json(500, { error: e?.message || 'Failed to perform free translation' });
  }
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!isNative() || !input.startsWith('/api/')) return fetch(input, init);
  if (input.startsWith('/api/translate')) return nativeTranslate(init);
  if (input.startsWith('/api/free-translate')) return nativeFreeTranslate(init);
  if (input.startsWith('/api/env-check')) return json(200, { gemini: false, openai: false, anthropic: false, custom: false });
  return json(404, { error: `Rute ${input} tidak tersedia di aplikasi Android` });
}
