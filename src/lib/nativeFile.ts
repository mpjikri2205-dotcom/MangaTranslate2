/**
 * Simpan Blob (PDF/ZIP hasil ekspor) di Android: tulis ke cache aplikasi lalu buka lembar
 * "Bagikan" sehingga pengguna bisa memilih Simpan ke File / Drive / WhatsApp, dll.
 * (Unduhan blob: biasa tidak berfungsi di WebView Android.)
 */
const CHUNK = 3 * 1024 * 512; // 1,5 MB mentah; kelipatan 3 byte -> potongan base64 bisa disambung

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(((r.result as string) || '').split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function saveBlobNative(blob: Blob, filename: string): Promise<string> {
  // @ts-ignore - paket terpasang lewat `npm install` (lihat package.json)
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  // @ts-ignore
  const { Share } = await import('@capacitor/share');
  const safe = filename.replace(/[\\/:*?"<>|]+/g, '_');
  const path = `export/${Date.now()}_${safe}`;
  let uri = '';
  for (let off = 0, i = 0; off < blob.size || i === 0; off += CHUNK, i++) {
    const data = await toBase64(blob.slice(off, off + CHUNK));
    if (i === 0) {
      const r = await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
      uri = r.uri;
    } else {
      await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    }
  }
  try {
    await Share.share({ title: safe, dialogTitle: 'Simpan / bagikan file', url: uri });
  } catch {
    /* pengguna menutup lembar bagikan */
  }
  return uri;
}
