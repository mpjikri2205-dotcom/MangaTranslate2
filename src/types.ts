export interface Batch {
  id: string;
  name: string;
  pages: MangaPage[];
  status: 'idle' | 'processing' | 'completed' | 'queued' | 'error';
  progress: number;
  type: 'zip' | 'images';
  zipFileName?: string;
}

export interface MangaPage {
  id: string;
  originalUrl: string;
  translatedUrl?: string;
  name: string;
  mimeType: string;
  status: 'pending' | 'translating' | 'completed' | 'error';
  selected?: boolean;
  error?: string;
  textBlocks?: TextBlock[];
  isCleaned?: boolean;
  isTranslated?: boolean;
}

export interface TextBlock {
  id: string;
  originalText: string;
  translatedText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number; // Relative to image height (0-1000)
  fontStyle?: 'normal' | 'bold' | 'italic' | 'bold-italic';
  fontFamily?: string;
  type?: 'auto' | 'manual';
  groupId?: string;
  padding?: number;
  align?: 'left' | 'center' | 'right';
  isBalloon?: boolean;
  /** 'auto' (default) = ikuti bentuk balon asli lewat deteksi pixel. Lainnya = patch manual. */
  cleanShape?: 'auto' | 'ellipse' | 'rounded-rect' | 'rect' | 'none';
  cleanColor?: string;
  color?: string;
  isCleanOnly?: boolean;
  isVertical?: boolean;

  // ---- Ditambahkan oleh perbaikan engine render ----
  /**
   * Area TEKS ASLI (skala 0-1000). Dipakai HANYA untuk menghapus teks asli.
   * Tidak ikut berpindah saat kotak teks terjemahan di-drag/resize.
   * Jika kosong, dipakai x/y/width/height (perilaku lama).
   */
  srcX?: number;
  srcY?: number;
  srcW?: number;
  srcH?: number;
  /** Jenis teks menurut AI */
  kind?: 'speech' | 'thought' | 'narration' | 'sfx' | 'other';
  /** Teks asli berarah vertikal (informasi saja; hasil terjemahan tetap horizontal) */
  sourceVertical?: boolean;
  /** Urutan baca dari AI (1..n) */
  order?: number;
  /** true jika ukuran font diatur manual oleh pengguna -> dipakai apa adanya sebagai batas atas */
  fontSizeLocked?: boolean;
  /** true = area hapus teks asli ikut bergerak bersama kotak teks */
  eraseFollow?: boolean;
  /** eksponen superellipse bentuk balon untuk tata letak (2 = oval, besar = persegi) */
  shapeN?: number;
  /** terjemahan asli dari AI (dipakai untuk belajar dari koreksi pengguna) */
  aiText?: string;
  /** Efek teks (opsional). strokeW: 0-30 (% ukuran font); blur: 0-30 */
  strokeW?: number;
  strokeColor?: string;
  shadowBlur?: number;
  shadowColor?: string;
  glowBlur?: number;
  glowColor?: string;
  /** Mode hapus teks asli di bawah blok ini. 'none' = jangan hapus */
  eraseMode?: 'auto' | 'none';
}

export interface OCRSettings {
  confidenceThreshold: number; // 0-100
  detectionSensitivity: number; // 0-100
}

export interface APISettings {
  provider: 'gemini' | 'openai' | 'anthropic' | 'auto';
  model: string;
}
