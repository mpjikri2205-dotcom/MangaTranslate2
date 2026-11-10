# MangaTranslate untuk Android (APK)

Kode aplikasi SAMA dengan versi web/localhost (`src/`). Perbedaannya hanya di lapisan kecil:
`src/lib/apiClient.ts` (pengganti server Node di HP), `nativeFile.ts` (simpan/bagikan PDF & ZIP), `platform.ts`.
Di browser/localhost semuanya tetap berjalan lewat `server.ts` seperti biasa (`npm run dev`).

## Cara 1 - tanpa Android Studio (disarankan): GitHub Actions
1. Buat repositori GitHub (private tidak apa-apa), upload SELURUH isi folder ini (jangan sertakan `node_modules`).
2. Buka tab **Actions** -> **Build Android APK** -> **Run workflow**. Tunggu sekitar 5-10 menit.
3. Selesai -> buka run tersebut -> bagian **Artifacts** -> unduh **MangaTranslate-APK** (isinya `app-debug.apk`).
4. Kirim APK ke HP, buka, izinkan "Pasang aplikasi dari sumber tidak dikenal", lalu install.
Setiap kali Anda mengubah kode web, cukup upload perubahan lalu jalankan workflow lagi -> APK baru.

## Cara 2 - Android Studio (di PC)
```
npm install
npm run android:add      # sekali saja, membuat folder android/
npm run android:sync     # build web + salin ke proyek Android (ulangi setiap ada perubahan kode)
npm run android:open     # buka Android Studio -> Build > Build APK(s)
```
Opsional: di `android/app/src/main/AndroidManifest.xml` tambahkan `android:largeHeap="true"` pada tag `<application` (workflow sudah melakukannya otomatis).

## Yang perlu diketahui
- **API key**: isi di Pengaturan (ikon gerigi) di dalam aplikasi; tersimpan di HP. Di APK tidak ada kunci "bawaan server".
- **Wajib internet** (panggilan AI, font, pdf.js dari CDN).
- **Ekspor PDF/ZIP**: akan membuka lembar "Bagikan"; pilih *Simpan ke File / Drive / dll*.
- **Endpoint kustom (OpenAI-compatible)** harus mengizinkan CORS (OpenRouter mengizinkan).
- **Memori HP terbatas**: untuk komik panjang, proses per 30-50 halaman agar tidak crash.
- Shortcut keyboard hanya untuk PC; di HP pakai toolbar. Seleksi drag di HP = tekan lama lalu seret.
- APK ini bertanda tangan *debug* (cukup untuk pemakaian pribadi, bukan untuk Play Store).

## Jika Anda sudah mengubah App.tsx sendiri
Salin `src/lib/platform.ts`, `apiClient.ts`, `nativeFile.ts`, lalu di `App.tsx`:
1. tambahkan 3 import (`apiFetch`, `isNative`, `saveBlobNative`);
2. ganti semua `fetch('/api/` menjadi `apiFetch('/api/`;
3. di awal `try {` pada `triggerServerSideDownload` tambahkan:
   `if (isNative()) return await saveBlobNative(fileBlob, filename);`

## Folder simpan ekspor (Android)
Ekspor PDF/ZIP langsung tersimpan tanpa dialog per file:
- Default: `Download/MangaTranslate/` di HP. Ganti: Pengaturan (gerigi) -> "Folder simpan ekspor" -> **Pilih folder...** (sekali saja).
- Kartu itu menampilkan status: **hijau "Plugin penyimpanan aktif"** atau **merah + alasan error**.
- Penyimpanan memakai plugin lokal `plugins/capacitor-mtfilesaver` (dipasang otomatis oleh `npm install` + `cap sync`).

### Memperbarui APK yang sudah ada (ikuti persis)
1. Ekstrak ZIP ini dan TIMPA SEMUA file di folder proyek yang dipakai Android Studio (folder yang punya `android/`).
   Pastikan folder `plugins/`, `scripts/`, `package.json`, dan `update-android.bat` ikut tertimpa. `node_modules` dan `android` jangan dihapus.
2. Klik dua kali **update-android.bat** (menjalankan `npm install` lalu `npm run android:sync`).
   Cari baris `[android-setup] OK`. Jika ada PERINGATAN, kirim isi jendela itu.
3. Android Studio: **File > Sync Project with Gradle Files**, lalu **Build > Generate APKs**.
4. Pasang APK baru DI ATAS yang lama (tanpa uninstall).

## Seleksi (gaya Google Drive)
- Halaman manga / proyek / blok teks: **tahan ~0,3 detik lalu geser naik/turun**; daftar otomatis menggulir di tepi layar.
- Setelah ada yang terpilih, ketuk item untuk menambah/mengurangi pilihan. Bar di bawah: Terjemahkan terpilih, Hapus, Batal.
