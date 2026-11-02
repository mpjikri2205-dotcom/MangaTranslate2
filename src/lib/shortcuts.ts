/** Shortcut keyboard yang bisa dikustomisasi (disimpan di localStorage). */
export interface ActionDef { id: string; label: string; key: string }

export const ACTIONS: ActionDef[] = [
  { id: 'prevPage', label: 'Halaman sebelumnya', key: 'ArrowLeft' },
  { id: 'nextPage', label: 'Halaman berikutnya', key: 'ArrowRight' },
  { id: 'toggleEdit', label: 'Masuk / keluar mode edit balon', key: 'e' },
  { id: 'toolSelect', label: 'Alat: Pilih (klik kosong = lepas, seret = seleksi area)', key: 'q' },
  { id: 'toolText', label: 'Alat: gambar kotak teks', key: 't' },
  { id: 'toolEraser', label: 'Alat: gambar area eraser', key: 'x' },
  { id: 'addText', label: 'Tambah kotak teks di tengah', key: 'shift+t' },
  { id: 'addEraser', label: 'Tambah eraser di tengah', key: 'shift+x' },
  { id: 'delete', label: 'Hapus blok terpilih', key: 'Delete' },
  { id: 'selectAll', label: 'Pilih semua blok', key: 'ctrl+a' },
  { id: 'deselect', label: 'Lepas pilihan blok', key: 'd' },
  { id: 'undo', label: 'Undo', key: 'ctrl+z' },
  { id: 'redo', label: 'Redo', key: 'ctrl+y' },
  { id: 'save', label: 'Simpan & keluar mode edit', key: 'ctrl+s' },
  { id: 'zoomIn', label: 'Zoom in', key: '+' },
  { id: 'zoomOut', label: 'Zoom out', key: '-' },
  { id: 'zoomFit', label: 'Zoom pas layar', key: '0' },
  { id: 'fontDown', label: 'Font lebih kecil', key: '[' },
  { id: 'fontUp', label: 'Font lebih besar', key: ']' },
  { id: 'alignL', label: 'Rata kiri', key: '1' },
  { id: 'alignC', label: 'Rata tengah', key: '2' },
  { id: 'alignR', label: 'Rata kanan', key: '3' },
  { id: 'horizontal', label: 'Teks horizontal', key: 'h' },
  { id: 'vertical', label: 'Teks vertikal', key: 'v' },
  { id: 'toggleErase', label: 'Hapus teks asli ON/OFF (blok terpilih)', key: 'c' },
  { id: 'eraseToBox', label: 'Area hapus = posisi kotak sekarang', key: 'm' },
  { id: 'strokeToggle', label: 'Stroke teks ON/OFF', key: 'k' },
  { id: 'retranslate', label: 'Terjemahkan ulang blok (AI)', key: 'r' },
  { id: 'help', label: 'Tampilkan bantuan shortcut', key: '?' }
];

/** Aksi yang hanya berlaku di mode edit */
export const EDIT_ONLY = new Set([
  'toolSelect', 'toolText', 'toolEraser', 'addText', 'addEraser', 'delete', 'selectAll', 'deselect', 'save',
  'fontDown', 'fontUp', 'alignL', 'alignC', 'alignR', 'horizontal', 'vertical', 'toggleErase', 'eraseToBox',
  'strokeToggle', 'retranslate'
]);

const KEY = 'mt_keymap';

export function loadKeymap(reset = false): Record<string, string> {
  const base: Record<string, string> = {};
  ACTIONS.forEach(a => (base[a.id] = a.key));
  if (reset) return base;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...base, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return base;
  }
}

export function saveKeymap(m: Record<string, string>) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* abaikan */ }
}

export function comboOf(e: KeyboardEvent): string {
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k === '=') k = '+';
  const letter = k.length === 1 && /[a-z]/i.test(k);
  const named = k.length > 1;
  if (k.length === 1) k = k.toLowerCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && (letter || named)) parts.push('shift');
  parts.push(k);
  return parts.join('+');
}

export function prettyCombo(c: string): string {
  if (!c) return '— (kosong)';
  return c.split('+').map(p => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))).join('+').replace('++', '+Plus').replace(/\+$/, '+Plus');
}
